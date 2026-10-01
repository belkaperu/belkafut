/**
 * lib/util.mjs — utilidades compartidas por verify-urls.mjs y update-canales.mjs.
 * Sin dependencias externas (Node 20+).
 */

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

export const COLORS = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", blue: "\x1b[36m", gray: "\x1b[90m",
};

export function makeLogger(name) {
  const state = { verbose: false };
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (c, s) => (useColor ? `${c}${s}${COLORS.reset}` : s);
  const tag = `[${name}]`;
  return {
    paint,
    setVerbose(v) { state.verbose = !!v; },
    log: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, paint(COLORS.yellow, "!"), ...a),
    err: (...a) => console.error(tag, paint(COLORS.red, "x"), ...a),
    vlog: (...a) => { if (state.verbose) console.log(paint(COLORS.gray, `${tag} debug`), ...a); },
  };
}

/* ------------------------------------------------------------------ *
 * Varios
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
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

export const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mapLimit(items, limit, fn) {
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

/* ------------------------------------------------------------------ *
 * Texto y slugs
 * ------------------------------------------------------------------ */

export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function normSlug(s) {
  return normalizeText(s).replace(/[^a-z0-9]+/g, "");
}

const STOP_TOKENS = new Set([
  "hd", "fhd", "uhd", "sd", "4k", "full", "en", "vivo", "online", "tv",
  "canal", "canales", "channel", "stream", "streaming", "lat", "latam",
  "hd2", "hd3", "hq", "opcion", "el", "la", "los", "las", "de", "del", "y",
]);

export function tokens(s) {
  return normalizeText(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOP_TOKENS.has(t));
}

export function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ");
}

export function cleanAnchorText(html) {
  return stripTags(html)
    .replace(/\\+/g, " ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

export function visibleText(html) {
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

export function urlJoin(base, href) {
  try {
    let h = String(href || "").trim().replace(/&amp;/g, "&");
    if (!h || h.startsWith("#") || h.startsWith("javascript:") || h.startsWith("mailto:")) return null;
    if (h.startsWith("//")) h = `https:${h}`;
    const u = new URL(h, base);
    // Los enlaces del sitio terminan con "#": se descarta el fragmento vacío
    if (u.href.endsWith("#")) return u.href.slice(0, -1);
    return u.toString();
  } catch { return null; }
}

/** Puntúa qué tan bien un slug (de proveedor) representa al título de un canal. */
export function slugScore(title, slug) {
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

/* ------------------------------------------------------------------ *
 * Base64 (los embeds de futbollibre usan ?r=<base64>)
 * ------------------------------------------------------------------ */

const B64_RE = /^[A-Za-z0-9+/_=-]{16,}$/;

export function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function decodeBase64Detailed(s) {
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

export function decodeBase64Maybe(s) {
  return decodeBase64Detailed(s)?.text ?? null;
}

export function encodeLike(style, url) {
  if (style === "b64") return Buffer.from(url, "utf8").toString("base64");
  if (style === "b64x2") {
    const b = Buffer.from(url, "utf8").toString("base64");
    return b + b;
  }
  return url;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

export function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url);
}

/** Limita la concurrencia por host y deja un respiro entre peticiones. */
export class HostGate {
  constructor(perHost, delayMs) {
    this.perHost = Math.max(1, perHost || 1);
    this.delayMs = delayMs || 0;
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

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * GET con timeout, límite de bytes y señal de aborto.
 * Devuelve siempre un objeto (nunca lanza).
 */
export async function httpGet(url, {
  timeoutMs = 12000,
  maxBytes = 200000,
  userAgent = DEFAULT_USER_AGENT,
  headers = {},
  redirect = "follow",
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect,
      signal: ctrl.signal,
      headers: { "User-Agent": userAgent, ...headers },
    });
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
        if (total >= maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } break; }
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    return {
      netOk: true, status: res.status, finalUrl: res.url || url,
      headers: res.headers, body, bytes: Buffer.byteLength(body),
    };
  } catch (e) {
    return {
      netOk: false, status: null,
      code: e?.cause?.code || e?.code || e?.name || "ERROR",
      message: e?.message || String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
