/**
 * test/futbollibre-parse.test.mjs
 *
 * Pruebas del parser del catálogo contra **markup real** de futbollibre
 * (capturado del sitio en vivo), sin necesidad de internet.
 *
 * Cubre los detalles que romperían en producción:
 *   - enlaces de la agenda con la URL real en base64 dentro de ?r=
 *   - imágenes con alt "Ver" y texto con barra escapada ("\\Win Sports + | OP2")
 *   - el mismo stream con distinto espejo (1.php en la agenda, 6.php en el embed)
 *   - páginas /en-vivo/<slug> con el reproductor real (tvf90.com)
 *   - payload Strapi estilo agenda.json (embed_name + embed_iframe)
 *   - enlaces de Google (/url?q=...)
 *
 * Ejecutar:  node test/futbollibre-parse.test.mjs
 */

import {
  FutbolibreCatalog, decodeEmbedHref, nameScore, parseCatalogHtml,
  parseStrapiPayload, playerLinksFromHtml,
} from "../lib/futbollibre.mjs";
import { decodeBase64Maybe, visibleText } from "../lib/util.mjs";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✘ ${msg}\x1b[0m${extra ? `\n      ${extra}` : ""}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ------------------------------------------------------------------ *
 * Fragmentos reales del sitio (tal como salen del HTML)
 * ------------------------------------------------------------------ */

const SITE = "https://futbollibrefullhd.org";
// Base64 tal cual aparece en el sitio: 1.php en la agenda
const B64_WIN_1 = "aHR0cHM6Ly90dmY5MC5jb20vMS5waHA/c3RyZWFtPXdpbnNwb3J0czI=";
const B64_WIN_6 = "aHR0cHM6Ly90dmY5MC5jb20vNi5waHA/c3RyZWFtPXdpbnNwb3J0czI=";
const B64_DISNEY = "aHR0cHM6Ly9sYTE0aGQuY29tL3Zpdm8vY2FuYWwucGhwP3N0cmVhbT1kaXNuZXkz";

const AGENDA_HTML = `<!DOCTYPE html><html><head><title>Agenda</title></head><body>
<h1>Agenda - 30 de septiembre de 2026</h1>
<ul>
  <li><span class="hora">21:00</span>
    <img src="https://img.wqxag.com/uploads/colombia_dcf9cc2637.png" alt="Colombia">
    <p>Primera A: Atl&eacute;tico Nacional vs Junior</p>
    <a href="${SITE}/embed/eventos.html?r=${B64_WIN_1}"><img src="https://img.icons8.com/?size=10&amp;id=59862" alt="Ver">\\Win Sports + | OP2</a>
    <a href="${SITE}/embed/eventos.html?r=${B64_WIN_6}"><img src="https://img.icons8.com/?size=10&amp;id=59862" alt="Ver">\\Win Sports + | HD</a>
  </li>
</ul>
</body></html>`;

const HOME_HTML = `<!DOCTYPE html><html><body>
<h2>Canales deportivos en vivo</h2>
<img src="${SITE}/img/logo-canal/espn_2.webp" alt="ESPN 2 en vivo">
<h3>ESPN 2</h3>
<p>F&uacute;tbol internacional y cobertura de diferentes disciplinas deportivas.</p>
<a href="${SITE}/en-vivo/espn-2">Ver Canal</a>
<img src="${SITE}/img/logo-canal/liga_1_max.webp" alt="Liga 1 MAX en vivo">
<h3>Liga 1 MAX</h3>
<p>Partidos, an&aacute;lisis y programaci&oacute;n del f&uacute;tbol peruano.</p>
<a href="${SITE}/en-vivo/liga-1-max">Ver Canal</a>
</body></html>`;

// Página de canal: aquí el enlace ya NO es base64, es el reproductor real
const EN_VIVO_HTML = `<!DOCTYPE html><html><head><title>ESPN en vivo por internet | Futbol Online</title></head><body>
<h1>ESPN 1 en vivo por Internet</h1>
<div id="reproductor">Reproductor</div>
<ul class="options"><li><a href="https://tvf90.com/5.php?stream=espn#">Reproductor</a></li></ul>
<a href="${SITE}/en-vivo/espn-2">ESPN 2</a>
<a href="https://futbollibrefullhd.org/">Inicio</a>
<img src="${SITE}/img/logo-canal/espn_2.webp" alt="ESPN 2 en vivo">
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<p>ESPN, fundada en 1978 por Bill Rasmussen, es una multinacional de entretenimiento deportivo.</p>
</body></html>`;

// Respuesta tipo Strapi (igual que agenda.json del repo)
const STRAPI_JSON = JSON.stringify({
  data: [
    {
      id: 29669,
      attributes: {
        diary_description: "Eurocopa de F\u00fatbol Sala de la UEFA: Croacia vs Espa\u00f1a",
        date_diary: "2026-02-04",
        embeds: {
          data: [
            {
              id: 783,
              attributes: {
                embed_name: "Disney+",
                idioma: "Espa\u00f1ol",
                embed_iframe: `/embed/eventos.html?r=${B64_DISNEY}`,
              },
            },
          ],
        },
      },
    },
  ],
});

/* ------------------------------------------------------------------ *
 * Pruebas
 * ------------------------------------------------------------------ */

console.log("Pruebas del parser con markup real de futbollibre");

section("1) Decodificación de los embeds (?r= en base64)");
{
  const fromAgenda = decodeEmbedHref(`/embed/eventos.html?r=${B64_WIN_1}`, SITE);
  ok(fromAgenda?.url === "https://tvf90.com/1.php?stream=winsports2", "el ?r= de la agenda da la URL real", fromAgenda?.url);
  ok(fromAgenda?.style === "b64", "detecta que venía en base64", fromAgenda?.style);

  const fromEmbed = decodeEmbedHref(`/embed/eventos.html?r=${B64_WIN_6}`, SITE);
  ok(fromEmbed?.url === "https://tvf90.com/6.php?stream=winsports2", "el embed sirve otro espejo (6.php)", fromEmbed?.url);

  const plain = decodeEmbedHref("/embed/eventos.html?get=https://tvf90.com/2.php?stream=x", SITE);
  ok(plain?.url === "https://tvf90.com/2.php?stream=x", "también acepta el parámetro en texto plano", plain?.url);

  ok(decodeBase64Maybe(B64_DISNEY) === "https://la14hd.com/vivo/canal.php?stream=disney3",
    "decodifica los embeds guardados en agenda.json");
}

section("2) Agenda: extracción de enlaces con imágenes y barras escapadas");
{
  const entries = parseCatalogHtml(AGENDA_HTML, `${SITE}/agenda`);
  const win = entries.find((e) => /win sports/i.test(e.name) && /OP2/i.test(e.name));
  ok(entries.length >= 2, `extrajo ${entries.length} entradas del listado`);
  ok(!!win, "encontró la entrada 'Win Sports + | OP2'", JSON.stringify(entries.map((e) => e.name)));
  ok(win?.directUrl === "https://tvf90.com/1.php?stream=winsports2", "con la URL real del stream", win?.directUrl);
  ok(!/^\\/.test(win?.name || "\\") && !/\bVer\b/.test(win?.name || ""), "limpia el nombre (sin \\ y sin el alt 'Ver')", win?.name);
  ok(entries.some((e) => e.directUrl?.includes("6.php")), "conserva el segundo espejo como entrada aparte");
}

section("3) Portada: tarjetas de canal (/en-vivo/<slug>)");
{
  const entries = parseCatalogHtml(HOME_HTML, SITE);
  const espn2 = entries.find((e) => e.kind === "channel" && /espn 2/i.test(e.name));
  ok(entries.filter((e) => e.kind === "channel").length === 2, "detectó las 2 tarjetas de canal",
    JSON.stringify(entries.map((e) => `${e.name}:${e.kind}`)));
  ok(espn2?.pageUrl === `${SITE}/en-vivo/espn-2`, "asocia el <h3> con su enlace 'Ver Canal'", espn2?.pageUrl);
  const liga = entries.find((e) => /liga 1 max/i.test(e.name));
  ok(liga?.pageUrl === `${SITE}/en-vivo/liga-1-max`, "nombre y slug correctos para Liga 1 MAX", liga?.pageUrl);
}

section("4) Página de canal: el reproductor real");
{
  const links = playerLinksFromHtml(EN_VIVO_HTML, `${SITE}/en-vivo/espn-1`);
  ok(links.some((l) => l.url === "https://tvf90.com/5.php?stream=espn"), "extrae el reproductor real (tvf90.com/5.php)",
    JSON.stringify(links.map((l) => l.url)));
  ok(!links.some((l) => l.url.includes("cdn.jsdelivr.net")), "ignora scripts de CDN");
  ok(!links.some((l) => /\.webp$/.test(l.url)), "ignora imágenes");
  ok(!links.some((l) => l.url.startsWith(SITE)), "ignora la navegación interna del propio sitio");
}

section("5) API tipo Strapi (agenda.json)");
{
  const entries = parseStrapiPayload(STRAPI_JSON, SITE);
  ok(entries.length >= 1, `extrajo ${entries.length} entrada(s) del JSON de Strapi`);
  const disney = entries.find((e) => /disney/i.test(e.name));
  ok(!!disney, "encontró el embed de Disney+", JSON.stringify(entries.map((e) => e.name)));
  ok(disney?.directUrl === "https://la14hd.com/vivo/canal.php?stream=disney3", "con la URL real decodificada", disney?.directUrl);
  ok(/Croacia/.test(entries.map((e) => e.event || "").join(" ")), "asocia el partido (diary_description) al embed");
}

section("6) Emparejamiento de nombres con canales reales");
{
  ok(nameScore("WIN SPORTS", "Win Sports + | OP2") >= 0.75, "WIN SPORTS ↔ 'Win Sports + | OP2'");
  ok(nameScore("ESPN", "ESPN | HD") >= 0.75, "ESPN ↔ 'ESPN | HD'");
  ok(nameScore("ESPN", "ESPN 2") === 0, "ESPN ≠ ESPN 2");
  ok(nameScore("ESPN 2", "ESPN 2") === 1, "ESPN 2 ↔ ESPN 2 (exacto)");
  ok(nameScore("FOX SPORTS", "FOX Deportes") === 0, "FOX SPORTS ≠ FOX Deportes");
  ok(nameScore("TUDN", "TUDN MX") >= 0.75, "TUDN ↔ 'TUDN MX' (región como calificador)");
  ok(nameScore("DAZN 1", "DAZN 1 ES") >= 0.75, "DAZN 1 ↔ 'DAZN 1 ES'");
}

section("7) Catálogo completo (resolve) con red simulada");
{
  const pages = {
    [`${SITE}/`]: HOME_HTML,
    [`${SITE}/agenda`]: AGENDA_HTML,
    [`${SITE}/en-vivo/espn-2`]: EN_VIVO_HTML.replace("tvf90.com/5.php?stream=espn", "tvf90.com/9.php?stream=espn2"),
  };
  const catalog = new FutbolibreCatalog({
    log: { log: () => {}, warn: () => {}, vlog: () => {} },
    http: async (url) => pages[url]
      ? { netOk: true, status: 200, finalUrl: url, body: pages[url], bytes: pages[url].length }
      : { netOk: false, status: null, code: "ENOTFOUND" },
  });

  await catalog.build({ domains: [SITE], paths: ["/", "/agenda"], discover: [], maxDomains: 1 });
  ok(catalog.domains[0] === SITE, "elige el dominio que responde", catalog.domains.join(","));
  ok(catalog.size >= 4, `catálogo con ${catalog.size} entradas (portada + agenda)`);

  const matches = catalog.match("ESPN 2");
  const espn2 = matches.find((m) => m.entry.pageUrl?.endsWith("/en-vivo/espn-2"));
  ok(!!espn2, "el canal ESPN 2 se encuentra en el catálogo");
  ok(!matches.some((m) => /liga 1/i.test(m.entry.name)), "no mezcla Liga 1 MAX con ESPN 2");
  ok(!matches.some((m) => /win sports/i.test(m.entry.name)), "no mezcla Win Sports con ESPN 2");

  const resolved = await catalog.resolve(espn2.entry, { maxPages: 1 });
  ok(resolved.some((r) => r.url === "https://tvf90.com/9.php?stream=espn2"),
    "al entrar a la página de canal obtiene el espejo propio del canal",
    JSON.stringify(resolved.map((r) => r.url)));
  ok(resolved.every((r) => !/(youtube|facebook|instagram)/.test(r.url)), "no cuela redes sociales");

  // Una URL de navegación interna no debe aparecer como stream
  const winMatch = catalog.match("WIN SPORTS");
  ok(winMatch.length >= 1, "encuentra WIN SPORTS en la agenda");
  ok(winMatch.every((m) => m.entry.directUrl?.includes("tvf90.com")), "sus URLs apuntan al stream real", JSON.stringify(winMatch.map((m) => m.entry.directUrl)));
}

section("8) Utilidades de texto");
{
  ok(visibleText("<b>Hola</b>\n<script>x=1</script> mundo").trim() === "Hola mundo", "visibleText quita scripts y etiquetas");
}

console.log(`\n\x1b[1mResultado: ${pass} OK, ${fail} fallos\x1b[0m`);
if (fail) {
  console.log("Fallos:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
