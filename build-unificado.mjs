#!/usr/bin/env node
/**
 * build-unificado.mjs — construye data_unificado.json a partir de data.json,
 * data1.json y data2.json, sin canales ni URLs repetidas.
 *
 * Qué hace:
 *   1. Une los canales de los tres archivos en una sola entrada por canal real
 *      (ignora mayúsculas, acentos, guiones, sufijos "HD/FHD/SD" y alias
 *      conocidos: "dazn 1 es" == "DAZN 1", "direcTV Sports" == "DSports"...).
 *   2. Deduplica los enlaces: dentro de cada canal deja una sola entrada por
 *      destino real (siguiendo las cadenas /p/...?r=...?r=<url>, ?url=<base64>,
 *      etc.). Prefiere el enlace directo sobre el reproductor envuelto.
 *   3. Limpia los nombres (basura de scraping, mojibake "Espaæol", ".html"),
 *      normaliza las 6 categorías y les pone su icono.
 *   4. Asigna la mejor imagen local de img/canales; descarta logos genéricos o
 *      que no correspondan al canal.
 *   5. Aparta los canales sin nombre útil (números sueltos, "Sin identificar",
 *      placeholders "Canal A0xx", restos de eventos) en `sin_identificar`,
 *      sin perder sus enlaces.
 *   6. Escribe estadísticas en `meta` y deja el archivo ordenado por categoría
 *      y nombre.
 *
 * Uso:
 *   node build-unificado.mjs                 # simulación: resume los cambios
 *   node build-unificado.mjs --apply         # escribe data_unificado.json
 *   node build-unificado.mjs --apply --out=otro.json
 *   node build-unificado.mjs --verbose       # detalle por canal
 *
 * Sin dependencias externas (Node 20+).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeLogger, parseArgs, safeDecode, decodeBase64Detailed, hostOf } from "./lib/util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = "2.0.0";
export const RAW_BASE = "https://raw.githubusercontent.com/belkaperu/belkafut/main/img/canales";

/* ------------------------------------------------------------------ *
 * Categorías canónicas
 * ------------------------------------------------------------------ */

export const CATEGORIES = [
  { name: "Deportes", display_name: "Deportes en Vivo", icon: "⚽" },
  { name: "Películas", display_name: "Películas", icon: "🎬" },
  { name: "Entretenimiento", display_name: "Entretenimiento", icon: "📺" },
  { name: "Infantiles", display_name: "Contenido Infantil", icon: "🧒" },
  { name: "Noticias", display_name: "Noticias", icon: "📰" },
  { name: "Internacionales", display_name: "Canales Internacionales", icon: "🌍" },
];
const CATEGORY_ORDER = new Map(CATEGORIES.map((c, i) => [c.name, i]));

/**
 * Esquema ORIGINAL del archivo (no ampliarlo): un canal solo tiene estas
 * claves, en este orden, y la raíz solo {categories, channels}.
 */
export const CHANNEL_FIELDS = ["name", "title", "normalized_name", "category", "imageUrl", "servers", "options"];
const QUALITY_SUFFIX = /\s+(hd|fhd|uhd|sd|4k|8k|h265|hevc|h\.?264|full|opc?|op\d)\s*$/i;
const CATEGORY_BY_KEY = new Map(
  CATEGORIES.flatMap((c) => [
    [keyOf(c.name), c.name],
    [keyOf(c.display_name), c.name],
  ]),
);

/* ------------------------------------------------------------------ *
 * Nombres: limpieza, clave de fusión, alias y nombres bonitos
 * ------------------------------------------------------------------ */

/** Arregla el mojibake típico de los scraping (UTF-8 leído como Latin-1). */
export function fixMojibake(s) {
  return String(s ?? "")
    .replace(/Ã¡/g, "á").replace(/Ã©/g, "é").replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó").replace(/Ãº/g, "ú").replace(/Ã±/g, "ñ")
    .replace(/Ã/g, "í").replace(/Â/g, "")
    .replace(/æ/g, "ñ").replace(/ð/g, "ó")
    .replace(/â€¦/g, "…").replace(/â€™/g, "’");
}

/** Limpia el nombre visible: espacios, mojibake, extensiones y adornos. */
export function cleanName(raw) {
  let s = fixMojibake(raw);
  s = s.replace(/\.(html?|php|m3u8?)$/i, "");
  s = s.replace(/^[\s|·•\-–—]+|[\s|·•\-–—]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Separa letras y números ("canal5mx" -> "canal 5 mx"). */
function splitAlphaNum(slug) {
  return String(slug)
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2");
}

/**
 * Clave de fusión: minúsculas, sin acentos, "&" -> "and", "+" -> "plus",
 * sin paréntesis ni sufijos de calidad. "ESPN  4 HD " -> "espn 4".
 * Las variantes regionales (AR, MX, DE, USA...) se conservan a propósito.
 */
const COUNTRY_BY_CODE = {
  RU: "rusia", PE: "peru", MX: "mexico", AR: "argentina", CO: "colombia", CL: "chile",
  ES: "espana", BR: "brasil", US: "usa", EC: "ecuador", VE: "venezuela", UY: "uruguay",
  PY: "paraguay", BO: "bolivia", GT: "guatemala", CR: "costa rica", DO: "republica dominicana",
  HN: "honduras", SV: "el salvador", NI: "nicaragua", PA: "panama", IT: "italia",
  FR: "francia", DE: "alemania", PT: "portugal", GB: "reino unido", CA: "canada",
  RD: "republica dominicana", GUA: "guatemala", NIC: "nicaragua", ESA: "el salvador",
  HND: "honduras", LAT: "latinoamerica", LATAM: "latinoamerica",
};

function keyBase(raw) {
  let s = fixMojibake(raw);
  s = s.replace(/\.(html?|php|m3u8?)(?=\s|$)/i, " ");
  s = s.replace(/&/g, " and ").replace(/\+/g, " plus ");
  // Banderas de región (🇷🇺, 🇵🇪...) -> nombre del país entre paréntesis
  s = s.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, (flag) => {
    const code = [...flag].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join("");
    return ` (${COUNTRY_BY_CODE[code] || code.toLowerCase()}) `;
  });
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
  // "(AR)", "(DE)", "(GUA)": marca la región del feed, así que se conserva
  // como token ("Fox Sports 2 (AR)" -> "fox sports 2 ar") en vez de borrarse.
  s = s.replace(/\(\s*([A-Za-z]{2,5})\s*\)/g, " $1 ");
  s = s.replace(/\((?:[^)]*)\)|\[[^\]]*\]/g, " ");
  // sufijos de calidad repetidos ("ESPN 5  HD HD")
  for (let i = 0; i < 3; i++) s = s.replace(QUALITY_SUFFIX, "").trim();
  // cirílico y otras escrituras se conservan (si no, quedan nombres vacíos)
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Igual que keyBase pero separando el número final de las marcas escritas
 * juntas: "canal10"/"Canal 10" -> "canal 10", "espn2" -> "espn 2".
 * Solo cuando la palabra tiene 3+ letras, para no romper marcas como "A24".
 */
export function keyOf(raw) {
  return keyBase(raw)
    .replace(/(^| )([a-z]{3,})(\d+)(?= |$)/g, "$1$2 $3")
    .trim()
    .replace(/\s+/g, " ");
}

/** Variante que además deja solo letras/números (para comparar imágenes). */
export function slugOf(raw) {
  return keyOf(raw).replace(/\s+/g, "-").replace(/^-+|-+$/g, "") || "canal";
}

/** Sinónimos de país/región que deben tratarse como iguales al fusionar. */
const KEY_SYNONYMS = { mx: "mexico", mexico: "mexico", pe: "peru", peru: "peru", ar: "argentina", argentina: "argentina", col: "colombia", colombia: "colombia", lat: "latinoamerica", latam: "latinoamerica", usa: "usa", us: "usa" };

/** Clave de fusión final: aplica alias y unifica MX/México, AR/Argentina... */
export function mergeKey(raw) {
  const k = canonicalKey(raw);
  return k.split(" ").map((t) => KEY_SYNONYMS[t] || t).join(" ");
}

/**
 * Alias conocidos: clave repetida/abreviada -> clave canónica.
 * Solo se listan equivalencias seguras (misma señal, distinto nombre).
 */
