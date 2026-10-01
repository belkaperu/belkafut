/**
 * lib/channel-images.mjs — busca y descarga logos de canales para guardarlos
 * en el repositorio (nada de hotlinks a terceros).
 *
 * Flujo:
 *   1. Lee las páginas de los sitios de "TV libre" (tvlibreonline.st, etc.),
 *      que publican una tarjeta por canal con su logo.
 *   2. Relaciona cada logo con el nombre del canal: alt de la imagen
 *      ("Telefe en VIVO online"), <h3> cercano o slug del enlace
 *      (/en-vivo/telefe).
 *   3. Empareja esos nombres con los canales del archivo de datos
 *      (usa nameScore: "ESPN 2" != "ESPN", acepta "| OP2", regiones, etc.).
 *   4. Descarga la imagen, la valida de verdad (tipo real por bytes mágicos,
 *      dimensiones, tamaño) y la guarda en img/canales/<slug>.<ext>.
 *
 * Sin dependencias externas (Node 20+).
 */

import { httpGet, normalizeText, normSlug, slugScore, urlJoin, hostOf } from "./util.mjs";
import { nameScore } from "./futbollibre.mjs";

/* ------------------------------------------------------------------ *
 * Nombres
 * ------------------------------------------------------------------ */

// Ruido típico en el alt de los logos de estos sitios
const ALT_NOISE_RE = new RegExp(
  [
    "en\\s+vivo\\s+online", "señal\\s+en\\s+vivo", "senal\\s+en\\s+vivo", "canal\\s+en\\s+vivo",
    "en\\s+vivo", "en\\s+directo", "ver\\s+canal", "ver\\s+online", "canal\\s+online",
    "tv\\s+online", "online\\s+gratis", "live\\s+stream", "en\\s+hd",
    "online", "gratis", "live", "canales", "canal", "hd", "ver",
  // Palabra completa: "ver" dentro de "E-ver-ything" o de "Uni-ver-sal" no se toca
  ].map((w) => `\\b(?:${w})\\b`).join("|"),
  "gi",
);

/** Limpia el texto de un alt/título para quedarnos con el nombre del canal. */
export function cleanImageName(raw) {
  let s = String(raw ?? "").replace(/<[^>]*>/g, " ");
  s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(ALT_NOISE_RE, " ");
  s = s.replace(/[|·•]+\s*$/g, "");
  s = s.replace(/\s*\|\s*/g, " ");
  s = s.replace(/\s*\(([^)]*)\)\s*/g, " ");     // "(Flow Sports)", "(DSports)"
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Archivos/hosts que nunca son logos de canal. */
const NOISE_HOST_RE = new RegExp(
  [
    "icons8", "gstatic", "google", "googleusercontent", "cdnjs", "jsdelivr", "unpkg",
    "flagcdn", "flagpedia", "wikipedia/commons/thumb/.*flag", "spinner", "placeholder",
    "gravatar", "doubleclick", "googletagmanager", "facebook", "twitter", "instagram",
    "whatsapp", "telegram", "youtube", "ytimg", "tiktok", "paypal", "fonts",
  ].join("|"),
  "i",
);
const NOISE_ALT_RE = /^(logo|bandera|flag|icono|icon|avatar|menu|home|inicio|buscar|search|carga|loading|publicidad|ad|anuncio)\b/i;

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)(\?|$)/i;

/* ------------------------------------------------------------------ *
 * Sniffing de imágenes (validación real, no solo content-type)
 * ------------------------------------------------------------------ */

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
function u32be(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }

