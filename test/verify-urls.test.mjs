/**
 * test/verify-urls.test.mjs
 *
 * Pruebas de verify-urls.mjs contra un servidor HTTP local que simula:
 *   - páginas de reproductor OK
 *   - 404, páginas de error con status 200, dominios parqueados, cuerpos vacíos
 *   - .m3u8 válidos e inválidos
 *   - 403 (bloqueo, no concluyente)
 *   - un buscador web simulado que devuelve enlaces a un reproductor real
 *   - un proveedor simulado (plantillas con {slug})
 *
 * Se ejecuta con:  node test/verify-urls.test.mjs      (o  npm test )
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const REPO = path.join(FIX, "repo");
const OUT = path.join(FIX, "out");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✘ ${msg}\x1b[0m${extra ? `\n      ${extra}` : ""}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ------------------------------------------------------------------ *
 * Servidor simulado
 * ------------------------------------------------------------------ */

const PAD = "Contenido de relleno para superar el mínimo de bytes. ".repeat(4);
const player = (extra = "") => `<!doctype html><html><body><div class="player">${extra}
  <iframe src="/embed/live.php" allowfullscreen></iframe></div>
  <script src="hls.js"></script><p>${PAD}</p></body></html>`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const LIVE_HOST = () => `http://127.0.0.1:${server.address()?.port ?? 0}`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  const send = (code, body, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };

  /* --- Sitio tipo futbollibre (agenda + páginas de canal) --- */
  if (p === "/flibre/") {
    // Portada: agenda del día (embeds con URL real en base64) + tarjetas de canal
    return send(200, `<html><body>
      <h2>Agenda - hoy</h2>
      <a href="${LIVE_HOST()}/flibre/embed/eventos.html?r=${b64(`${LIVE_HOST()}/flibre/stream/1.php?stream=win-sports`)}"><img alt="Ver" src="i.png">Win Sports + | OP2</a>
      <a href="${LIVE_HOST()}/flibre/embed/eventos.html?r=${b64(`${LIVE_HOST()}/flibre/lpg.php?stream=espn`)}"><img alt="Ver" src="i.png">ESPN | HD</a>
      <h2>Canales deportivos</h2>
      <h3>TUDN</h3><p>Señal mexicana</p>
      <a href="${LIVE_HOST()}/flibre/en-vivo/tudn">Ver Canal</a>
      <h3>TUDN 2</h3><p>Señal alterna</p>
      <a href="${LIVE_HOST()}/flibre/en-vivo/tudn-2">Ver Canal</a>
      <h3>ESPN 2</h3><p>Señal 2</p>
      <a href="${LIVE_HOST()}/flibre/en-vivo/espn-2">Ver Canal</a>
      </body></html>`);
  }
  if (p === "/flibre/agenda") {
    return send(200, `<html><body>
      <a href="${LIVE_HOST()}/flibre/embed/eventos.html?r=${b64(`${LIVE_HOST()}/flibre/stream/9.php?stream=win-sports`)}"><img alt="Ver">Win Sports + | OP3</a>
      </body></html>`);
  }
  // Página de canal: aquí vive el reproductor real (los enlaces ya no son base64)
  if (p === "/flibre/en-vivo/tudn") {
    return send(200, `<html><body><div class="player">
      <a href="${LIVE_HOST()}/flibre/stream/tudn.php?stream=tudn#">Reproductor</a>
      <iframe src="${LIVE_HOST()}/flibre/embed/player.php"></iframe>
      </div>${PAD}</body></html>`);
  }
  if (p === "/flibre/en-vivo/espn-2") {
    return send(200, `<html><body><div class="player">
      <a href="${LIVE_HOST()}/flibre/stream/5.php?stream=espn2#">Reproductor</a>
      </div>${PAD}</body></html>`);
  }
  if (p === "/flibre/en-vivo/tudn-2") {
    return send(200, `<html><body><div class="player">
      <a href="${LIVE_HOST()}/flibre/stream/tudn2.php?stream=tudn2#">Reproductor</a>
      </div>${PAD}</body></html>`);
  }
  if (p === "/flibre/stream/tudn2.php") {
    return send(200, player("<video src='z.m3u8'></video>"));
  }
  if (p === "/flibre/stream/tudn.php" || p === "/flibre/stream/5.php" || p === "/flibre/stream/1.php") {
    return send(200, player("<video src='x.m3u8'></video>"));
  }
  // El embed sirve un espejo distinto al del parámetro r=
  if (p === "/flibre/embed/eventos.html") {
    return send(200, player(`<a href="${LIVE_HOST()}/flibre/stream/6.php?stream=win-sports">Reproductor</a>`));
  }
  if (p === "/flibre/embed/player.php") return send(200, player("<video src='y.m3u8'></video>"));

  /* --- Buscador tipo Google (enlaces /url?q=...) --- */
  if (p === "/gsearch") {
    const q = u.searchParams.get("q") || "";
    const results = [];
    if (/futbollibre/i.test(q)) results.push(`${LIVE_HOST()}/flibre/`);
    else results.push(`${LIVE_HOST()}/web/player.php`);
    const html = results
      .map((r) => `<a href="/url?q=${encodeURIComponent(r)}&sa=U&ved=xyz">resultado</a>`)
      .join("\n");
    return send(200, `<html><body><div id="search">${html}</div></body></html>`);
  }

  if (p === "/good/player.php") return send(200, player());
  if (p === "/repron.html") return send(200, player());
  if (p === "/dead/404.php") return send(404, `<html><body>404 Not Found ${PAD}</body></html>`);
  if (p === "/dead/text.php") return send(200, `<html><body><h1>Lo sentimos</h1><p>La página no encontrada ${PAD}</p></body></html>`);
  if (p === "/parked/index.php") return send(200, `<html><body><h1>This domain is for sale</h1><p>${PAD}</p></body></html>`);
  if (p === "/empty/blank.php") return send(200, "hola");
  if (p === "/m3u8/ok.m3u8") return send(200, "#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts\n", "application/vnd.apple.mpegurl");
  if (p === "/m3u8/bad.m3u8") return send(200, "<html><body>404 Not Found</body></html>");
  if (p === "/blocked/secret.php") return send(403, "Forbidden");
  if (p === "/embed/live.php") return send(200, player("<video src='x.m3u8'></video>"));
  if (p === "/web/player.php") return send(200, player("<iframe src='/web/embed.php'></iframe>"));
  if (p === "/web/embed.php") return send(200, player());
  // Página que recibe el stream en base64 (como m3u8player.html?url=...)
  if (p === "/b64player.html") return send(200, player());

  // Proveedor simulado: solo algunos slugs existen
  if (p === "/prov/live1.php") {
    const slug = u.searchParams.get("stream") || "";
    if (["espn", "espn_hd", "tudn", "tudn_hd", "foxsports"].includes(slug)) return send(200, player(`data-slug="${slug}"`));
    return send(404, "no encontrado");
  }

  // Buscador simulado
  if (p === "/search") {
    const q = u.searchParams.get("q") || "";
    const base = `http://127.0.0.1:${server.address()?.port ?? 0}`;
    return send(200, `<html><body>
      <a href="${base}/web/player.php">${q} - ver en vivo</a>
      <a href="https://www.youtube.com/watch?v=x">youtube (debe ignorarse)</a>
      <a href="${base}/search?q=${encodeURIComponent(q)}">mas resultados (mismo host del buscador)</a>
      </body></html>`);
  }

  return send(404, "not found");
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function buildFixtures(port) {
  const P = `http://127.0.0.1:${port}`;
  const wrap = (inner) => `/p/foxrepro1.html?r=${P}/repron.html?r=${inner}`;

  const data = {
    canales: [
      {
        title: "ESPN", image: "", category: "deportes",
        options: [
          { label: "ESPN HD", url: wrap(`${P}/good/player.php?stream=espn`) },
          { label: "ESPN 404", url: wrap(`${P}/dead/404.php`) },
          { label: "ESPN TEXTO", url: wrap(`${P}/dead/text.php`) },
          { label: "ESPN PARQUEADO", url: wrap(`${P}/parked/index.php`) },
          { label: "ESPN VACIO", url: wrap(`${P}/empty/blank.php`) },
        ],
      },
      {
        title: "TUDN",
        options: [
          { label: "TUDN OK", url: wrap(`${P}/good/player.php?stream=tudn`) },
          { label: "TUDN CAIDO", url: wrap(`${P}/dead/404.php`) },
        ],
      },
      {
        title: "CANAL RARO XYZ",
        options: [{ label: "CANAL RARO HD", url: wrap(`${P}/dead/404.php`) }],
      },
      {
        title: "MOVISTAR",
        options: [{ label: "MOVISTAR M3U8", url: `${P}/m3u8/ok.m3u8` }],
      },
      {
        title: "M3U8 MALO",
        options: [{ label: "M3U8 MALO", url: `${P}/m3u8/bad.m3u8` }],
      },
      {
        title: "BLOQUEADO",
        options: [{ label: "BLOQUEADO", url: wrap(`${P}/blocked/secret.php`) }],
      },
      {
        title: "DAZN",
        options: [{ label: "DAZN 1", url: `https://own.test/belkafut/canalplayerid?id=DAZN_1_ES` }],
      },
      {
        title: "PAGINA LOCAL OK",
        options: [{ label: "LOCAL", url: `https://own.test/belkafut/tv.html` }],
      },
      {
        title: "EXTERNO MUERTO",
        options: [{ label: "WRAP EXTERNO", url: `${P}/dead/404.php?r=${P}/good/player.php` }],
      },
      {
        // La página responde bien, pero el m3u8 que lleva en base64 está caído
        title: "B64 PLAYER",
        options: [{
          label: "B64 CAIDO",
          url: `/p/x.html?r=${P}/repron.html?r=${P}/b64player.html?url=${Buffer.from(`${P}/m3u8/bad.m3u8`).toString("base64")}`,
        }],
      },
      {
        // Igual pero el stream viene en un parámetro get= (no encadenable)
        title: "GET PLAYER",
        options: [{
          label: "GET CAIDO",
          url: `${P}/good/player.php?get=${Buffer.from(`${P}/m3u8/bad.m3u8`).toString("base64")}&key=abc`,
        }],
      },
      {
        // Solo se puede arreglar con la agenda (URL real dentro del ?r= en base64)
        title: "WIN SPORTS",
        options: [{ label: "WIN SPORTS HD", url: wrap(`${P}/dead/404.php?stream=winsports`) }],
      },
      {
        // No está en la agenda: lo tiene que resolver un proveedor conocido
        title: "FOX SPORTS",
        options: [{ label: "FOX SPORTS HD", url: wrap(`${P}/dead/404.php?stream=foxsports`) }],
      },
      {
        // Solo se puede arreglar entrando a la página de canal de la agenda
        title: "TUDN 2",
        options: [{ label: "TUDN 2 HD", url: wrap(`${P}/dead/404.php`) }],
      },
    ],
  };

  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  // CRLF a propósito: comprobamos que el formato se conserva
  const text = JSON.stringify(data, null, 2).replace(/\n/g, "\r\n");
  fs.writeFileSync(path.join(REPO, "data1.json"), text);
  fs.writeFileSync(path.join(REPO, "tv.html"), "<html>player</html>");
  fs.writeFileSync(path.join(REPO, "data2.json"), JSON.stringify({
    canales: [
      { title: "ESPN", normalized_name: "espn", servers: [{ name: "1", url: `${P}/good/player.php?stream=espn` }] },
      { title: "TUDN", normalized_name: "tudn", servers: [{ name: "1", url: `${P}/good/player.php?stream=tudn` }] },
    ],
  }, null, 2));

  const sources = {
    targets: { files: ["data1.json"] },
    verification: {
      timeoutMs: 5000, minBodyBytes: 180, retries: 0, concurrency: 8,
      perHostConcurrency: 4, perHostDelayMs: 0,
      ownHosts: ["own.test"], checkOwnHostOverHttp: false,
      deadTextPatterns: ["no encontrada", "this domain is for sale", "404 not found"],
      playerMarkers: ["<iframe", "<video", ".m3u8", "player"],
      strictContent: false,
    },
    providers: [
      { id: "sim", label: "Sim", hosts: ["127.0.0.1"], templates: [`${P}/prov/live1.php?stream={slug}`], kind: "page" },
    ],
    slugAliases: { espn: ["espn", "espn_hd"], tudn: ["tudn"] },
    slugPatterns: ["{base}", "{base}_hd"],
    search: {
      enabled: true, maxQueries: 30, maxResultsPerQuery: 5, maxPagesToInspect: 2,
      maxCandidatesPerQuery: 4, cacheTtlMinutes: 0,
      queryTemplates: ["{title} en vivo"],
      skipHosts: ["youtube.com"],
      engines: [{ name: "mock", kind: "generic-links", url: `${P}/search?q={q}`, allowOwnHost: true }],
    },
    agenda: {
      enabled: true,
      domains: [`${P}/flibre`],
      paths: ["/", "/agenda"],
      apiPaths: [],
      discoverFromSearch: true,
      searchQueries: ["futbollibre agenda"],
      hostPattern: "127\\.0\\.0\\.1",
      maxDomains: 2,
      maxEntriesPerChannel: 4,
      maxPagesPerEntry: 1,
      minNameScore: 0.75,
      cacheTtlMinutes: 0,
    },
    repair: { enabled: true, allowSiblingCopy: true, maxCandidatesPerChannel: 30, minSlugScore: 0.55 },
  };
  fs.writeFileSync(path.join(FIX, "sources.test.json"), JSON.stringify(sources, null, 2));

  // Config para update-canales.mjs (mismo sitio simulado)
  const sourcesCanales = {
    verification: {
      timeoutMs: 5000, concurrency: 6, perHostConcurrency: 4, perHostDelayMs: 0,
      minBodyBytes: 180, deadTextPatterns: ["no encontrada"],
      playerMarkers: ["<iframe", "<video", ".m3u8", "player"],
    },
    search: {
      enabled: true, maxQueries: 5, maxResultsPerQuery: 5, cacheTtlMinutes: 0,
      skipHosts: ["youtube.com"],
      engines: [{ name: "mock", kind: "generic-links", url: `${P}/search?q={q}`, allowOwnHost: true }],
    },
    agenda: {
      domains: [`${P}/flibre`],
      paths: ["/", "/agenda"],
      apiPaths: [],
      discoverFromSearch: true,
      searchQueries: ["futbollibre agenda"],
      hostPattern: "127\\.0\\.0\\.1",
      maxDomains: 2,
      maxPagesPerEntry: 1,
    },
  };
  fs.writeFileSync(path.join(FIX, "sources.canales.test.json"), JSON.stringify(sourcesCanales, null, 2));
  return text;
}

