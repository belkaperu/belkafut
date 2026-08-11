#!/usr/bin/env node
// Update embed links inside data1.json from the live embed site.
// Works with Node 20+ (global fetch), no external dependencies.
//
// Behavior:
//   1. Probes the embed homepage (SOURCE_URL or a list of candidate domains).
//   2. Detects the current live domain + extracts the real embed2/... URLs
//      from every channel card page.
//   3. Rewrites data1.json so every URL pointing at any known embed.* host
//      now points to the live domain, and corrects embed2 slugs when the
//      site renamed them (e.g. espnpremium.php -> espnpremiumlat.php).
//   4. Emits GITHUB_OUTPUT changed=true/false and the detected domain.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_URL = process.env.SOURCE_URL || "";
const TARGET_FILE = process.env.TARGET_FILE || "data1.json";
const TIMEOUT_MS = 20000;

const DOMAIN_RE = /(?:https?:\/\/)?embed\.[a-z0-9-]+\.(?:fun|com|net|org|xyz|live|top)[^\s"'<>\\]*/gi;
const EMBED_HOST_RE = /^embed\.[a-z0-9-]+\.(?:fun|com|net|org|xyz|live|top)$/i;

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (embed-updater/1.0)" },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, text };
  } finally {
    clearTimeout(t);
  }
}

// Extract the origin (scheme+host) from any embed URL found in a string.
function embedOrigins(text) {
  const out = new Map();
  for (const m of text.matchAll(DOMAIN_RE)) {
    try {
      const u = new URL(m[0].startsWith("http") ? m[0] : `https://${m[0]}`);
      if (EMBED_HOST_RE.test(u.host)) out.set(u.origin, (out.get(u.origin) || 0) + 1);
    } catch {
      /* ignore */
    }
  }
  return out;
}

// Card list on the homepage: channel-name + href to a <slug>.php page.
function parseCards(html, origin) {
  const cards = [];
  const cardRe = /<div\s+class="channel-name">([^<]*)<\/div>[\s\S]*?<a\s+href="([^"]+\.(?:php|html))"[^>]*class="btn"/gi;
  let mm;
  while ((mm = cardRe.exec(html)) !== null) {
    const name = mm[1].trim();
    let href = mm[2];
    if (!href.includes("://")) href = origin + href;
    cards.push({ name, href });
  }
  return cards;
}

// On a channel page, the real stream embed lives at /embed2/<slug>.(php|html).
function realEmbed2Path(html) {
  const m = html.match(/embed2\/[a-zA-Z0-9_.-]+\.(?:php|html)/i);
  return m ? m[0] : null;
}

function log(...args) {
  console.log("[updater]", ...args);
}

