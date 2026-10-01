#!/usr/bin/env node
/**
 * update-images.mjs — busca logos de canales en sitios de TV libre, los
 * descarga al repositorio (img/canales/) y rellena el campo `image` de los
 * canales que no lo tienen.
 *
 * Flujo:
 *   1. Lee los canales del archivo (data1.json por defecto) y detecta cuáles
 *      no tienen imagen (o, con --repair-broken, los que apuntan a una rota).
 *   2. Arma un catálogo de logos desde los sitios de "TV libre"
 *      (tvlibreonline.st y compañía; también los descubre buscando en Google).
 *   3. Empareja cada canal por nombre (ESPN != ESPN 2, acepta "| OP2", países…).
 *   4. Descarga la imagen, la valida (bytes mágicos, dimensiones, tamaño),
 *      la guarda en img/canales/<slug>.<ext> y apunta el JSON a esa ruta.
 *
 * Las imágenes quedan EN el repositorio: nada de hotlinks a terceros.
 *
 * Uso:
 *   node update-images.mjs                    # simulación
 *   node update-images.mjs --apply            # descarga y escribe
 *   node update-images.mjs --repair-broken    # también reemplaza las rotas
 *   node update-images.mjs --only-channel=ESPN
 *
 * Sin dependencias externas (Node 20+).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeLogger, parseArgs, num, mapLimit, normalizeText, normSlug, hostOf, httpGet } from "./lib/util.mjs";
import { ChannelImageCatalog, filenameFor, imageUrlScore } from "./lib/channel-images.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const L = makeLogger("imagenes");
L.setVerbose(!!args.verbose);
const { log, warn, err: errlog, vlog } = L;

const VERSION = "1.0.0";

/* ------------------------------------------------------------------ *
 * Configuración
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  enabled: true,
  file: "data1.json",
  field: "image",
  nameField: "title",
  dir: "img/canales",
  urlBase: "",                  // si se deja vacío: rutas relativas
  urlMode: "absolute",          // absolute | relative
  sources: [
    { id: "tvlibreonline", url: "https://tvlibreonline.st/" },
    { id: "tvlibreonline-tv", url: "https://tvlibreonline.tv/" },
    { id: "cablevisionhd", url: "https://www.cablevisionhd.com/" },
    { id: "telegratuita", url: "https://telegratuita.st/" },
    { id: "televisionlibre-co", url: "https://televisionlibre.com.co/" },
    { id: "futbollibre", url: "https://futbollibrefullhd.org/" },
  ],
  discoverFromSearch: true,
  searchQueries: [
    "television libre canales en vivo",
    "tv libre online canales en vivo",
    "ver canales de television gratis online",
  ],
  hostPattern: "(tvlibre|televisionlibre|telegratuita|cablevision|bestleague|futbol|pelota|canales)",
  maxDiscoveredSites: 6,
  minNameScore: 0.75,
  maxImageBytes: 400000,
  // Los logos simples (y los SVG) pueden pesar poco: el filtro real son las
  // dimensiones (minWidth/minHeight), no el peso.
  minImageBytes: 120,
  minWidth: 24,
  minHeight: 24,
  timeoutMs: 15000,
  concurrency: 4,
  maxPerRun: 0,                 // 0 = sin límite
};

function loadSources() {
  const p = path.resolve(String(args.sources || path.join(__dirname, "sources.json")));
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...(cfg.images || {}), _path: p };
  } catch (e) {
    warn(`No se pudo leer ${p}: ${e.message}; uso valores por defecto`);
    return { ...DEFAULTS };
  }
}

const cfg = loadSources();
if (args["url-mode"]) cfg.urlMode = String(args["url-mode"]);
if (args["url-base"]) cfg.urlBase = String(args["url-base"]);
if (args["dir"]) cfg.dir = String(args["dir"]);
if (args["field"]) cfg.field = String(args["field"]);
if (args["name-field"]) cfg.nameField = String(args["name-field"]);
if (args["min-score"]) cfg.minNameScore = num(args["min-score"], cfg.minNameScore);
if (args.sites) cfg.sources = String(args.sites).split(",").map((u) => ({ id: hostOf(u) || u, url: u.trim() }));
if (args["no-search"]) cfg.discoverFromSearch = false;

const TARGET = path.resolve(String(args.file || path.join(__dirname, cfg.file)));
const IMG_DIR = path.resolve(__dirname, cfg.dir);
const REPORT = String(args.report || path.join(__dirname, "imagenes-reporte.json"));

function publicUrlFor(filename) {
  if (cfg.urlMode === "relative") return `${cfg.dir.replace(/\/$/, "")}/${filename}`;
  const base = (cfg.urlBase || "").replace(/\/$/, "");
  if (!base) return `${cfg.dir.replace(/\/$/, "")}/${filename}`;
  return `${base}/${cfg.dir.replace(/^\.?\//, "").replace(/\/$/, "")}/${filename}`;
}

/* ------------------------------------------------------------------ *
 * Búsqueda de sitios (para descubrir más fuentes de logos)
 * ------------------------------------------------------------------ */