/* ------------------------------------------------------------------ *
 * Ejecución del verificador
 * ------------------------------------------------------------------ */

function runVerifier(extraArgs, env = {}, repoDir = REPO) {
  return new Promise((resolve) => {
    const args = [
      path.join(ROOT, "verify-urls.mjs"),
      `--file=${path.join(repoDir, "data1.json")}`,
      `--sources=${path.join(FIX, "sources.test.json")}`,
      `--cache=${path.join(OUT, "cache.json")}`,
      "--allow-local",
      ...extraArgs,
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (process.env.SHOW_OUT) process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; if (process.env.SHOW_OUT) process.stderr.write(d); });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** Ejecuta update-canales.mjs apuntando al mismo servidor simulado. */
function runCanalesUpdater(extraArgs, repoDir) {
  return new Promise((resolve) => {
    const args = [
      path.join(ROOT, "update-canales.mjs"),
      `--file=${path.join(repoDir, "data1.json")}`,
      `--sources=${path.join(FIX, "sources.canales.test.json")}`,
      ...extraArgs,
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (process.env.SHOW_OUT) process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; if (process.env.SHOW_OUT) process.stderr.write(d); });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/* ------------------------------------------------------------------ *
 * Pruebas
 * ------------------------------------------------------------------ */

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`Servidor simulado en http://127.0.0.1:${port}`);

  const originalText = buildFixtures(port);
  fs.mkdirSync(OUT, { recursive: true });

  /* ---------- A) simulación: solo detecta, no escribe ---------- */
  section("A) Modo simulación (sin --apply)");
  const A = await runVerifier([`--report=${path.join(OUT, "report-a")}`]);
  ok(A.code === 0, "termina con código 0", A.err);
  const repA = readJson(path.join(OUT, "report-a.json"));
  ok(repA.modo === "dry-run", "modo = dry-run");
  ok(fs.readFileSync(path.join(REPO, "data1.json"), "utf8") === originalText, "no modificó data1.json en simulación");

  const det = (canal, opcion) => repA.detalle.find((d) => d.canal === canal && (opcion === undefined || d.opcion === opcion));
  const allOpts = [...repA.detalle];

  ok(!allOpts.some((d) => d.canal === "ESPN" && d.opcion === "ESPN HD"), "ESPN HD (OK) no aparece como problema");
  ok(!allOpts.some((d) => d.canal === "MOVISTAR"), "m3u8 válido no aparece como problema");
  ok(!allOpts.some((d) => d.canal === "PAGINA LOCAL OK"), "página local existente = OK");
  ok(det("ESPN", "ESPN 404")?.motivo.join().includes("404"), "404 detectado por status HTTP");
  ok(det("ESPN", "ESPN TEXTO")?.motivo.join().includes("texto de error"), "página de error con status 200 detectada por contenido");
  ok(det("ESPN", "ESPN PARQUEADO")?.motivo.join().includes("domain is for sale"), "dominio parqueado detectado");
  ok(det("ESPN", "ESPN VACIO")?.motivo.join().includes("vacía"), "respuesta vacía detectada");
  ok(det("M3U8 MALO")?.motivo.join().includes("#EXTM3U"), "m3u8 sin #EXTM3U detectado");
  ok(det("DAZN")?.motivo.join().includes("no existe en el repositorio"), "página local inexistente detectada");
  ok(repA.avisos.some((a) => a.canal === "BLOQUEADO"), "403 queda como aviso (bloqueo), no como caída");
  const ext = det("EXTERNO MUERTO");
  ok(ext && ext.url_muerta?.includes("/dead/404.php"), "detecta capa externa muerta dentro de la cadena");

  /* ---------- B) --apply: repara y escribe ---------- */
  section("B) Modo --apply con reparación");
  const B = await runVerifier(["--apply", "--search", `--report=${path.join(OUT, "report-b")}`]);
  ok(B.code === 0, "termina con código 0", B.err);
  const repB = readJson(path.join(OUT, "report-b.json"));
  const dataAfter = readJson(path.join(REPO, "data1.json"));
  const txtAfter = fs.readFileSync(path.join(REPO, "data1.json"), "utf8");

  ok(repB.modo === "apply", "modo = apply");
  ok(txtAfter.includes("\r\n"), "conserva los saltos de línea CRLF");
  ok(repB.resumen.opciones_caidas >= 8, `detectó las opciones caídas (${repB.resumen.opciones_caidas})`);
  ok(repB.resumen.arregladas >= 8, `arregló opciones (${repB.resumen.arregladas})`);
  ok(repB.duracion_seg >= 0, "reporta duración");

  const fixOf = (canal, opcion) => repB.arreglos.find((a) => a.canal === canal && a.opcion === opcion);
  const espn404 = fixOf("ESPN", "ESPN 404");
  ok(!!espn404, "ESPN 404 fue arreglada");
  ok(espn404?.fuente.startsWith("agenda:"), "se arregló desde la agenda de futbollibre", espn404?.fuente);

  // Canal que no está en la agenda -> debe caer al proveedor conocido
  const fox = fixOf("FOX SPORTS", "FOX SPORTS HD");
  ok(!!fox, "FOX SPORTS (no está en la agenda) se arregló por proveedor");
  ok(fox?.url_nueva.includes("/prov/live1.php?stream=foxsports"), "usó el proveedor con el slug correcto", fox?.url_nueva);
  ok(fox?.fuente.startsWith("proveedor:"), "marca la fuente del arreglo", fox?.fuente);

  const texto = fixOf("ESPN", "ESPN TEXTO");
  ok(!!texto, "página de error (status 200) fue arreglada");

  const raro = fixOf("CANAL RARO XYZ", "CANAL RARO HD");
  ok(!!raro, "canal sin proveedor fue arreglado por búsqueda web");
  ok(raro?.fuente.startsWith("web:"), "el arreglo viene de la búsqueda web", raro?.fuente);
  ok(!!raro && /\/web\/(embed|player)\.php/.test(raro.url_nueva), "extrajo el iframe real de la página encontrada", raro?.url_nueva);

  const tudn = fixOf("TUDN", "TUDN CAIDO");
  ok(!!tudn, "TUDN CAIDO arreglado (proveedor, agenda o hermana)");
  ok(!!tudn && tudn.fuente.startsWith("agenda:"), "la agenda tiene prioridad sobre los proveedores", tudn?.fuente);

  // Agenda: la URL real viene dentro del ?r= en base64 (portada)
  const win = fixOf("WIN SPORTS", "WIN SPORTS HD");
  ok(!!win, "arreglado desde la agenda de futbollibre");
  ok(!!win && /\/flibre\/stream\/1\.php\?stream=win-sports/.test(win.url_nueva), "extrajo la URL real del ?r= en base64", win?.url_nueva);

  // Agenda: página de canal (/en-vivo/<slug>) -> reproductor real
  const tudn2 = fixOf("TUDN 2", "TUDN 2 HD");
  ok(!!tudn2, "arreglado entrando a la página de canal de la agenda");
  ok(!!tudn2 && /\/flibre\/stream\/tudn2\.php/.test(tudn2.url_nueva), "sacó el reproductor real de la página de canal", tudn2?.url_nueva);
  ok(!!tudn2 && !/espn/.test(tudn2.url_nueva), "no confundió TUDN 2 con ESPN 2");

  // La agenda se reporta en el JSON
  ok(repB.agenda?.entradas > 0, `la agenda aportó entradas (${repB.agenda?.entradas})`);
  ok(repB.agenda?.dominios?.length >= 1, "reporta el dominio de futbollibre usado", JSON.stringify(repB.agenda?.dominios));
  ok(repB.agenda?.canales_consultados > 0, "reporta cuántos canales se consultaron en la agenda");

  const externo = fixOf("EXTERNO MUERTO", "WRAP EXTERNO");
  ok(!!externo, "capa externa muerta reemplazada por opción completa");
  ok(externo?.alcance === "opción completa", "reemplaza la opción completa cuando la capa muerta no es la interna", externo?.alcance);

  // La URL interna de una opción arreglada debe conservar el envoltorio
  const espnOpt = dataAfter.canales.find((c) => c.title === "ESPN")?.options.find((o) => o.label === "ESPN 404");
  ok(espnOpt?.url.startsWith("/p/foxrepro1.html?r=") && espnOpt.url.includes("/repron.html?r=http"),
    "conserva la cadena de envoltorios al reemplazar la URL interna", espnOpt?.url);
  const foxOpt = dataAfter.canales.find((c) => c.title === "FOX SPORTS")?.options[0];
  ok(foxOpt?.url.startsWith("/p/foxrepro1.html?r=") && foxOpt.url.includes("/prov/live1.php?stream=foxsports"),
    "conserva el envoltorio al arreglar por proveedor", foxOpt?.url);

  ok(JSON.stringify(dataAfter).length > 0 && dataAfter.canales.length === 14, "el JSON sigue siendo válido y completo");

  // Stream interno en base64: la página responde 200 pero el manifiesto está caído
  const b64fix = fixOf("B64 PLAYER", "B64 CAIDO");
  ok(!!b64fix, "detectó el manifiesto base64 interno caído (página 200)");
  const b64opt = dataAfter.canales.find((c) => c.title === "B64 PLAYER")?.options[0]?.url || "";
  const m = /\?url=([A-Za-z0-9+/=]+)/.exec(b64opt);
  ok(!!m, "conserva el parámetro ?url= del reproductor", b64opt);
  ok(!!m && Buffer.from(m[1], "base64").toString("utf8").startsWith("http"),
    "el reemplazo vuelve a ir codificado en base64", m ? Buffer.from(m[1], "base64").toString("utf8") : "");
  ok(!!m && !Buffer.from(m[1], "base64").toString("utf8").includes("/m3u8/bad.m3u8"),
    "quitó el manifiesto caído");

  const getfix = fixOf("GET PLAYER", "GET CAIDO");
  ok(!!getfix, "detectó el stream caído dentro de un parámetro get=");
  ok(repB.canales_rotos.every((c) => c.estado === "arreglado" || c.estado === "parcial" || c.estado === "roto"), "clasifica canales por estado");
  const daznAfter = repB.detalle.find((d) => d.canal === "DAZN");
  ok(daznAfter?.veredicto === "dead", "DAZN sigue reportado como caído");
  ok(repB.detalle.filter((d) => d.veredicto === "dead" && !d.arreglo).length <= 1, "casi todo lo caído quedó arreglado");

  /* ---------- C) reejecución: idempotencia ---------- */
  section("C) Segunda ejecución (idempotencia)");
  const C1 = await runVerifier(["--apply", "--no-search", `--report=${path.join(OUT, "report-c1")}`]);
  const txt1 = fs.readFileSync(path.join(REPO, "data1.json"), "utf8");
  const C2 = await runVerifier(["--apply", "--no-search", `--report=${path.join(OUT, "report-c2")}`]);
  const txt2 = fs.readFileSync(path.join(REPO, "data1.json"), "utf8");
  ok(C1.code === 0 && C2.code === 0, "ambas corridas terminan bien", C1.err + C2.err);
  ok(txt1 === txt2, "no vuelve a cambiar el archivo (idempotente)");
  const repC2 = readJson(path.join(OUT, "report-c2.json"));
  ok(repC2.resumen.arregladas === 0, `no vuelve a arreglar lo ya arreglado (${repC2.resumen.arregladas})`);

  /* ---------- D) GITHUB_OUTPUT ---------- */
  section("D) Salidas para GitHub Actions");
  const ghOut = path.join(OUT, "gh-output.txt");
  fs.writeFileSync(ghOut, "");
  const D = await runVerifier([`--report=${path.join(OUT, "report-d")}`], { GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: path.join(OUT, "summary.md") });
  ok(D.code === 0, "termina bien con GITHUB_OUTPUT", D.err);
  const gh = fs.readFileSync(ghOut, "utf8");
  ok(/changed=/.test(gh) && /fixed=\d+/.test(gh) && /broken=\d+/.test(gh), "escribe changed/fixed/broken", gh);
  ok(fs.existsSync(path.join(OUT, "summary.md")) && fs.readFileSync(path.join(OUT, "summary.md"), "utf8").includes("Verificación de URLs"),
    "escribe el resumen para el step summary");

  /* ---------- E) cortafuegos: sin internet no se toca nada ---------- */
  section("E) Cortafuegos sin acceso a internet");
  const repoB = path.join(FIX, "repo-breaker");
  fs.rmSync(repoB, { recursive: true, force: true });
  fs.mkdirSync(repoB, { recursive: true });
  const closed = "http://127.0.0.1:9/"; // puerto cerrado -> error de red inmediato
  const dataB = {
    canales: Array.from({ length: 12 }, (_, i) => ({
      title: `CANAL ${i + 1}`,
      options: [{ label: "op", url: `/p/x.html?r=${closed}live.php?stream=canal${i + 1}` }],
    })),
  };
  fs.writeFileSync(path.join(repoB, "data1.json"), JSON.stringify(dataB, null, 2));
  const textB = fs.readFileSync(path.join(repoB, "data1.json"), "utf8");
  const E = await runVerifier(["--apply", "--search", `--report=${path.join(OUT, "report-e")}`], {}, repoB);
  ok(E.code === 3, "sale con código 3 (sin internet)", `exit=${E.code}`);
  const repE = readJson(path.join(OUT, "report-e.json"));
  ok(repE.error === "sin_acceso_a_internet", "el reporte marca sin_acceso_a_internet", repE.error);
  ok(repE.resumen.arregladas === 0, "no propone arreglos sin poder verificar");
  ok(fs.readFileSync(path.join(repoB, "data1.json"), "utf8") === textB, "no modificó el archivo");

  /* ---------- F) update-canales.mjs (workflow de canales) ---------- */
  section("F) Actualizador de canales desde futbollibre");
  const repoU = path.join(FIX, "repo-update");
  fs.rmSync(repoU, { recursive: true, force: true });
  fs.mkdirSync(repoU, { recursive: true });
  const P2 = `http://127.0.0.1:${port}`;
  const dataU = {
    canales: [
      { title: "TUDN", image: "", category: "deportes", options: [{ label: "vieja", url: `${P2}/dead/404.php` }] },
      { title: "WIN SPORTS", image: "", category: "deportes", options: [{ label: "vieja", url: `${P2}/dead/404.php` }] },
      { title: "CANAL SIN AGENDA", image: "", category: "x", options: [{ label: "x", url: `${P2}/good/player.php` }] },
    ],
  };
  const textU = JSON.stringify(dataU, null, 2).replace(/\n/g, "\r\n");
  fs.writeFileSync(path.join(repoU, "data1.json"), textU);

  const U1 = await runCanalesUpdater([`--report=${path.join(OUT, "report-update.json")}`], repoU);
  ok(U1.code === 0, "termina sin error", U1.err);
  ok(fs.readFileSync(path.join(repoU, "data1.json"), "utf8") === textU, "en simulación no escribe");
  const repU = readJson(path.join(OUT, "report-update.json"));
  ok(repU.entradas_catalogo > 0, `leyó el catálogo (${repU.entradas_catalogo} entradas)`, JSON.stringify(repU.dominios));
  ok(repU.opciones_agregadas >= 2, `propuso opciones verificadas (${repU.opciones_agregadas})`);
  ok(repU.urls_verificadas_ok >= 2, "solo propone URLs que verifican");

  const U2 = await runCanalesUpdater(["--apply", `--report=${path.join(OUT, "report-update2.json")}`], repoU);
  ok(U2.code === 0, "aplica sin error", U2.err);
  const afterU = fs.readFileSync(path.join(repoU, "data1.json"), "utf8");
  ok(/\r\n/.test(afterU), "conserva CRLF");
  const docU = JSON.parse(afterU);
  const tudnU = docU.canales.find((c) => c.title === "TUDN");
  ok(tudnU.options.length > 1, "agregó opciones nuevas al canal existente", JSON.stringify(tudnU.options));
  ok(tudnU.options.some((o) => o.url.includes("/flibre/")), "la opción nueva apunta al stream de la agenda");
  ok(tudnU.options[0].label === "vieja", "no toca las opciones existentes");
  const sinAgenda = docU.canales.find((c) => c.title === "CANAL SIN AGENDA");
  ok(sinAgenda.options.length === 1, "no inventa opciones para canales que no están en la agenda");
  // Formato: fuera de las inserciones el archivo debe ser idéntico
  const strippedA = textU.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  const strippedB = afterU.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  ok(strippedB.length > strippedA.length && strippedB.slice(0, 2).join() === strippedA.slice(0, 2).join(),
    "inserta sin reescribir el resto del archivo");

  const U3 = await runCanalesUpdater(["--apply", `--report=${path.join(OUT, "report-update3.json")}`], repoU);
  ok(fs.readFileSync(path.join(repoU, "data1.json"), "utf8") === afterU, "segunda corrida: no duplica ni cambia nada");

  /* ---------- resumen ---------- */
  console.log(`\n\x1b[1mResultado: ${pass} OK, ${fail} fallos\x1b[0m`);
  if (fail) {
    console.log("Fallos:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("Error en las pruebas:", e);
  server.close();
  process.exit(1);
});
