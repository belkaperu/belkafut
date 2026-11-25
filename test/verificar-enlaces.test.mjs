/**
 * test/verificar-enlaces.test.mjs
 *
 * Pruebas del verificador de enlaces contra un servidor local que simula:
 *   - destino OK, 404, 403 (bloqueo), 200 vacío, dominio parqueado, m3u8 válido,
 *     m3u8 con HTML dentro, puerto cerrado
 *   - options envueltas en 1, 2 y 3 capas (incluida base64)
 *
 * Lo importante que se comprueba: se decide por el DESTINO REAL, no por el
 * envoltorio; un 403 no borra; y nunca se deja un canal sin enlaces.
 *
 * Se ejecuta con:  node test/verificar-enlaces.test.mjs      (o  npm test )
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "verificar-"));

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✔\x1b[0m ${msg}`); } else {
    fail += 1;
    console.log(`  \x1b[31m✘ ${msg}\x1b[0m${extra ? `\n      ${extra}` : ""}`);
  }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ---------------- servidor simulado ---------------- */

const PAD = "x".repeat(600);
let BASE_GLOBAL = "";
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;

  if (p.startsWith("/live")) {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    res.end("#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts\n");
    return;
  }
  if (p.startsWith("/falso-m3u8")) {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    res.end("<html>no soy un m3u8</html>");
    return;
  }
  if (p.startsWith("/pagina-m3u8-roto")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><script>var src="${BASE_GLOBAL}/no-existe/manifiesto.m3u8";</script>
      <video id="v"></video><p>${PAD}</p></body></html>`);
    return;
  }
  if (p.startsWith("/pagina-m3u8-bueno")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><script>var src="${BASE_GLOBAL}/live/manifiesto.m3u8";</script>
      <video id="v"></video><p>${PAD}</p></body></html>`);
    return;
  }
  if (p.startsWith("/sin-video")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><p>Could not play video.</p>
      <p>Error code: hls:networkError_manifestLoadError</p><p>${PAD}</p></body></html>`);
    return;
  }
  if (p.startsWith("/vacio")) {
    res.writeHead(200);
    res.end("");
    return;
  }
  if (p.startsWith("/parqueado")) {
    res.writeHead(200);
    res.end("<h1>This domain is parked</h1> Domain for sale");
    return;
  }
  if (p.startsWith("/bloqueo")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (p.startsWith("/no-existe")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  // reproductor real
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body><video src="/live.m3u8"></video><p>${PAD}</p></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
BASE_GLOBAL = BASE;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/* ---------------- fixture ---------------- */

const canal = (name, servers, options) => ({
  name, title: name, normalized_name: name.toLowerCase(), category: "Deportes",
  imageUrl: null, servers, options,
});
const srv = (url, n = "s") => ({ name: n, url });

const doc = {
  categories: [{ display_name: "Deportes en Vivo", icon: "⚽", name: "Deportes" }],
  channels: [
    // la option de 3 capas debe salvarse: el destino responde
    canal("ESPN", [srv(`${BASE}/ok`)], [
      { label: "ESPN HD", url: `/p/foxrepro1.html?r=https://belkaperu.github.io/belkafut/repron.html?r=https://belkaperu.github.io/belkafut/repro.html?r=${b64(`${BASE}/ok`)}` },
    ]),
    // option a 404, server vivo -> se borra la option
    canal("AXN", [srv(`${BASE}/ok`)], [{ label: "AXN", url: `/p/repro1.html?r=${BASE}/no-existe` }]),
    // único enlace caído -> se protege, el canal no queda vacío
    canal("TNT", [srv(`${BASE}/no-existe`)], []),
    // 403 -> bloqueo, no se borra
    canal("HBO", [srv(`${BASE}/bloqueo`)], []),
    // 200 vacío -> muerto, pero tiene otro vivo
    canal("CNN", [srv(`${BASE}/ok`), srv(`${BASE}/vacio`)], []),
    // dominio parqueado -> muerto
    canal("Discovery", [srv(`${BASE}/ok`), srv(`${BASE}/parqueado`)], []),
    // m3u8 válido vs "m3u8" que en realidad es HTML
    canal("Fox", [srv(`${BASE}/live.m3u8`), srv(`${BASE}/falso-m3u8.m3u8`)], []),
    // puerto cerrado -> muerto
    canal("Star", [srv(`${BASE}/ok`), srv("http://127.0.0.1:9/nada")], []),
    // página 200 cuyo m3u8 no existe -> SIN_VIDEO, se borra
    canal("ESPN2", [srv(`${BASE}/ok`), srv(`${BASE}/pagina-m3u8-roto`)], []),
    // página 200 cuyo m3u8 sí existe -> se conserva
    canal("ESPN3", [srv(`${BASE}/ok`), srv(`${BASE}/pagina-m3u8-bueno`)], []),
    // "Could not play video" con 200 -> SIN_VIDEO, se borra
    canal("TVC", [srv(`${BASE}/ok`), srv(`${BASE}/sin-video`)], []),
  ],
};