export const ALIASES = {
  // --- Discovery / factual ---
  discovery: "discovery channel",
  "discovery helth": "discovery home and health",
  "discovery h and h": "discovery home and health",
  "discovery hh": "discovery home and health",
  "home and health": "discovery home and health",
  dhe: "discovery home and health",
  "discovery id": "investigation discovery",
  "id investigation": "investigation discovery",
  id: "investigation discovery",
  "discovery tlc": "tlc",
  "discovery a and e": "a and e",
  "disc theather": "discovery theater",
  "discovery theater": "discovery theater",
  turbo: "discovery turbo",
  discovery: "discovery channel",
  // --- ESPN ---
  "espn mx": "espn mexico",
  "espn 3 mx": "espn 3 mexico",
  "espn 4 mx": "espn 4 mexico",
  "espn 6 mx": "espn 6 mexico",
  // --- Fox ---
  foxusa1: "fox sports 1",
  fs2: "fox sports 2",
  "fox sport 3": "fox sports 3",
  "fox sports mex": "fox sports mexico",
  "fox sports mx": "fox sports mexico",
  "fox deportes usa": "fox deportes",
  "fox premium": "fox sports premium",
  "fox sport premium": "fox sports premium",
  // --- Universal ---
  universaltv: "universal tv",
  universal: "universal tv",
  "universal channel": "universal tv",
  universalcine: "universal cinema",
  universalcinema: "universal cinema",
  universalcomedy: "universal comedy",
  universalcrime: "universal crime",
  universalreal: "universal reality",
  universalprime: "universal premiere",
  // --- TNT / otros ---
  tntserie: "tnt series",
  "star chanel": "star channel",
  "sony movie": "sony movies",
  "sony competeciones": "sony competencias",
  // --- DirecTV / DSports ---
  "directv sports": "dsports",
  "directv sports 2": "dsports 2",
  "directv sports plus": "dsports plus",
  directvsportsmotor: "dsports motor",
  // --- Movistar ---
  "la liga": "movistar laliga",
  "logo movistar laliga": "movistar laliga",
  "movistar la liga": "movistar laliga",
  "liga de campeones": "movistar liga de campeones",
  "movistar liga de campeones 1": "movistar liga de campeones",
  // --- Perú / LatAm ---
  golperu: "gol peru",
  "liga 1max": "liga 1 max",
  americatv: "america tv",
  america: "america tv",
  "americatvar": "america tv argentina",
  "canal5mx": "canal 5",
  // --- Variantes de escritura de la misma señal ---
  // "COMEDIA CENTRAL" (data.json) es Comedy Central; "Distrito Comedia" es otro canal.
  "comedia central": "comedy central",
  // "WARNER" (data2) repite el feed de Warner Channel; "Warner Bros TV" es otro.
  warner: "warner channel",
  // "El Trece" (Argentina) y "Trece" (Paraguay) son canales distintos: sin alias.

  // --- Geográficos / noticias ---
  "national geographic": "nat geo",
  nacionalwd: "nat geo",
  cnne: "cnn espanol",
  "rt espanol": "rt",
  eltrece: "el trece",
  tvpublica: "tv publica",
  daznliga: "dazn la liga",
  "dazn 1 es": "dazn 1",
  "dazn 2 es": "dazn 2",
  "movistar deportes es": "movistar deportes",
  foxdeportes: "fox deportes",
  dpelicula: "de pelicula",
  azteca7: "azteca 7",
  "arena sports": "arenasports",
  "film and art": "film and arts",
  "paramount channel": "paramount",
  "desny channel": "disney channel",
  "deseny channel": "disney channel",
  "desny junior": "disney jr",
  "deseny junior": "disney jr",
  "euro chanel": "eurochannel",
  "euro channel": "eurochannel",
  // "LA 1 ES" es La 1 (TVE): el sufijo solo marca la región del feed
  "la 1 es": "la 1",
  "la 2es": "la 2",
  // variantes de escritura de un mismo canal regional
  "sportvbra": "sportv brasil",
  "sportvbra 2": "sportv brasil 2",
  "sportvbra 3": "sportv brasil 3",
  "star chanel": "star channel",
  "tsn": "tsn",
  // --- Varios ---
  "discovery science": "discovery science",
};
delete ALIASES["discovery science"]; // identidad, no hace falta
delete ALIASES["discovery theater"]; // identidad, no hace falta
delete ALIASES["rcn novelas"]; // identidad, no hace falta
delete ALIASES["sport tv pt"]; // identidad, no hace falta
delete ALIASES["telefe html"]; // identidad, no hace falta
delete ALIASES["tsn"]; // identidad, no hace falta

/** Nombres visibles canónicos (marca escrita como debe verse). */
export const DISPLAY_NAMES = {
  "a and e": "A&E",
  "arenasports": "Arena Sports",
  "real madrid tv": "Real Madrid TV",
  "tigo sports el salvador": "Tigo Sports El Salvador",
  "a spori": "A Spor",
  "a spor": "A Spor",
  "cn": "CN",
  "a24": "A24",
  "civ": "CIV",
  "cyv": "CYV",
  "ns": "NS",
  "sn": "SN",
  "mc": "MC",
  "in": "IN",
  "las": "LAS",
  "tele": "Tele",
  "peru": "Perú",
  "gol": "Gol",
  "dnews": "DNews",
  "daxery": "Daxery",
  "film and arts": "Film & Arts",
  "filmart": "Film & Arts",
  "dpelicula": "De Película",
  "d pelicula plus": "De Película Plus",
  "paramaunt": "Paramount",
  "paramount": "Paramount",
  "sonny tv": "Sonny TV",
  "fx tv": "FX TV",
  "hgtv": "HGTV",
  "eurosports": "Eurosport",
  "eurosports 1": "Eurosport 1",
  "eurosports 2": "Eurosport 2",
  "la 1": "La 1",
  "la 2": "La 2",
  "lnplus": "LN+",
  "tve internacional": "TVE Internacional",
  "tvg2es": "TVG 2 (ES)",
  "tvg 2 es": "TVG 2 (ES)",
  "sportv brasil": "SporTV Brasil",
  "sportv brasil 2": "SporTV Brasil 2",
  "sportv brasil 3": "SporTV Brasil 3",
  "canal 9 ixchiguan gt": "Canal 9 (GT)",
  "canal 13 gua": "Canal 13 (GUA)",
  "canal 7 gua": "Canal 7 (GUA)",
  "canal 11 gua": "Canal 11 (GUA)",
  "canal 3 gua": "Canal 3 (GUA)",
  "canal 2 esa": "Canal 2 (ESA)",
  "canal 4 esa": "Canal 4 (ESA)",
  "canal 14 nic": "Canal 14 (NIC)",
  "guatevision gua": "Guatevision (GUA)",
  "telemicro rd": "Telemicro (RD)",
  "faro vision do": "Faro Visión (DO)",
  "sas tv gt": "Sas TV (GT)",
  "vision tv gt": "Visión TV (GT)",
  "tn23 gt": "TN23 (GT)",
  "futv cr": "FUTV (CR)",
  "td plus cr": "Td+ (CR)",
  "td plus 2 cr": "Td+ 2 (CR)",
  "tigo gt": "TIGO (GT)",
  "canal 27 gt": "Canal 27 (GT)",
  "canal 7 gt": "Canal 7 (GT)",
  "tve": "TVE",
  "tvg2": "TVG 2",
  "h and h": "H&H",
  "mas tv toto": "Mas TV Toto",
  "maschic": "MasChic",
  "mazinyer z": "Mazinyer Z",
  "zona dazn it": "Zona DAZN IT",
  "zonadaznit": "Zona DAZN IT",
  "danz 1 de": "DAZN 1 (DE)",
  "l1 max peru": "L1 Max Perú",
  "primasport": "Prima Sport",
  "prima sport": "Prima Sport",
  "sports degital": "Sports Digital",
  "fk": "FK",
  "ftv": "FTV",
  "sony": "Sony",

  "ssc sports": "SSC Sports",
  "ssc": "SSC",
  "euro chanel": "Eurochannel",
  "bein sports es": "BeIN Sports ES",
  "bein sports extra": "BeIN Sports Extra",
  "bein sports xtra": "BeIN Sports Xtra",
  "bein sports n": "BeIN Sports Ñ",
  "bein sports": "BeIN Sports",
  "tsn": "TSN",
  "tsn 1": "TSN 1",
  "tsn 2": "TSN 2",
  "tsn 3": "TSN 3",
  "tsn 4": "TSN 4",
  "tsn 5": "TSN 5",
  "sky sports": "Sky Sports",
  "sky sports mexico": "Sky Sports México",
  "premier league 1": "Premier League 1",
  "la liga peruana": "La Liga Peruana",
  "sports live": "Sports Live",
  "sports tv": "Sports TV",
  "sportv 3": "SporTV 3",
  "unido 2 sports": "Unido 2 Sports",
  "tabil sports": "Tabil Sports",
  e: "E!",
  "discovery channel": "Discovery Channel",
  "discovery home and health": "Discovery Home & Health",
  "investigation discovery": "Investigation Discovery",
  tlc: "TLC",
  "discovery theater": "Discovery Theater",
  "discovery world": "Discovery World",
  "discovery kids": "Discovery Kids",
  "discovery turbo": "Discovery Turbo",
  "discovery science": "Discovery Science",
  "nat geo": "Nat Geo",
  espn: "ESPN",
  "espn 2": "ESPN 2",
  "espn 3": "ESPN 3",
  "espn 4": "ESPN 4",
  "espn 5": "ESPN 5",
  "espn 6": "ESPN 6",
  "espn 7": "ESPN 7",
  "espn ar": "ESPN Argentina",
  "espn col": "ESPN Colombia",
  "espn mexico": "ESPN México",
  "espn 2 mexico": "ESPN 2 México",
  "espn 3 mexico": "ESPN 3 México",
  "espn 4 mexico": "ESPN 4 México",
  "espn 5 mexico": "ESPN 5 México",
  "espn 6 mexico": "ESPN 6 México",
  "espn premium": "ESPN Premium",
  "espn premium argentina": "ESPN Premium Argentina",
  "espn deportes": "ESPN Deportes",
  "espn brasil": "ESPN Brasil",
  "espn usa": "ESPN USA",
  "espn 4 5 6 7": "ESPN 4.5, 6 y 7",
  "fox sports": "Fox Sports",
  "fox sports 1": "Fox Sports 1",
  "fox sports 2": "Fox Sports 2",
  "fox sports 3": "Fox Sports 3",
  "fox sports 2 ar": "Fox Sports 2 (AR)",
  "fox sports 2 argentina": "Fox Sports 2 (AR)",
  "fox sports 3 ar": "Fox Sports 3 (AR)",
  "fox sports 3 argentina": "Fox Sports 3 (AR)",
  "fox sports mexico": "Fox Sports México",
  "fox sports 2 mexico": "Fox Sports 2 México",
  "fox sports 3 mexico": "Fox Sports 3 México",
  "fox sports premium": "Fox Sports Premium",
  "fox deportes": "Fox Deportes",
  foxusa1: "Fox Sports 1",
  "fox 1 hd": "Fox 1",
  "fox 2 hd": "Fox 2",
  "fox nic hd": "Fox NIC",
  "hbo": "HBO",
  "hbo 2": "HBO 2",
  "hbo plus": "HBO Plus",
  "hbo family": "HBO Family",
  "hbo mundi": "HBO Mundi",
  "hbo pop": "HBO Pop",
  "hbo signature": "HBO Signature",
  "hbo xtreme": "HBO Xtreme",
  tnt: "TNT",
  "tnt series": "TNT Series",
  "tnt novelas": "TNT Novelas",
  tbs: "TBS",
  "tnt sports": "TNT Sports",
  "tnt sports 1": "TNT Sports 1",
  "tnt sports 2": "TNT Sports 2",
  "tnt sports 3": "TNT Sports 3",
  "tnt sports chile": "TNT Sports Chile",
  "tnt sports premium": "TNT Sports Premium",
  "star channel": "Star Channel",
  "sony": "Sony",
  "sony movies": "Sony Movies",
  "sony competencias": "Sony Competencias",
  "warner channel": "Warner Channel",
  fx: "FX",
  space: "Space",
  amc: "AMC",
  axn: "AXN",
  cinecanal: "Cinecanal",
  cinemax: "Cinemax",
  "cinemax 2": "Cinemax 2",
  golden: "Golden",
  "golden edge": "Golden Edge",
  "golden plus": "Golden Plus",
  "golden premier": "Golden Premier",
  "golden premier 2": "Golden Premier 2",
  history: "History",
  "history 2": "History 2",
  "universal tv": "Universal TV",
  "universal cinema": "Universal Cinema",
  "universal comedy": "Universal Comedy",
  "universal crime": "Universal Crime",
  "universal reality": "Universal Reality",
  "universal premiere": "Universal Premiere",
  "universal premiere 2": "Universal Premiere 2",
  "studio universal": "Studio Universal",
  "dazn 1": "DAZN 1",
  "dazn 2": "DAZN 2",
  "dazn 2 de": "DAZN 2 DE",
  "dazn f1": "DAZN F1",
  "dazn la liga": "DAZN LaLiga",
  "daznliga": "DAZN LaLiga",
  dsports: "DSports",
  "dsports 2": "DSports 2",
  "dsports plus": "DSports+",
  "dsports motor": "DSports Motor",
  "win sports": "Win Sports",
  "win sports plus": "Win Sports+",
  "movistar laliga": "Movistar LaLiga",
  "movistar liga de campeones": "Movistar Liga de Campeones",
  "movistar deportes": "Movistar Deportes",
  "liga 1 max": "Liga 1 Max",
  "gol peru": "Gol Perú",
  goltv: "GOLTV",
  "tyc sports": "TyC Sports",
  tudn: "TUDN",
  premiere: "Premiere",
  "claro sports": "Claro Sports",
  "claro sports 2": "Claro Sports 2",
  "claro cinema": "Claro Cinema",
  claro: "Claro",
  "zapping ec": "Zapping EC",
  "america tv": "América TV",
  "america tv argentina": "América TV Argentina",
  atv: "ATV",
  rcn: "RCN",
  "rcn extra": "RCN Extra",
  caracol: "Caracol",
  telefe: "Telefe",
  "el trece": "El Trece",
  eltrece: "El Trece",
  latina: "Latina",
  mega: "Mega",
  etc: "ETC",
  tvc: "TVC",
  "tvc deportes": "TVC Deportes",
  "canal 5": "Canal 5",
  "canal 5 ar": "Canal 5 AR",
  "canal 5 mx": "Canal 5 MX",
  "canal 7": "Canal 7",
  "canal 7 mx": "Canal 7 MX",
  "canal 7 gt": "Canal 7 GT",
  "tv publica": "TV Pública",
  tvpublica: "TV Pública",
  "tv peru": "TV Perú",
  deportv: "DeporTV",
  planetatv: "Planeta TV",
  univision: "Univision",
  telemundo: "Telemundo",
  "telemundo 51": "Telemundo 51",
  "telemundo puerto rico": "Telemundo Puerto Rico",
  galavision: "Galavisión",
  "c5n": "C5N",
  tn: "TN",
  "24hv": "24 Horas",
  "cnn espanol": "CNN Español",
  "dw espanol": "DW Español",
  "france24": "France 24",
  "bbc news": "BBC News",
  "tele sur": "teleSUR",
  telesur: "teleSUR",
  "cronica tv": "Crónica TV",
  "canal 26": "Canal 26",
  "espn argentina": "ESPN AR",
  "espn colombia": "ESPN CO",
  "cine": "Cine",
  "europa": "Europa",
  "warner channel": "Warner Channel",
  "television metropolis 19 1": "Televisión Metrópolis 19.1",
  "freetv com freetv 8 2": "FreeTV 8.2",
  "canal azteca gua": "Canal Azteca (GUA)",
  "canal señal colombia": "Canal Señal Colombia",
  "canal senal colombia": "Canal Señal Colombia",
  "de pelicula": "De Película",
  "de pelicula plus": "De Película Plus",
  "willax": "Willax",
  "wilax": "Willax",
  "cnbc": "CNBC",
  rt: "RT",
  cnn: "CNN",
  "disney channel": "Disney Channel",
  "disney jr": "Disney Jr.",
  "cartoon network": "Cartoon Network",
  cartoonito: "Cartoonito",
  nickelodeon: "Nickelodeon",
  "nick jr": "Nick Jr.",
  nick: "Nick",
  tooncast: "Tooncast",
  "disney xd": "Disney XD",
  "baby tv": "Baby TV",
  "baby first": "BabyFirst",
  semillitas: "Semillitas",
  "dreamworks": "DreamWorks",
  "el gourmet": "El Gourmet",
  "comedy central": "Comedy Central",
  "distrito comedia": "Distrito Comedia",
  mtv: "MTV",
  unicable: "Unicable",
  pasiones: "Pasiones",
  tlnovelas: "Tlnovelas",
  usa: "USA",
  syfy: "SyFy",
  "life time": "Lifetime",
  lifetime: "Lifetime",
  "film and arts": "Film & Arts",
  "film art": "Film & Arts",
  "sony novelas": "Sony Novelas",
  "multipremier": "Multipremier",
  "mundo latam": "Mundo LATAM",
  "rcn novelas": "RCN Novelas",
};