const searchCfg = (() => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.resolve(String(args.sources || path.join(__dirname, "sources.json"))), "utf8"));
    return doc.search || {};
  } catch { return {}; }
})();

function parseSearchLinks(html, kind, engine, baseUrl, skipHosts) {
  const out = [];
  const engineHost = hostOf(baseUrl || engine.url || "");
  const push = (href) => {
    if (!href) return;
    let h = href.trim().replace(/&amp;/g, "&");
    if (h.startsWith("//")) h = `https:${h}`;
    if (!/^https?:/i.test(h)) { try { h = new URL(h, baseUrl).toString(); } catch { return; } }
    try {
      const u = new URL(h);
      const isRedirect = /\/(url|link|redirect)$/i.test(u.pathname) || u.host !== engineHost;
      const wrapped = u.searchParams.get("uddg") || u.searchParams.get("url") ||
        (isRedirect ? u.searchParams.get("q") : null);
      const real = wrapped && /^https?:/i.test(decodeURIComponent(wrapped)) ? decodeURIComponent(wrapped) : u.toString();
      const ru = new URL(real);
      if (skipHosts.some((s) => ru.host === s || ru.host.endsWith(`.${s}`))) return;
      if (ru.host === engineHost && !engine.allowOwnHost) return;
      out.push(ru.toString());
    } catch { /* ignore */ }
  };
  if (kind === "bing") for (const m of html.matchAll(/<h2>\s*<a[^>]+href="([^"]+)"/gi)) push(m[1]);
  else if (kind === "google") for (const m of html.matchAll(/<a[^>]+href="(\/url\?[^"]+|https?:\/\/[^"]+)"/gi)) push(m[1]);
  else if (kind === "duckduckgo") for (const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi)) push(m[1]);
  else for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/gi)) push(m[1]);
  return [...new Set(out)];
}

async function discoverSites() {
  if (!cfg.discoverFromSearch || !(searchCfg.engines || []).length) return [];
  const found = [];
  const skipHosts = searchCfg.skipHosts || [];
  let pattern = null;
  try { pattern = new RegExp(cfg.hostPattern, "i"); } catch { /* ignore */ }

  for (const q of cfg.searchQueries) {
    for (const engine of searchCfg.engines) {
      const url = engine.url.replace("{q}", encodeURIComponent(q));
      const res = await httpGet(url, { timeoutMs: cfg.timeoutMs, maxBytes: 400000 });
      if (!res.netOk || res.status >= 400) { vlog(`búsqueda ${engine.name}: ${res.status || res.code}`); continue; }
      for (const link of parseSearchLinks(res.body, engine.kind, engine, res.finalUrl || url, skipHosts)) {
        const host = hostOf(link);
        if (!host) continue;
        if (pattern && !pattern.test(host)) continue;
        const origin = `${new URL(link).origin}/`;
        if (!found.includes(origin)) found.push(origin);
      }
      if (found.length >= cfg.maxDiscoveredSites) break;
    }
    if (found.length >= cfg.maxDiscoveredSites) break;
  }
  return found.slice(0, cfg.maxDiscoveredSites);
}

/* ------------------------------------------------------------------ *
 * Canales del archivo
 * ------------------------------------------------------------------ */

function readChannels(file) {
  const text = fs.readFileSync(file, "utf8");
  const doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  const arr = doc.canales || doc.channels || (Array.isArray(doc) ? doc : null);
  if (!Array.isArray(arr)) throw new Error(`${path.basename(file)} no tiene una lista de canales`);
  const channels = arr.map((c, index) => ({
    index,
    title: String(c[cfg.nameField] ?? c.title ?? c.name ?? `canal[${index}]`),
    image: String(c[cfg.field] ?? "").trim(),
  }));
  return { text, doc, arr, channels };
}

