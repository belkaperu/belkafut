#!/usr/bin/env node
/**
 * verify-urls.mjs — Verificador y reparador automático de URLs de belkafut.
 *
 * Qué hace:
 *   1. Lee un archivo de canales (por defecto data1.json) y extrae la cadena de
 *      URLs de cada opción: /p/player.html?r=<repron.html?r=<URL real>>
 *   2. Verifica cada URL real por HTTP **y por contenido** (no solo el status):
 *      detecta 404/5xx, dominios caídos, DNS inexistente, páginas de error,
 *      dominios parqueados/en venta, páginas vacías y players sin reproductor.
 *      Los .m3u8 deben empezar con #EXTM3U.
 *   3. Si una URL está caída, busca reemplazo en este orden:
 *        a) el mismo proveedor con variantes del slug (espn -> espn_hd ...)
 *        b) otros proveedores conocidos de sources.json
 *        c) slugs que ya funcionan para ese canal en data1/data2/data.json
 *        d) búsqueda web (DuckDuckGo/Bing) + extracción del iframe/m3u8 real
 *      Solo acepta el reemplazo si la URL nueva pasa la verificación de contenido.
 *   4. Reescribe el archivo conservando el formato (CRLF, indentación) y deja
 *      reportes en JSON y Markdown.
 *
 * Uso:
 *   node verify-urls.mjs                         # simulación (no escribe nada)
 *   node verify-urls.mjs --apply                 # aplica los arreglos
 *   node verify-urls.mjs --apply --search        # idem + búsqueda web
 *   node verify-urls.mjs --only-channel=ESPN --verbose
 *
 * Ver VERIFY-URLS.md para todas las opciones.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";

/* ------------------------------------------------------------------ *
 * Utilidades básicas
 * ------------------------------------------------------------------ */

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", blue: "\x1b[36m", gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s);

let VERBOSE = false;
const log = (...a) => console.log("[verify]", ...a);
const vlog = (...a) => { if (VERBOSE) console.log(paint(C.gray, "[debug]"), ...a); };
const warn = (...a) => console.warn("[verify]", paint(C.yellow, "!"), ...a);
const errlog = (...a) => console.error("[verify]", paint(C.red, "x"), ...a);

function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith("--")) { out._.push(raw); continue; }
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
VERBOSE = !!args.verbose;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normSlug(s) {
  return normalizeText(s).replace(/[^a-z0-9]+/g, "");
}

const STOP_TOKENS = new Set([
  "hd", "fhd", "uhd", "sd", "4k", "full", "en", "vivo", "online", "tv",
  "canal", "canales", "channel", "stream", "streaming", "lat", "latam",
  "hd2", "hd3", "hq", "opcion", "el", "la", "los", "las", "de", "del", "y",
]);

function tokens(s) {
  return normalizeText(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOP_TOKENS.has(t));
}

/* ------------------------------------------------------------------ *
 * Configuración
 * ------------------------------------------------------------------ */

const HARD_DEFAULTS = {
  targets: { files: ["data1.json"], urlKeys: ["url"] },
  verification: {
    timeoutMs: 12000,
    maxBodyBytes: 200000,
    minBodyBytes: 180,
    retries: 1,
    retryDelayMs: 800,
    concurrency: 10,
    perHostConcurrency: 2,
    perHostDelayMs: 250,
    userAgent: "Mozilla/5.0 (compatible; belkafut-url-verifier/1.0)",
    extraHeaders: {},
    blockedStatuses: [401, 403, 429, 451, 503],
    unverifiableHostThreshold: 4,
    ownHosts: [],
    ownHostFallbackToLocalFiles: true,
    checkOwnHostOverHttp: true,
    m3u8MustStartWithExtm3u: true,
    strictContent: false,
    deepStreamVerdict: "dead",
    deadTextPatterns: [],
    playerMarkers: ["<iframe", "<video", ".m3u8", "player", "embed"],
    hostOverrides: {},
  },
  providers: [],
  slugAliases: {},
  slugPatterns: ["{base}"],
  search: {
    enabled: false,
    maxQueries: 25,
    maxResultsPerQuery: 8,
    maxPagesToInspect: 4,
    maxCandidatesPerQuery: 6,
    cacheTtlMinutes: 720,
    queryTemplates: ["{title} en vivo ver online"],
    skipHosts: [],
    engines: [],
  },
  repair: {
    enabled: true,
    allowSiblingCopy: true,
    maxCandidatesPerChannel: 40,
    minSlugScore: 0.55,
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base === "object" && base && typeof extra === "object" && extra) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return extra === undefined ? base : extra;
}

function loadConfig() {
  const sourcesPath = path.resolve(args.sources ? String(args.sources) : path.join(__dirname, "sources.json"));
  let fileCfg = {};
  if (fs.existsSync(sourcesPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
      log(`Config: ${path.relative(process.cwd(), sourcesPath)}`);
    } catch (e) {
      warn(`sources.json inválido (${e.message}); uso los valores por defecto`);
    }
  } else {
    warn(`No se encontró ${sourcesPath}; uso los valores por defecto`);
  }
  const cfg = deepMerge(HARD_DEFAULTS, fileCfg);
  cfg._sourcesPath = sourcesPath;

  // Overrides desde CLI
  if (args["concurrency"]) cfg.verification.concurrency = num(args["concurrency"], cfg.verification.concurrency);
  if (args["timeout"]) cfg.verification.timeoutMs = num(args["timeout"], cfg.verification.timeoutMs);
  if (args["search"] === true) cfg.search.enabled = true;
  if (args["no-search"] === true || args["search"] === "off" || args["search"] === "none") cfg.search.enabled = false;
  if (args["no-repair"] === true) cfg.repair.enabled = false;
  if (args["allow-local"] === true) {
    cfg._allowLocal = true;
  }
  if (args["own-mode"]) cfg._ownMode = String(args["own-mode"]);
  else cfg._ownMode = cfg.verification.checkOwnHostOverHttp ? "auto" : "local";
  if (args["slug-sources"]) cfg._slugSources = String(args["slug-sources"]).split(",").map((s) => s.trim()).filter(Boolean);
  vlog(`verificación: timeout=${cfg.verification.timeoutMs}ms concurrencia=${cfg.verification.concurrency} ownHosts=[${cfg.verification.ownHosts.join(",")}]`);
  vlog(`búsqueda: ${cfg.search.enabled ? "activada" : "desactivada"} (${(cfg.search.engines || []).length} motores) · reparación: ${cfg.repair.enabled ? "activada" : "desactivada"}`);
  return cfg;
}

/* ------------------------------------------------------------------ *
 * HTTP: descarga con límites, reintentos y educación por host
 * ------------------------------------------------------------------ */

class HostGate {
  constructor(perHost, delayMs) {
    this.perHost = perHost;
    this.delayMs = delayMs;
    this.state = new Map();
  }
  async acquire(host) {
    let st = this.state.get(host);
    if (!st) { st = { active: 0, last: 0, queue: [] }; this.state.set(host, st); }
    while (st.active >= this.perHost) {
      await new Promise((res) => st.queue.push(res));
    }
    st.active++;
    const wait = st.last + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    st.last = Date.now();
  }
  release(host) {
    const st = this.state.get(host);
    if (!st) return;
    st.active = Math.max(0, st.active - 1);
    const next = st.queue.shift();
    if (next) next();
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url);
}