/** Nombres que solo aportan ruido o son placeholders. */
const JUNK_EXACT = new Set([
  "no lo se", "no se", "sin senal", "sin identificar", "otra url", "live",
  "sports", "tv104", "tv105", "tv106", "tv 104", "tv 105", "tv 106",
]);
const JUNK_PATTERNS = [
  /^\d+$/,                                          // "31", "54"
  /^\d{4}\s+\d{1,2}\s+\d{2}\s*(?:am|pm)?\s*(?:est|edt)?$/, // "2025 4 00 pm est"
  /^\d{4}\s+\d{1,2}\s*(?:am|pm)\s*(?:est|edt)?$/,
  // OJO: "Canal A0xx" NO es basura; son canales del proveedor que el archivo
  // original ya listaba en `channels`. Solo se descartan nombres sin ningún
  // dato (números sueltos, "NO LO SE", restos de fecha/hora).
];

/**
 * Mapa de alias con la clave ya normalizada: así "sportvbra3" (alias escrito
 * a mano) casa con la clave real "sportv 3" que produce keyOf.
 */
const ALIAS_MAP = new Map();
for (const [from, to] of Object.entries(ALIASES)) {
  const k = keyOf(from);
  if (k && !ALIAS_MAP.has(k)) ALIAS_MAP.set(k, keyOf(to));
}

/** Une la clave con sus alias. */
export function canonicalKey(raw) {
  let k = keyOf(raw);
  const seen = new Set();
  while (ALIAS_MAP.has(k) && !seen.has(k)) {
    seen.add(k);
    const next = ALIAS_MAP.get(k);
    if (!next || next === k) break;
    k = next;
  }
  return k;
}

export function isJunkName(raw) {
  const k = keyBase(raw);
  if (!k) return true;
  if (JUNK_EXACT.has(k)) return true;
  if (JUNK_PATTERNS.some((re) => re.test(k))) return true;
  const spaced = splitAlphaNum(k);
  return JUNK_PATTERNS.some((re) => re.test(spaced));
}

const ACRONYMS = new Set([
  "TV", "HD", "FHD", "UHD", "ESPN", "HBO", "TNT", "CNN", "AXN", "RCN", "ATV",
  "TUDN", "TBS", "AMC", "FX", "USA", "MTV", "NBA", "NFL", "MLB", "NHL", "UFC",
  "WWE", "DAZN", "F1", "TVN", "C5N", "TN", "RT", "DW", "CNBC", "BBC", "DW",
  "DSports", "DS", "EC", "GT", "MX", "AR", "CO", "PE", "CL", "VE", "USA",
  "FUTV", "TVC", "CBS", "FS1", "FS2", "TCM", "MGM", "A24", "HGTV", "ID",
  "NIC", "GUA", "HND", "ESA", "RD", "DE", "ES", "PT", "IT", "CZ", "Ñ",
  "GOLTV", "TIGO", "TELENOSTALGIA", "RDS", "CA", "ECDF", "MLS", "PBA",
  "TSN", "SSC", "FMH", "FM", "IT", "MX", "BEIN", "VTV", "L1", "DC", "GUA",
  "HND", "ESA", "NIC", "CR", "DO", "GT", "ECDF", "RDS", "TVC", "CNN", "CBS",
  "TSN", "EC", "CGH", "NBC", "ABC", "CBS", "PBS", "RTE", "SIC", "TVI",
]);

const SMALL_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "al", "a"]);

