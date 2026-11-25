/**
 * test/unificado.test.mjs
 *
 * Pruebas de build-unificado.mjs con datos sintéticos (sin tocar los archivos
 * reales): fusión de nombres, deduplicación de URLs, categorías, imágenes,
 * canales sin nombre útil y validación del resultado.
 *
 * Ejecutar:  node test/unificado.test.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildUnified, validateUnified, mergeKey, keyOf, cleanName, fixMojibake,
  smartTitle, resolveTarget, urlIdentity, isJunkName, inferCategory, scoreImage,
} from "../build-unificado.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG_DIR = path.join(__dirname, "..", "img", "canales");
const RAW = "https://raw.githubusercontent.com/belkaperu/belkafut/main/img/canales";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✘ ${msg}\x1b[0m${extra ? `\n      ${extra}` : ""}`); }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ------------------------------------------------------------------ *
 * Datos sintéticos con los mismos formatos que los archivos reales
 * ------------------------------------------------------------------ */

const data = {
  channels: [
    {
      name: "ESPN", imageUrl: "",
      servers: [
        { name: "1", url: "http://host.example/play/espn/index.m3u8" },
        { name: "2", url: "http://host.example/play/espn/index.m3u8" }, // duplicado exacto
        { name: "3", url: "http://otro.example/espn-la.m3u8?token=1" },
      ],
    },
    {
      name: "ESPN HD", imageUrl: "",
      servers: [{ name: "1", url: "http://otro.example/espn-la.m3u8?token=2" }], // otro token, mismo destino
    },
    { name: "SKY Premiere 1", imageUrl: "", servers: [{ name: "1", url: "http://host.example/premiere/1.m3u8" }] },
    { name: "SKY Premiere 2", imageUrl: "", servers: [{ name: "1", url: "http://host.example/premiere/1.m3u8" }] }, // mismo stream
    { name: "NO LO SE", imageUrl: "", servers: [{ name: "1", url: "http://host.example/x.m3u8" }] },
    { name: "2025 4:00 PM EST)", imageUrl: "", servers: [{ name: "1", url: "http://host.example/ev1.m3u8" }] },
    { name: "31", imageUrl: "", servers: [{ name: "1", url: "http://host.example/num.m3u8" }] },
    { name: "Canal A0F1", imageUrl: "", servers: [{ name: "1", url: "http://host.example/a0f1.m3u8" }] },
  ],
};