async function main() {
  // Locate the target file: prioritize the directory of this script,
  // then process.cwd() as fallback.
  const candidates = [
    path.join(__dirname, TARGET_FILE),      // script directory
    path.join(process.cwd(), TARGET_FILE),  // current working directory
  ];
  // Also if TARGET_FILE is absolute, include it directly.
  if (path.isAbsolute(TARGET_FILE)) {
    candidates.unshift(TARGET_FILE);
  }
  const targetPath = candidates.find((p) => fs.existsSync(p));
  if (!targetPath) {
    throw new Error(
      `Target file not found: ${TARGET_FILE} (tried: ${candidates.join(", ")})`
    );
  }
  const targetText = fs.readFileSync(targetPath, "utf8");

  // Candidate homepages: user source first, then origins already present in
  // the file (the previous domains), then a couple of common fallbacks.
  const candidateOrigins = new Set();
  if (SOURCE_URL) {
    try {
      const u = new URL(SOURCE_URL);
      candidateOrigins.add(u.origin.replace(/\/$/, ""));
    } catch {
      log("Ignoring invalid SOURCE_URL:", SOURCE_URL);
    }
  }
  for (const origin of embedOrigins(targetText).keys()) candidateOrigins.add(origin);

  // Probe each candidate until the homepage is live and contains cards.
  let liveOrigin = null;
  let cards = [];
  for (const origin of candidateOrigins) {
    try {
      const res = await get(origin + "/");
      if (!res.ok) {
        log("Dead:", origin, res.status);
        continue;
      }
      cards = parseCards(res.text, origin);
      if (cards.length === 0) {
        log("Unrecognized page (no cards):", origin);
        continue;
      }
      liveOrigin = res.url.replace(/\/$/, "");
      log("Live domain:", liveOrigin, "| cards:", cards.length);
      break;
    } catch (e) {
      log("Probe failed:", origin, e.message);
    }
  }
  if (!liveOrigin) {
    log("No live embed site found among candidates:", [...candidateOrigins]);
    process.exitCode = 0;
    return;
  }

  // Extract the REAL embed2 path from each card page and build:
  //   slugMap:  "espnpremium"       -> "embed2/espnpremiumlat.php"
  //   validEmbed2: set of embed2 paths actually served by the live site
  const slugMap = new Map();
  const validEmbed2 = new Set();
  let realCount = 0;
  for (const card of cards) {
    const pageSlug = decodeURIComponent(card.href.split("/").pop());
    const baseName = pageSlug.replace(/\.(php|html)$/i, "");
    if (slugMap.has(baseName)) continue;
    try {
      const page = await get(card.href);
      if (!page.ok) continue;
      const realPath = realEmbed2Path(page.text);
      if (!realPath) continue;
      slugMap.set(baseName, realPath);
      validEmbed2.add(realPath);
      realCount++;
    } catch (e) {
      /* skip individual page failures */
    }
  }
  log("Real embed2 URLs extracted:", realCount);

  // Some channels only existed on a previous domain and are absent from the
  // current card list; probe the live embed2/<slug>.php variant for them.
  const oldEmbed2 = new Set(
    [...targetText.matchAll(/embed2\/([a-zA-Z0-9_.-]+)\.(?:php|html)/g)].map((m) => m[1])
  );
  for (const slug of oldEmbed2) {
    const base = slug.replace(/\.(php|html)$/i, "");
    if (slugMap.has(base)) continue;
    try {
      const probe = await get(`${liveOrigin}/embed2/${base}.php`);
      if (probe.ok) {
        slugMap.set(base, `embed2/${base}.php`);
        validEmbed2.add(`embed2/${base}.php`);
      }
    } catch (e) {
      /* keep unresolved */
    }
  }
  log("Resolved embed2 slugs:", slugMap.size);

  // Rewrite the file: point every embed.* host at the live domain, and fix
  // slugs when the site changed the embed2 file name.
  const newText = targetText
    .split("\n")
    .map((line) => rewriteLine(line, liveOrigin, slugMap, validEmbed2))
    .join("\n");

  if (newText === targetText) {
    log("No changes needed.");
    setOutput("changed", "false");
    setOutput("domain", liveOrigin);
    return;
  }

  fs.writeFileSync(targetPath, newText);
  const changed = (newText.match(DOMAIN_RE) || []).length;
  log("Updated", changed, "embed references in", TARGET_FILE);
  setOutput("changed", "true");
  setOutput("domain", liveOrigin);
}

function rewriteLine(line, liveOrigin, slugMap, validEmbed2) {
  if (!/embed\./i.test(line)) return line;
  return line.replace(DOMAIN_RE, (match) => {
    try {
      const hasScheme = /^https?:\/\//i.test(match);
      const u = new URL(hasScheme ? match : `https://${match}`);
      if (!EMBED_HOST_RE.test(u.host)) return match;

      // Swap host to the live one.
      const live = new URL(liveOrigin);
      u.hostname = live.hostname;
      u.protocol = live.protocol;

      // Correct the embed2 slug when the site renamed the file for this page.
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "embed2" && parts[1]) {
        const base = parts[1].replace(/\.(php|html)$/i, "");
        if (slugMap.has(base)) {
          u.pathname = "/" + slugMap.get(base);
        } else if (!validEmbed2.has(parts.join("/"))) {
          // Old slug may exist under the other extension (.html <-> .php).
          const alt = parts.join("/").replace(/\.html$/, ".php").replace(/\.php$/, ".html");
          if (validEmbed2.has(alt)) {
            u.pathname = "/" + alt;
          }
        }
      }
      return u.origin + u.pathname + u.search;
    } catch {
      return match;
    }
  });
}

function setOutput(name, value) {
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) fs.appendFileSync(gh, `${name}=${value}\n`);
  log(`GITHUB_OUTPUT ${name}=${value}`);
}

main().catch((err) => {
  console.error("[updater] ERROR:", err);
  process.exit(1);
});