async function fetchRaw(url, cfg, { maxBytes, timeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? cfg.verification.timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": cfg.verification.userAgent,
        ...cfg.verification.extraHeaders,
      },
    });
    const limit = maxBytes ?? cfg.verification.maxBodyBytes;
    let body = "";
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= limit) { try { await reader.cancel(); } catch { /* ignore */ } break; }
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    return { netOk: true, status: res.status, finalUrl: res.url || url, headers: res.headers, body, bytes: Buffer.byteLength(body) };
  } catch (e) {
    return { netOk: false, error: e, code: e?.cause?.code || e?.code || e?.name || "ERROR", message: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Clasificación por contenido
 * ------------------------------------------------------------------ */

function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cfgFor(url, cfg) {
  const host = hostOf(url);
  const ov = cfg.verification.hostOverrides?.[host] || {};
  return { ...cfg.verification, ...ov };
}

/**
 * Clasifica una respuesta HTTP.
 * verdict: ok | suspect | dead | blocked
 */
function classify(url, res, cfg) {
  const v = cfgFor(url, cfg);
  const reasons = [];
  const looksM3u8 = /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(res.headers?.get?.("content-type") || "");
  const looksMpd = /\.mpd(\?|$)/i.test(url) || /dash\+xml/i.test(res.headers?.get?.("content-type") || "");

  if (!res.netOk) {
    const code = String(res.code || "");
    const deadCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
      "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "AbortError", "TypeError"];
    const reason = `error de red: ${res.code || res.message || "desconocido"}`;
    if (deadCodes.includes(code)) return { verdict: "dead", code, reasons: [reason], status: null };
    return { verdict: "dead", code: code || "NETWORK", reasons: [reason], status: null };
  }

  const status = res.status;
  if (v.blockedStatuses.includes(status)) {
    return { verdict: "blocked", status, code: `http_${status}`, reasons: [`HTTP ${status} (bloqueo/protección, no concluyente)`] };
  }
  if (status === 404 || status === 410) {
    return { verdict: "dead", status, code: `http_${status}`, reasons: [`HTTP ${status}`] };
  }
  if (status >= 500) {
    return { verdict: "dead", status, code: `http_${status}`, reasons: [`HTTP ${status}`] };
  }
  if (status >= 400) {
    return { verdict: "dead", status, code: `http_${status}`, reasons: [`HTTP ${status}`] };
  }

  const body = res.body || "";
  const bytes = res.bytes ?? Buffer.byteLength(body);

  if (looksM3u8) {
    if (!/^\s*#EXTM3U/i.test(body)) {
      return { verdict: "dead", status, code: "m3u8_sin_extm3u", reasons: ["el .m3u8 no empieza con #EXTM3U"] };
    }
    if (!/#EXTINF|#EXT-X-STREAM-INF/i.test(body)) {
      return { verdict: "suspect", status, code: "m3u8_sin_segmentos", reasons: ["manifiesto sin segmentos"] };
    }
    return { verdict: "ok", status, code: "m3u8_ok", reasons: ["manifiesto m3u8 válido"], bytes };
  }

  if (looksMpd) {
    if (!/<MPD[\s>]/i.test(body)) {
      return { verdict: "dead", status, code: "mpd_invalido", reasons: ["el .mpd no contiene un manifiesto DASH válido"] };
    }
    return { verdict: "ok", status, code: "mpd_ok", reasons: ["manifiesto DASH válido"], bytes };
  }

  if (bytes < v.minBodyBytes) {
    return { verdict: "dead", status, code: "vacio", reasons: [`respuesta vacía o muy corta (${bytes} bytes)`], bytes };
  }

  const text = normalizeText(visibleText(body));
  const hit = v.deadTextPatterns.find((p) => text.includes(normalizeText(p)));
  if (hit) {
    return { verdict: "dead", status, code: "pagina_de_error", reasons: [`texto de error/caída: "${hit}"`], bytes };
  }

  const markers = v.playerMarkers.filter((m) => body.toLowerCase().includes(String(m).toLowerCase()));
  if (markers.length === 0) {
    if (v.strictContent) {
      return { verdict: "dead", status, code: "sin_reproductor", reasons: ["no se detectó reproductor en el contenido"], bytes };
    }
    return { verdict: "suspect", status, code: "sin_reproductor", reasons: ["no se detectó reproductor (revisar)"], bytes };
  }

  return { verdict: "ok", status, code: "ok", reasons: [`contenido OK (${markers.slice(0, 3).join(", ")})`], bytes,
    markers: markers.slice(0, 6) };
}

/* ------------------------------------------------------------------ *
 * Verificación (con caché + límites por host)
 * ------------------------------------------------------------------ */

class Verifier {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();      // url -> resultado
    this.inflight = new Map();   // url -> promesa
    this.gate = new HostGate(cfg.verification.perHostConcurrency, cfg.verification.perHostDelayMs);
    this.stats = { requests: 0, network: 0 };
  }

  async verify(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = this._verifyOnce(url).then((r) => {
      this.cache.set(url, r);
      this.inflight.delete(url);
      return r;
    });
    this.inflight.set(url, p);
    return p;
  }

  async _verifyOnce(url) {
    const cfg = this.cfg;
    if (!cfg._allowLocal && isLocalUrl(url)) {
      return { url, verdict: "skip", code: "local_no_permitido", reasons: ["URL local omitida (usa --allow-local)"], checkedAt: new Date().toISOString() };
    }
    const host = hostOf(url);
    let attempt = 0;
    let res;
    const maxAttempts = 1 + Math.max(0, cfg.verification.retries);
    while (attempt < maxAttempts) {
      attempt++;
      await this.gate.acquire(host);
      try {
        this.stats.requests++;
        res = await fetchRaw(url, cfg);
      } finally {
        this.gate.release(host);
      }
      if (res.netOk && !(res.status >= 500)) break;
      if (attempt < maxAttempts) await sleep(cfg.verification.retryDelayMs * attempt);
    }
    if (!res.netOk) this.stats.network++;
    const cls = classify(url, res, cfg);
    return {
      url,
      verdict: cls.verdict,
      code: cls.code,
      status: cls.status ?? null,
      finalUrl: res.finalUrl,
      reasons: cls.reasons,
      bytes: cls.bytes ?? null,
      checkedAt: new Date().toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Parseo de las cadenas de URLs de las opciones
 * ------------------------------------------------------------------ */

const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
const CHAIN_KEYS = /(?:^|&)(r|embed|url|redirect|src)=/;
const SLUG_PARAM_RE = /[?&](stream|channel|id|canal)=([^&"'\s]+)/i;
const B64_RE = /^[A-Za-z0-9+/_=-]{16,}$/;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Decodifica base64 devolviendo también el "estilo" usado (normal o duplicado). */
function decodeBase64Detailed(s) {
  const clean = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const tryDec = (p) => {
    if (!B64_RE.test(p)) return null;
    const pad = p + "=".repeat((4 - (p.length % 4)) % 4);
    try {
      const dec = Buffer.from(pad, "base64").toString("utf8").trim();
      return /^https?:\/\//i.test(dec) ? dec : null;
    } catch { return null; }
  };
  const whole = tryDec(clean);
  if (whole) return { text: whole, style: "b64" };
  if (clean.length % 2 === 0) {
    const half = tryDec(clean.slice(0, clean.length / 2)); // patrón duplicado: <b64><b64>
    if (half) return { text: half, style: "b64x2" };
  }
  return null;
}

function decodeBase64Maybe(s) {
  return decodeBase64Detailed(s)?.text ?? null;
}

/** Codifica una URL igual que el valor original (para no romper al reproductor). */
function encodeLike(style, url) {
  if (style === "b64") return Buffer.from(url, "utf8").toString("base64");
  if (style === "b64x2") {
    const b = Buffer.from(url, "utf8").toString("base64");
    return b + b;
  }
  return url;
}

/**
 * Descompone la URL de una opción en capas:
 *   /p/x.html?r=https://host/wrap.html?r=https://real/stream.php?stream=espn
 * -> layers: ["/p/x.html", "https://host/wrap.html", "https://real/stream.php?stream=espn"]
 */
function parseChain(rawUrl) {
  const layers = [];
  const prefixes = []; // texto de cada capa hasta incluir la clave de encadenado ("...?r=")
  const encodings = []; // cómo venía codificado el valor: plain | b64 | b64x2
  let cur = String(rawUrl ?? "").trim();
  const seen = new Set();
  for (let i = 0; i < 10 && cur; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    layers.push(cur);
    const q = cur.indexOf("?");
    if (q === -1) break;
    const query = cur.slice(q + 1);
    const m = CHAIN_KEYS.exec(query);
    if (!m) break;
    prefixes.push(cur.slice(0, q + 1) + query.slice(0, m.index + m[0].length));
    let next = safeDecode(query.slice(m.index + m[0].length)).trim();
    let style = "plain";
    if (!/^https?:\/\//i.test(next)) {
      const dec = decodeBase64Detailed(next);
      if (dec) { next = dec.text; style = dec.style; } else break;
    }
    encodings.push(style);
    if (!next || next === cur) break;
    cur = next;
  }
  const absolute = layers.filter((l) => /^https?:\/\//i.test(l));
  const target = absolute.length ? absolute[absolute.length - 1] : null;
  const slugParam = (() => {
    for (const l of [...layers].reverse()) {
      const m = SLUG_PARAM_RE.exec(l);
      if (m) return { key: m[1].toLowerCase(), slug: safeDecode(m[2]) };
    }
    return null;
  })();
  return { raw: rawUrl, layers, prefixes, encodings, absolute, target, slugParam };
}

/**
 * Construye el nuevo valor de una opción conservando los envoltorios que
 * siguen vivos:  /p/x.html?r=repron.html?r=<MUERTA>
 *   - si la capa muerta es la última, solo se cambia esa URL
 *   - si está en medio, se conservan las capas anteriores y se descartan las
 *     que colgaban de la capa muerta
 */
function buildNewOptionValue(chain, deadLayerIndex, newUrl) {
  const layers = chain?.layers || [];
  if (!layers.length) return newUrl;
  const k = deadLayerIndex == null || deadLayerIndex < 0 ? layers.length - 1 : deadLayerIndex;
  if (k <= 0) return newUrl;
  // raw = prefixes[0] + prefixes[1] + ... + prefixes[k-1] + layers[k]
  const prefix = (chain.prefixes || []).slice(0, k).join("");
  if (!prefix) return newUrl;
  // Si el valor iba en base64 (ej. m3u8player.html?url=...), se vuelve a codificar
  const style = chain.encodings?.[k - 1] || "plain";
  return prefix + encodeLike(style, newUrl);
}

/**
 * URLs "escondidas" dentro de una opción: parámetros get/url/src/u/link (en
 * texto o base64) y manifiestos .m3u8/.mpd sueltos. Devuelve también el valor
 * original y su codificación, para poder reemplazarlo sin romper nada.
 */
function deepEntries(str) {
  const out = [];
  for (const m of String(str).matchAll(/([?&])(get|url|src|u|link)=([^&"'\s]+)/gi)) {
    const rawValue = m[3];
    let dec = null;
    if (/^https?:\/\//i.test(rawValue)) dec = { text: safeDecode(rawValue), style: "plain" };
    else dec = decodeBase64Detailed(rawValue);
    if (dec) out.push({ url: dec.text, rawValue, style: dec.style, key: m[2].toLowerCase(), index: m.index });
  }
  for (const m of String(str).matchAll(/https?:\/\/[^\s"'<>\\]*?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi)) {
    const u = m[0];
    if ((u.match(/:\/\//g) || []).length > 1) continue; // era una cadena anidada, no una URL suelta
    out.push({ url: u, rawValue: u, style: "plain", key: null, index: m.index });
  }
  const seen = new Map();
  for (const e of out) if (!seen.has(e.url)) seen.set(e.url, e);
  return [...seen.values()];
}

function deepUrls(str) {
  return deepEntries(str).map((e) => e.url);
}

/* ------------------------------------------------------------------ *
 * Lectura de datos y contexto
 * ------------------------------------------------------------------ */

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function listChannelArrays(doc) {
  if (!doc || typeof doc !== "object") return [];
  if (Array.isArray(doc)) return [doc];
  const out = [];
  for (const key of ["canales", "channels", "lista", "items"]) {
    if (Array.isArray(doc[key])) out.push(doc[key]);
  }
  return out.length ? out : [[]];
}

function collectOptions(doc) {
  const options = [];
  const arrays = listChannelArrays(doc);
  for (const arr of arrays) {
    arr.forEach((ch, ci) => {
      if (!ch || typeof ch !== "object") return;
      const title = ch.title || ch.name || ch.nombre || `canal[${ci}]`;
      const optKey = Array.isArray(ch.options) ? "options" : Array.isArray(ch.servers) ? "servers" : null;
      if (!optKey) return;
      ch[optKey].forEach((o, oi) => {
        if (!o || typeof o !== "object") return;
        const urlKey = ["url", "link", "src"].find((k) => typeof o[k] === "string");
        if (!urlKey) return;
        options.push({
          channelIndex: ci,
          optionIndex: oi,
          channelTitle: title,
          label: o.label || o.name || o.nombre || `opción ${oi + 1}`,
          urlKey,
          rawUrl: o[urlKey],
        });
      });
    });
  }
  return options;
}

/** Índice host -> Map(slug -> veces visto) a partir de los archivos del repo. */
function harvestSlugs(files, extraOptions) {
  const byHost = new Map();
  const byChannelName = new Map();
  const add = (host, slug) => {
    if (!host || !slug) return;
    if (!byHost.has(host)) byHost.set(host, new Map());
    const m = byHost.get(host);
    m.set(slug, (m.get(slug) || 0) + 1);
  };
  const scanString = (s) => {
    for (const m of String(s).matchAll(/(https?:\/\/[^\s"'<>\\]+)/g)) {
      const u = m[1];
      const sm = SLUG_PARAM_RE.exec(u);
      if (sm) add(hostOf(u), safeDecode(sm[2]));
    }
  };
  const walk = (node, channelName) => {
    if (typeof node === "string") { scanString(node); return; }
    if (Array.isArray(node)) { node.forEach((n) => walk(n, channelName)); return; }
    if (node && typeof node === "object") {
      const name = node.title || node.name || node.nombre || channelName;
      if (name && typeof name === "string" && (node.options || node.servers)) {
        const slugs = [];
        for (const o of [...(node.options || []), ...(node.servers || [])]) {
          const u = o?.url || o?.link;
          if (typeof u !== "string") continue;
          const sm = SLUG_PARAM_RE.exec(u);
          if (sm) slugs.push(safeDecode(sm[2]));
        }
        if (slugs.length) {
          const key = normSlug(name);
          if (key) byChannelName.set(key, [...new Set([...(byChannelName.get(key) || []), ...slugs])]);
        }
      }
      for (const v of Object.values(node)) walk(v, name);
    }
  };
  const paths = [...new Set(files)].map((f) => path.resolve(f));
  for (const p of paths) {
    if (!fs.existsSync(p)) { vlog(`slug-sources: no existe ${p}`); continue; }
    const doc = readJsonSafe(p);
    if (!doc) continue;
    walk(doc, null);
    for (const o of collectOptions(doc)) scanString(o.rawUrl);
  }
  for (const o of extraOptions || []) scanString(o.rawUrl);
  return { byHost, byChannelName };
}

/* ------------------------------------------------------------------ *
 * Páginas locales (belkaperu.github.io) cuando no hay red
 * ------------------------------------------------------------------ */

function buildLocalIndex(root) {
  const files = new Set();
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files.add(r);
    }
  };
  walk(root, "");
  return files;
}

function localFileFor(url, index, repoName) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === repoName) parts.shift();
  const p = parts.join("/");
  if (!p) return { path: "", exists: index.has("index.html") };
  const candidates = [p, `${p}.html`, `${p}.htm`, `${p}/index.html`, `${p}/index.htm`];
  for (const c of candidates) if (index.has(c)) return { path: c, exists: true };
  return { path: p, exists: false, tried: candidates };
}

async function verifyLocalPage(url, cfg, ctx, verifier) {
  const u = new URL(url);
  const repoName = u.pathname.split("/").filter(Boolean)[0] || "";
  const mode = cfg._ownMode;
  const local = localFileFor(url, ctx.localIndex, repoName);

  if (mode !== "local" && mode !== "auto") {
    // solo http
  }
  if (mode === "local") {
    return {
      url, verdict: local?.exists ? "ok" : "dead",
      code: local?.exists ? "archivo_local_ok" : "archivo_local_ausente",
      status: null, finalUrl: url,
      reasons: [local?.exists ? `archivo local presente (${local.path})` : `la página no existe en el repositorio (${local?.path})`],
      checkedAt: new Date().toISOString(),
    };
  }
  const http = await verifier.verify(url);
  if (http.verdict === "dead" && http.status === null && cfg.verification.ownHostFallbackToLocalFiles && local) {
    // Sin red hacia GitHub Pages (runner bloqueado): usamos el repo como fuente de verdad.
    return {
      url,
      verdict: local.exists ? "ok" : "dead",
      code: local.exists ? "archivo_local_ok" : "archivo_local_ausente",
      status: null, finalUrl: url,
      reasons: [`sin red hacia GitHub Pages; verificado contra el repositorio (${local.exists ? "existe " + local.path : "no existe " + local.path})`],
      checkedAt: new Date().toISOString(),
    };
  }
  if (http.verdict === "dead" && http.status === 404 && local && !local.exists) {
    http.reasons = [...(http.reasons || []), `y tampoco existe en el repositorio (${local.path})`];
  }
  return http;
}

/* ------------------------------------------------------------------ *
 * Evaluación de una opción
 * ------------------------------------------------------------------ */

const VERDICT_RANK = { dead: 3, blocked: 2, suspect: 2, ok: 1, skip: 0 };

function evaluateOption(rec, cfg, ctx) {
  const chain = parseChain(rec.rawUrl);
  rec.chain = chain;
  rec.checks = [];
  const absolute = chain.absolute;
  const ownHosts = cfg.verification.ownHosts || [];

  if (!absolute.length) {
    rec.verdict = "skip";
    rec.deadUrl = null;
    rec.reasons = ["enlace relativo: no verificable sin el dominio de la app"];
    return rec;
  }

  let worst = "skip";
  let deadUrl = null;
  let deadLayerIndex = null;
  for (const url of absolute) {
    const host = hostOf(url);
    const isOwn = ownHosts.some((h) => host === h || host.endsWith(`.${h}`));
    const res = isOwn ? ctx.ownResults.get(url) : ctx.results.get(url);
    if (!res) continue;
    rec.checks.push(res);
    const rank = VERDICT_RANK[res.verdict] ?? 0;
    if (rank > (VERDICT_RANK[worst] ?? 0)) {
      worst = res.verdict;
      deadUrl = url;
      deadLayerIndex = chain.layers.indexOf(url);
    }
  }
  // Manifiestos internos (m3u8/mpd escondidos en params url= / get=):
  // una página puede responder 200 y aun así no tener stream detrás.
  rec.deepChecks = [];
  for (const e of deepEntries(rec.rawUrl)) {
    if (absolute.includes(e.url)) continue;
    const r = ctx.results.get(e.url);
    if (r) rec.deepChecks.push({ ...r, entry: e });
  }
  const deepDead = rec.deepChecks.filter((c) => c.verdict === "dead");
  if (deepDead.length && VERDICT_RANK[worst] <= VERDICT_RANK.suspect &&
      (cfg.verification.deepStreamVerdict ?? "dead") === "dead") {
    worst = "dead";
    deadUrl = deepDead[0].url;
    deadLayerIndex = chain.layers.indexOf(deadUrl);
    rec.deepCulprit = deepDead[0];
  }

  rec.verdict = worst;
  rec.deadUrl = worst === "dead" ? (deadUrl || absolute[absolute.length - 1]) : null;
  rec.deadLayerIndex = deadLayerIndex;
  const culprit = rec.checks.find((c) => c.url === rec.deadUrl) || rec.checks.find((c) => c.verdict === worst);
  rec.reasons = (culprit?.reasons || []).concat(rec.deepCulprit && culprit !== rec.deepCulprit
    ? [`stream interno: ${rec.deepCulprit.reasons.join("; ")}`] : []);
  rec.detailUrls = deepUrls(rec.rawUrl).filter((u) => !absolute.includes(u));
  return rec;
}

/* ------------------------------------------------------------------ *
 * Búsqueda de reemplazos
 * ------------------------------------------------------------------ */

function slugVariants(title, label, aliasMap, patterns) {
  const out = new Set();
  const base = normSlug(title);
  const key = normalizeText(title);
  const push = (s) => { if (s && String(s).length >= 2) out.add(String(s)); };
  for (const alias of aliasMap?.[key] || []) push(alias);
  for (const alias of aliasMap?.[normSlug(title)] || []) push(alias);
  for (const p of patterns || ["{base}"]) push(p.replace("{base}", base));
  push(base);
  push(normSlug(label));
  // tokens principales: "ESPN MX HD 2" -> "espn", "espnmx"
  const tk = tokens(title);
  if (tk.length) push(tk[0]);
  if (tk.length > 1) push(tk.join(""));
  return [...out];
}

function slugScore(title, slug) {
  const a = normSlug(title), b = normSlug(slug);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) {
    const r = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.6 + 0.35 * r;
  }
  const ta = tokens(title), tb = tokens(slug);
  if (!ta.length || !tb.length) return 0;
  const inter = ta.filter((t) => tb.includes(t)).length;
  return inter / Math.max(ta.length, tb.length);
}

function providerTemplatesFor(host, cfg) {
  return cfg.providers.filter((p) => (p.hosts || []).includes(host));
}

function buildUrlFromTemplate(tpl, slug) {
  return tpl.replace(/\{slug\}/g, encodeURIComponent(slug));
}

/* --- Búsqueda web --- */

function parseSearchResults(html, kind, cfg, engine, baseUrl) {
  const links = [];
  const engineHost = hostOf(baseUrl || engine?.url || "");
  const skip = cfg.search.skipHosts || [];
  const push = (href) => {
    if (!href) return;
    let h = href.trim().replace(/&amp;/g, "&");
    if (h.startsWith("//")) h = `https:${h}`;
    if (!/^https?:/i.test(h)) {
      // enlaces relativos: se resuelven contra el buscador
      try { h = new URL(h, baseUrl).toString(); } catch { return; }
    }
    try {
      const u = new URL(h);
      // DuckDuckGo envuelve en /l/?uddg=<url real>
      const uddg = u.searchParams.get("uddg") || u.searchParams.get("url") || u.searchParams.get("q");
      const real = uddg && /^https?:/i.test(uddg) ? decodeURIComponent(uddg) : u.toString();
      const ru = new URL(real);
      const host = ru.host;
      if (skip.some((s) => host === s || host.endsWith(`.${s}`))) return;
      if (!engine?.allowOwnHost && engineHost && host === engineHost) return;
      if (!/^https?:$/i.test(ru.protocol)) return;
      links.push(ru.toString());
    } catch { /* ignore */ }
  };

  if (kind === "bing") {
    for (const m of html.matchAll(/<h2>\s*<a[^>]+href="([^"]+)"/gi)) push(m[1]);
  } else if (kind === "duckduckgo") {
    for (const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi)) push(m[1]);
  } else {
    for (const m of html.matchAll(/<a[^>]+href="([^"]+)"/gi)) push(m[1]);
  }
  return [...new Set(links)];
}

async function webSearch(query, cfg, cache) {
  const now = Date.now();
  const ttlMin = Number.isFinite(Number(cfg.search.cacheTtlMinutes)) ? Number(cfg.search.cacheTtlMinutes) : 720;
  const ttl = ttlMin * 60000;
  const hit = cache.searches?.[query];
  if (hit && ttl > 0 && now - hit.ts < ttl) {
    vlog(`búsqueda "${query}": ${hit.links.length} resultados en caché`);
    return hit.links;
  }

  const links = [];
  for (const engine of cfg.search.engines || []) {
    const url = engine.url.replace("{q}", encodeURIComponent(query));
    try {
      const res = await fetchRaw(url, cfg, { maxBytes: 300000, timeoutMs: cfg.verification.timeoutMs });
      if (!res.netOk || res.status >= 400) {
        vlog(`búsqueda ${engine.name}: HTTP ${res.status || res.code}`);
        continue;
      }
      const found = parseSearchResults(res.body, engine.kind, cfg, engine, res.finalUrl || url);
      vlog(`búsqueda "${query}" en ${engine.name}: ${found.length} resultados`);
      links.push(...found);
      if (links.length >= (cfg.search.maxResultsPerQuery || 8)) break;
    } catch (e) {
      vlog(`búsqueda ${engine.name} falló: ${e.message}`);
    }
  }
  const uniq = [...new Set(links)].slice(0, cfg.search.maxResultsPerQuery || 8);
  if (!cache.searches) cache.searches = {};
  cache.searches[query] = { ts: now, links: uniq };
  return uniq;
}

/** De una página candidata saca iframes/m3u8/enlaces de player. */
function extractPlayerUrls(html, baseUrl) {
  const out = [];
  const push = (raw, kind) => {
    if (!raw) return;
    let u = raw.trim().replace(/&amp;/g, "&");
    if (u.startsWith("//")) u = `https:${u}`;
    try { u = new URL(u, baseUrl).toString(); } catch { return; }
    if (!/^https?:\/\//i.test(u)) return;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)(\?|$)/i.test(u)) return;
    out.push({ url: u, kind });
  };
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) push(m[1], "iframe");
  for (const m of html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)) push(m[1], "video");
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) push(m[1], "source");
  for (const m of html.matchAll(/["'](https?:\/\/[^"']{8,300}\.m3u8[^"']*)["']/gi)) push(m[1], "m3u8");
  for (const m of html.matchAll(/(?:file|source|src)\s*[:=]\s*["']([^"']*\.m3u8[^"']*)["']/gi)) push(m[1], "m3u8");
  for (const m of html.matchAll(/(?:get|url)=([A-Za-z0-9+/_=-]{20,})/g)) {
    const dec = decodeBase64Maybe(m[1]);
    if (dec) push(dec, "b64");
  }
  // dedupe por url, priorizando m3u8
  const prio = { m3u8: 0, b64: 1, video: 2, source: 3, iframe: 4 };
  const seen = new Map();
  for (const o of out) if (!seen.has(o.url)) seen.set(o.url, o);
  return [...seen.values()].sort((a, b) => (prio[a.kind] ?? 9) - (prio[b.kind] ?? 9));
}

class Repairer {
  constructor(cfg, verifier, ctx) {
    this.cfg = cfg;
    this.verifier = verifier;
    this.ctx = ctx;
    this.searchQueries = 0;
    this.attempts = 0;
  }

  /** Verifica una URL candidata y devuelve el resultado si es ok. */
  async tryCandidate(url, source) {
    if (!url) return null;
    if (this.verifier.cache.has(url)) {
      const r = this.verifier.cache.get(url);
      if (r.verdict === "ok") return { url, source, verification: r };
      return null;
    }
    if (this.ctx.unverifiableHosts.has(hostOf(url))) return null;
    this.attempts++;
    const r = await this.verifier.verify(url);
    if (r.verdict === "ok") return { url, source, verification: r };
    return null;
  }

  /** Candidatos por proveedor + slug. */
  providerCandidates(rec, preferHost) {
    const cfg = this.cfg;
    const title = rec.channelTitle;
    const slugs = slugVariants(title, rec.label, cfg.slugAliases, cfg.slugPatterns);
    // slugs ya vistos para ese canal en el repo
    const key = normSlug(title);
    const known = this.ctx.slugIndex.byChannelName.get(key) || [];
    for (const s of known) slugs.push(s);
    // slugs que funcionan en otras opciones del mismo canal
    for (const s of this.ctx.channelSlugs.get(rec.channelIndex) || []) slugs.push(s);

    const scored = [...new Set(slugs)]
      .map((s) => ({ slug: s, score: Math.max(slugScore(title, s), known.includes(s) ? 0.9 : 0) }))
      .filter((s) => s.score >= (cfg.repair.minSlugScore ?? 0.55))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const out = [];
    const providers = preferHost
      ? [...cfg.providers.filter((p) => (p.hosts || []).includes(preferHost)), ...cfg.providers.filter((p) => !(p.hosts || []).includes(preferHost))]
      : cfg.providers;
    for (const p of providers) {
      for (const s of scored) {
        for (const tpl of p.templates || []) {
          out.push({ url: buildUrlFromTemplate(tpl, s.slug), source: `proveedor:${p.id} (${s.slug})`, score: s.score });
        }
      }
    }
    return out;
  }

  /** Búsqueda web + extracción del reproductor real. */
  async searchCandidates(rec) {
    const cfg = this.cfg;
    if (!cfg.search.enabled) return [];
    if (this.searchQueries >= (cfg.search.maxQueries || 0)) return [];
    vlog(`buscando en la web: "${rec.channelTitle}"`);
    const out = [];
    for (const tpl of cfg.search.queryTemplates || []) {
      if (this.searchQueries >= (cfg.search.maxQueries || 0)) break;
      const q = tpl.replace("{title}", rec.channelTitle).replace("{label}", rec.label);
      this.searchQueries++;
      const links = await webSearch(q, cfg, this.ctx.cache);
      let inspected = 0;
      for (const link of links) {
        if (inspected >= (cfg.search.maxPagesToInspect || 4)) break;
        inspected++;
        const res = await fetchRaw(link, cfg, { maxBytes: 260000 });
        if (!res.netOk || res.status >= 400) continue;
        const extracted = extractPlayerUrls(res.body || "", res.finalUrl || link);
        for (const e of extracted.slice(0, cfg.search.maxCandidatesPerQuery || 6)) {
          out.push({ url: e.url, source: `web:${hostOf(res.finalUrl || link)} (${e.kind})` });
        }
        // la propia página puede ser el reproductor
        if (extracted.length === 0) {
          const cls = classify(res.finalUrl || link, res, cfg);
          if (cls.verdict === "ok") out.push({ url: res.finalUrl || link, source: `web:${hostOf(link)} (página)` });
        }
      }
      if (out.length) break;
    }
    return out;
  }

  async repair(rec) {
    const cfg = this.cfg;
    if (!cfg.repair.enabled || !rec.deadUrl) return null;
    const candidates = [];
    const deadHost = hostOf(rec.deadUrl);

    // a) mismo proveedor/host, distintas variantes de slug
    for (const c of this.providerCandidates(rec, deadHost)) {
      if (hostOf(c.url) === deadHost) candidates.push({ ...c, priority: 0 });
      else candidates.push({ ...c, priority: 1 });
    }
    // b) mismo host pero conservando el path original (slug nuevo en la misma ruta)
    try {
      const deadUrl = new URL(rec.deadUrl);
      const originalSlug = rec.chain?.slugParam?.slug;
      const variants = slugVariants(rec.channelTitle, rec.label, cfg.slugAliases, cfg.slugPatterns);
      const keys = originalSlug ? ["stream", "channel", "id", "canal"] : [];
      for (const v of variants.slice(0, 8)) {
        const u = new URL(deadUrl.toString());
        let touched = false;
        for (const k of keys) {
          if (u.searchParams.has(k)) { u.searchParams.set(k, v); touched = true; }
        }
        if (touched) candidates.unshift({ url: u.toString(), source: `mismo host, slug ${v}`, priority: 0 });
      }
    } catch { /* ignore */ }

    // c) copiar una opción hermana que sí funciona
    if (cfg.repair.allowSiblingCopy) {
      for (const s of this.ctx.channelWorkingUrls.get(rec.channelIndex) || []) {
        candidates.push({ url: s, source: "opción hermana del mismo canal", priority: 2 });
      }
    }

    const max = cfg.repair.maxCandidatesPerChannel || 40;
    const seen = new Set();
    // Un candidato solo sirve si cambia de verdad el valor de la opción:
    // si la URL nueva deja la opción igual, no arregla nada.
    const acceptable = (url) => {
      if (!url || url === rec.deadUrl || seen.has(url)) return false;
      seen.add(url);
      return buildNewOptionValue(rec.chain, rec.deadLayerIndex, url) !== rec.rawUrl;
    };

    let tried = 0;
    for (const c of candidates.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))) {
      if (!acceptable(c.url)) continue;
      if (tried++ >= max) break;
      if (this.ctx.unverifiableHosts.has(hostOf(c.url))) continue;
      const ok = await this.tryCandidate(c.url, c.source);
      if (ok) return ok;
    }

    // d) búsqueda web
    const web = await this.searchCandidates(rec);
    for (const c of web.slice(0, cfg.search.maxCandidatesPerQuery || 6)) {
      if (!acceptable(c.url)) continue;
      if (this.ctx.unverifiableHosts.has(hostOf(c.url))) continue;
      const ok = await this.tryCandidate(c.url, c.source);
      if (ok) return ok;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Escritura de arreglos conservando el formato
 * ------------------------------------------------------------------ */

function applyFixesToText(originalText, fixes) {
  const map = new Map();
  for (const f of fixes) {
    const oldLit = JSON.stringify(f.oldValue);
    if (!map.has(oldLit)) map.set(oldLit, JSON.stringify(f.newValue));
  }
  if (!map.size) return { text: originalText, applied: 0, missing: fixes.length };
  const literals = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(literals.map(escapeRe).join("|"), "g");
  let applied = 0;
  const text = originalText.replace(re, (m) => { applied++; return map.get(m) ?? m; });
  return { text, applied, missing: fixes.length - applied };
}

/* ------------------------------------------------------------------ *
 * Reportes
 * ------------------------------------------------------------------ */

function fmtVerdict(v) {
  if (v === "ok") return "✅ OK";
  if (v === "dead") return "❌ CAÍDA";
  if (v === "blocked") return "⚠️ bloqueada";
  if (v === "suspect") return "⚠️ dudosa";
  return "➖ omitida";
}

function buildMarkdown(report) {
  const r = report.resumen;
  const lines = [];
  lines.push(`# Verificación de URLs — ${report.fecha}`);
  lines.push("");
  lines.push(`Archivo: \`${report.archivo}\` · Modo: **${report.modo}** · Duración: ${report.duracion_seg}s`);
  lines.push("");
  lines.push("| Métrica | Valor |");
  lines.push("| --- | --- |");
  lines.push(`| Canales | ${r.canales} |`);
  lines.push(`| Opciones | ${r.opciones} |`);
  lines.push(`| URLs verificadas | ${r.urls_verificadas} |`);
  lines.push(`| Opciones OK | ${r.opciones_ok} |`);
  lines.push(`| Opciones caídas | ${r.opciones_caidas} |`);
  lines.push(`| Arregladas | ${r.arregladas} |`);
  lines.push(`| Sin arreglo | ${r.sin_arreglo} |`);
  lines.push(`| Hosts no verificables desde el runner | ${r.hosts_no_verificables.length} |`);
  lines.push("");

  if (report.arreglos.length) {
    lines.push(`## ✅ Arreglos aplicados (${report.arreglos.length})`);
    lines.push("");
    lines.push("| Canal | Opción | URL nueva | Fuente |");
    lines.push("| --- | --- | --- | --- |");
    for (const a of report.arreglos) {
      lines.push(`| ${a.canal} | ${a.opcion} | \`${a.url_nueva}\` | ${a.fuente} |`);
    }
    lines.push("");
  }

  if (report.canales_rotos.length) {
    lines.push(`## ❌ Canales con opciones caídas (${report.canales_rotos.length})`);
    lines.push("");
    lines.push("| Canal | Opciones | Caídas | Sin arreglo | Estado |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of report.canales_rotos) {
      lines.push(`| ${c.canal} | ${c.opciones} | ${c.caidas} | ${c.sin_arreglo} | ${c.estado} |`);
    }
    lines.push("");
    lines.push("### Detalle de URLs caídas sin arreglo");
    lines.push("");
    for (const d of report.detalle.filter((x) => x.veredicto === "dead" && !x.arreglo)) {
      lines.push(`- **${d.canal}** · ${d.opcion}`);
      lines.push(`  - URL: \`${d.url_muerta || d.url_original}\``);
      lines.push(`  - Motivo: ${d.motivo.join("; ")}`);
    }
    lines.push("");
  }

  if (report.avisos.length) {
    lines.push(`## ⚠️ Avisos (${report.avisos.length})`);
    lines.push("");
    for (const a of report.avisos.slice(0, 60)) {
      lines.push(`- **${a.canal}** · ${a.opcion}: ${a.motivo.join("; ")} — \`${a.url}\``);
    }
    if (report.avisos.length > 60) lines.push(`- … y ${report.avisos.length - 60} más (ver JSON)`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Generado por verify-urls.mjs v${VERSION}_`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  return Promise.all(workers).then(() => out);
}

async function main() {
  const t0 = Date.now();
  const cfg = loadConfig();
  const targetFile = path.resolve(String(args.file || (cfg.targets.files && cfg.targets.files[0]) || "data1.json"));
  const apply = !!args.apply && !args["dry-run"];
  const reportBase = String(args.report || "verificacion-reporte");

  log(paint(C.blue, `verify-urls v${VERSION}`));
  log(`Archivo objetivo: ${path.relative(process.cwd(), targetFile)}`);
  if (!fs.existsSync(targetFile)) {
    errlog(`No existe ${targetFile}`);
    process.exit(2);
  }
  const originalText = fs.readFileSync(targetFile, "utf8");
  const doc = JSON.parse(originalText.replace(/^\uFEFF/, ""));
  let options = collectOptions(doc);

  const onlyChannel = args["only-channel"] ? String(args["only-channel"]).toLowerCase() : null;
  if (onlyChannel) options = options.filter((o) => normalizeText(o.channelTitle).includes(onlyChannel));
  const limit = num(args.limit, 0);
  if (limit > 0) options = options.slice(0, limit);
  log(`Opciones a revisar: ${options.length}`);

  // Índice de slugs (para proponer reemplazos) desde data1/data2/data + my.m3u
  const slugSourceFiles = cfg._slugSources || ["data1.json", "data2.json", "data.json"].map((f) => path.join(path.dirname(targetFile), f));
  const slugIndex = harvestSlugs(slugSourceFiles, []);
  vlog(`slugs por host: ${[...slugIndex.byHost.keys()].length} hosts`);

  const ctx = {
    results: new Map(),
    ownResults: new Map(),
    localIndex: buildLocalIndex(path.dirname(targetFile)),
    slugIndex,
    channelSlugs: new Map(),
    channelWorkingUrls: new Map(),
    unverifiableHosts: new Set(),
    cache: { searches: {} },
    repoName: path.basename(path.dirname(targetFile)) || "belkafut",
  };

  const cachePath = path.resolve(String(args.cache || ".verify-cache.json"));
  if (fs.existsSync(cachePath)) {
    const c = readJsonSafe(cachePath);
    if (c && typeof c === "object") ctx.cache = { searches: {}, ...c };
  }

  const verifier = new Verifier(cfg);

  // 1. Recolectar URLs únicas a verificar
  const chains = options.map((o) => parseChain(o.rawUrl));
  const ownHosts = cfg.verification.ownHosts || [];
  const uniqueUrls = new Set();
  const uniqueOwn = new Set();
  chains.forEach((c) => {
    for (const u of c.absolute) {
      const h = hostOf(u);
      if (ownHosts.some((x) => h === x || h.endsWith(`.${x}`))) uniqueOwn.add(u);
      else uniqueUrls.add(u);
    }
  });
  // Manifiestos internos escondidos en params (url=, get=) o sueltos
  const deepSet = new Set();
  for (const o of options) {
    for (const e of deepEntries(o.rawUrl)) {
      const h = hostOf(e.url);
      if (!h) continue;
      if (ownHosts.some((x) => h === x || h.endsWith(`.${x}`))) continue;
      if (uniqueUrls.has(e.url)) continue;
      deepSet.add(e.url);
    }
  }
  for (const u of deepSet) uniqueUrls.add(u);
  if (deepSet.size) vlog(`manifiestos/streams internos a verificar: ${deepSet.size}`);
  log(`URLs únicas: ${uniqueUrls.size} externas + ${uniqueOwn.size} propias`);

  if (args["list-urls"]) {
    for (const u of [...uniqueUrls].sort()) console.log(u);
    for (const u of [...uniqueOwn].sort()) console.log(u);
    return;
  }

  // 2. Verificar
  log("Verificando…");
  const total = uniqueUrls.size + uniqueOwn.size;
  let done = 0;
  const tick = () => { done++; if (done % 25 === 0 || done === total) log(`  ${done}/${total} URLs`); };

  await mapLimit([...uniqueUrls], cfg.verification.concurrency, async (u) => {
    ctx.results.set(u, await verifier.verify(u)); tick();
  });
  await mapLimit([...uniqueOwn], Math.min(4, cfg.verification.concurrency), async (u) => {
    ctx.ownResults.set(u, await verifyLocalPage(u, cfg, ctx, verifier)); tick();
  });

  // 2b. Cortafuegos: si no hay red, no tocamos nada
  const external = [...ctx.results.values()];
  const netFailures = external.filter((r) => /^error de red/.test((r.reasons || []).join(" "))).length;
  const externalChecked = external.length;
  if (externalChecked >= 8 && netFailures / Math.max(1, externalChecked) > 0.85) {
    errlog(`Sin acceso a internet confiable (${netFailures}/${externalChecked} fallos de red). No se aplica ningún cambio.`);
    fs.writeFileSync(`${reportBase}.json`, JSON.stringify({
      fecha: new Date().toISOString(), modo: apply ? "apply" : "dry-run", archivo: path.relative(process.cwd(), targetFile),
      resumen: { canales: 0, opciones: options.length, urls_verificadas: externalChecked, opciones_ok: 0, opciones_caidas: 0, arregladas: 0, sin_arreglo: 0, hosts_no_verificables: [] },
      arreglos: [], canales_rotos: [], detalle: [], avisos: [],
      error: "sin_acceso_a_internet",
    }, null, 2));
    setGithubOutput({ changed: "false", fixed: "0", broken: "0", unfixed: "0", error: "sin_acceso_a_internet" });
    process.exitCode = 3;
    return;
  }

  // 2c. Hosts no verificables desde el runner (Cloudflare/bloqueos): no se reparan
  const hostStats = new Map();
  for (const r of ctx.results.values()) {
    const h = hostOf(r.url);
    if (!h) continue;
    if (!hostStats.has(h)) hostStats.set(h, { ok: 0, bad: 0, blocked: 0 });
    const s = hostStats.get(h);
    if (r.verdict === "ok") s.ok++;
    else if (r.verdict === "blocked") s.blocked++;
    else if (r.verdict === "dead") s.bad++;
  }
  for (const [h, s] of hostStats) {
    const th = cfg.verification.unverifiableHostThreshold ?? 4;
    if (s.ok === 0 && (s.blocked + s.bad) >= th && s.blocked >= Math.max(1, Math.floor(th / 2))) {
      ctx.unverifiableHosts.add(h);
    }
  }
  if (ctx.unverifiableHosts.size) {
    warn(`Hosts no verificables desde este runner (se reportan, no se reparan): ${[...ctx.unverifiableHosts].join(", ")}`);
  }

  // 3. Evaluar opciones
  const records = options.map((o) => evaluateOption(o, cfg, ctx));
  // Degradar veredictos de hosts no verificables
  for (const rec of records) {
    if (rec.deadUrl && ctx.unverifiableHosts.has(hostOf(rec.deadUrl))) {
      rec.verdict = "blocked";
      rec.reasons = [...rec.reasons, "host no verificable desde el runner"];
      rec.deadUrl = null;
    }
  }

  // Índice de slugs por canal (a partir de opciones OK) y de URLs que funcionan
  for (const rec of records) {
    const u = rec.chain?.absolute || [];
    for (const url of u) {
      const r = ctx.results.get(url) || ctx.ownResults.get(url);
      if (r?.verdict !== "ok") continue;
      const sm = SLUG_PARAM_RE.exec(url);
      if (sm) {
        const set = ctx.channelSlugs.get(rec.channelIndex) || new Set();
        set.add(safeDecode(sm[2]));
        ctx.channelSlugs.set(rec.channelIndex, set);
      }
      if (url === rec.chain.target) {
        const arr = ctx.channelWorkingUrls.get(rec.channelIndex) || [];
        arr.push(url);
        ctx.channelWorkingUrls.set(rec.channelIndex, arr);
      }
    }
  }
  for (const [k, v] of ctx.channelSlugs) ctx.channelSlugs.set(k, [...v]);

  const broken = records.filter((r) => r.verdict === "dead");
  log(`Resultado: ${records.filter((r) => r.verdict === "ok").length} OK · ${broken.length} caídas · ${records.filter((r) => r.verdict === "suspect" || r.verdict === "blocked").length} dudosas/bloqueadas · ${records.filter((r) => r.verdict === "skip").length} omitidas`);

  // 4. Reparar
  const repairer = new Repairer(cfg, verifier, ctx);
  const arreglos = [];
  if (broken.length && cfg.repair.enabled) {
    log(`Buscando reemplazos para ${broken.length} opciones caídas (proveedores${cfg.search.enabled ? " + búsqueda web" : ""} + hermanas)…`);
    await mapLimit(broken, Math.max(1, Math.min(4, Math.floor(cfg.verification.concurrency / 3))), async (rec) => {
      try {
        const fix = await repairer.repair(rec);
        if (fix) {
          rec.fix = fix;
          const isInner = rec.deadLayerIndex == null || rec.deadLayerIndex === rec.chain.layers.length - 1;
          rec.newValue = buildNewOptionValue(rec.chain, rec.deadLayerIndex, fix.url);
          rec.fixScope = isInner ? "url interna" : "opción completa";
          if (rec.newValue === rec.rawUrl) { rec.fix = null; rec.newValue = null; return; }
          arreglos.push({
            canal: rec.channelTitle,
            opcion: rec.label,
            url_vieja: rec.deadUrl,
            url_nueva: fix.url,
            fuente: fix.source,
            alcance: rec.fixScope,
            status: fix.verification.status,
          });
          log(`  ${paint(C.green, "✔")} ${rec.channelTitle} · ${rec.label} → ${fix.url} ${paint(C.gray, `(${fix.source})`)}`);
        } else {
          log(`  ${paint(C.red, "✘")} ${rec.channelTitle} · ${rec.label} sin reemplazo (${rec.reasons.join("; ")})`);
        }
      } catch (e) {
        warn(`reparación falló para ${rec.channelTitle}: ${e.message}`);
      }
    });
  }

  // 5. Aplicar
  const fixes = records.filter((r) => r.fix).map((r) => ({ oldValue: r.rawUrl, newValue: r.newValue }));
  let newText = originalText;
  let appliedCount = 0;
  if (apply && fixes.length) {
    const res = applyFixesToText(originalText, fixes);
    newText = res.text;
    appliedCount = res.applied;
    if (res.missing > 0) warn(`${res.missing} arreglos no se encontraron literalmente en el archivo`);
  }
  const changed = newText !== originalText;
  if (apply && changed) fs.writeFileSync(targetFile, newText);
  if (apply && changed) log(paint(C.green, `Archivo actualizado (${appliedCount} reemplazos).`));
  else if (fixes.length) log(`${fixes.length} arreglos propuestos (simulación; usa --apply para escribir).`);

  // 6. Reportes
  const resumenOpciones = {
    ok: records.filter((r) => r.verdict === "ok").length,
    dead: broken.length,
    arregladas: records.filter((r) => r.fix).length,
    sin_arreglo: broken.filter((r) => !r.fix).length,
  };
  const porCanal = new Map();
  for (const r of records) {
    const k = r.channelIndex;
    if (!porCanal.has(k)) porCanal.set(k, { canal: r.channelTitle, opciones: 0, caidas: 0, sin_arreglo: 0, arregladas: 0 });
    const c = porCanal.get(k);
    c.opciones++;
    if (r.verdict === "dead") {
      c.caidas++;
      if (r.fix) c.arregladas++; else c.sin_arreglo++;
    }
  }
  const canalesRotos = [...porCanal.values()]
    .filter((c) => c.caidas > 0)
    .map((c) => ({ ...c, estado: c.arregladas === c.caidas ? "arreglado" : c.arregladas > 0 ? "parcial" : "roto" }))
    .sort((a, b) => b.sin_arreglo - a.sin_arreglo || b.caidas - a.caidas);

  const report = {
    fecha: new Date().toISOString(),
    version: VERSION,
    modo: apply ? "apply" : "dry-run",
    archivo: path.relative(process.cwd(), targetFile),
    duracion_seg: Math.round((Date.now() - t0) / 100) / 10,
    resumen: {
      canales: new Set(records.map((r) => r.channelIndex)).size,
      opciones: records.length,
      urls_verificadas: ctx.results.size + ctx.ownResults.size,
      opciones_ok: resumenOpciones.ok,
      opciones_caidas: resumenOpciones.dead,
      arregladas: resumenOpciones.arregladas,
      sin_arreglo: resumenOpciones.sin_arreglo,
      hosts_no_verificables: [...ctx.unverifiableHosts],
    },
    arreglos,
    canales_rotos: canalesRotos,
    avisos: records.filter((r) => r.verdict === "suspect" || r.verdict === "blocked").map((r) => ({
      canal: r.channelTitle, opcion: r.label, url: r.deadUrl || r.chain?.target || r.rawUrl, motivo: r.reasons,
    })),
    detalle: records
      .filter((r) => r.verdict !== "ok")
      .map((r) => ({
        canal: r.channelTitle,
        opcion: r.label,
        url_original: r.rawUrl,
        url_muerta: r.deadUrl,
        url_objetivo: r.chain?.target,
        veredicto: r.verdict,
        motivo: r.reasons,
        arreglo: r.fix ? { url: r.fix.url, fuente: r.fix.source, alcance: r.fixScope } : null,
      })),
  };

  const jsonPath = `${reportBase}.json`;
  const mdPath = `${reportBase}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, buildMarkdown(report));

  // caché de búsquedas
  if (Object.keys(ctx.cache.searches || {}).length) {
    try { fs.writeFileSync(cachePath, JSON.stringify(ctx.cache, null, 2)); } catch { /* ignore */ }
  }

  log(`Reportes: ${path.relative(process.cwd(), jsonPath)} · ${path.relative(process.cwd(), mdPath)}`);
  log(`Resumen: ${resumenOpciones.ok} OK / ${resumenOpciones.dead} caídas / ${resumenOpciones.arregladas} arregladas / ${resumenOpciones.sin_arreglo} sin arreglo`);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, buildMarkdown(report));
      fs.appendFileSync(summaryFile, "\n");
    } catch { /* ignore */ }
  }
  setGithubOutput({
    changed: String(changed),
    fixed: String(resumenOpciones.arregladas),
    broken: String(resumenOpciones.dead),
    unfixed: String(resumenOpciones.sin_arreglo),
    report: jsonPath,
  });

  process.exitCode = 0;
}

function setGithubOutput(obj) {
  const out = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  if (out) {
    try { fs.appendFileSync(out, `${lines.join("\n")}\n`); } catch { /* ignore */ }
  }
  for (const l of lines) vlog(`GITHUB_OUTPUT ${l}`);
}

main().catch((e) => {
  errlog("ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