const FIXTURE = path.join(TMP, "data.json");
fs.writeFileSync(FIXTURE, JSON.stringify(doc, null, 2));

/* ---------------- ejecutar el verificador ---------------- */

function correr(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "verificar-enlaces.mjs"), `--archivo=${FIXTURE}`, "--sin-canario", ...args], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

section("Desenvolvimiento de URLs");
const { unwrap, nextHop, isWrapperUrl } = await import(path.join(ROOT, "lib/desenvolver.mjs"));

ok(
  unwrap(`/p/foxrepro1.html?r=https://belkaperu.github.io/belkafut/repron.html?r=https://la18hd.su/vivo/canales.php?stream=espn`).final
    === "https://la18hd.su/vivo/canales.php?stream=espn",
  "atraviesa 3 capas hasta la URL real (el ejemplo de la18hd.su)"
);
ok(unwrap(`/p/repro.html?r=${b64("https://streamxhd.com/live1.php?stream=espn")}`).final === "https://streamxhd.com/live1.php?stream=espn",
  "decodifica el base64 del último salto");
ok(unwrap(`${BASE}/live.m3u8`).layers === 0, "una URL directa no se toca");
ok(isWrapperUrl("/p/foxrepro1.html?r=x") && !isWrapperUrl("https://la18hd.su/x.php"), "distingue envoltorio de destino");
ok(nextHop("https://la18hd.su/vivo/canales.php?stream=espn") === null, "el destino final no tiene siguiente salto");

section("Veredicto por destino real (simulación)");
const sim = await correr(["--timeout=4000", "--pausa=20", "--reintentos=2", "--espera-pasada=200"]);
ok(sim.code === 0, "termina sin error", `exit ${sim.code}`);
ok(/vivos: 12/.test(sim.out), "12 enlaces vivos", sim.out.match(/vivos: \d+/)?.[0]);
ok(/muertos: 8/.test(sim.out), "8 enlaces muertos (sin duplicar)", sim.out.match(/muertos: \d+/)?.[0]);
ok(!/pasada 2.*muertos.*12/.test(sim.out), "los fallos no se cuentan dos veces");
ok(/protegidos \(último enlace del canal\): 1/.test(sim.out), "1 protegido por ser el último del canal");
ok(/Simulación\. Se borrarían 7/.test(sim.out), "simulación: borraría 7");
ok(/SIN_VIDEO/.test(sim.out), "distingue 200 con reproductor sin vídeo");
ok(/HTTP 404/.test(sim.out) && /SIN_VIDEO/.test(sim.out) && /SIN_CONEXION/.test(sim.out),
  "distingue 404, 200 sin vídeo y puerto cerrado");
ok(!/HBO \|/.test(sim.out), "un 403 no se marca como muerto");
ok(/127\.0\.0\.1:9\s+1\/1\s+CAÍDO/.test(sim.out), "detecta el host realmente caído");

