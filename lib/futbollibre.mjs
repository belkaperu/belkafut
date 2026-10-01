/**
 * lib/futbollibre.mjs — catálogo de futbollibre (y sitios hermanos).
 *
 * Flujo que automatiza:
 *   1. Descubre el dominio vivo de futbollibre (semillas + búsqueda en Google/Bing/DDG).
 *   2. Entra a la portada y a la agenda y extrae los enlaces de reproducción:
 *        https://<dominio>/embed/eventos.html?r=<base64 de la URL real>
 *   3. Entra a las páginas de canal (/en-vivo/<slug>) y saca de ahí el
 *      reproductor real (ej. https://tvf90.com/5.php?stream=espn), que puede
 *      venir en un espejo distinto al de la agenda.
 *   4. Devuelve un catálogo: nombre del canal -> URLs reales verificables.
 *
 * Sin dependencias externas (Node 20+).
 */

import {
  cleanAnchorText, decodeBase64Detailed, decodeBase64Maybe, hostOf, httpGet,
  normalizeText, normSlug, safeDecode, slugScore, stripTags, tokens, urlJoin,
} from "./util.mjs";

/* ------------------------------------------------------------------ *
 * Parseo de HTML
 * ------------------------------------------------------------------ */

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const EMBED_PARAM_RE = /[?&](?:r|get|url|embed)=([^&"'\s]+)/i;

/** Nombre legible del enlace: quita imágenes/alt ("Ver"), backslashes y ruido. */
export function entryNameFromAnchor(innerHtml) {
  let t = String(innerHtml ?? "").replace(/<img\b[^>]*>/gi, " ").replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  t = cleanAnchorText(t);
  t = t.replace(/^(ver|mirar|play|watch)\b[\s:|-]*/i, "");
  t = t.replace(/\\+/g, " ").replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim();
  // "Ver" suelto al final (alt de íconos que quedó como texto)
  t = t.replace(/\s*\bver\b\s*$/i, "").trim();
  return t;
}

/** Nombre a partir del slug: /en-vivo/liga-1-max -> "liga 1 max" (y su título). */
export function nameFromSlug(slug) {
  return String(slug || "")
    .replace(/\.(html?|php)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrae entradas del catálogo desde el HTML (portada, agenda, páginas de canal).
 * Detecta los enlaces de reproducción con parámetro base64 y las tarjetas de canal.
 */
export function parseCatalogHtml(html, baseUrl) {
  const entries = [];
  const siteHost = hostOf(baseUrl);

  // 1) Enlaces de reproducción: .../embed/eventos.html?r=<base64>  (y variantes ?get=)
  for (const m of String(html).matchAll(ANCHOR_RE)) {
    const href = m[1];
    const decoded = decodeEmbedHref(href, baseUrl);
    if (!decoded) continue;
    const name = entryNameFromAnchor(m[2]) || nameFromSlug(href.split("/").pop() || "");
    entries.push({
      name,
      pageUrl: urlJoin(baseUrl, href),
      directUrl: decoded.url,
      encoding: decoded.style,
      kind: "embed",
      site: siteHost,
    });
  }

  // 2) Tarjetas de canal: <h3>Nombre</h3> ... <a href="/en-vivo/slug">Ver Canal</a>
  const headings = [];
  for (const m of String(html).matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    headings.push({ index: m.index, text: cleanAnchorText(m[1]) });
  }
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']*\/(?:en-vivo|canal|ver|channel)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const pageUrl = urlJoin(baseUrl, m[1]);
    if (!pageUrl) continue;
    let name = "";
    const before = headings.filter((h) => h.index < m.index).pop();
    if (before && m.index - before.index < 2500) name = before.text;
    if (!name) {
      const anchorText = entryNameFromAnchor(m[2]);
      if (anchorText && !/^(ver|canal|reproducir)\b/i.test(anchorText)) name = anchorText;
    }
    if (!name) name = nameFromSlug(m[1].split("/").filter(Boolean).pop());
    entries.push({ name, pageUrl, directUrl: null, kind: "channel", site: siteHost });
  }

  return entries.filter((e) => e.name && (e.pageUrl || e.directUrl));
}

/** Decodifica un href tipo /embed/eventos.html?r=<base64> -> URL real. */
export function decodeEmbedHref(href, baseUrl) {
  const m = EMBED_PARAM_RE.exec(String(href || ""));
  if (!m) return null;
  const raw = safeDecode(m[1]);
  if (/^https?:\/\//i.test(raw)) return { url: raw, style: "plain" };
  const dec = decodeBase64Detailed(raw);
  if (!dec) return null;
  // Normaliza posibles parámetros heredados dentro del enlace
  return { url: dec.text, style: dec.style, base: baseUrl };
}

/**
 * Busca payloads JSON (tipo Strapi) embebidos o servidos por API:
 *   { "embed_name": "ESPN", "embed_iframe": "/embed/eventos.html?r=<base64>" }
 */
export function parseStrapiPayload(body, baseUrl) {
  const out = [];
  const text = String(body ?? "");
  const re = /"embed_iframe"\s*:\s*"([^"]+)"([\s\S]{0,600}?)"embed_name"\s*:\s*"([^"]*)"/g;
  const re2 = /"embed_name"\s*:\s*"([^"]*)"([\s\S]{0,600}?)"embed_iframe"\s*:\s*"([^"]+)"/g;
  const push = (iframe, name) => {
    const decoded = decodeEmbedHref(iframe.replace(/\\\//g, "/"), baseUrl);
    if (!decoded) return;
    out.push({
      name: String(name || "").trim(),
      pageUrl: urlJoin(baseUrl, iframe.replace(/\\\//g, "/")),
      directUrl: decoded.url,
      encoding: decoded.style,
      kind: "api",
      site: hostOf(baseUrl),
    });
  };
  for (const m of text.matchAll(re)) push(m[1], m[3]);
  for (const m of text.matchAll(re2)) push(m[3], m[1]);
  // Las fechas/descripciones ayudan a nombrar eventos de la agenda
  for (const m of text.matchAll(/"diary_description"\s*:\s*"([^"]+)"/g)) {
    const desc = m[1].replace(/\\u[\dA-Fa-f]{4}/g, " ");
    const tail = text.slice(m.index, m.index + 4000);
    const emb = /"embed_iframe"\s*:\s*"([^"]+)"/.exec(tail);
    const nm = /"embed_name"\s*:\s*"([^"]*)"/.exec(tail);
    if (!emb) continue;
    const decoded = decodeEmbedHref(emb[1].replace(/\\\//g, "/"), baseUrl);
    if (!decoded) continue;
    out.push({
      name: (nm?.[1] || desc).trim(),
      event: desc.trim(),
      pageUrl: urlJoin(baseUrl, emb[1].replace(/\\\//g, "/")),
      directUrl: decoded.url,
      encoding: decoded.style,
      kind: "api-event",
      site: hostOf(baseUrl),
    });
  }
  return out;
}

const PLAYER_EXT_RE = /\.(?:m3u8|mpd)(\?|$)/i;
const SKIP_LINK_RE = /\.(?:css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|xml|txt)(\?|$)/i;
const NOISE_HOST_RE = /(google|gstatic|bing|duckduckgo|cloudflare|fonts|icons8|jsdelivr|googletagmanager|doubleclick|schema\.org|w3\.org|facebook|twitter|instagram|whatsapp|telegram|t\.me|youtube|paypal)/i;

/**
 * URLs candidatas a reproductor dentro de una página
 * (enlaces directos, iframes, manifiestos y parámetros base64).
 */
export function playerLinksFromHtml(html, baseUrl, { ownHosts = [], limit = 25 } = {}) {
  const found = [];
  const siteHost = hostOf(baseUrl);
  const push = (raw, kind) => {
    const u = urlJoin(baseUrl, raw);
    if (!u) return;
    const host = hostOf(u);
    if (!host) return;
    if (NOISE_HOST_RE.test(host)) return;
    if (SKIP_LINK_RE.test(u) && !PLAYER_EXT_RE.test(u)) return;
    if (host === siteHost && !PLAYER_EXT_RE.test(u) && !/\/(embed|player|repro|en-vivo)\b/i.test(u)) {
      // Enlaces internos (navegación) solo si parecen reproductor
      if (!/[?&](?:r|get|url|stream|channel|id)=/i.test(u)) return;
    }
    if (ownHosts.some((h) => host === h || host.endsWith(`.${h}`))) return;
    found.push({ url: u, kind });
  };

  for (const m of String(html).matchAll(ANCHOR_RE)) {
    const decoded = decodeEmbedHref(m[1], baseUrl);
    if (decoded) push(decoded.url, "embed-b64");
    else if (/\.(?:php|html?|m3u8|mpd)\b/i.test(m[1]) || /[?&](?:stream|channel|id|get)=/i.test(m[1])) push(m[1], "link");
  }
  for (const m of String(html).matchAll(/<iframe\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) push(m[1], "iframe");
  for (const m of String(html).matchAll(/<(?:video|source)\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) push(m[1], "video");
  for (const m of String(html).matchAll(/https?:\/\/[^\s"'<>\\]*?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi)) {
    if ((m[0].match(/:\/\//g) || []).length === 1) push(m[0], "manifest");
  }
  for (const m of String(html).matchAll(/[?&](?:get|url|src|u)=([A-Za-z0-9+/_=-]{20,})/gi)) {
    const dec = decodeBase64Maybe(m[1]);
    if (dec) push(dec, "b64-param");
  }
  for (const m of String(html).matchAll(/["'](\/[^"']*\.(?:m3u8|mpd)[^"']*)["']/gi)) push(m[1], "manifest-rel");

  const seen = new Map();
  for (const f of found) if (!seen.has(f.url)) seen.set(f.url, f);
  const prio = { manifest: 0, "manifest-rel": 1, "embed-b64": 2, "b64-param": 3, iframe: 4, video: 5, link: 6 };
  return [...seen.values()]
    .sort((a, b) => (prio[a.kind] ?? 9) - (prio[b.kind] ?? 9))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Comparación de nombres de canal
 * ------------------------------------------------------------------ */

// Calificadores que no cambian de canal: HD, | OP2, Móvil, 2 letras de país…
const SAFE_EXTRA_RE = new RegExp(
  "^(?:" + [
    "hd", "fhd", "uhd", "sd", "4k", "full", "movil", "mobile", "online", "en", "vivo", "live",
    "op", "opc", "opcion", "espejo", "server", "servidor", "mirror", "senal", "premium", "plus",
    "lat", "latam", "global", "int", "internacional",
    // países / regiones (3 letras)
    "esp", "arg", "mex", "usa", "col", "chl", "per", "ecu", "bol", "par", "uru", "ven", "bra", "ger", "ita", "fra", "hol", "ing",
    // países (2 letras)
    "es", "en", "ar", "mx", "us", "pe", "cl", "co", "ec", "bo", "py", "uy", "ve", "br", "nl",
    "de", "it", "fr", "uk", "gt", "cr", "pa", "do", "hn", "sv", "ni", "pr", "cu", "pt",
  ].join("|") + ")\\d*$",
  "i",
);

/**
 * Números que identifican al canal: solo los que van sueltos ("ESPN 2", "DAZN 1",
 * "Fox Sports 3"). Los que van pegados a una palabra son de la opción, no del
 * canal ("| OP2", "HD2"), así que no cuentan.
 */
function numberTokens(s) {
  const out = [];
  for (const m of normalizeText(s).matchAll(/(?:^|[^a-z0-9])(\d+)(?![a-z0-9])/g)) out.push(m[1]);
  return out;
}

/**
 * Puntúa si la entrada del catálogo corresponde al canal buscado.
 * - Los números deben coincidir exactamente (ESPN ≠ ESPN 2).
 * - Se permiten calificadores (HD, | OP2, Móvil, país) alrededor del nombre.
 * - Extras significativos se rechazan (FOX Deportes no sirve para FOX Sports).
 */
export function nameScore(channelTitle, entryName) {
  const a = normalizeText(channelTitle), b = normalizeText(entryName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = normSlug(channelTitle), sb = normSlug(entryName);
  // "ESPN2" == "ESPN 2" == "ESPN | 2": misma clave, mismo canal
  if (sa && sa === sb) return 1;
  const ta = tokens(channelTitle), tb = tokens(entryName);
  if (!ta.length || !tb.length) return slugScore(channelTitle, entryName) * 0.5;

  const eq = (x, y) => x === y || (x.length > 2 && y.length > 2 && (x.startsWith(y) || y.startsWith(x)));
  const missing = ta.filter((t) => !tb.some((x) => eq(t, x)));
  const extra = tb.filter((t) => !ta.some((x) => eq(t, x)));

  // Los números identifican al canal: "ESPN" y "ESPN 2" son distintos
  const numT = numberTokens(channelTitle).sort().join(",");
  const numE = numberTokens(entryName).sort().join(",");
  if (numT !== numE) return 0;

  if (missing.some((t) => !SAFE_EXTRA_RE.test(t))) return 0;  // falta el nombre base
  if (extra.some((t) => !SAFE_EXTRA_RE.test(t))) return 0;    // es otro canal

  if (sa === sb) return 1;
  return Math.max(0.5, Math.min(1, 0.95 - (extra.length + missing.length) * 0.03));
}

/* ------------------------------------------------------------------ *
 * Catálogo
 * ------------------------------------------------------------------ */

export class FutbolibreCatalog {
  constructor({ log = console, http = httpGet } = {}) {
    this.entries = [];
    this.domains = [];
    this.pagesFetched = 0;
    this.log = log;
    this.http = http;
    this._resolved = new Map();
  }

  get size() { return this.entries.length; }

  addEntries(list) {
    for (const e of list) {
      if (!e) continue;
      const key = `${normalizeText(e.name)}|${e.directUrl || e.pageUrl || ""}`;
      if (this._keys?.has(key)) {
        // refuerza entradas ya vistas (ej. mismo embed en portada y agenda)
        const prev = this._keys.get(key);
        if (!prev.directUrl && e.directUrl) Object.assign(prev, e);
        prev.hits = (prev.hits || 1) + 1;
        continue;
      }
      this._keys = this._keys || new Map();
      e.hits = 1;
      this._keys.set(key, e);
      this.entries.push(e);
    }
  }

  /** Descarga una página y agrega lo que encuentre al catálogo. */
  async ingest(url, opts = {}) {
    const res = await this.http(url, opts);
    this.pagesFetched++;
    if (!res.netOk || res.status >= 400) return { ok: false, status: res.status, pageUrl: url };
    const finalUrl = res.finalUrl || url;
    this.addEntries(parseCatalogHtml(res.body, finalUrl));
    if (/embed_iframe|diary_description/.test(res.body)) {
      this.addEntries(parseStrapiPayload(res.body, finalUrl));
    }
    return { ok: true, status: res.status, pageUrl: finalUrl, entries: this.size };
  }

  /** Construye el catálogo: dominios semilla + descubiertos, portada, agenda y APIs. */
  async build({ domains = [], paths = ["/", "/agenda"], apiPaths = [], maxDomains = 3, discover, log } = {}) {
    const logger = log || this.log;
    const candidates = [...new Set([...domains, ...(discover || [])])].filter(Boolean);
    const tried = [];

    for (const domain of candidates) {
      if (this.domains.length >= maxDomains) break;
      if (tried.includes(domain)) continue;
      tried.push(domain);
      let alive = false;
      for (const p of paths) {
        const url = `${domain.replace(/\/$/, "")}${p}`;
        const r = await this.ingest(url);
        if (r.ok) alive = true;
        logger.vlog?.(`agenda: ${url} -> ${r.ok ? `${r.status} (${this.size} entradas)` : r.status || "sin respuesta"}`);
      }
      for (const p of apiPaths) {
        const url = `${domain.replace(/\/$/, "")}${p}`;
        const r = await this.ingest(url);
        if (r.ok) alive = true;
        logger.vlog?.(`agenda api: ${url} -> ${r.ok ? r.status : r.status || "sin respuesta"}`);
      }
      if (alive && this.size > 0) {
        this.domains.push(domain);
        logger.log?.(`agenda: catálogo desde ${domain} (${this.size} entradas)`);
      }
    }

    // Deduplica por URL directa (el mismo stream puede aparecer en varias páginas)
    const seen = new Set();
    this.entries = this.entries.filter((e) => {
      const k = e.directUrl || e.pageUrl;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return this;
  }

  /** Entradas del catálogo que corresponden al canal (mejor puntuadas primero). */
  match(channelTitle, { minScore = 0.75, limit = 12 } = {}) {
    const scored = [];
    for (const e of this.entries) {
      const names = [e.name, e.event].filter(Boolean);
      let best = 0;
      for (const n of names) best = Math.max(best, nameScore(channelTitle, n));
      if (best >= minScore) scored.push({ entry: e, score: best });
    }
    return scored
      .sort((a, b) => b.score - a.score || (b.entry.directUrl ? 1 : 0) - (a.entry.directUrl ? 1 : 0))
      .slice(0, limit);
  }

  /** Entradas cuyo enlace real apunta a un slug concreto (útil como respaldo). */
  matchSlug(slug, { limit = 6 } = {}) {
    const s = normSlug(slug);
    if (!s) return [];
    return this.entries
      .filter((e) => e.directUrl && normSlug(e.directUrl).includes(s))
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0.6 }));
  }

  /**
   * Convierte una entrada del catálogo en URLs concretas verificables:
   * primero el enlace directo conocido y luego lo que haya en su página
   * (que suele traer un espejo más fresco).
   */
  async resolve(entry, { maxPages = 1, timeoutMs = 12000, userAgent, headers, ownHosts = [] } = {}) {
    const cacheKey = entry.pageUrl || entry.directUrl || "";
    if (this._resolved.has(cacheKey)) return this._resolved.get(cacheKey);
    const out = [];
    const push = (url, source) => {
      if (!url || out.some((o) => o.url === url)) return;
      out.push({ url, source });
    };

    if (entry.directUrl) push(entry.directUrl, `agenda:${entry.site || "futbollibre"}`);
    if (entry.pageUrl && maxPages > 0) {
      const res = await this.http(entry.pageUrl, { timeoutMs, userAgent, headers });
      this.pagesFetched++;
      if (res.netOk && res.status < 400) {
        const links = playerLinksFromHtml(res.body, res.finalUrl || entry.pageUrl, { ownHosts, limit: 8 });
        for (const l of links) push(l.url, `agenda:${entry.site || "futbollibre"} (${l.kind})`);
      }
    }
    this._resolved.set(cacheKey, out);
    return out;
  }
}

/** Normaliza un dominio dado por el usuario o encontrado en una búsqueda. */
export function toOrigin(value) {
  if (!value) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Igual que toOrigin pero conservando la ruta base (útil si el sitio vive en
 * un subdirectorio, p.ej. https://midominio.com/futbol).
 */
export function toBase(value) {
  if (!value) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

/** Dominio que parece de la familia futbollibre (para filtrar resultados de búsqueda). */
export function looksLikeFutbolibre(url, pattern) {
  const host = hostOf(url);
  if (!host) return false;
  if (pattern) {
    try { if (new RegExp(pattern, "i").test(host)) return true; } catch { /* ignore */ }
  }
  return /futbol|pelota|agenda|rojadirecta|tarjeta/i.test(host);
}

export { decodeBase64Maybe, stripTags, urlJoin };
