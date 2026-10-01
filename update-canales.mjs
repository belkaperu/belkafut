#!/usr/bin/env node
/**
 * update-canales.mjs — descubre canales y sus URLs reales desde futbollibre
 * y los integra en data1.json (solo si la URL verifica).
 *
 * Flujo:
 *   1. Busca el dominio vivo de futbollibre (Google/Bing/DuckDuckGo + semillas
 *      de sources.json) y arma el catálogo agenda/portada/páginas de canal.
 *   2. De cada entrada saca la URL real del stream (los embeds vienen con la URL
 *      en base64 en ?r=, y la página del canal suele tener un espejo más fresco).
 *   3. Verifica cada URL antes de agregarla: nunca se agrega un canal muerto.
 *   4. Fusiona con data1.json: agrega opciones nuevas a los canales existentes
 *      (sin duplicar URLs) y canales nuevos solo si traen al menos una opción viva.
 *
 * Sin dependencias externas (Node 20+).
 *
 * Uso:
 *   node update-canales.mjs                # simulación
 *   node update-canales.mjs --apply        # escribe data1.json
 *   node update-canales.mjs --apply --only-channel=ESPN
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeLogger, parseArgs, num, mapLimit, normalizeText, hostOf, httpGet } from "./lib/util.mjs";
import { FutbolibreCatalog, looksLikeFutbolibre, nameScore, toBase, toOrigin } from "./lib/futbollibre.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const L = makeLogger("canales");
L.setVerbose(!!args.verbose);
const { log, warn, err: errlog, vlog } = L;

const TARGET = path.resolve(String(args.file || path.join(__dirname, "data1.json")));
const MAX_ADDS_PER_CHANNEL = num(args["max-options"], 3);

/* ------------------------------------------------------------------ *
 * Configuración (sources.json)
 * ------------------------------------------------------------------ */

function loadSources() {
  const p = path.resolve(String(args.sources || path.join(__dirname, "sources.json")));
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    warn(`No se pudo leer ${p}: ${e.message}; uso valores por defecto`);
    return {};
  }
}

const cfg = loadSources();
const agendaCfg = {
  domains: [],
  paths: ["/", "/agenda"],
  apiPaths: [],
  discoverFromSearch: false,
  searchQueries: ["futbollibre agenda", "futbollibre canales en vivo"],
  hostPattern: "",
  maxDomains: 2,
  maxNameScore: 0.75,
  ...(cfg.agenda || {}),
};
if (args["agenda-domains"]) agendaCfg.domains = String(args["agenda-domains"]).split(",");
const verification = {
  timeoutMs: 12000, concurrency: 8, perHostConcurrency: 3, perHostDelayMs: 150,
  minBodyBytes: 180, blockedStatuses: [401, 403, 429, 451, 503],
  deadTextPatterns: [], playerMarkers: ["<iframe", "<video", ".m3u8", "player", "embed", "file:"],
  ...(cfg.verification || {}),
};
const searchCfg = {
  enabled: true, maxQueries: 12, maxResultsPerQuery: 8, cacheTtlMinutes: 720,
  skipHosts: [], engines: [],
  ...(cfg.search || {}),
};

const http = (url, opts = {}) => httpGet(url, {
  timeoutMs: opts.timeoutMs ?? verification.timeoutMs,
  maxBytes: opts.maxBytes ?? 400000,
  userAgent: verification.userAgent,
  headers: verification.extraHeaders,
});

/* ------------------------------------------------------------------ *
 * Búsqueda (para descubrir el dominio de futbollibre)
 * ------------------------------------------------------------------ */

const searchCache = { searches: {} };