function isLocalPath(v) {
  return !!v && !/^https?:\/\//i.test(v);
}

/** Verifica si una imagen existente sigue viva (para --repair-broken). */
async function existingImageOk(url) {
  const res = await httpGet(url, { timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxImageBytes, raw: true });
  if (!res.netOk || res.status >= 400) return { ok: false, reason: res.netOk ? `HTTP ${res.status}` : `red: ${res.code}` };
  const { sniffImage } = await import("./lib/channel-images.mjs");
  const sniff = sniffImage(res.buffer);
  return sniff.type ? { ok: true } : { ok: false, reason: sniff.reason || "no es una imagen" };
}

/* ------------------------------------------------------------------ *
 * Escritura en el JSON (conservando el formato exacto)
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cambia el valor del campo de imagen del canal indicado sin tocar el resto
 * del archivo (misma indentación, mismos saltos de línea).
 *
 * El ancla es la clave del nombre (`"title": "ESPN"`), NO el nombre suelto: los
 * títulos también aparecen dentro de labels/URLs de otros canales y de ahí
 * saldrían ediciones al canal equivocado. `cursor` avanza en orden de documento
 * para que los títulos duplicados se resuelvan uno a uno.
 */
export function setChannelImage(text, channelTitle, field, newValue, cursor = 0, nameField = "title") {
  const titleRe = new RegExp(`"${escapeRe(nameField)}"\\s*:\\s*${escapeRe(JSON.stringify(channelTitle))}`, "g");
  titleRe.lastIndex = cursor;
  const titleMatch = titleRe.exec(text);
  if (!titleMatch) return null;
  const afterTitle = titleMatch.index + titleMatch[0].length;

  const nextTitleRe = new RegExp(`"${escapeRe(nameField)}"\\s*:`, "g");
  nextTitleRe.lastIndex = afterTitle;
  const nextTitle = nextTitleRe.exec(text);
  const limit = nextTitle ? nextTitle.index : text.length;

  const keyRe = new RegExp(`"${escapeRe(field)}"\\s*:`, "g");
  keyRe.lastIndex = afterTitle;
  const keyMatch = keyRe.exec(text);
  if (!keyMatch || keyMatch.index > limit) return null;

  const openQuote = text.indexOf('"', keyMatch.index + keyMatch[0].length);
  if (openQuote === -1 || openQuote > limit) return null;
  let i = openQuote + 1;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') break;
  }
  if (i >= text.length || i > limit) return null;
  return {
    start: openQuote + 1,
    end: i,
    limit,
    nextCursor: i + 1,
    text: text.slice(0, openQuote + 1) + newValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + text.slice(i),
  };
}

/**
 * Red de seguridad: confirma que el texto editado sigue siendo JSON válido y
 * que cada canal quedó apuntando a la imagen esperada. Si algo no cuadra, no se
 * escribe nada.
 */