/** Pone mayúsculas correctas sin destrozar siglas ni marcas. */
export function smartTitle(raw) {
  let s = cleanName(raw);
  if (!s) return s;
  // "Fox 1 HD" -> "Fox 1": la calidad no forma parte del nombre del canal
  const sinCalidad = s.replace(/\s+(?:HD|SD|FHD|UHD|4K)\s*$/i, "").trim();
  if (sinCalidad) s = sinCalidad;
  if (s.toUpperCase() === s && s.length <= 6) return s; // siglas: "TVN", "ESPN"
  // Escrituras no latinas (cirílico, árabe...): se respetan tal cual.
  if (/[^\u0000-\u024F\s\d.,&+()'\-¡¿!|]/u.test(s)) return s;
  // Puntos y comas que forman parte del nombre: "8.2", "19.1", "Jr.", "4.5, 6 y 7"
  s = s.replace(/(\d)\.(\d)/g, "$1\u0000$2").replace(/\bJr\./g, "Jr\u0000");
  // "4.5, 6 y 7": comas y puntos que separan números, no adornos
  s = s.replace(/(\d),(\s*)(?=\d)/g, "$1\u0001$2");
  const out = s
    .split(" ")
    .map((word, i) => {
      const bare = word.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9&+!\u0000\u0001]/g, "");
      if (!bare) return word;
      if (ACRONYMS.has(bare)) return bare.toUpperCase();
      if (ACRONYMS.has(bare.toUpperCase())) return bare;
      if (i > 0 && SMALL_WORDS.has(bare.toLowerCase())) return bare.toLowerCase();
      // palabras con números ("canal5mx", "espn2")
      if (/^[a-záéíóúüñ]+[0-9]/i.test(bare)) {
        return bare.replace(/^([a-záéíóúüñ]+)/i, (m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
      }
      return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\bY\b/g, "y")
    .replace(/\bDe\b/g, "de");
  return out.replace(/\u0000/g, ".").replace(/\u0001/g, ",");
}

/* ------------------------------------------------------------------ *
 * Cadenas de URL: destino final y deduplicación
 * ------------------------------------------------------------------ */

const CHAIN_KEYS = /(?:^|&)(r|embed|url|redirect|src|get)=/;

/**
 * Sigue los envoltorios de una URL y devuelve el destino real.
 *   /p/x.html?r=https://host/repron?r=<base64>  ->  https://...
 */
export function resolveTarget(raw) {
  const layers = [];
  let cur = String(raw ?? "").trim();
  const seen = new Set();
  for (let i = 0; i < 12 && cur; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    layers.push(cur);
    const q = cur.indexOf("?");
    if (q === -1) break;
    const query = cur.slice(q + 1);
    const m = CHAIN_KEYS.exec(query);
    if (!m) break;
    let next = safeDecode(query.slice(m.index + m[0].length)).trim();
    if (!/^https?:\/\//i.test(next) && !next.startsWith("/")) {
      const dec = decodeBase64Detailed(next);
      if (!dec) break;
      next = dec.text;
    }
    if (!next || next === cur) break;
    cur = next;
  }
  const absolute = layers.filter((l) => /^https?:\/\//i.test(l));
  return { layers, target: absolute.length ? absolute[absolute.length - 1] : layers[layers.length - 1] };
}

/**
 * Destinos comprobados que NO sirven vídeo aunque respondan 200.
 *
 * Se verificó a mano: devuelven "Could not play video /
 * hls:networkError_manifestLoadError" o redirigen a un dominio aparcado.
 * Se descartan en el generador para que el catálogo no se vuelva a llenar de
 * enlaces muertos al regenerarlo desde las fuentes.
 *
 * Para volver a admitir uno, bórralo de esta lista y revisa que reproduzca.
 */
export const SIN_VIDEO = [
  { host: "streamxhd.com", motivo: "redirige a streamxhd.sbs, sin reproductor" },
  { host: "streamxhd.sbs", motivo: "sin reproductor" },
  { host: "streamx-hd.com", motivo: "sin reproductor" },
  { host: "stream-xhd.com", motivo: "sin reproductor" },
  { host: "streamx996.one", motivo: "sin reproductor" },
  { host: "streamhdx.com", motivo: "sin reproductor" },
  { host: "la18hd.su", motivo: "hls:networkError_manifestLoadError" },
  { host: "la20hd.com", motivo: "dominio inexistente (ENOTFOUND)" },
  { host: "tvf90.com", motivo: "hls:networkError_manifestLoadError" },
  { host: "alilus.github.io", motivo: "m3u8player: 'no se puede reproducir' (102630)" },
  { host: "belami.top", motivo: "HTTP 404 en todos sus enlaces" },
];

const SIN_VIDEO_HOSTS = new Set(SIN_VIDEO.map((x) => x.host));

/** ¿La URL (o el destino al que apunta) está en la lista de sin vídeo? */
export function esSinVideo(url) {
  for (const u of [url, resolveTarget(url).target]) {
    const h = hostOf(u);
    if (h && SIN_VIDEO_HOSTS.has(h.replace(/^www\./, ""))) return true;
  }
  return false;
}

/** Identidad estable de una URL (para comparar sin falsos negativos). */
export function urlIdentity(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  if (s.startsWith("/")) return s;
  try {
    const u = new URL(s);
    u.hash = "";
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (u.pathname !== "/") out = out.replace(/\/+$/, "");
    return out;
  } catch {
    return s;
  }
}

/** Tipo de enlace: hls (reproducible directo), embed, player o page. */
export function classifyUrl(url) {
  const s = String(url ?? "").trim();
  const u = /^https?:\/\//i.test(s) ? s : s;
  const lower = u.toLowerCase();
  if (/\.(m3u8|mpd)(\?|$)/.test(lower) || /[?&](?:type|format)=hls\b/.test(lower)) return "hls";
  if (/\/p\/[\w.-]+\.html(\?|$)/.test(lower) || /(?:^|\/)(?:repro|repron|repro1|repro3|tt|canalmas)\.html(\?|$)/.test(lower)) {
    return "player";
  }
  if (/\/embed[\d/]|embed\.|\.php(\?|$)/.test(lower)) return "embed";
  return "page";
}

function isWrapped(url) {
  return /[?&](r|embed|url|get)=/i.test(String(url));
}

/* ------------------------------------------------------------------ *
 * Categorías
 * ------------------------------------------------------------------ */

const OTA_EXACT = new Set([
  "caracol", "telefe", "el trece", "eltrece", "latina", "mega", "chilevision",
  "tvn", "rcn", "atv", "america tv", "america tv argentina", "panamericana tv",
  "tv publica", "tv publica", "tv peru", "global tv", "guatevision",
  "telepacifico", "telecaribe", "teleislas", "telecafe", "capital", "city tv",
  "canal del congreso", "canal 5", "canal 5 ar", "canal 5 mx", "canal 5 del pueblo",
  "canal 5 el lider", "canal 7", "canal 7 mx", "canal 7 gt", "canal 7 noticias",
  "canal 9", "canal 9 ixchiguan gt", "canal 10", "canal 11", "canal 13",
  "canal 2", "canal 3", "canal 4", "canal 6", "canal 11 gua", "canal 13 gua",
  "canal 14 nic", "canal 2 esa", "canal 3 gua", "canal 3 telesistemas hnd",
  "canal 4 esa", "canal 7 gua", "canal antigua", "canal azteca gua", "canal 27 gt",
  "guatevision gua", "gobierno gua", "11 costa rica", "6 repretel", "tv agro",
  "willax", "faro vision do", "sas tv gt", "vision tv gt", "telemetro",
  "tvn hd", "cbc", "tv 5 monde", "france 24", "euronews", "ewtn", "tbn enlace",
]);

// Canales de deportes conocidos que el nombre no delata (o delata mal).
const SPORTS_EXACT = new Set([
  "arenasports", "arena sports", "aym sport", "bandsports", "cdn deportes", "deportes tvc",
  "deportv", "depor tv", "depor tvc", "eurosports", "eurosport", "eurosport 1", "eurosport 2",
  "gol", "laligahypermotion", "laliga hypermotion", "latin america sport", "prima sport", "teledeporte",
  "wapa deportes", "zona dazn it", "zona dazn", "cbs sports", "cdg deportes",
  "canal del futbol", "futbol", "sport tv pt", "sport tv 1", "sport tv 2",
  "sky sports mexico", "sky sports f1", "sky sports bundesliga", "sky sports premier league",
  "super sports", "tigo sports", "ecdf", "sportv brasil", "sportv brasil 2",
  "sportv brasil 3", "unido 2 sports", "tabil sports", "sports live", "sports tv",
  "sports digital", "tudn vix", "claro sports 2", "dsports plus", "dsports motor",
]);

const CATEGORY_RULES = [
  ["Deportes", /\b(espn|fox sports|fox sport|fox deportes|dazn|tudn|tyc|golperu|gol peru|goltv|dsports|directv sports|win sports|bein|tnt sports|movistar deportes|movistar laliga|movistar liga|la liga|liga 1|liga max|premier league|sky sports|eurosport|nba|nfl|mlb|nhl|tsn|ufc|wwe|sports|sportv|tigo sports|claro sports|super sports|ssc|combate|futbol|futbol libre|mlb network|red bull|motor|billiards)\b/],
  ["Infantiles", /\b(disney|cartoon|nickelodeon|nick jr|tooncast|discovery kids|baby|semillitas|dreamworks|kids|infantil|junior|jr)\b/],
  ["Noticias", /\b(cnn|cnne|news|noticias|noticiero|milenio|adn ?40|ntn24|cronicatv|cnbc|euronews|france ?24|dw|rt|telesur|tele sur|c5n|bbc news|canal 26|24 ?h|24hv|24 horas)\b/],
  ["Películas", /\b(hbo|cinemax|cinecanal|golden|space|amc|tcm|syfy|mgm|paramount|cine|cinema|pelicula|peliculas|film|movie|movies|multiplex|multicinema|a24|universal cinema|universal premiere|universal comedy|universal crime|universal reality|studio universal|star channel|warner)\b/],
  ["Entretenimiento", /\b(tnt|tbs|fx|a and e|history|discovery|nat geo|tlc|lifetime|comedy|distrito comedia|el gourmet|mtv|unicable|pasiones|tlnovelas|novelas|sony|universal tv|usa|e|trutv|hgtv|home and health|film and arts|everything|e!)\b/],
];
const CATEGORY_EXACT = {
  "a and e": "Entretenimiento",
  e: "Entretenimiento",
  "cn": "Películas",
  "love nature": "Entretenimiento",
  "multipremier": "Películas",
  "sonny tv": "Entretenimiento",
  "11 costa rica": "Internacionales",
  "6 repretel": "Internacionales",
  "investigation discovery": "Entretenimiento",
  "discovery theater": "Películas",
  "discovery science": "Entretenimiento",
  "discovery world": "Entretenimiento",
  "discovery turbo": "Entretenimiento",
  tlc: "Entretenimiento",
  premiere: "Deportes",
  "star channel": "Entretenimiento",
  "sony": "Entretenimiento",
  "sony novelas": "Entretenimiento",
  "sony competencias": "Entretenimiento",
  "warner channel": "Entretenimiento",
  syfy: "Entretenimiento",
  "fox sports premium": "Deportes",
  "fox sports 1": "Deportes",
  "dsports motor": "Deportes",
  "tyc sports": "Deportes",
  "gol peru": "Deportes",
  "tudn": "Deportes",
};

const WEAK_CATEGORIES = new Set(["general", "all", "internacionales"]);

export function inferCategory(key, records = []) {
  if (CATEGORY_EXACT[key]) return CATEGORY_EXACT[key];
  if (SPORTS_EXACT.has(key)) return "Deportes";
  if (/\b(sports?|deportes?|futbol|baloncesto)\b/.test(key) && !/\b(tnt sports|fox sports premium)\b/.test(key)) {
    return "Deportes";
  }
  const text = ` ${key} `;
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(text)) return cat;
  }
  if (OTA_EXACT.has(key) || /^canal \d/.test(key) || /^\d+ (costa rica|repretel)$/.test(key)) {
    return "Internacionales";
  }
  // Categorías de los archivos de origen: data2 es el más curado.
  const bySource = [
    ...records.filter((r) => r.source === "data2.json"),
    ...records.filter((r) => r.source === "data1.json"),
    ...records.filter((r) => r.source === "data.json"),
  ];
  for (const r of bySource) {
    const norm = CATEGORY_BY_KEY.get(keyOf(r.category || ""));
    if (!norm) continue;
    if (WEAK_CATEGORIES.has(keyOf(r.category || ""))) continue;
    return norm;
  }
  return "Internacionales";
}

/* ------------------------------------------------------------------ *
 * Imágenes
 * ------------------------------------------------------------------ */

function loadImageIndex(dir) {
  const index = new Map(); // slug de archivo -> nombre de archivo
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file)) continue;
      const base = file.replace(/\.[a-z0-9]+$/i, "");
      index.set(base.toLowerCase(), file);
    }
  } catch { /* sin carpeta de imágenes */ }
  return index;
}

