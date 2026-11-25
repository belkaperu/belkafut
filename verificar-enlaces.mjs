#!/usr/bin/env node
/**
 * verificar-enlaces.mjs — Comprueba de verdad los enlaces de data_unificado.json
 * y elimina solo los que no sirven.
 *
 * La diferencia con un chequeo ingenuo: las `options` son envoltorios
 * (`/p/foxrepro1.html?r=…repron.html?r=…repro.html?r=<base64>`), así que
 * comprobar el envoltorio no dice nada. Aquí se desenvuelve hasta el destino
 * real y se comprueba ESE: `https://la18hd.su/vivo/canales.php?stream=espn`.
 *
 * Un enlace se borra solo si:
 *   1. el destino real no responde, y
 *   2. falla en dos pasadas separadas (evita borrar por un corte pasajero), y
 *   3. el canal conserva al menos otro enlace vivo.
 *
 * Nunca se borra por host: un host con 146 enlaces y 11 fallos está vivo.
 *
 * Uso:
 *   node verificar-enlaces.mjs                    # simulación, informe por pantalla
 *   node verificar-enlaces.mjs --apply            # borra los confirmados muertos
 *   node verificar-enlaces.mjs --reporte=r.json   # informe en JSON
 *   node verificar-enlaces.mjs --timeout=10000 --concurrencia=4 --pausa=250
 *   node verificar-enlaces.mjs --solo-options     # comprobar solo las options
 *   node verificar-enlaces.mjs --max-caido=1      # desactivar el tope de caídos
 *   node verificar-enlaces.mjs --sin-canario      # saltar la prueba de conexión
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COLORS as C, makeLogger, parseArgs, num, sleep, hostOf, mapLimit, HostGate } from "./lib/util.mjs";
import { unwrap, isWrapperUrl } from "./lib/desenvolver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const L = makeLogger("enlaces");
L.setVerbose(!!args.verbose);
const { log, warn } = L;
const paint = (c, s) => L.paint(c, s);
const bold = (s) => L.paint(C.blue, s);

const ARCHIVO = path.resolve(String(args.archivo || "data_unificado.json"));
const TIMEOUT = num(args.timeout, 10000);
const CONCURRENCIA = num(args.concurrencia, 4);
const PAUSA = num(args.pausa, 250);
const REINTENTOS = num(args.reintentos, 2);
const PASSES = num(args.pasadas, 2);
const SOLO_OPTIONS = !!args["solo-options"];
const UMBRAL_BYTES = num(args["min-bytes"], 40);
// Salvaguarda: si cae más de esta fracción, es que el entorno no tiene red.
const MAX_CAIDO = num(args["max-caido"], 0.9);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

/* ------------------------------------------------------------------ *
 * Comprobación de una URL
 * ------------------------------------------------------------------ */

/** Códigos que no demuestran que el enlace esté muerto. */
const INCONCLUYENTE = new Set([401, 403, 405, 418, 429, 503, 520, 521, 522, 523, 524]);

/** Marcas de página de error servida con status 200. */
const ERROR_TXT = [
  "not found", "no encontrado", "404", "domain for sale", "dominio en venta",
  "this domain is parked", "account suspended", "cuenta suspendida", "bandwidth exceeded",
  "the requested url was not found", "page not found", "no disponible",
];

/** ¿El cuerpo parece un stream HLS válido o una página de reproductor con vídeo? */
function looksLikeContent(finalUrl, status, body, bytes) {
  const esM3u8 = /\.m3u8(\?|$)/i.test(finalUrl);
  const txt = (body || "").trim();

  if (esM3u8) return /^#EXTM3U/i.test(txt);

  // .ts / segmentos binarios: con bytes basta
  if (/\.(ts|m4s|mp4|mpd)(\?|$)/i.test(finalUrl)) return bytes > 0 && status === 200;

  if (bytes < UMBRAL_BYTES) return false;

  const low = txt.toLowerCase();
  if (ERROR_TXT.some((m) => low.includes(m)) && bytes < 4000) return false;

  // Página de reproductor: debe mencionar vídeo o un iframe
  return /<video|hls\.js|\.m3u8|allowfullscreen|<iframe/i.test(txt) || bytes > 8000;
}

/**
 * Comprueba un destino real.
 * @returns {{ok:boolean, status:number|null, code:string, motivo:string, bytes:number}}
 */