export function verifyWrite(newText, expected, { nameField = "title", field = "image" } = {}) {
  let doc;
  try {
    doc = JSON.parse(newText.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ok: false, reason: `el JSON editado no parsea: ${e.message}` };
  }
  const arr = doc.canales || doc.channels || [];
  for (const [title, url] of expected) {
    const hit = arr.find((c) => c && c[nameField] === title && c[field] === url);
    if (!hit) {
      const other = arr.find((c) => c && c[nameField] === title);
      return { ok: false, reason: `"${title}" quedó con ${field}=${JSON.stringify(other?.[field] ?? null)}` };
    }
  }
  return { ok: true, canales: arr.length };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now();
  const apply = !!args.apply && !args["dry-run"];
  if (!fs.existsSync(TARGET)) {
    errlog(`No existe ${TARGET}`);
    process.exit(2);
  }

  log(`update-images v${VERSION}`);
  log(`Archivo: ${path.relative(process.cwd(), TARGET)} · carpeta: ${cfg.dir} · modo URL: ${cfg.urlMode}`);

  const { text: originalText, channels } = readChannels(TARGET);
  const only = args["only-channel"] ? normalizeText(String(args["only-channel"])) : null;
  const repairBroken = !!args["repair-broken"];

  // 1. ¿Qué canales necesitan imagen?
  //    - sin imagen: siempre
  //    - con imagen externa: solo si --repair-broken y esa imagen está rota
  //    - con imagen ya local (img/...): nunca
  const pending = channels.filter((c) => {
    if (only && !normalizeText(c.title).includes(only)) return false;
    return !c.image;
  });

  let toRepair = [];
  if (repairBroken) {
    const externals = channels.filter((c) => c.image && !isLocalPath(c.image) &&
      (!only || normalizeText(c.title).includes(only)));
    log(`Comprobando ${externals.length} imágenes externas existentes…`);
    const checks = await mapLimit(externals, Math.max(1, Math.min(8, cfg.concurrency * 2)), async (c) => {
      const r = await existingImageOk(c.image);
      return r.ok ? null : { ...c, brokenReason: r.reason };
    });
    toRepair = checks.filter(Boolean);
    log(`Imágenes externas rotas: ${toRepair.length}`);
  }

  const work = [...pending, ...toRepair];
  const max = num(args["max-per-run"], cfg.maxPerRun);
  const target = max > 0 ? work.slice(0, max) : work;

  log(`Canales sin imagen: ${pending.length}${repairBroken ? ` · rotas: ${toRepair.length}` : ""} · a procesar: ${target.length}`);
  if (!target.length) {
    log("No hay nada que completar. 🎉");
    writeReport({ target: 0, downloaded: 0, notFound: 0, failed: 0, details: [], sites: [], durationMs: Date.now() - t0 });
    setOutputs({ changed: "false", added: "0", failed: "0" });
    return;
  }

  // 2. Catálogo de logos
  const discovered = await discoverSites();
  const siteUrls = [...new Set([...cfg.sources.map((s) => s.url), ...discovered])].filter(Boolean);
  log(`Sitios de logos: ${siteUrls.length} (${discovered.length} descubiertos por búsqueda)`);

  const catalog = new ChannelImageCatalog({
    log: { log, warn, vlog },
    http: (url, opts = {}) => httpGet(url, {
      timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
      maxBytes: opts.maxBytes ?? 1000000,
      headers: opts.headers,
      raw: !!opts.raw,
    }),
    config: {
      maxImageBytes: cfg.maxImageBytes,
      minImageBytes: cfg.minImageBytes,
      minWidth: cfg.minWidth,
      minHeight: cfg.minHeight,
      timeoutMs: cfg.timeoutMs,
    },
  });
  await catalog.build({ sites: siteUrls, concurrency: cfg.concurrency });
  log(`Catálogo de logos: ${catalog.size} imágenes de ${catalog.sites.length} sitios`);

  // 3. Descargar
  fs.mkdirSync(IMG_DIR, { recursive: true });
  // Nombres reclamados en ESTA corrida. Los archivos que ya estaban en disco se
  // reutilizan (mismo canal = mismo nombre), evitando telefe-2.png, telefe-3.png…
  const usedFiles = new Set();
  const bySource = new Map();     // imageUrl -> archivo ya guardado
  const details = [];
  let downloaded = 0, notFound = 0, failed = 0;

  await mapLimit(target, Math.max(1, Math.min(3, cfg.concurrency)), async (channel) => {
    const matches = catalog.match(channel.title, { minScore: cfg.minNameScore, limit: 6 });
    if (!matches.length) {
      notFound++;
      vlog(`sin logo: ${channel.title}`);
      details.push({ canal: channel.title, estado: "sin_coincidencia", motivo: "no se encontró en los sitios de TV libre" });
      return;
    }
    // Mejor match primero; dentro de cada uno, la mejor URL
    const ordered = matches
      .flatMap((m) => [{ ...m, entry: m.entry }])
      .sort((a, b) => (b.score - a.score) || (imageUrlScore(b.entry.imageUrl) - imageUrlScore(a.entry.imageUrl)));

    for (const m of ordered) {
      const srcUrl = m.entry.imageUrl;
      let saved = bySource.get(srcUrl);
      if (!saved) {
        const dl = await catalog.download(srcUrl, { referer: m.entry.pageUrl || m.entry.site });
        if (!dl.ok) {
          vlog(`falló ${channel.title} <- ${srcUrl}: ${dl.reason}`);
          continue;
        }
        const filename = uniqueName(filenameFor(channel.title, dl.ext), usedFiles);
        usedFiles.add(filename);
        if (apply) fs.writeFileSync(path.join(IMG_DIR, filename), dl.buffer);
        saved = { filename, ...dl };
        bySource.set(srcUrl, saved);
      }
      downloaded++;
      details.push({
        canal: channel.title,
        estado: "ok",
        archivo: `${cfg.dir.replace(/\/$/, "")}/${saved.filename}`,
        url_publica: publicUrlFor(saved.filename),
        origen: srcUrl,
        sitio: m.entry.site,
        score: Number(m.score.toFixed(2)),
        tipo: saved.type,
        dimensiones: saved.width && saved.height ? `${saved.width}x${saved.height}` : null,
        bytes: saved.bytes,
      });
      return;
    }
    failed++;
    details.push({ canal: channel.title, estado: "descarga_fallida", motivo: "ninguna de las imágenes candidatas era válida" });
  });

  // 4. Escribir los cambios en el JSON (texto, preservando formato)
  const replaced = new Map();
  for (const d of details.filter((x) => x.estado === "ok")) {
    replaced.set(d.canal, d.url_publica);
  }

  let newText = originalText;
  let appliedCount = 0;
  if (apply) {
    const written = new Map();
    let cursor = 0;
    for (const channel of channels) {
      const url = replaced.get(channel.title);
      if (!url) continue;
      const res = setChannelImage(newText, channel.title, cfg.field, url, cursor, cfg.nameField);
      if (!res) { warn(`no se pudo escribir la imagen de "${channel.title}"`); continue; }
      newText = res.text;
      cursor = res.nextCursor;
      appliedCount++;
      written.set(channel.title, url);
    }
    // Red de seguridad antes de tocar el archivo
    const check = verifyWrite(newText, written, { nameField: cfg.nameField, field: cfg.field });
    if (!check.ok) {
      errlog(`No se escribe nada: ${check.reason}`);
      appliedCount = 0;
      newText = originalText;
    } else if (appliedCount) {
      vlog(`Escritura verificada: ${appliedCount} canales, ${check.canales} en total`);
    }
  }
  const changed = apply && newText !== originalText;
  if (changed) {
    fs.writeFileSync(TARGET, newText);
    log(`Archivo actualizado: ${appliedCount} imágenes`);
  } else if (replaced.size) {
    log(`${replaced.size} imágenes listas (simulación; usa --apply para descargarlas y escribir)`);
  }

  log(`Resumen: ${downloaded} descargadas · ${notFound} sin coincidencia · ${failed} fallidas`);
  writeReport({
    target: target.length, downloaded, notFound, failed,
    details, sites: catalog.sites, catalogSize: catalog.size,
    applied: appliedCount, changed, durationMs: Date.now() - t0,
  });
  setOutputs({ changed: String(changed), added: String(appliedCount), failed: String(failed + notFound) });
}