// Ojo: "de" NO se filtra, es el código de Alemania ("dazn-2-de", "dazn-1-de").
const IMAGE_STOP = new Set(["amp", "and", "y", "la", "el", "los", "las", "the", "canal"]);

function imageTokens(text) {
  return keyOf(text)
    .split(" ")
    .filter((t) => t && !IMAGE_STOP.has(t) && !/^(hd|fhd|sd|uhd)$/.test(t));
}

/** Quita tokens repetidos manteniendo el orden: [espn,2,mexico,2] -> [espn,2,mexico]. */
function uniqTokens(tokens) {
  const out = [];
  for (const t of tokens) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * Expande un token con letras y números pegados ("canal5mx" -> canal,5,mx)
 * solo cuando hay 3+ letras juntas, para no romper marcas como "A24" o "C5N".
 */
function expandToken(t) {
  const m = /^([a-z]{3,})(\d+)([a-z]*)$/.exec(t);
  if (m) return [m[1], m[2], ...(m[3] ? [m[3]] : [])];
  const m2 = /^([a-z]*)(\d+)([a-z]{3,})$/.exec(t);
  if (m2) return [...(m2[1] ? [m2[1]] : []), m2[2], m2[3]];
  return [t];
}

export function scoreImage(name, baseSlug) {
  const nameTokens = uniqTokens(imageTokens(name).flatMap(expandToken));
  // Si el nombre trae "canal" se compara también con la versión sin él:
  // "Canal 5 MX" debe casar con "canal5mx", no solo con "5 mx".
  const nameNoCanal = nameTokens.filter((t) => t !== "canal");
  const fileTokens = uniqTokens(
    keyOf(baseSlug)
      .split(" ")
      .flatMap(expandToken)
      // el filtro va después de expandir: "canal5mx" suelta "canal"
      .filter((t) => t && !IMAGE_STOP.has(t) && !/^(hd|fhd|sd|uhd)$/.test(t)),
  );
  const scoreSets = (a, b) => {
    if (!a.length || !b.length) return 0;
    const A = new Set(a);
    const B = new Set(b);
    const inter = [...A].filter((t) => B.has(t)).length;
    if (inter === A.size && inter === B.size) return 1;
    if (inter === A.size || inter === B.size) {
      return 0.5 + 0.25 * (inter / new Set([...A, ...B]).size);
    }
    return (inter / new Set([...A, ...B]).size) * 0.8;
  };
  return Math.max(scoreSets(nameTokens, fileTokens), scoreSets(nameNoCanal, fileTokens));
}

const IMAGE_HINTS = {
  "gol peru": "golperu.png",
  "america tv": "america-tv.webp",
  "america tv argentina": "americatvar-html.jpg",
  "canal 5": "canal-5.webp",
  "canal 5 mx": "canal5mx.png",
  "a and e": "",
  "discovery home and health": "discovery-h-amp-h.webp",
  "investigation discovery": "discovery-id.png",
  "discovery channel": "discovery-channel.webp",
  "golden edge": "golden-edge-2.webp",
  "golden plus": "golden-plus-2.webp",
  "win sports plus": "win-sports.jpg",
  "tnt sports chile": "tnt-sports-chile.png",
  "tv publica": "tvpublica.png",
  "film and arts": "film-art.svg",
  "news": "dnews.webp",
};

/** Candidatos de imagen con su puntuación, de mayor a menor. */
function imageCandidates({ key, names, candidates, requireStrong }, imageIndex) {
  const scoreFor = (name, base) => scoreImage(name, base);
  const out = [];
  const seen = new Set();
  const push = (score, file) => {
    const url = `${RAW_BASE}/${file}`;
    if (out.some((o) => o.url === url)) return;
    out.push({ score, url });
  };

  // 1. Pistas manuales
  const hint = IMAGE_HINTS[key];
  if (hint) {
    const file = imageIndex.get(hint.replace(/\.[a-z0-9]+$/i, "").toLowerCase());
    if (file) { push(1, file); seen.add(file.toLowerCase()); }
  }

  // 2. Mejor logo local por nombre
  for (const [base, file] of imageIndex) {
    if (seen.has(file.toLowerCase())) continue;
    let score = 0;
    for (const name of names) score = Math.max(score, scoreFor(name, base.toLowerCase()));
    if (score >= (requireStrong ? 0.97 : 0.9)) push(score, file);
  }

  // 3. Imágenes locales ya referenciadas por los archivos de origen
  for (const url of candidates) {
    const m = /\/img\/canales\/([^/?#]+)$/i.exec(String(url || ""));
    if (!m) continue;
    const file = imageIndex.get(m[1].toLowerCase().replace(/\.[a-z0-9]+$/i, ""));
    if (!file) continue;
    const score = Math.max(...names.map((n) => scoreImage(n, file.replace(/\.[a-z0-9]+$/i, "").toLowerCase())));
    if (score >= (requireStrong ? 0.95 : 0.85)) push(score - 0.02, file);
  }

  // 4. Hotlinks: solo si el archivo se llama como el canal (evita tvenvivo.webp)
  for (const url of candidates) {
    if (!/^https?:\/\//i.test(String(url || ""))) continue;
    if (/raw\.githubusercontent\.com\/belkaperu\/belkafut\/img\/canales\//i.test(url)) continue;
    let base = "";
    try { base = path.basename(new URL(url).pathname).replace(/\.[a-z0-9]+$/i, "").toLowerCase(); } catch { continue; }
    if (!base) continue;
    const score = Math.max(...names.map((n) => scoreImage(n, base)));
    if (score >= 0.92) out.push({ score: score - 0.05, url: url.trim() });
  }
  // Desempate: el archivo que reproduce el nombre exactamente
  // ("espn-2.webp" antes que "espn-2-2.webp"), y luego el más corto.
  const baseOf = (url) => url.split("/").pop().replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const keySlug = key.replace(/\s+/g, "-");
  const exact = (url) => (baseOf(url) === keySlug || baseOf(url) === keySlug.replace(/-/g, "") ? 0 : 1);
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      exact(a.url) - exact(b.url) ||
      baseOf(a.url).length - baseOf(b.url).length ||
      a.url.localeCompare(b.url),
  );
}

/**
 * Asigna imágenes evitando repetir la misma entre canales distintos:
 * primero se queda el canal cuyo nombre coincide mejor con el archivo.
 */
/**
 * Etiquetas de opciones repetidas entre canales: se quedan con el nombre del
 * canal dueño del enlace ("ESPN 2 HD" dentro de ESPN Brasil, no "ESPN 2").
 */
function dedupeOptionLabels(channels) {
  const owners = new Map(); // label normalizada -> canal
  for (const ch of channels) {
    for (const o of ch.options) {
      const k = o.label.toLowerCase();
      if (!owners.has(k)) owners.set(k, ch);
      else if (owners.get(k) !== ch) {
        const host = playerName(o.url);
        let base = `${o.label} · ${host}`;
        let n = 2;
        while (owners.has(base.toLowerCase())) base = `${o.label} · ${host} ${n++}`;
        o.label = base;
        owners.set(base.toLowerCase(), ch);
      }
    }
  }
}

function assignImages(channels, imageIndex) {
  for (const ch of channels) {
    const requireStrong = /\d/.test(ch.normalized_name) || /^sky cinema/.test(ch.normalized_name);
    ch._imgList = imageCandidates(
      {
        key: ch.normalized_name,
        names: [...new Set([ch.name, ...(ch.aliases || []), ...(ch._sourceNames || [])])],
        candidates: ch._imageRefs || [],
        requireStrong,
      },
      imageIndex,
    );
  }
  const requests = channels.map((ch) => ({ ch, list: ch._imgList }));
  const flat = [];
  for (const { ch, list } of requests) {
    for (const c of list) flat.push({ ch, ...c });
  }
  flat.sort((a, b) => b.score - a.score || a.ch.normalized_name.localeCompare(b.ch.normalized_name));
  const usedUrls = new Set();
  const assigned = new Set();
  for (const item of flat) {
    if (assigned.has(item.ch.normalized_name)) continue;
    if (usedUrls.has(item.url) && item.score < 0.99) continue;
    usedUrls.add(item.url);
    assigned.add(item.ch.normalized_name);
    item.ch.imageUrl = item.url;
  }
  for (const ch of channels) if (!ch.imageUrl) ch.imageUrl = null;
}

/* ------------------------------------------------------------------ *
 * Lectura de los archivos de origen
 * ------------------------------------------------------------------ */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Normaliza los tres formatos a una lista de registros intermedios. */
export function collectRecords(docs) {
  const records = [];
  const push = (source, rawName, category, image, streams) => {
    const name = cleanName(rawName);
    if (!name) return;
    const valid = streams
      .map((s) => ({ ...s, url: String(s.url ?? "").trim() }))
      .filter((s) => s.url);
    if (!valid.length) return;
    records.push({ source, name, category: category || null, image: image || null, streams: valid });
  };

  for (const ch of docs.data?.channels || []) {
    push("data.json", ch.name, null, ch.imageUrl, (ch.servers || []).map((s) => ({ url: s.url, label: s.name, section: "servers" })));
  }
  for (const ch of docs.data1?.canales || []) {
    push("data1.json", ch.title, ch.category, ch.image, (ch.options || []).map((o) => ({ url: o.url, label: o.label, section: "options" })));
  }
  for (const ch of docs.data2?.channels || []) {
    push("data2.json", ch.name, ch.category, ch.imageUrl, (ch.servers || []).map((s) => ({ url: s.url, label: s.name, section: "servers" })));
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * Merges
 * ------------------------------------------------------------------ */

const SOURCE_RANK = { "data1.json": 0, "data2.json": 1, "data.json": 2 };

const DISPLAY_BY_KEY = new Map();
for (const [k, v] of Object.entries(DISPLAY_NAMES)) DISPLAY_BY_KEY.set(keyOf(k), v);

function pickDisplayName(key, records, displayTable = {}) {
  if (displayTable[key]) return displayTable[key];
  if (DISPLAY_BY_KEY.has(key)) return DISPLAY_BY_KEY.get(key);
  const scored = records
    .map((r) => {
      const cleaned = cleanName(r.name);
      const hasLower = /[a-záéíóúüñ]/.test(cleaned);
      const hasUpper = /[A-ZÁÉÍÓÚÜÑ]/.test(cleaned);
      let score = 0;
      if (hasLower && hasUpper) score += 4;
      if (/\s/.test(cleaned)) score += 2;
      if (!hasUpper || !hasLower) score -= 1;
      score += (3 - (SOURCE_RANK[r.source] ?? 3)) * 0.5;
      score -= Math.max(0, cleaned.length - 32) * 0.1;
      return { cleaned, score };
    })
    .sort((a, b) => b.score - a.score);
  return smartTitle(scored[0]?.cleaned || key);
}

/** Nombre del stream final de una URL envuelta ("...stream=dazn2" -> "dazn2"). */
/** Un host como etiqueta: "tvf90.com" -> "tvf90" (sin puntos ni "www"). */
function sanitizeLabel(text) {
  return String(text || "")
    .replace(/^www\./i, "")
    .replace(/\.[a-z]{2,6}$/i, "")
    .trim();
}

/** Nombre corto y legible del reproductor de una URL relativa (/p/repro1.html). */
function playerName(url) {
  const m = /\/p\/([a-z0-9_-]+)\.html/i.exec(String(url));
  if (m) return m[1];
  return sanitizeLabel(hostOf(url)) || "player";
}

function streamName(url) {
  const target = resolveTarget(url).target;
  try {
    const u = new URL(target, "http://local");
    for (const k of ["stream", "canal", "channel", "id"]) {
      const v = u.searchParams.get(k);
      if (v) return String(v).slice(0, 24);
    }
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    return last.replace(/\.[a-z0-9]+$/i, "").slice(0, 24) || hostOf(url) || "player";
  } catch {
    return hostOf(url) || "player";
  }
}

function serverLabel(url) {
  const host = hostOf(url);
  if (host) return host;
  const kind = classifyUrl(url);
  if (kind === "hls") return "HLS";
  if (kind === "embed") return "Embed";
  if (kind === "player") return "Reproductor";
  return "Enlace";
}

/** Orden de los enlaces: HLS directo primero; luego embeds y reproductores. */
function streamRank(url) {
  const kind = classifyUrl(url);
  return { hls: 0, embed: 1, page: 2, player: 3 }[kind] ?? 4;
}

/** Preferencia entre dos enlaces que llevan al mismo destino. */
function compareCandidates(a, b) {
  const wrapA = isWrapped(a.url) ? 1 : 0;
  const wrapB = isWrapped(b.url) ? 1 : 0;
  if (wrapA !== wrapB) return wrapA - wrapB; // directo antes que envuelto
  const reprA = /repron/i.test(a.url) ? 0 : 1;
  const reprB = /repron/i.test(b.url) ? 0 : 1;
  if (reprA !== reprB) return reprA - reprB;
  if (a.layers.length !== b.layers.length) return a.layers.length - b.layers.length;
  const srcA = SOURCE_RANK[a.source] ?? 9;
  const srcB = SOURCE_RANK[b.source] ?? 9;
  if (srcA !== srcB) return srcA - srcB;
  // A igualdad, la cadena con envoltorio del repo (/p/...?r=repron?r=) es la
  // que usan las apps de Android/iOS.
  const repoA = /belkaperu\.github\.io/i.test(a.url) ? 0 : 1;
  const repoB = /belkaperu\.github\.io/i.test(b.url) ? 0 : 1;
  if (repoA !== repoB) return repoA - repoB;
  return a.url.length - b.url.length;
}

const PALABRAS_PROVEEDOR = new Set([
  "embed", "m3u", "m3u8", "player", "reproductor", "op", "op1", "op2", "op3",
  "server", "servidor", "link", "enlace", "hd", "sd", "ver", "canal", "online",
  "direto", "directo", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
]);

function cleanLabel(raw, fallback) {
  let s = cleanName(raw);
  s = s.replace(/\s{2,}/g, " ");
  if (!s) return fallback;
  if (PALABRAS_PROVEEDOR.has(s.toLowerCase())) return fallback;
  return s;
}

/**
 * Une registros del mismo canal y deduplica enlaces.
 * Devuelve { servers, options, urlsEliminadas }.
 */
export function mergeStreams(records) {
  const byTarget = new Map();
  let exactDropped = 0;
  let sinVideoDropped = 0;
  const seenExact = new Set();

  for (const r of records) {
    for (const st of r.streams) {
      const id = urlIdentity(st.url);
      if (!id) continue;
      if (esSinVideo(st.url)) { sinVideoDropped++; continue; }
      if (seenExact.has(id)) { exactDropped++; continue; }
      seenExact.add(id);
      const { layers, target } = resolveTarget(st.url);
      const tid = urlIdentity(target) || id;
      const candidate = {
        url: st.url,
        label: st.label,
        section: st.section,
        source: r.source,
        layers,
        target: tid,
      };
      const prev = byTarget.get(tid);
      if (!prev || compareCandidates(candidate, prev) < 0) byTarget.set(tid, candidate);
    }
  }

  const chosen = [...byTarget.values()];
  const servers = [];
  const options = [];
  for (const c of chosen) {
    if (c.section === "options") options.push(c);
    else servers.push(c);
  }

  servers.sort((a, b) => streamRank(a.url) - streamRank(b.url) || (hostOf(a.url) || a.url).localeCompare(hostOf(b.url) || b.url));
  options.sort((a, b) => (a.label || "").localeCompare(b.label || "", "es") || a.url.localeCompare(b.url));

  // Nombres únicos y legibles para los servidores: si la etiqueta original no
  // aporta (un número suelto, "OP", "M3U"...) se usa el proveedor (host).
  const serverOut = [];
  const usedNames = new Map();
  for (const s of servers) {
    const raw = cleanLabel(s.label, "");
    const generic = !raw || /^\d{1,2}$/.test(raw) || PALABRAS_PROVEEDOR.has(raw.toLowerCase());
    const base = generic ? serverLabel(s.url) : raw;
    const n = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, n);
    serverOut.push({ name: n === 1 ? base : `${base} (${n})`, url: s.url });
  }

  // Etiquetas de las opciones: si dos traen la misma etiqueta, la que no
  // corresponde al canal es un residuo, así que estrena etiqueta propia.
  const optionOut = [];
  const usedLabels = new Set();
  const norm = (s) => s.trim().toLowerCase();
  // Sufijo que desambigua: el proveedor si es conocido, si no el stream final.
  const suffixOf = (url) => {
    try {
      const u = new URL(url, "http://local");
      const host = u.hostname.replace(/^www\./, "");
      if (host && !/^(local|localhost)$/.test(host)) return host;
      return streamName(url);
    } catch {
      return streamName(url);
    }
  };
  for (const o of options) {
    const host = playerName(o.url);
    // Partes de la etiqueta original: "ESPN2 · tvf90.com" -> ["ESPN2", "tvf90"]
    const parts = cleanLabel(o.label, host)
      .split("·")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (/^[\w-]+(\.[\w-]+)+$/.test(p) ? sanitizeLabel(p) : p));
    const core = parts[0] || sanitizeLabel(host);
    const originalSuffixes = parts.slice(1);

    // Etiqueta = nombre del propio canal ("real" para "Real"): se le añade el
    // destino solo si aporta algo distinto.
    let baseCore = core;
    if (norm(o.label) === core.toLowerCase()) {
      const extra = streamName(o.url);
      const a = keyOf(core);
      const b = keyOf(extra);
      if (b && a !== b && !a.includes(b) && !b.includes(a)) baseCore = `${core} · ${extra}`;
    }

    // Etiquetas que no dicen nada ("OP SD", "enlace", "1"): se acompañan del proveedor
    const generica =
      PALABRAS_PROVEEDOR.has(baseCore.toLowerCase()) ||
      /^op(\s*(hd|sd|fhd|\d))?$/.test(baseCore.toLowerCase());
    if (generica) baseCore = `${baseCore} · ${suffixOf(o.url)}`;

    const usados = new Set();
    const has = (l) => usedLabels.has(l) || usados.has(l);
    const keyIn = (l, x) => keyOf(l).includes(keyOf(x));

    // Candidatos de sufijo, en orden de utilidad: los que ya traía la etiqueta,
    // el stream final y el proveedor.
    const extras = [...originalSuffixes, streamName(o.url), suffixOf(o.url)].filter(
      (x, i, arr) => x && arr.indexOf(x) === i && keyOf(x),
    );

    let base = baseCore;
    if (has(base.toLowerCase())) {
      const extra = extras.find((x) => !keyIn(baseCore, x));
      if (extra) base = `${baseCore} · ${extra}`;
    }
    // Sin candidatos nuevos: numerar ("Fox Sports · tvf90.com 2") en vez de
    // repetir el mismo sufijo (antes eso dejaba el while dando vueltas).
    let n = 2;
    while (has(base.toLowerCase())) {
      const extra = extras.find((x) => !keyIn(base, x));
      base = extra ? `${baseCore} · ${extra}` : `${baseCore} ​${n}`.replace("​", "·");
      usados.add(base.toLowerCase());
      n++;
      if (n > 50) break;
    }
    usedLabels.add(base.toLowerCase());
    optionOut.push({ label: base, url: o.url });
  }

  return { servers: serverOut, options: optionOut, exactDropped, sinVideoDropped, targetDropped: exactDropped + 0 };
}

function uniqueSlug(base, used) {
  let slug = slugOf(base);
  if (!used.has(slug)) { used.add(slug); return slug; }
  let i = 2;
  while (used.has(`${slug}-${i}`)) i++;
  used.add(`${slug}-${i}`);
  return `${slug}-${i}`;
}

/* ------------------------------------------------------------------ *
 * Deduplicación entre canales
 * ------------------------------------------------------------------ */

function nameTokens(name) {
  return keyOf(name).split(" ").filter((t) => t && !/^(?:hd|sd|fhd|op\d?)$/.test(t));
}

/**
 * El mismo destino (embed, HLS) aparece en dos canales distintos: casi siempre
 * es un enlace mal copiado o un embed que sirve a varias señales. Se conserva
 * en el canal cuyo nombre coincide mejor con la URL y, si el otro canal se
 * quedaría sin ningún enlace, se le deja igualmente.
 * Devuelve la cantidad de enlaces quitados.
 */
const CHANNEL_NUM = /\b(\d{1,3})\s*$/;

function dedupeAcrossChannels(channels) {
  const byTarget = new Map(); // targetId -> [{ ch, kind, index, url }]
  for (const ch of channels) {
    for (const kind of ["servers", "options"]) {
      ch[kind].forEach((item, index) => {
        const { target } = resolveTarget(item.url);
        const id = urlIdentity(target) || urlIdentity(item.url);
        if (!byTarget.has(id)) byTarget.set(id, []);
        byTarget.get(id).push({ ch, kind, index, url: item.url, id });
      });
    }
  }
  const removals = []; // { ch, kind, index, keeper }
  for (const [id, items] of byTarget) {
    if (new Set(items.map((i) => i.ch.normalized_name)).size < 2) continue;
    // ¿A qué canal "pertenece" la URL? (sus palabras dentro de la URL)
    const idText = keyOf(id.replace(/[?&=#/._-]+/g, " "));
    const scoreOf = (ch) => {
      const tokens = nameTokens(ch.name);
      if (!tokens.length) return 0;
      const hit = tokens.filter((t) => idText.split(" ").includes(t)).length;
      return hit / tokens.length;
    };
    // Se queda en el canal que más lo necesita (menos enlaces propios), a
    // igualdad en el que mejor coincide con la URL y, si sigue el empate, por
    // orden natural ("Sky Premiere 1" gana a "Sky Premiere 10").
    const linksOf = (ch) => ch.servers.length + ch.options.length;
    const nat = (a, b) => a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" });
    const ranked = [...items].sort(
      (a, b) =>
        linksOf(a.ch) - linksOf(b.ch) ||
        scoreOf(b.ch) - scoreOf(a.ch) ||
        nat(a.ch, b.ch),
    );
    const keeper = ranked[0];
    for (const item of ranked.slice(1)) {
      if (item.ch.normalized_name === keeper.ch.normalized_name) continue;
      removals.push({ ...item, keeper });
    }
  }
  const byChannel = new Map();
  for (const r of removals) {
    if (!byChannel.has(r.ch)) byChannel.set(r.ch, []);
    byChannel.get(r.ch).push(r);
  }
  let removed = 0;
  const emptied = [];
  for (const [ch, list] of byChannel) {
    const drop = new Set(list.map((r) => `${r.kind}:${r.index}`));
    const before = ch.servers.length + ch.options.length;
    ch.servers = ch.servers.filter((_, i) => !drop.has(`servers:${i}`));
    ch.options = ch.options.filter((_, i) => !drop.has(`options:${i}`));
    removed += before - (ch.servers.length + ch.options.length);
    if (!ch.servers.length && !ch.options.length) {
      emptied.push({ ch, keeper: list[list.length - 1].keeper.ch });
    }
  }
  // El canal que se quedó vacío no se pierde: su nombre pasa a ser alias del
  // canal que sí tiene el stream (mismo stream, dos nombres). En meta queda la
  // lista de estos canales absorbidos para poder revisarlos.
  for (const { ch, keeper } of emptied) {
    const alias = ch.name.trim();
    if (!alias || !keeper) continue;
    keeper.aliases = Array.isArray(keeper.aliases) ? keeper.aliases : [];
    // Los alias automáticos llevan "~" delante para distinguirlos de los que
    // vienen de los archivos de origen (esos son nombres reales del canal).
    if (!keeper.aliases.some((a) => keyOf(a) === keyOf(alias))) keeper.aliases.push(alias);
    keeper.aliases.sort((a, b) => a.localeCompare(b, "es"));
  }
  const absorbed = emptied.map(({ ch, keeper }) => ({ nombre: ch.name, alias_de: keeper?.name || null }));
  return { removed, keptShared: emptied.length, absorbed };
}

/**
 * Ids de canales que se quedaron sin enlaces (sus enlaces compartidos pasaron
 * al canal correcto): se informan en meta, no se borran en silencio.
 */
function channelsWithoutLinks(channels) {
  return channels.filter((c) => !c.servers.length && !c.options.length).map((c) => c.name);
}

/**
 * Última pasada: un enlace exacto no puede estar en dos lados del archivo.
 * Se queda donde ya estaba (catálogo con nombre) y solo se quita de
 * `sin_identificar`, que es la sección de descarte.
 */
function dedupeAcrossSections(channels, sinIdentificar) {
  const used = new Set();
  for (const ch of channels) {
    for (const item of [...ch.servers, ...ch.options]) {
      used.add(urlIdentity(item.url));
      used.add(urlIdentity(resolveTarget(item.url).target));
    }
  }
  const keepUnique = (list) =>
    list.filter((s) => {
      const id = urlIdentity(s.url);
      const tid = urlIdentity(resolveTarget(s.url).target);
      if (used.has(id) || used.has(tid)) return false;
      used.add(id);
      used.add(tid);
      return true;
    });
  let removed = 0;
  for (const x of sinIdentificar) {
    const before = x.servers.length + (x.options?.length || 0);
    x.servers = keepUnique(x.servers);
    if (x.options) {
      x.options = keepUnique(x.options);
      if (!x.options.length) delete x.options;
    }
    removed += before - (x.servers.length + (x.options?.length || 0));
  }
  const vacios = sinIdentificar.filter((x) => !x.servers.length && !x.options?.length).map((x) => x.name);
  return { removed, vacios };
}

/* ------------------------------------------------------------------ *
 * Construcción del documento
 * ------------------------------------------------------------------ */

/**
 * Construye el documento unificado (función pura, sin tocar disco).
 * @param {object} docs  { data, data1, data2 }
 * @param {object} opts  { imageIndex, displayNames, generatedAt }
 */
export function buildUnified(docs, opts = {}) {
  const imageIndex = opts.imageIndex || new Map();
  const displayNames = opts.displayNames || DISPLAY_NAMES;
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const updatedAt = generatedAt.slice(0, 10);
  const records = collectRecords(docs);

  const groups = new Map();
  const unidentified = [];
  for (const rec of records) {
    if (isJunkName(rec.name)) {
      unidentified.push(rec);
      continue;
    }
    const key = mergeKey(rec.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  const usedKeys = new Set();
  const channels = [];
  const stats = {
    canales_fusionados: 0,
    nombres_absorvidos: 0,
    urls_exactas_eliminadas: 0,
    urls_compartidas_eliminadas: 0,
    enlaces_duplicados_entre_secciones: 0,
    canales_sin_imagen: 0,
    canales_sin_enlaces: 0,
    canales_descartados: [],
    canales_con_stream_compartido: 0,
    canales_absorbidos: [],
  };

  for (const [key, recs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "es"))) {
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const names = [...new Set(recs.map((r) => cleanName(r.name)))];
    const display = pickDisplayName(key, recs, displayNames);
    const { servers, options, exactDropped } = mergeStreams(recs);
    stats.urls_exactas_eliminadas += exactDropped;

    if (names.length > 1 || recs.length > 1) {
      stats.canales_fusionados++;
      stats.nombres_absorvidos += Math.max(0, names.length - 1);
    }
    if (!servers.length && !options.length) { stats.canales_sin_enlaces++; continue; }

    // Alias: nombres de los archivos de origen distintos del nombre visible
    const aliasSet = new Set();
    const displayLoose = keyOf(display);
    for (const n of names) {
      const loose = keyOf(n);
      if (!loose || loose === displayLoose) continue;
      aliasSet.add(n);
    }
    // "ESPN HD" -> "ESPN" ya está en display/aliases: sobra
    for (const alias of [...aliasSet]) {
      const loose = keyOf(alias);
      if (loose === displayLoose) aliasSet.delete(alias);
    }
    const aliases = [...aliasSet].sort((a, b) => a.localeCompare(b, "es"));

    const category = inferCategory(key, recs);
    const sources = [...new Set(recs.map((r) => r.source))];

    channels.push({
      name: display,
      title: display,
      normalized_name: key,
      category,
      imageUrl: null,
      servers,
      options,
      // metadatos internos (se usan al asignar imágenes y se quitan al final)
      _imageRefs: recs.map((r) => r.image).filter(Boolean),
      _sourceNames: names,
      _aliases: aliases,
      _sources: sources,
    });
  }

  assignImages(channels, imageIndex);
  dedupeOptionLabels(channels);
  for (const ch of channels) {
    delete ch._imageRefs; delete ch._imgList; delete ch._sourceNames;
    delete ch._aliases; delete ch._sources;
  }
  const crossResult = dedupeAcrossChannels(channels);
  stats.urls_compartidas_eliminadas = crossResult.removed;
  stats.canales_con_stream_compartido = crossResult.keptShared;
  stats.canales_absorbidos = crossResult.absorbed;
  stats.canales_sin_imagen = channels.filter((c) => !c.imageUrl).length;
  const vacios = channelsWithoutLinks(channels);
  stats.canales_descartados = vacios;
  stats.canales_sin_enlaces = vacios.length;
  for (const name of vacios) {
    const idx = channels.findIndex((c) => c.name === name);
    if (idx !== -1) channels.splice(idx, 1);
  }

  // Mismo orden que el archivo original: alfabético por nombre.
  channels.sort((a, b) => a.name.localeCompare(b.name, "es"));

  // Canales sin nombre útil: se conservan aparte, sin mezclarse con el catálogo
  const unidentGroups = new Map();
  for (const rec of unidentified) {
    const key = keyOf(rec.name) || "sin nombre";
    if (!unidentGroups.has(key)) unidentGroups.set(key, []);
    unidentGroups.get(key).push(rec);
  }
  const sinIdentificar = [];
  let unidentifiedStreams = 0;
  const familias = new Map(); // motivo -> { nombres, streams }
  const motivoDe = (key) => {
    if (/^\d+$/.test(key)) return "numericos";
    if (/^\d{4}\s/.test(key)) return "restos_de_eventos";
    // Los "Canal A0xx" NO se apartan: así estaban en el archivo original y
    // quitarlos cambiaría el contenido del catálogo, no solo su estructura.
    return null;
  };
  for (const [key, recs] of [...unidentGroups.entries()].sort((a, b) => a[0].localeCompare(b[0], "es"))) {
    const names = [...new Set(recs.map((r) => cleanName(r.name)))];
    // Se conservan servidores y reproductores: antes solo se miraban los
    // servidores y un canal que únicamente traía reproductor perdía su enlace.
    const { servers, options } = mergeStreams(recs);
    const enlaces = [...servers, ...options];
    if (!enlaces.length) continue;
    unidentifiedStreams += enlaces.length;
    const familia = motivoDe(key);
    if (familia) {
      if (!familias.has(familia)) familias.set(familia, { nombres: [], streams: [], porDestino: new Map() });
      const f = familias.get(familia);
      f.nombres.push(...names);
      for (const s of enlaces) {
        const id = urlIdentity(resolveTarget(s.url).target) || urlIdentity(s.url);
        if (!f.porDestino.has(id)) f.porDestino.set(id, s);
      }
      continue;
    }
    sinIdentificar.push({
      name: names[0] || "Sin identificar",
      normalized_name: key,
      motivo: "sin_nombre_util",
      ...(names.length > 1 ? { nombres: names } : {}),
      servers,
      ...(options.length ? { options } : {}),
    });
  }
  for (const [familia, f] of familias) {
    sinIdentificar.push({
      name: {
        numericos: "Canales numericos sin nombre",
        restos_de_eventos: "Restos de eventos (fecha/hora)",
        placeholders_proveedor: "Placeholders del proveedor (Canal A0xx)",
      }[familia],
      motivo: familia,
      cantidad: f.nombres.length,
      nombres: [...new Set(f.nombres)].sort((a, b) => a.localeCompare(b, "es")),
      servers: [...f.porDestino.values()],
    });
  }

  const cross = dedupeAcrossSections(channels, sinIdentificar);
  stats.enlaces_duplicados_entre_secciones = cross.removed;
  // Los canales sin nombre útil NO entran al archivo: solo se informan por
  // consola para no cambiar el esquema (raíz = categories + channels).
  const sinIdentificarFiltrado = sinIdentificar.filter((x) => x.servers.length || x.options?.length);

  // Se quitan los metadatos internos y se dejan SOLO los campos originales,
  // en el mismo orden que el archivo de siempre.
  const channelsOut = channels.map((ch) =>
    Object.fromEntries(CHANNEL_FIELDS.map((k) => [k, ch[k]])),
  );

  const doc = {
    // Mismo orden de claves que el archivo original: display_name, icon, name.
    categories: CATEGORIES.map((c) => ({ display_name: c.display_name, icon: c.icon, name: c.name })),
    channels: channelsOut,
  };
  // Resumen para la CLI: propiedad NO enumerable, así JSON.stringify y
  // Object.keys solo ven {categories, channels}.
  Object.defineProperty(doc, "summary", { value: {
    generado: generatedAt,
    fuentes: {
      "data.json": docs.data?.channels?.length ?? 0,
      "data1.json": docs.data1?.canales?.length ?? 0,
      "data2.json": docs.data2?.channels?.length ?? 0,
    },
    servidores: channelsOut.reduce((n, c) => n + c.servers.length, 0),
    opciones: channelsOut.reduce((n, c) => n + c.options.length, 0),
    con_imagen: channelsOut.filter((c) => c.imageUrl).length,
    fusionados: stats.canales_fusionados,
    nombres_absorvidos: stats.nombres_absorvidos,
    urls_repetidas_eliminadas: stats.urls_exactas_eliminadas,
    urls_compartidas_eliminadas: stats.urls_compartidas_eliminadas,
    canales_absorbidos: stats.canales_absorbidos,
    canales_sin_imagen: stats.canales_sin_imagen,
    sin_identificar: sinIdentificarFiltrado,
  }, enumerable: false });
  return doc;
}

/* ------------------------------------------------------------------ *
 * Validación del resultado
 * ------------------------------------------------------------------ */

/** Comprueba que no queden ids, claves ni URLs repetidas. */
export function validateUnified(doc) {
  const problems = [];
  const keys = new Set();
  const catNames = new Set();
  for (const c of doc.categories || []) {
    if (catNames.has(c.name)) problems.push(`categoría repetida: ${c.name}`);
    catNames.add(c.name);
    for (const k of Object.keys(c)) {
      if (!["name", "display_name", "icon"].includes(k)) problems.push(`campo extra en categoría: ${k}`);
    }
  }
  for (const k of Object.keys(doc)) {
    if (!["categories", "channels"].includes(k)) problems.push(`sección extra en la raíz: ${k}`);
  }
  for (const ch of doc.channels || []) {
    for (const k of Object.keys(ch)) {
      if (!CHANNEL_FIELDS.includes(k)) problems.push(`campo extra en ${ch.name}: ${k}`);
    }
    if (keys.has(ch.normalized_name)) problems.push(`clave repetida: ${ch.normalized_name}`);
    keys.add(ch.normalized_name);
    const urls = new Set();
    for (const s of [...(ch.servers || []), ...(ch.options || [])]) {
      const id = urlIdentity(s.url);
      if (urls.has(id)) problems.push(`URL repetida en ${ch.name}: ${s.url}`);
      urls.add(id);
    }
    if (!ch.servers?.length && !ch.options?.length) problems.push(`canal sin enlaces: ${ch.name}`);
    if (!CATEGORY_ORDER.has(ch.category)) problems.push(`categoría inválida en ${ch.name}: ${ch.category}`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const L = makeLogger("unificado");
  L.setVerbose(!!args.verbose);
  const { log, warn } = L;

  const apply = !!args.apply;
  const outPath = path.resolve(String(args.out || path.join(__dirname, "data_unificado.json")));
  const docs = {
    data: readJson(path.join(__dirname, "data.json")),
    data1: readJson(path.join(__dirname, "data1.json")),
    data2: readJson(path.join(__dirname, "data2.json")),
  };
  const imageIndex = loadImageIndex(path.join(__dirname, "img", "canales"));
  const doc = buildUnified(docs, { imageIndex });
  const problems = validateUnified(doc);

  const S = doc.summary;
  const total = doc.channels.length;
  log(`Fuentes: data.json ${S.fuentes["data.json"]} · data1.json ${S.fuentes["data1.json"]} · data2.json ${S.fuentes["data2.json"]}`);
  log(`Canales: ${total} (${S.fusionados} fusionados, ${S.nombres_absorvidos} nombres absorbidos)`);
  log(`Enlaces: ${S.servidores + S.opciones} (${S.urls_repetidas_eliminadas} URLs repetidas eliminadas)`);
  log(`Con imagen: ${S.con_imagen}/${total} · sin imagen: ${S.canales_sin_imagen}`);
  const sinId = S.sin_identificar;
  const sinIdEnlaces = sinId.reduce((n, x) => n + x.servers.length + (x.options?.length || 0), 0);
  log(`Sin identificar (descartados, no van al archivo): ${sinId.length} entradas, ${sinIdEnlaces} enlaces`);
  if (problems.length) {
    warn(`Validación: ${problems.length} problema(s)`);
    problems.slice(0, 20).forEach((p) => warn(`  - ${p}`));
  } else {
    log("Validación: esquema original y sin claves ni URLs repetidas ✔");
  }

  if (args.verbose) {
    for (const c of doc.channels) {
      log(`${c.category.padEnd(16)} ${c.name.padEnd(32)} ${c.servers.length}S/${c.options.length}O ${c.imageUrl ? "🖼" : "—"}`);
    }
  }

  if (!apply) {
    log("Simulación: usa --apply para escribir el archivo");
    return;
  }
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  log(`Escrito ${path.relative(__dirname, outPath)} (${kb} KB)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
