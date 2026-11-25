/**
 * lib/desenvolver.mjs — Desenvuelve las URLs anidadas de data_unificado.json.
 *
 * Las `options` del catálogo no son enlaces directos: son capas de reproductor
 * que hay que atravesar hasta llegar al stream real.
 *
 *   /p/foxrepro1.html?r=<repron.html?r=<repro.html?r=<base64 del m3u8>>>
 *
 * Cada capa se identifica por su parámetro (`r`, `embed`, `u`, `url`) o por ser
 * un base64 suelto en el query (`repro.html?r=aHR0cHM6…`).
 *
 * El resultado es el destino final que de verdad sirve el contenido: el que hay
 * que comprobar para decidir si un enlace sirve o no.
 */

import { isLocalUrl } from "./util.mjs";

/** Parámetros donde los reproductores del sitio esconden el siguiente salto. */
const PARAMS = ["r", "embed", "u", "url", "src", "link", "id"];

/** Páginas del propio sitio que son solo un <iframe> hacia `r`. */
export const WRAPPER_PATHS = ["/p/", "/repro", "/repron", "repro.html", "repron.html"];

const B64_RE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** ¿Parece un trozo en base64 con una URL dentro? */
export function decodeB64Maybe(raw) {
  if (!raw || !B64_RE.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const txt = Buffer.from(padded, "base64").toString("utf8");
    if (/^https?:\/\//i.test(txt) || txt.startsWith("//")) return txt;
  } catch {
    /* no era base64 */
  }
  return null;
}

/**
 * Saca el siguiente salto de una URL de reproductor.
 * Devuelve `null` cuando la URL ya es el destino final.
 */
export function nextHop(rawUrl, base = "https://belkaperu.github.io/belkafut/") {
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl, base);
  } catch {
    return null;
  }

  for (const p of PARAMS) {
    const v = u.searchParams.get(p);
    if (!v) continue;
    const b64 = decodeB64Maybe(v);
    if (b64) return b64;
    if (v !== rawUrl) return v;
  }

  // Query entero en base64: repro.html?r=aHR0cHM6…
  const rawQuery = u.search.replace(/^\?/, "");
  if (rawQuery) {
    const b64 = decodeB64Maybe(rawQuery);
    if (b64) return b64;
  }

  // Rutas tipo /p/xxx.html?<base64> sin nombre de parámetro
  if (/^(?:\/p\/|repro)/i.test(u.pathname) && u.pathname !== u.href) {
    for (const [, v] of u.searchParams) {
      const b64 = decodeB64Maybe(v);
      if (b64) return b64;
      if (/^https?:\/\//i.test(v)) return v;
    }
  }
  return null;
}

/**
 * Desenvuelve una URL hasta su destino real.
 *
 * @returns {{
 *   original: string,        // tal como está en el archivo
 *   final: string,           // destino último a comprobar
 *   hops: string[],          // capas intermedias
 *   layers: number,          // cuántas capas se atravesaron
 *   selfHosted: boolean,     // si todo se queda en belkaperu.github.io
 *   unrecognized: boolean    // si no se pudo sacar nada y no es directa
 * }}
 */
export function unwrap(rawUrl, base = "https://belkaperu.github.io/belkafut/") {
  const hops = [];
  let cur = rawUrl;
  let selfHosted = true;
  let unrecognized = false;

  for (let i = 0; i < 8; i += 1) {
    const nxt = nextHop(cur, base);
    if (!nxt) break;
    const resolved = safeResolve(nxt, base);
    if (resolved === cur) break;
    hops.push(resolved);
    cur = resolved;
  }

  for (const h of [rawUrl, ...hops]) {
    if (!isLocalUrl(h) && !/^https?:\/\/belkaperu\.github\.io\//i.test(h)) selfHosted = false;
  }

  // Si sigue siendo una página del sitio, no hemos llegado al stream.
  if (hops.length === 0 && isWrapperUrl(rawUrl, base)) unrecognized = true;

  return { original: rawUrl, final: cur, hops, layers: hops.length, selfHosted, unrecognized };
}

function safeResolve(v, base) {
  try {
    return new URL(v, base).href;
  } catch {
    return v;
  }
}

/** ¿La URL es una página envoltorio del propio sitio (no un stream)? */
export function isWrapperUrl(rawUrl, base = "https://belkaperu.github.io/belkafut/") {
  if (!rawUrl) return false;
  let u;
  try {
    u = new URL(rawUrl, base);
  } catch {
    return false;
  }
  if (!/belkaperu\.github\.io$/i.test(u.hostname)) {
    // rutas relativas del repo
    if (!rawUrl.startsWith("/")) return false;
  }
  return WRAPPER_PATHS.some((p) => u.pathname.startsWith(p)) || /repron?\.html$/i.test(u.pathname);
}