function uniqueName(filename, used) {
  if (!used.has(filename)) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  for (let i = 2; i < 500; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

function writeReport(data) {
  const report = {
    fecha: new Date().toISOString(),
    version: VERSION,
    archivo: path.relative(process.cwd(), TARGET),
    carpeta: cfg.dir,
    modo: args.apply ? "apply" : "dry-run",
    canales_sin_imagen: data.target,
    descargadas: data.downloaded,
    sin_coincidencia: data.notFound,
    fallidas: data.failed,
    aplicadas: data.applied || 0,
    cambiado: !!data.changed,
    sitios: data.sites || [],
    catalogo: data.catalogSize || 0,
    duracion_seg: Math.round((data.durationMs || 0) / 100) / 10,
    detalle: data.details || [],
  };
  try {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    log(`Reporte: ${path.relative(process.cwd(), REPORT)}`);
  } catch (e) {
    warn(`No se pudo escribir el reporte: ${e.message}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Logos de canales (${report.fecha})`, "",
      `- Archivo: \`${report.archivo}\` · carpeta: \`${report.carpeta}\``,
      `- Descargadas: **${report.descargadas}** · sin coincidencia: ${report.sin_coincidencia} · fallidas: ${report.fallidas}`,
      `- Catálogo: ${report.catalogo} logos de ${report.sitios.length} sitios`, "",
      ...report.detalle.filter((d) => d.estado === "ok").slice(0, 60)
        .map((d) => `- **${d.canal}** → \`${d.archivo}\` (${d.origen})`),
    ];
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n"); } catch { /* ignore */ }
  }
}

function setOutputs(obj) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try { fs.appendFileSync(out, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); } catch { /* ignore */ }
}

// Solo ejecuta si se invoca como script (permite importar setChannelImage/verifyWrite en las pruebas)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    errlog("ERROR:", e?.stack || e?.message || e);
    process.exit(1);
  });
}