async function comprobar(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });

    const buf = Buffer.from(await res.arrayBuffer());
    const cuerpo = buf.subarray(0, 60000).toString("utf8");

    if (res.status === 200) {
      if (!looksLikeContent(res.url || url, res.status, cuerpo, buf.length)) {
        return { ok: false, status: 200, code: "VACIO", motivo: "responde 200 pero no trae contenido útil", bytes: buf.length };
      }
      return { ok: true, status: 200, code: "OK", motivo: "", bytes: buf.length };
    }

    if (INCONCLUYENTE.has(res.status)) {
      // El panel nos bloquea a nosotros, no está muerto para el navegador.
      return { ok: true, status: res.status, code: "BLOQUEO", motivo: `HTTP ${res.status} (bloqueo, no concluyente)`, bytes: buf.length };
    }

    return { ok: false, status: res.status, code: `HTTP ${res.status}`, motivo: `HTTP ${res.status}`, bytes: buf.length };
  } catch (e) {
    const code = e?.cause?.code || e?.code || (e?.name === "TypeError" ? "SIN_CONEXION" : e?.name) || "ERROR";
    const motivo = code === "ABORT_ERR" || e?.name === "AbortError" ? "timeout" : code;
    return { ok: false, status: null, code, motivo, bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Comprueba con reintentos y espaciado. */
async function comprobarConReintentos(url, gate) {
  const host = hostOf(url) || "desconocido";
  let ultimo = null;
  for (let i = 0; i < REINTENTOS; i += 1) {
    await gate.acquire(host);
    try {
      ultimo = await comprobar(url);
    } finally {
      gate.release(host);
    }
    if (ultimo.ok) return ultimo;
    // Solo insistimos en fallos de red, no en un 404 claro.
    if (ultimo.status && ultimo.status !== 408 && ultimo.status !== 500) return ultimo;
    if (i + 1 < REINTENTOS) await sleep(900 * (i + 1));
  }
  return ultimo;
}

/* ------------------------------------------------------------------ *
 * Programa
 * ------------------------------------------------------------------ */

if (!fs.existsSync(ARCHIVO)) {
  console.error(`No existe ${ARCHIVO}`);
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
const canales = doc.channels || [];

// Recolectar enlaces con su destino real
const items = [];
for (const ch of canales) {
  if (!SOLO_OPTIONS) {
    (ch.servers || []).forEach((s, i) => {
      items.push({ canal: ch.name, tipo: "server", idx: i, original: s.url, final: s.url, layers: 0, selfHosted: false });
    });
  }
  (ch.options || []).forEach((o, i) => {
    const u = unwrap(o.url);
    items.push({
      canal: ch.name, tipo: "option", idx: i,
      original: o.url, final: u.final, layers: u.layers,
      selfHosted: u.selfHosted, unrecognized: u.unrecognized,
    });
  });
}

const porHost = new Map();
for (const it of items) {
  const h = hostOf(it.final) || "sin-host";
  porHost.set(h, (porHost.get(h) || 0) + 1);
}

log(`${bold("Archivo:")} ${path.relative(process.cwd(), ARCHIVO)}`);
log(`${bold("Canales:")} ${canales.length} · ${bold("Enlaces:")} ${items.length}`);
log(`  servers: ${items.filter((i) => i.tipo === "server").length} · options: ${items.filter((i) => i.tipo === "option").length}`);
log(`  con envoltorio: ${items.filter((i) => i.layers > 0).length} · destinos distintos: ${porHost.size}`);
log(`  timeout ${TIMEOUT} ms · concurrencia ${CONCURRENCIA}/host · pausa ${PAUSA} ms · ${PASSES} pasada(s)`);
if (!fs.existsSync("/.dockerenv") && !process.env.CI) {
  warn("Si este entorno no tiene salida a internet, todo saldrá como caído. Ejecútalo en GitHub Actions.");
}
log("");

/* ------------------------------------------------------------------ *
 * Canario: ¿este entorno tiene internet?
 * ------------------------------------------------------------------ */

if (!args["sin-canario"]) {
  const CANARIO = ["https://example.com/", "https://www.google.com/generate_204"];
  let hayRed = false;
  for (const u of CANARIO) {
    // eslint-disable-next-line no-await-in-loop
    const r = await comprobar(u);
    if (r.ok || r.status) { hayRed = true; break; }
  }
  if (!hayRed) {
    console.error(paint(C.red, "\n✘ Sin salida a internet en este entorno."));
    console.error(paint(C.red, "  Todos los enlaces saldrían caídos, así que no se comprueba nada."));
    console.error(paint(C.yellow, "  Ejecútalo en GitHub Actions, o usa --sin-canario si sabes lo que haces."));
    process.exit(2);
  }
  log(`${paint(C.gray, "canario: hay red ✔")}`);
}

const gate = new HostGate(CONCURRENCIA, PAUSA);

// Un solo veredicto por enlace: la última pasada manda.
const veredicto = new Map();
let hechos = 0;

for (let pasada = 1; pasada <= PASSES; pasada += 1) {
  const pendientes = pasada === 1
    ? items
    : items.filter((it) => veredicto.get(it) && !veredicto.get(it).ok);
  if (!pendientes.length) break;

  if (PASSES > 1) log(bold(`\nPasada ${pasada}/${PASSES}: ${pendientes.length} enlace(s)`));
  hechos = 0;
  const totalPasada = pendientes.length;

  await mapLimit(pendientes, Math.max(2, CONCURRENCIA), async (it) => {
    const r = await comprobarConReintentos(it.final, gate);
    veredicto.set(it, { ...r, pasada });
    hechos += 1;
    if (hechos % 50 === 0 || hechos === totalPasada) {
      process.stdout.write(`\r  comprobados ${hechos}/${totalPasada}…`);
    }
  });

  if (pasada < PASSES && pendientes.some((it) => !veredicto.get(it)?.ok)) {
    await sleep(num(args["espera-pasada"], 2000));
  }
}
process.stdout.write("\n");

/* ------------------------------------------------------------------ *
 * Informe
 * ------------------------------------------------------------------ */

const muertos = items.filter((it) => veredicto.get(it) && !veredicto.get(it).ok);
const vivos = items.filter((it) => veredicto.get(it) && veredicto.get(it).ok);
const sinProbar = items.filter((it) => !veredicto.get(it));

for (const it of muertos) {
  const v = veredicto.get(it);
  it.code = v.code;
  it.motivo = v.motivo;
  it.status = v.status;
  it.pasada = v.pasada;
}

// Canales que se quedarían sin nada
const vivosPorCanal = new Map();
for (const it of vivos) {
  if (!vivosPorCanal.has(it.canal)) vivosPorCanal.set(it.canal, 0);
  vivosPorCanal.set(it.canal, vivosPorCanal.get(it.canal) + 1);
}

const quedanVacios = new Set();
for (const it of muertos) {
  if (!vivosPorCanal.get(it.canal)) quedanVacios.add(it.canal);
}

// Protección: no borrar el último enlace de un canal
const aBorrar = [];
const protegidos = [];
for (const it of muertos) {
  if (quedanVacios.has(it.canal)) {
    protegidos.push(it);
  } else {
    aBorrar.push(it);
  }
}

const porHostFallo = new Map();
for (const it of muertos) {
  const h = hostOf(it.final) || "sin-host";
  if (!porHostFallo.has(h)) porHostFallo.set(h, { fallos: 0, total: porHost.get(h) || 0 });
  porHostFallo.get(h).fallos += 1;
}

const hostsCaidos = [...porHostFallo.entries()]
  .filter(([, v]) => v.total > 0 && v.fallos === v.total)
  .map(([h]) => h)
  .sort();

const hostsParciales = [...porHostFallo.entries()]
  .filter(([, v]) => v.total > 0 && v.fallos > 0 && v.fallos < v.total)
  .sort((a, b) => b[1].fallos - a[1].fallos);

function tabla(titulo, filas, cabecera) {
  if (!filas.length) return;
  log(bold(`\n${titulo}`));
  log(`  ${cabecera}`);
  for (const f of filas) log(`  ${f}`);
}

log("");
log(paint(C.green, `✔ vivos: ${vivos.length}`));
log(paint(C.red, `✘ muertos: ${muertos.length}`));
if (protegidos.length) {
  log(paint(C.yellow, `⚠ protegidos (último enlace del canal): ${protegidos.length}`));
}
log(`  canales que se quedarían vacíos: ${quedanVacios.size}`);
if (sinProbar.length) log(paint(C.yellow, `  sin veredicto (no se tocan): ${sinProbar.length}`));

tabla(
  "FALLOS POR HOST (solo los que fallan en TODOS sus enlaces = host caído)",
  hostsCaidos.slice(0, 40).map((h) => {
    const v = porHostFallo.get(h);
    return `${h.padEnd(40)} ${String(v.fallos).padStart(5)}/${String(v.total).padEnd(5)} ${paint(C.red, "CAÍDO")}`;
  }).concat(
    hostsCaidos.length > 40 ? [`… y ${hostsCaidos.length - 40} hosts más`] : []
  ),
  "host                                     fallos/total"
);

tabla(
  "HOSTS CON FALLOS PARCIALES (estos NO se borran enteros: están vivos)",
  hostsParciales.slice(0, 15).map(([h, v]) => {
    return `${h.padEnd(40)} ${String(v.fallos).padStart(5)}/${String(v.total).padEnd(5)} ${paint(C.yellow, `${Math.round((v.fallos / v.total) * 100)}%`)}`;
  }),
  "host                                     fallos/total"
);

log(bold("\n--- MUESTRA DE FALLOS (primeros 40) ---"));
for (const it of muertos.slice(0, 40)) {
  log(`  ${it.canal} | ${it.tipo} | ${hostOf(it.final)} | ${it.code} | ${it.final.slice(0, 110)}`);
}

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

const informe = {
  generado: new Date().toISOString(),
  archivo: path.basename(ARCHIVO),
  resumen: {
    canales: canales.length,
    enlaces: items.length,
    vivos: vivos.length,
    muertos: muertos.length,
    protegidos: protegidos.length,
    canales_que_quedarian_vacios: quedanVacios.size,
    hosts_caidos: hostsCaidos.length,
  },
  hosts_caidos: hostsCaidos,
  hosts_parciales: Object.fromEntries(hostsParciales),
  fallos: muertos.map((it) => ({
    canal: it.canal, tipo: it.tipo, original: it.original, destino: it.final,
    code: it.code, motivo: it.motivo, protegido: protegidos.includes(it),
  })),
};

if (args.reporte) {
  fs.writeFileSync(path.resolve(String(args.reporte)), JSON.stringify(informe, null, 2));
  log(`\nInforme escrito en ${args.reporte}`);
}

const fraccionCaida = items.length ? muertos.length / items.length : 0;
const sospechoso = fraccionCaida > MAX_CAIDO;

if (sospechoso) {
  log(paint(C.red,
    `\n✘ ${(fraccionCaida * 100).toFixed(0)}% de los enlaces salen caídos (> ${(MAX_CAIDO * 100).toFixed(0)}%).`));
  log(paint(C.red, "  Eso casi siempre significa que este entorno no tiene salida a internet,"));
  log(paint(C.red, "  no que el catálogo esté roto. No se borra nada."));
  log(paint(C.yellow, "  Si de verdad es correcto, repite con --max-caido=1"));
  informe.resumen.abortado_por_sospecha = true;
  if (args.reporte) fs.writeFileSync(path.resolve(String(args.reporte)), JSON.stringify(informe, null, 2));
  process.exit(2);
}

if (!args.apply) {
  log(paint(C.yellow, `\nSimulación. Se borrarían ${aBorrar.length} enlace(s). Usa --apply para aplicarlo.`));
} else if (!aBorrar.length) {
  log("\nNada que borrar.");
} else {
  // Borrar de abajo hacia arriba para no romper índices
  const porCanal = new Map();
  for (const it of aBorrar) {
    if (!porCanal.has(it.canal)) porCanal.set(it.canal, { servers: new Set(), options: new Set() });
    porCanal.get(it.canal)[it.tipo === "server" ? "servers" : "options"].add(it.idx);
  }

  let borrados = 0;
  for (const ch of canales) {
    const idx = porCanal.get(ch.name);
    if (!idx) continue;
    const antesS = (ch.servers || []).length;
    const antesO = (ch.options || []).length;
    ch.servers = (ch.servers || []).filter((_, i) => !idx.servers.has(i));
    ch.options = (ch.options || []).filter((_, i) => !idx.options.has(i));
    borrados += antesS - ch.servers.length + (antesO - ch.options.length);
  }

  fs.writeFileSync(ARCHIVO, `${JSON.stringify(doc, null, 2)}\n`);
  log(paint(C.green, `\n✔ Borrados ${borrados} enlace(s) de ${porCanal.size} canal(es).`));
  log(`  Escrito ${path.basename(ARCHIVO)}`);
  if (protegidos.length) {
    log(paint(C.yellow, `  ${protegidos.length} enlace(s) se conservaron por ser el último del canal.`));
  }
}