/** Detecta el tipo real y las dimensiones a partir de los bytes. */
export function sniffImage(buf) {
  const b = buf;
  if (!b || b.length < 16) return { type: null, reason: "demasiado pequeño" };

  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF
  if (b.slice(0, 6).toString("latin1").match(/^GIF8[79]a$/)) {
    return { type: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + len;
    }
    return { type: "jpeg", width: null, height: null };
  }
  // WEBP
  if (b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") {
    const fmt = b.slice(12, 16).toString("latin1");
    if (fmt === "VP8X") return { type: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (fmt === "VP8 ") return { type: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (fmt === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { type: "webp", width: null, height: null };
  }
  // SVG (texto)
  const head = b.slice(0, 600).toString("utf8");
  if (/<svg[\s>]/i.test(head)) {
    const w = /\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)/i.exec(head);
    const h = /\bheight\s*=\s*["']?(\d+(?:\.\d+)?)/i.exec(head);
    const vb = /\bviewBox\s*=\s*["']?\s*[\d.-]+[\s,]+[\d.-]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(head);
    return {
      type: "svg",
      width: w ? Math.round(Number(w[1])) : vb ? Math.round(Number(vb[1])) : null,
      height: h ? Math.round(Number(h[1])) : vb ? Math.round(Number(vb[2])) : null,
    };
  }
  if (/^\s*(<!doctype|<html)/i.test(head)) return { type: null, reason: "es una página HTML, no una imagen" };
  if (b.slice(4, 12).toString("latin1").includes("ftypavif")) return { type: "avif", width: null, height: null };
  if (b[0] === 0x42 && b[1] === 0x4d) return { type: "bmp", width: u16le(b, 18), height: u16le(b, 22) };
  return { type: null, reason: "formato de imagen no reconocido" };
}

/** Extensión coherente con el contenido real (no con la URL). */
export function extForType(type, url = "") {
  const fromUrl = (IMG_EXT_RE.exec(url)?.[1] || "").toLowerCase();
  const map = {
    png: "png", jpeg: "jpg", gif: "gif", webp: "webp", svg: "svg", avif: "avif", bmp: "bmp",
  };
  const clean = (t) => (t === "jpeg" ? "jpg" : t);
  if (type && map[type]) {
    // Si la URL dice otra cosa y el tipo real es distinto, manda el tipo real
    return map[type];
  }
  return clean(fromUrl) || "img";
}

/**
 * Nombre de archivo seguro y estable para un canal:
 * "Cartoon Network" -> cartoon-network.svg · "ESPN 2" -> espn-2.png
 */
export function filenameFor(title, ext) {
  const base = normalizeText(title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "canal";
  return `${base}.${ext}`;
}

/* ------------------------------------------------------------------ *
 * Parser de catálogo de logos
 * ------------------------------------------------------------------ */

const ATTR_CACHE = new Map();
function attr(re, name) {
  if (!ATTR_CACHE.has(name)) {
    ATTR_CACHE.set(name, new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  }
  const m = ATTR_CACHE.get(name).exec(re);
  return m ? m[1] : null;
}

/** Elige la mejor URL de imagen de una etiqueta <img>. */
function imgSrc(attrs) {
  const raw = attr(attrs, "src") || attr(attrs, "data-src") || attr(attrs, "data-lazy-src") ||
    attr(attrs, "data-original") || attr(attrs, "data-srcset") || attr(attrs, "srcset");
  if (!raw) return null;
  const first = raw.split(",")[0].trim().split(/\s+/)[0];
  return first || null;
}

/**
 * Saca del HTML las tarjetas "canal + logo".
 * Devuelve [{ name, imageUrl, pageUrl, site, alt }]
 */
export function parseImageCatalog(html, baseUrl, { maxEntries = 800 } = {}) {
  const out = [];
  const site = hostOf(baseUrl);
  const text = String(html ?? "");

  for (const m of text.matchAll(/<img\b([^>]*)>/gi)) {
    if (out.length >= maxEntries) break;
    const attrs = m[1];
    const src = imgSrc(attrs);
    if (!src) continue;
    const imageUrl = urlJoin(baseUrl, src);
    if (!imageUrl) continue;
    if (NOISE_HOST_RE.test(imageUrl)) continue;
    if (/^data:/i.test(src)) continue;

    const alt = (attr(attrs, "alt") || attr(attrs, "title") || "").trim();
    if (NOISE_ALT_RE.test(alt)) continue;

    // Enlace contenedor (la tarjeta suele ser <a href="/en-vivo/<slug>">)
    const before = text.slice(Math.max(0, m.index - 700), m.index);
    const anchors = [...before.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)];
    const href = anchors.length ? anchors[anchors.length - 1][1] : null;
    const pageUrl = href ? urlJoin(baseUrl, href) : null;

    // <h3>/<h4> cercano (algunos sitios ponen el nombre ahí)
    const near = text.slice(m.index, m.index + 700);
    const heading = /<h[2-4]\b[^>]*>([\s\S]{0,80}?)<\/h[2-4]>/i.exec(near);
    const headingText = heading ? cleanImageName(heading[1].replace(/<[^>]*>/g, " ")) : "";
    const slugName = pageUrl ? cleanImageName(decodeURIComponent(pageUrl.split("/").filter(Boolean).pop() || "")) : "";

    const candidates = [cleanImageName(alt), headingText, slugName].filter((s) => s && s.length >= 2);
    if (!candidates.length) continue;
    const name = candidates.reduce((a, b) => (b.length > a.length ? b : a));

    out.push({ name, imageUrl, pageUrl, site, alt: alt || null, candidates });
  }

  // Dedupe por (nombre, imagen)
  const seen = new Set();
  return out.filter((e) => {
    const k = `${normalizeText(e.name)}|${e.imageUrl}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Catálogo con descarga
 * ------------------------------------------------------------------ */

export class ChannelImageCatalog {
  constructor({ log = console, http = httpGet, config = {} } = {}) {
    this.entries = [];
    this.sites = [];
    this.pagesFetched = 0;
    this.downloads = 0;
    this.log = log;
    this.http = http;
    this.config = {
      maxImageBytes: 400000,
      // El peso mínimo es solo un colador: los logos simples (o un SVG) pueden
      // pesar poco, así que el filtro real son las dimensiones.
      minImageBytes: 120,
      minWidth: 24,
      minHeight: 24,
      timeoutMs: 15000,
      userAgent: undefined,
      ...config,
    };
  }

  get size() { return this.entries.length; }

  addEntries(list, site = null) {
    for (const e of list) {
      if (!e?.imageUrl) continue;
      if (site) e.site = e.site || site;
      this.entries.push(e);
    }
  }

  /** Descarga una página de la lista y agrega sus logos al catálogo. */
  async ingest(url) {
    const res = await this.http(url, {
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxPageBytes || 1200000,
      userAgent: this.config.userAgent,
      headers: this.config.headers,
    });
    this.pagesFetched++;
    if (!res.netOk || res.status >= 400) {
      this.log.vlog?.(`imágenes: ${url} -> ${res.status || res.code}`);
      return { ok: false, status: res.status || res.code };
    }
    const found = parseImageCatalog(res.body, res.finalUrl || url);
    this.addEntries(found);
    this.log.vlog?.(`imágenes: ${url} -> ${found.length} logos`);
    return { ok: true, found: found.length };
  }

  /** Construye el catálogo desde los sitios configurados. */
  async build({ sites = [], concurrency = 4 } = {}) {
    const list = [...new Set(sites)].filter(Boolean);
    const queue = [...list];
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
      while (queue.length) {
        const url = queue.shift();
        const r = await this.ingest(url);
        if (r.ok) this.sites.push(url);
      }
    });
    await Promise.all(workers);
    // Dedupe global por imagen
    const seen = new Set();
    this.entries = this.entries.filter((e) => {
      if (seen.has(e.imageUrl)) return false;
      seen.add(e.imageUrl);
      return true;
    });
    return this;
  }

  /** Mejores coincidencias del catálogo para un canal. */
  match(channelTitle, { minScore = 0.75, limit = 8 } = {}) {
    const scored = [];
    for (const e of this.entries) {
      let best = 0;
      for (const cand of e.candidates?.length ? e.candidates : [e.name]) {
        best = Math.max(best, nameScore(channelTitle, cand));
      }
      if (best >= minScore) scored.push({ entry: e, score: best });
    }
    return scored
      .sort((a, b) => b.score - a.score || (b.entry.imageUrl.length - a.entry.imageUrl.length < 0 ? 1 : 0))
      .slice(0, limit);
  }

  /**
   * Descarga y valida una imagen.
   * Devuelve { ok, buffer, type, width, height, ext, bytes, reason }
   */
  async download(imageUrl, { referer } = {}) {
    this.downloads++;
    const res = await this.http(imageUrl, {
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxImageBytes,
      userAgent: this.config.userAgent,
      headers: referer ? { Referer: referer } : undefined,
      raw: true,
    });
    if (!res.netOk) return { ok: false, reason: `error de red: ${res.code || res.message}` };
    if (res.status >= 400) return { ok: false, reason: `HTTP ${res.status}` };

    const ctype = res.headers?.get?.("content-type") || "";
    const bytes = res.buffer?.length ?? res.bytes ?? 0;
    if (bytes < this.config.minImageBytes) return { ok: false, reason: `archivo demasiado pequeño (${bytes} bytes)` };
    if (bytes > this.config.maxImageBytes) return { ok: false, reason: `archivo demasiado grande (${bytes} bytes)` };
    if (/text\/html/i.test(ctype)) return { ok: false, reason: "el servidor devolvió HTML" };

    const buf = res.buffer || Buffer.from(res.body || "", "utf8");
    const sniff = sniffImage(buf);
    if (!sniff.type) return { ok: false, reason: sniff.reason || "no es una imagen válida" };
    if (/^image\//i.test(ctype) && !ctype.includes(sniff.type === "jpg" ? "jpeg" : sniff.type) &&
        !(sniff.type === "svg" && /svg/i.test(ctype))) {
      // tipos que no coinciden no son un problema grave, pero avisamos
      this.log.vlog?.(`imagen ${imageUrl}: content-type ${ctype} vs bytes ${sniff.type}`);
    }
    const { width, height } = sniff;
    if (width != null && width < this.config.minWidth) return { ok: false, reason: `muy angosta (${width}px)` };
    if (height != null && height < this.config.minHeight) return { ok: false, reason: `muy baja (${height}px)` };
    if (width != null && height != null && width * height <= 256) {
      return { ok: false, reason: `dimensiones de pixel de rastreo (${width}x${height})` };
    }
    return { ok: true, buffer: buf, type: sniff.type, width, height, bytes, ext: extForType(sniff.type, imageUrl), ctype };
  }
}

/** Puntúa la calidad esperada de una imagen solo por la URL (desempate). */
export function imageUrlScore(url) {
  const u = String(url || "");
  let s = 0;
  if (/\.(png|webp)$/i.test(u)) s += 2;        // suelen ser logos limpios
  if (/\.svg$/i.test(u)) s += 2;               // vectorial, mejor aún
  if (/logo|canal|channel/i.test(u)) s += 1;
  if (/\/(img|images|logo-canal)\//i.test(u)) s += 1;
  if (/thumb|small|mini|1x1|pixel|track/i.test(u)) s -= 3;
  return s;
}

export { nameScore, slugScore };