function parseSearchLinks(html, kind, engine, baseUrl) {
  const out = [];
  const engineHost = hostOf(baseUrl || engine.url || "");
  const skip = searchCfg.skipHosts || [];
  const push = (href) => {
    if (!href) return;
    let h = href.trim().replace(/&amp;/g, "&");
    if (h.startsWith("//")) h = `https:${h}`;
    if (!/^https?:/i.test(h)) {
      try { h = new URL(h, baseUrl).toString(); } catch { return; }
    }
    try {
      const u = new URL(h);
      const isRedirect = /\/(url|link|redirect)$/i.test(u.pathname) || u.host !== engineHost;
      const wrapped = u.searchParams.get("uddg") || u.searchParams.get("url") ||
        (isRedirect ? u.searchParams.get("q") : null);
      const real = wrapped && /^https?:/i.test(decodeURIComponent(wrapped)) ? decodeURIComponent(wrapped) : u.toString();
      const ru = new URL(real);
      if (skip.some((s) => ru.host === s || ru.host.endsWith(`.${s}`))) return;
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

async function webSearch(query) {
  const hit = searchCache.searches[query];
  if (hit && Date.now() - hit.ts < (searchCfg.cacheTtlMinutes ?? 720) * 60000) return hit.links;
  const links = [];
  for (const engine of searchCfg.engines || []) {
    const url = engine.url.replace("{q}", encodeURIComponent(query));
    const res = await http(url, { maxBytes: 300000 });
    if (!res.netOk || res.status >= 400) { vlog(`búsqueda ${engine.name}: ${res.status || res.code}`); continue; }
    links.push(...parseSearchLinks(res.body, engine.kind, engine, res.finalUrl || url));
    if (links.length >= (searchCfg.maxResultsPerQuery || 8)) break;
  }
  const uniq = [...new Set(links)].slice(0, searchCfg.maxResultsPerQuery || 8);
  searchCache.searches[query] = { ts: Date.now(), links: uniq };
  return uniq;
}

/* ------------------------------------------------------------------ *
 * Verificación (para no agregar canales muertos)
 * ------------------------------------------------------------------ */

function classify(url, res) {
  if (!res.netOk) return { ok: false, why: `error de red: ${res.code || res.message}` };
  if (verification.blockedStatuses.includes(res.status)) return { ok: false, why: `HTTP ${res.status} (bloqueado)` , inconclusive: true };
  if (res.status >= 400) return { ok: false, why: `HTTP ${res.status}` };
  const body = res.body || "";
  if (/\.(m3u8|mpd)(\?|$)/i.test(url)) {
    if (/\.mpd(\?|$)/i.test(url) ? !/<MPD[\s>]/i.test(body) : !/^\s*#EXTM3U/i.test(body)) {
      return { ok: false, why: "manifiesto inválido" };
    }
    return { ok: true, why: "manifiesto OK" };
  }
  if ((res.bytes ?? body.length) < verification.minBodyBytes) return { ok: false, why: "respuesta vacía" };
  const text = normalizeText(body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
  const dead = (verification.deadTextPatterns || []).find((p) => text.includes(normalizeText(p)));
  if (dead) return { ok: false, why: `texto de error: "${dead}"` };
  const marker = (verification.playerMarkers || []).some((m) => body.toLowerCase().includes(String(m).toLowerCase()));
  if (!marker) return { ok: false, why: "sin reproductor", inconclusive: true };
  return { ok: true, why: "contenido OK" };
}

async function verify(url) {
  const res = await http(url);
  return { url, ...classify(url, res), status: res.status, bytes: res.bytes };
}

/* ------------------------------------------------------------------ *
 * Catálogo
 * ------------------------------------------------------------------ */

async function buildCatalog() {
  const catalog = new FutbolibreCatalog({ log: { log, warn, vlog }, http });

  const discovered = [];
  if (agendaCfg.discoverFromSearch && searchCfg.enabled) {
    for (const q of agendaCfg.searchQueries || []) {
      const links = await webSearch(q);
      for (const link of links) {
        if (!looksLikeFutbolibre(link, agendaCfg.hostPattern)) continue;
        const origin = toOrigin(link);
        if (origin) discovered.push(origin);
      }
    }
    log(`Búsqueda: ${discovered.length} dominio(s) candidatos`);
  }
  const seeds = (agendaCfg.domains || []).map(toBase).filter(Boolean);
  await catalog.build({
    domains: seeds,
    discover: [...new Set(discovered)],
    paths: agendaCfg.paths,
    apiPaths: agendaCfg.apiPaths,
    maxDomains: agendaCfg.maxDomains,
    log: { log, warn, vlog },
  });
  return catalog;
}

/* ------------------------------------------------------------------ *
 * Fusión con data1.json
 * ------------------------------------------------------------------ */

function readTarget() {
  const text = fs.readFileSync(TARGET, "utf8");
  const doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!Array.isArray(doc.canales)) throw new Error(`${path.basename(TARGET)} no tiene "canales"`);
  return { doc, text };
}

/**
 * Busca a qué canal del archivo corresponde un nombre del catálogo:
 * primero coincidencia exacta y, si no, la mejor puntuación de nameScore
 * (que ya sabe que "Win Sports + | OP2" es de "WIN SPORTS" pero que
 * "ESPN 2" no es "ESPN").
 */
function findChannelIndex(canales, name) {
  const key = normalizeText(name);
  let idx = canales.findIndex((c) => normalizeText(c.title || c.name) === key);
  if (idx !== -1) return idx;
  const loose = key.replace(/[^a-z0-9]+/g, " ").trim();
  idx = canales.findIndex((c) => normalizeText(c.title || c.name).replace(/[^a-z0-9]+/g, " ").trim() === loose);
  if (idx !== -1) return idx;

  const min = agendaCfg.minNameScore ?? 0.75;
  let best = { idx: -1, score: 0 };
  canales.forEach((c, i) => {
    const s = nameScore(c.title || c.name, name);
    if (s > best.score) best = { idx: i, score: s };
  });
  return best.score >= min ? best.idx : -1;
}

async function main() {
  if (!fs.existsSync(TARGET)) {
    errlog(`No existe ${TARGET}`);
    process.exit(2);
  }
  const apply = !!args.apply && !args["dry-run"];
  const only = args["only-channel"] ? normalizeText(String(args["only-channel"])) : null;
  const reportPath = String(args.report || path.join(__dirname, "canales-reporte.json"));

  const { doc, text: originalText } = readTarget();
  log(`Catálogo objetivo: ${path.basename(TARGET)} (${doc.canales.length} canales)`);

  const catalog = await buildCatalog();
  if (catalog.size === 0) {
    warn("No se encontró ningún dominio de futbollibre con entradas. No se cambia nada.");
    fs.writeFileSync(reportPath, JSON.stringify({
      fecha: new Date().toISOString(), estado: "sin_catalogo", dominios: catalog.domains,
      canales_agregados: 0, opciones_agregadas: 0, detalle: [],
    }, null, 2));
    setGithubOutput({ changed: "false", added_channels: "0", added_options: "0" });
    return;
  }

  // Agrupa las entradas del catálogo por nombre (una por canal)
  const groups = new Map();
  for (const entry of catalog.entries) {
    if (!entry.name) continue;
    const key = normalizeText(entry.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  log(`Catálogo: ${catalog.size} entradas en ${groups.size} canales de ${catalog.domains.join(", ")}`);

  // Candidatos a verificar: la URL directa y/o la página del canal
  const jobs = [];
  for (const [key, entries] of groups) {
    if (only && !key.includes(only)) continue;
    const idx = findChannelIndex(doc.canales, entries[0].name);
    if (idx === -1) {
      vlog(`catálogo: "${entries[0].name}" no está en ${path.basename(TARGET)} (se omite)`);
      continue;
    }
    for (const entry of entries) {
      jobs.push({ key, entry, channelIndex: idx });
    }
  }
  log(`Canales del catálogo presentes en el archivo: ${new Set(jobs.map((j) => j.channelIndex)).size}`);

  // Resuelve y verifica
  const results = await mapLimit(jobs, Math.max(1, Math.min(4, verification.concurrency || 6)), async (job) => {
    const candidates = await catalog.resolve(job.entry, {
      maxPages: agendaCfg.maxPagesPerEntry ?? 1,
      timeoutMs: verification.timeoutMs,
      userAgent: verification.userAgent,
      headers: verification.extraHeaders,
    });
    for (const c of candidates) {
      const v = await verify(c.url);
      if (v.ok) return { ...job, url: c.url, source: c.source, why: v.why };
    }
    return null;
  });

  const alive = results.filter(Boolean);
  log(`URLs verificadas OK: ${alive.length}/${jobs.length}`);

  // Fusiona
  const added = [];
  const perChannel = new Map();
  for (const r of alive) {
    const channel = doc.canales[r.channelIndex];
    const list = perChannel.get(r.channelIndex) || 0;
    if (list >= MAX_ADDS_PER_CHANNEL) continue;
    channel.options = Array.isArray(channel.options) ? channel.options : [];
    const existing = new Set(channel.options.map((o) => String(o.url || "")));
    if (existing.has(r.url)) continue;
    const label = `${r.entry.name} · ${hostOf(r.url)}`;
    channel.options.push({ label, url: r.url });
    perChannel.set(r.channelIndex, list + 1);
    added.push({ canal: channel.title, opcion: label, url: r.url, fuente: r.source, evento: r.entry.event || null });
  }

  const changed = added.length > 0;
  if (apply && changed) {
    // Inserta las opciones nuevas conservando el formato del archivo (CRLF)
    const updatedText = mergeIntoText(originalText, doc, added);
    fs.writeFileSync(TARGET, updatedText);
    log(`Archivo actualizado: ${added.length} opciones en ${perChannel.size} canales`);
  } else if (changed) {
    log(`${added.length} opciones nuevas propuestas (simulación; usa --apply para escribir)`);
  } else {
    log("Sin novedades: todas las URLs del catálogo ya estaban o no verificaron.");
  }

  const report = {
    fecha: new Date().toISOString(),
    estado: changed ? (apply ? "aplicado" : "simulado") : "sin_cambios",
    dominios: catalog.domains,
    entradas_catalogo: catalog.size,
    canales_en_catalogo_presentes: new Set(jobs.map((j) => j.channelIndex)).size,
    urls_verificadas_ok: alive.length,
    opciones_agregadas: added.length,
    canales_tocados: perChannel.size,
    detalle: added,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Reporte: ${path.relative(process.cwd(), reportPath)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Canales desde futbollibre (${report.fecha})`, "",
      `- Dominios: ${report.dominios.join(", ") || "ninguno"}`,
      `- Entradas del catálogo: ${report.entradas_catalogo}`,
      `- URLs verificadas OK: ${report.urls_verificadas_ok}`,
      `- Opciones agregadas: ${report.opciones_agregadas} en ${report.canales_tocados} canales`, "",
      ...added.slice(0, 40).map((a) => `- **${a.canal}**: \`${a.url}\` (${a.fuente})`),
    ];
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n"); } catch { /* ignore */ }
  }
  setGithubOutput({
    changed: String(changed),
    added_options: String(added.length),
    added_channels: String(perChannel.size),
  });
}

/** Devuelve el índice del corchete/llave que cierra al que abre en openIdx. */
function matchBracket(text, openIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Inserta las opciones nuevas en el texto original sin reserializar el archivo:
 * así se conserva byte a byte todo lo demás (formato, escapes, CRLF).
 */
function mergeIntoText(originalText, doc, added) {
  const eol = /\r\n/.test(originalText) ? "\r\n" : "\n";
  const byChannel = new Map();
  for (const a of added) {
    if (!byChannel.has(a.canal)) byChannel.set(a.canal, []);
    byChannel.get(a.canal).push(a);
  }

  const plans = [];
  let cursor = 0;
  for (const channel of doc.canales) {
    const title = channel.title ?? channel.name;
    const lit = JSON.stringify(title);
    const at = originalText.indexOf(lit, cursor);
    if (at === -1) continue;
    cursor = at + lit.length;
    const items = byChannel.get(title);
    if (!items?.length) continue;

    const boundary = originalText.indexOf('"title":', cursor);
    const optKey = originalText.indexOf('"options"', cursor);
    if (optKey === -1 || (boundary !== -1 && optKey > boundary)) continue;
    const arrStart = originalText.indexOf("[", optKey);
    const arrEnd = matchBracket(originalText, arrStart);
    if (arrStart === -1 || arrEnd === -1) continue;

    // Sangría del array (la del corchete de cierre)
    const lineStart = originalText.lastIndexOf(eol, arrEnd) + eol.length;
    const indent = " ".repeat(Math.max(0, arrEnd - lineStart));
    const itemIndent = indent + "  ";

    // Se inserta justo después del último elemento (o del "[") para que la coma
    // quede pegada al cierre anterior y el resto del archivo no cambie.
    let insertAt = arrEnd;
    while (insertAt > 0 && /\s/.test(originalText[insertAt - 1])) insertAt--;
    const emptyArray = originalText[insertAt - 1] === "[";
    const blocks = items.map((it) => {
      const obj = JSON.stringify({ label: it.opcion, url: it.url }, null, 2)
        .split("\n").join(eol + itemIndent);
      return itemIndent + obj;
    });
    const insertion = (emptyArray ? "" : ",") + eol + blocks.join("," + eol);
    plans.push({ position: insertAt, insertion });
  }

  if (!plans.length) return originalText;
  let out = originalText;
  for (const p of plans.sort((a, b) => b.position - a.position)) {
    out = out.slice(0, p.position) + p.insertion + out.slice(p.position);
  }
  return out;
}

function setGithubOutput(obj) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try { fs.appendFileSync(out, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); } catch { /* ignore */ }
}

main().catch((e) => {
  errlog("ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