section("Salvaguarda de entorno sin red");
const sinRed = await new Promise((resolve) => {
  // Canario apuntando a un puerto cerrado: así el caso "sin red" es determinista
  // y no depende de que el runner de CI tenga internet.
  const p = spawn(process.execPath, [path.join(ROOT, "verificar-enlaces.mjs"), `--archivo=${FIXTURE}`, "--timeout=2000", "--canario=http://127.0.0.1:9/"]);
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code, out }));
});
ok(sinRed.code === 2, "aborta con código 2 si no hay internet", `exit ${sinRed.code}`);
ok(/Sin salida a internet/.test(sinRed.out), "lo explica en vez de borrar todo");

section("Aplicar sin romper el esquema");
const rep = path.join(TMP, "reporte.json");
fs.copyFileSync(FIXTURE, path.join(TMP, "antes.json"));
const app = await correr(["--timeout=4000", "--pausa=20", "--reintentos=2", "--espera-pasada=200", "--apply", `--reporte=${rep}`]);
ok(app.code === 0, "termina sin error al aplicar");
ok(/Borrados 7 enlace/.test(app.out), "borra exactamente 7", app.out.match(/Borrados[^\n]*/)?.[0]);

const despues = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
ok(JSON.stringify(Object.keys(despues)) === '["categories","channels"]', "la raíz sigue siendo {categories, channels}");
ok(
  despues.channels.every((c) => JSON.stringify(Object.keys(c)) === '["name","title","normalized_name","category","imageUrl","servers","options"]'),
  "cada canal conserva sus 7 campos, en orden"
);
ok(despues.channels.every((c) => c.servers.every((x) => JSON.stringify(Object.keys(x)) === '["name","url"]')),
  "los servidores siguen siendo {name, url}");
ok(despues.channels.every((c) => c.options.every((x) => JSON.stringify(Object.keys(x)) === '["label","url"]')),
  "las options siguen siendo {label, url}");
ok(despues.channels.every((c) => c.servers.length + c.options.length > 0),
  "ningún canal queda sin enlaces");
ok(despues.channels.find((c) => c.name === "TNT").servers.length === 1, "el protegido conserva su enlace");
ok(despues.channels.find((c) => c.name === "HBO").servers.length === 1, "el 403 conserva su enlace");
ok(despues.channels.find((c) => c.name === "ESPN").options.length === 1, "la option envuelta y viva se conserva");
ok(despues.channels.find((c) => c.name === "AXN").options.length === 0, "la option muerta se borra");
ok(despues.channels.find((c) => c.name === "CNN").servers.length === 1, "se borra el 200 vacío, no el vivo");
ok(despues.channels.find((c) => c.name === "Fox").servers.length === 1, "se borra el falso m3u8 (HTML), no el real");
ok(despues.channels.find((c) => c.name === "ESPN2").servers.length === 1,
  "se borra la página cuyo manifiesto .m3u8 no existe");
ok(despues.channels.find((c) => c.name === "ESPN3").servers.length === 2,
  "se conserva la página cuyo manifiesto .m3u8 sí responde");
ok(despues.channels.find((c) => c.name === "TVC").servers.length === 1,
  "se borra el 200 que dice 'Could not play video'");
ok(fs.existsSync(rep), "escribe el informe en JSON");
const informe = JSON.parse(fs.readFileSync(rep, "utf8"));
ok(informe.resumen.muertos === 8 && informe.resumen.protegidos === 1, "el informe cuadra con la pantalla");
ok(informe.fallos.every((f) => f.canal && f.destino && f.code), "cada fallo dice canal, destino y motivo");

/* ---------------- cierre ---------------- */

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n\x1b[1mResultado:\x1b[0m ${pass} ✔  ${fail ? `\x1b[31m${fail} ✘\x1b[0m` : "0 ✘"}`);
process.exit(fail ? 1 : 0);
