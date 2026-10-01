#!/usr/bin/env node
/**
 * OBSOLETO. Antes scrapeaba futbollibre.com / trajiraroja.com con axios+cheerio
 * y escribía data1.json como un array suelto (formato incorrecto).
 *
 * Ahora lo reemplaza update-canales.mjs, que:
 *   - no usa dependencias,
 *   - busca el dominio vivo de futbollibre en Google/Bing/DuckDuckGo,
 *   - entra a su agenda y páginas de canal y extrae la URL real del stream,
 *   - verifica cada URL antes de agregarla a data1.json.
 *
 * Este archivo solo existe para no romper enlaces viejos.
 */
console.warn("[scrape-canales] Obsoleto: redirigiendo a update-canales.mjs …");
console.warn("[scrape-canales] Uso: node update-canales.mjs [--apply] [--only-channel=ESPN]");

import("./update-canales.mjs");