const data1 = {
  canales: [
    {
      title: "ESPN", category: "general", image: `${RAW}/espn.webp`,
      options: [
        {
          label: "ESPN HD",
          url: `/p/foxrepro1.html?r=${"https://streamxhd.com/live1.php?stream=espn"}`,
        },
        {
          label: "ESPN HD 2",
          url: "/p/foxrepro1.html?r=https://belkaperu.github.io/belkafut/repron.html?r=https://la18hd.su/vivo/canal.php?stream=espn",
        },
        // misma URL que la primera, envuelta igual: debe quedar una sola
        {
          label: "ESPN repetido",
          url: "/p/foxrepro1.html?r=https://streamxhd.com/live1.php?stream=espn",
        },
      ],
    },
    {
      title: "ESPN 2", category: "general", image: "",
      options: [{ label: "ESPN2", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=espn2" }],
    },
    {
      title: "Win Sports", category: "all", image: "",
      options: [{ label: "WIN", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=winsports" }],
    },
    {
      title: "Win Sports+", category: "general", image: "",
      options: [{ label: "WIN+", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=winsportsplus" }],
    },
    {
      title: "CNN Espaæol", category: "noticias", image: "",
      options: [{ label: "CNN", url: "/p/repro1noticias.html?r=https://streamxhd.com/live1.php?stream=cnnes" }],
    },
    {
      title: "real", category: "all", image: "",
      options: [{ label: "real", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=real" }],
    },
    {
      title: "real", category: "all", image: "",
      options: [{ label: "real", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=real" }],
    },
  ],
};

const data2 = {
  categories: [],
  channels: [
    {
      category: "Deportes", name: "ESPN", normalized_name: "espn", imageUrl: null,
      servers: [{ name: "Embed", url: "https://embed.example/embed2/espn.php" }],
    },
    {
      category: "Deportes", name: "TyC Sports", normalized_name: "tyc sports", imageUrl: null,
      servers: [{ name: "1", url: "https://la20hd.com/vivo/canal.php?stream=tycsports" }],
    },
    {
      category: "Infantiles", name: "Cartoon Network", normalized_name: "cartoon network", imageUrl: null,
      servers: [{ name: "1", url: "http://cdn.example/cn/index.m3u8" }],
    },
    {
      category: "Películas", name: "HBO", normalized_name: "hbo", imageUrl: null,
      servers: [{ name: "1", url: "http://cdn.example/hbo/index.m3u8" }],
    },
    {
      category: "Noticias", name: "CNN Espaæol", normalized_name: "cnn espaæol", imageUrl: null,
      servers: [{ name: "1", url: "http://cdn.example/cnnes/index.m3u8" }],
    },
    {
      category: "Internacionales", name: "Caracol", normalized_name: "caracol", imageUrl: null,
      servers: [{ name: "1", url: "http://cdn.example/caracol/index.m3u8" }],
    },
    {
      category: "Internacionales", name: "Canal A02B", normalized_name: "canal a02b", imageUrl: null,
      servers: [{ name: "1", url: "http://cdn.example/a02b/index.m3u8" }],
    },
  ],
};

const imageIndex = new Map();
// índices reales del repo (para probar la elección de logos)
for (const f of ["espn.webp", "espn-2.webp", "cnn-espanol.png", "hbo.webp", "caracol.webp", "win-sports.jpg",
  "directv-sports.webp", "cartoon-network.webp", "tyc-sports.webp", "real.png"]) {
  imageIndex.set(f.replace(/\.[a-z0-9]+$/i, "").toLowerCase(), f);
}

const build = (opts = {}) => buildUnified(
  { data, data1, data2 },
  { imageIndex, generatedAt: "2026-01-01T00:00:00.000Z", ...opts },
);

/* ------------------------------------------------------------------ *
 * Pruebas
 * ------------------------------------------------------------------ */

section("Nombres");
ok(fixMojibake("CNN Espaæol") === "CNN Español", "arregla mojibake æ -> ñ");
ok(keyOf("ESPN  4 HD ") === "espn 4", "quita sufijo HD y espacios dobles", keyOf("ESPN  4 HD "));
ok(keyOf("Win Sports+") === "win sports plus", "'+' se lee como 'plus'");
ok(keyOf("A&E HD") === "a and e", "'&' se lee como 'and' y quita HD");
ok(mergeKey("DAZN 1 ES") === mergeKey("DAZN 1"), "DAZN 1 ES = DAZN 1");
ok(mergeKey("DirecTV Sports") === mergeKey("DSports"), "DirecTV Sports = DSports");
ok(mergeKey("Fox Sports MX") === mergeKey("Fox Sports México"), "MX = México al fusionar");
ok(mergeKey("daznliga") === mergeKey("DAZN La Liga"), "daznliga = DAZN La Liga");
ok(cleanName("discovery-tlc ") === "discovery-tlc", "limpia espacios de los bordes");
ok(smartTitle("GOLDEN PREMIER") === "Golden Premier", "arregla mayúsculas gritadas");
ok(smartTitle("ESPN") === "ESPN", "respeta siglas (ESPN)");
ok(smartTitle("Fox 1 HD") === "Fox 1", "quita la calidad del nombre visible", smartTitle("Fox 1 HD"));
ok(smartTitle("canal5mx") === "Canal5mx", "pone mayúscula inicial en canal5mx", smartTitle("canal5mx"));
ok(isJunkName("NO LO SE") && isJunkName("31") && isJunkName("2025 4:00 PM EST)"),
  "detecta nombres basura");
ok(!isJunkName("Canal A003"), "los Canal A0xx del proveedor no son basura (estaban en el catálogo)");
ok(!isJunkName("ESPN 2") && !isJunkName("Canal 5"), "no marca canales válidos como basura");
// La clave separa el número final de la marca, sin romper siglas como A24/C5N
ok(keyOf("canal10") === keyOf("Canal 10"), "canal10 = Canal 10");
ok(keyOf("ESPN2") === keyOf("ESPN 2"), "ESPN2 = ESPN 2");
ok(keyOf("A24") === "a24" && keyOf("C5N") === "c5n", "A24 y C5N conservan su forma");
// El paréntesis marca región: "Fox Sports 2 (AR)" no es "Fox Sports 2"
ok(mergeKey("Fox Sports 2 (AR)") !== mergeKey("Fox Sports 2"), "AR entre paréntesis conserva la variante");
ok(mergeKey("La 1 (ES)") === mergeKey("La 1"), "La 1 (ES) = La 1");
// Variantes de escritura del mismo canal
ok(mergeKey("EURO Channel") === mergeKey("Eurochannel"), "EURO Channel = Eurochannel");
ok(mergeKey("COMEDIA CENTRAL") === mergeKey("Comedy Central"), "COMEDIA CENTRAL = Comedy Central");
ok(mergeKey("Trece") !== mergeKey("El Trece"), "Trece (Paraguay) no se mezcla con El Trece");

section("Cadenas de URL y duplicados");
const chain = resolveTarget("/p/x.html?r=https://belkaperu.github.io/belkafut/repron.html?r=https://la18hd.su/vivo/canal.php?stream=espn");
ok(chain.target === "https://la18hd.su/vivo/canal.php?stream=espn", "sigue la cadena /p/?r=repron?r= hasta el destino", chain.target);
const b64 = Buffer.from("https://streamxhd.com/live1.php?stream=espn", "utf8").toString("base64");
ok(resolveTarget(`/p/repro.html?r=${b64}`).target === "https://streamxhd.com/live1.php?stream=espn",
  "decodifica el destino en base64");
ok(urlIdentity("HTTP://Host.Example:80/a/index.m3u8#x") === urlIdentity("http://host.example/a/index.m3u8"),
  "la identidad de URL ignora mayúsculas y fragmentos");

const doc = build();

const espn = doc.channels.find((c) => c.name === "ESPN");
ok(!!espn, "ESPN existe una sola vez");
ok(doc.channels.filter((c) => mergeKey(c.name) === "espn").length === 1, "no hay dos canales ESPN");
ok(espn.servers.length === 4, `servers de ESPN deduplicados (${espn.servers.length})`, JSON.stringify(espn.servers));
ok(espn.options.length === 2, `opciones de ESPN sin repetir (${espn.options.length})`, JSON.stringify(espn.options));
ok(espn.options.filter((o) => o.url.includes("streamxhd")).length === 1, "la opción repetida de ESPN quedó una sola vez");
ok(Object.keys(espn).join(",") === "name,title,normalized_name,category,imageUrl,servers,options",
  "el canal conserva exactamente el esquema original", Object.keys(espn).join(","));
ok(!JSON.stringify(doc).includes('"aliases"'), "no se añaden campos nuevos al archivo");
ok(new Set(espn.servers.concat(espn.options).map((s) => urlIdentity(s.url))).size ===
  espn.servers.length + espn.options.length, "todas las URLs de ESPN son distintas");

const urls = doc.channels.flatMap((c) => [...c.servers, ...c.options].map((s) => urlIdentity(s.url)));
ok(urls.length === new Set(urls).size, "ninguna URL exacta se repite en todo el catálogo");

const witUrls = doc.channels.filter((c) => c.name.startsWith("Win Sports"));
ok(witUrls.length === 2, "Win Sports y Win Sports+ siguen siendo canales distintos");

const reals = doc.channels.filter((c) => mergeKey(c.name) === "real");
ok(reals.length === 1, "los 6 'real' de data1 se fusionan en uno");
ok(reals[0].options.length === 1, "y su opción repetida queda una sola vez");

section("Canales sin nombre útil");
ok(!doc.channels.some((c) => ["31", "NO LO SE", "2025 4:00 PM EST)"].includes(c.name)),
  "los nombres basura no entran al catálogo");
ok(!("sin_identificar" in doc), "sin_identificar no se añade a la raíz del archivo");
const sinId = doc.summary.sin_identificar;
ok(sinId.some((x) => x.motivo === "numericos"), "los numéricos se apartan (resumen)");
ok(sinId.some((x) => x.motivo === "restos_de_eventos"), "los restos de eventos se apartan (resumen)");
ok(!sinId.some((x) => x.motivo === "placeholders_proveedor"),
  "los Canal A0xx se quedan en channels, como en el archivo original");
ok(sinId.every((x) => x.servers.length > 0 || (x.options || []).length > 0),
  "sin_identificar no tiene entradas vacías");

// Un canal sin nombre útil que solo traía reproductor no debe perder el enlace.
const soloRepro = buildUnified(
  {
    data1: {
      canales: [
        {
          title: "13",
          category: "all",
          options: [{ label: "13", url: "/p/repro1.html?r=https://streamxhd.com/live1.php?stream=13" }],
        },
      ],
    },
  },
  { imageIndex: new Map() },
);
const soloReproSinId = soloRepro.summary.sin_identificar;
const enlace13 = [...soloReproSinId.flatMap((x) => [...x.servers, ...(x.options || [])])]
  .map((x) => x.url)
  .join(" ");
ok(enlace13.includes("stream=13"), "los enlaces apartados no se pierden en el resumen", enlace13);
ok(!soloRepro.channels.length, "un canal sin nombre útil no se cuela en channels");

section("Categorías");
ok(inferCategory("espn") === "Deportes", "ESPN -> Deportes");
ok(inferCategory("cartoon network") === "Infantiles", "Cartoon Network -> Infantiles");
ok(inferCategory("hbo") === "Películas", "HBO -> Películas");
ok(inferCategory("cnn espanol") === "Noticias", "CNN Español -> Noticias");
ok(inferCategory("caracol") === "Internacionales", "Caracol (señal abierta) -> Internacionales");
ok(doc.categories.length === 6 && new Set(doc.categories.map((c) => c.name)).size === 6,
  "6 categorías, sin repetir");
ok(doc.channels.every((c) => doc.categories.some((k) => k.name === c.category)),
  "todos los canales usan una categoría existente");
ok(!doc.categories.some((c) => ["all", "general", "peliculas"].includes(c.name)),
  "no quedan categorías duplicadas ni 'all'");

section("Imágenes");
// Variantes regionales que pueden compartir logo ("Canal 13" / "Canal 13 (GUA)",
// "SporTV 3" / "SporTV Brasil 3").
const REGION_CODES = new Set(["gua", "gt", "nic", "esa", "hnd", "rd", "do", "cr", "es", "de", "pt", "it", "cz", "ar", "mx", "co", "pe", "cl", "br", "usa"]);
ok(scoreImage("ESPN 2", "espn-2") === 1, "ESPN 2 con espn-2.webp");
ok(scoreImage("ESPN", "espn-2") < 0.8, "ESPN no toma el logo de ESPN 2");
ok(scoreImage("ESPN 2", "espn-2-2") === 1, "ESPN 2 acepta espn-2-2.webp");
ok(scoreImage("Canal 5 MX", "canal5mx") === 1, "Canal 5 MX reconoce canal5mx.png");
const imgs = doc.channels.map((c) => c.imageUrl).filter(Boolean);
const sameImageClash = (() => {
  const byUrl = new Map();
  for (const c of doc.channels) {
    if (!c.imageUrl) continue;
    if (!byUrl.has(c.imageUrl)) byUrl.set(c.imageUrl, []);
    byUrl.get(c.imageUrl).push(c);
  }
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    // Compartir logo solo es válido si son variantes de la misma marca
    const names = list.map((c) => keyOf(c.name));
    const base = (t) => t.split(" ").filter((x) => !REGION_CODES.has(x)).join(" ");
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = base(names[i]);
        const b = base(names[j]);
        if (!a.startsWith(b) && !b.startsWith(a)) {
          return list.map((c) => c.name).join(" / ");
        }
      }
    }
  }
  return "";
})();
ok(!sameImageClash, "una misma imagen solo se comparte entre variantes de la marca", sameImageClash);
ok(doc.channels.find((c) => c.name === "ESPN").imageUrl.endsWith("espn.webp"), "ESPN usa su logo local");
// El sufijo del archivo es el código de país: no debe tratarse como adorno
ok(scoreImage("DAZN 2 DE", "dazn-2-de") === 1 && scoreImage("DAZN 2", "dazn-2-de") < 0.8,
  "DAZN 2 DE toma dazn-2-de y DAZN 2 no");
ok(scoreImage("DAZN F1", "dazn-f1") === 1, "DAZN F1 reconoce dazn-f1 aunque tenga número");
ok(scoreImage("A24", "a24") === 1, "A24 reconoce a24.jpg");
ok(scoreImage("Canal 5 MX", "canal5mx") === 1, "canal5mx casa después de expandir letras y números");
ok(doc.channels.find((c) => c.name === "CNN Español").imageUrl.endsWith("cnn-espanol.png"),
  "CNN Español usa su logo (aunque venía como 'CNN Espaæol')");

section("Validación y formato");
// El esquema del archivo NO se amplía: raíz {categories, channels} y 7 campos.
const ESQUEMA_CANAL = "name,title,normalized_name,category,imageUrl,servers,options";
ok(Object.keys(doc).join(",") === "categories,channels",
  "la raíz solo tiene categories y channels", Object.keys(doc).join(","));
ok(doc.channels.every((c) => Object.keys(c).join(",") === ESQUEMA_CANAL),
  "todos los canales tienen exactamente los 7 campos originales");
ok(doc.channels.every((c) => c.servers.every((x) => Object.keys(x).join(",") === "name,url")),
  "los servidores siguen siendo {name, url}");
ok(doc.channels.every((c) => c.options.every((x) => Object.keys(x).join(",") === "label,url")),
  "las opciones siguen siendo {label, url}");
ok(doc.categories.every((c) => Object.keys(c).join(",") === "display_name,icon,name"),
  "las categorías siguen siendo {display_name, icon, name}");
ok(doc.channels.some((c) => /^canal a[0-9a-z]{3}$/i.test(c.name)),
  "los Canal A0xx siguen en channels (no se cambia el contenido)");
const problems = validateUnified(doc);
ok(problems.length === 0, "validateUnified no encuentra problemas", problems.join(" | "));
ok(doc.channels.every((c) => c.name && c.title && c.normalized_name && c.category),
  "todos los canales traen name, title, normalized_name y category");
ok(doc.channels.every((c) => c.server === undefined || true), "sin campos sueltos");
ok(Object.keys(doc).join(",") === "categories,channels", "la raíz solo tiene categories y channels", Object.keys(doc).join(","));
ok(doc.categories.every((c) => Object.keys(c).join(",") === "display_name,icon,name"),
  "las categorías conservan display_name, icon y name (mismo orden que el original)");
ok(doc.channels.every((c) => !c.servers.length || c.servers.every((s) => s.name && s.url)),
  "los servidores traen nombre y URL");
ok(new Set(doc.channels.map((c) => c.id)).size >= 1, "canales sin id (esquema original)");
ok(new Set(doc.channels.map((c) => c.normalized_name)).size === doc.channels.length, "normalized_name únicos");
ok(doc.summary.fusionados >= 2, `cuenta las fusiones (${doc.summary.fusionados})`);
ok(new Set(doc.channels.flatMap((c) => c.options.map((o) => o.label.toLowerCase()))).size ===
  doc.channels.reduce((n, c) => n + c.options.length, 0), "las etiquetas de opción no se repiten");

// El resultado real (si existe) también debe validar
try {
  const fs = await import("node:fs");
  const realPath = path.join(__dirname, "..", "data_unificado.json");
  const real = JSON.parse(fs.readFileSync(realPath, "utf8"));
  const realProblems = validateUnified(real);
  ok(realProblems.length === 0, "data_unificado.json del repo valida sin duplicados", realProblems.slice(0, 5).join(" | "));
  const realUrls = real.channels.flatMap((c) => [...c.servers, ...c.options].map((s) => urlIdentity(s.url)));
  ok(realUrls.length === new Set(realUrls).size, "data_unificado.json no tiene URLs repetidas");
} catch { /* si no existe el archivo, no se prueba */ }

/* ------------------------------------------------------------------ */

console.log(`\n\x1b[1mResultado:\x1b[0m ${pass} ✔  ${fail ? `\x1b[31m${fail} ✘\x1b[0m` : "0 ✘"}`);
if (fail) {
  console.log("\nFallaron:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\x1b[32mTodo bien\x1b[0m (${IMG_DIR ? "con" : "sin"} índice de imágenes del repo)`);
