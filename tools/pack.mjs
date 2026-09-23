#!/usr/bin/env node
// Pack a built game folder into a Yandex Games-ready zip and validate it against the
// archive requirements (1.21, 1.22, relative paths, SDK tag). Dependency-free: writes the
// zip container by hand with forward-slash entry names — Windows PowerShell 5.1
// Compress-Archive writes backslashes, which Yandex's importer stores literally, leaving a
// white screen where only index.html loads.
//
// Usage:
//   node pack.mjs <dist-dir> [--out build.zip] [--check-only] [--exclude=_tmp,foo] [--allow-external=host1,host2]
//
// Exit code 1 on any hard failure (missing index.html, > 100 MB, bad file names).

import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Tiny arg parser: `--name=value`, `--name value`, or bare `--name` (boolean).
const VALUE_FLAGS = new Set(["out", "exclude", "allow-external"]);
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const eq = a.indexOf("=");
  const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
  if (eq !== -1) flags[name] = a.slice(eq + 1);
  else if (VALUE_FLAGS.has(name) && i + 1 < args.length && !args[i + 1].startsWith("--")) flags[name] = args[++i];
  else flags[name] = true;
}
const flag = (name, def) => (name in flags ? flags[name] : def);

const srcDir = path.resolve(positional[0] ?? "dist");
const outFile = path.resolve(String(flag("out", "build.zip")));
const checkOnly = flag("check-only", false) === true;
const exclude = new Set(String(flag("exclude", "_tmp")).split(",").filter(Boolean));
const allowExternal = new Set(String(flag("allow-external", "")).split(",").filter(Boolean));
// Hosts on the platform's default CSP allowlist (Yandex CSP announcement). Anything else is refused at runtime.
const CSP_ALLOWED = /(^|\.)yandex\.(ru|com|net|kz|by|uz|az|co\.il|com\.am|com\.ge|com\.tr|ee|fr|kg|lt|lv|md|tj|tm|ua)$|^yastatic\.net$|^yastat\.net$|^yandexmetrica\.com$|^mc\.yandex\.(ru|com)$|^www\.google-analytics\.com$|^www\.googletagmanager\.com$|(^|\.)unity3d\.com$|(^|\.)eponesh\.com$|(^|\.)gameanalytics\.com$|^storage\.yandexcloud\.net$|(^|\.)website\.yandexcloud\.net$|^fonts\.googleapis\.com$|^fonts\.gstatic\.com$/;

const MAX_BYTES = 100 * 1024 * 1024;
const errors = [];
const warnings = [];

async function walk(dir, rel = "") {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (exclude.has(entry.name) || exclude.has(relPath)) continue;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relPath)));
    else out.push(relPath);
  }
  return out;
}

// --- validation --------------------------------------------------------------

let files;
try {
  files = await walk(srcDir);
} catch (err) {
  console.error(`Cannot read ${srcDir}: ${err.message}`);
  process.exit(1);
}

if (!files.includes("index.html")) {
  errors.push("index.html is not at the archive root (requirement 1.22). Check Vite `root`/`build.outDir`.");
  const nested = files.find((f) => f.endsWith("/index.html"));
  if (nested) errors.push(`Found a nested one at ${nested} — the archive root must contain it directly.`);
}

let total = 0;
for (const f of files) {
  const st = await fs.stat(path.join(srcDir, f));
  total += st.size;
  if (/\s/.test(f)) errors.push(`File name contains whitespace: ${f} (requirement 1.22)`);
  if (/[Ѐ-ӿ]/.test(f)) errors.push(`File name contains Cyrillic characters: ${f} (requirement 1.22)`);
  if (/[^\x20-\x7E]/.test(f)) warnings.push(`Non-ASCII file name (may break on the CDN): ${f}`);
  if (f.endsWith(".map")) warnings.push(`Source map in the build: ${f} (counts toward 100 MB, leaks sources — set build.sourcemap=false)`);
  if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(f)) warnings.push(`OS junk file: ${f}`);
  if (/(^|\/)sdk\.js$/.test(f)) warnings.push(`A local sdk.js is bundled (${f}); the platform serves /sdk.js itself — do not ship a copy.`);
}
if (total > MAX_BYTES) errors.push(`Uncompressed size ${(total / 1048576).toFixed(1)} MB exceeds 100 MB (requirement 1.21)`);
else if (total > 40 * 1024 * 1024) warnings.push(`Uncompressed size ${(total / 1048576).toFixed(1)} MB — large builds hurt Conversion To Play; compress models/textures/audio`);

if (files.includes("index.html")) {
  const html = await fs.readFile(path.join(srcDir, "index.html"), "utf8");
  const hasRelativeSdk = /<script[^>]+src=["']\/sdk\.js["']/i.test(html);
  const hasAbsoluteSdk = /<script[^>]+src=["']https:\/\/sdk\.games\.s3\.yandex\.net\/sdk\.js["']/i.test(html);
  if (!hasRelativeSdk && !hasAbsoluteSdk) errors.push('No <script src="/sdk.js"></script> in index.html (requirement 1.1 / 1.19.1)');
  if (hasAbsoluteSdk) warnings.push("SDK loaded from the absolute URL — correct only for own-domain hosting; archives should use /sdk.js");
  if (/<script[^>]+src=["'][^"']*sdk\.js["']/i.test(html) && !hasRelativeSdk && !hasAbsoluteSdk) errors.push("sdk.js is loaded from an unofficial path");

  const absRefs = [...html.matchAll(/(?:src|href)=["'](\/(?!sdk\.js)[^"'/][^"']*)["']/gi)].map((m) => m[1]);
  for (const ref of absRefs) errors.push(`Domain-absolute reference "${ref}" in index.html — the game is served from a deep path; use relative URLs (Vite base: './')`);

  const hosts = new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const h of hosts) {
    if (CSP_ALLOWED.test(h) || allowExternal.has(h)) continue;
    warnings.push(`External host referenced in index.html: ${h} — not on the default CSP allowlist; it will be refused unless approved on the console's CSP tab`);
  }
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) warnings.push("Google Fonts is loaded at runtime (allowed by CSP) — consider bundling .woff2 so screenshots and offline-ish sessions never fall back to a system font");
  if (/unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|esm\.sh/.test(html)) errors.push("A public JS CDN is referenced — the platform CSP blocks it (script-src); bundle the library");
  if (/<base\s/i.test(html)) warnings.push("<base> tag present — make sure it does not turn asset URLs into domain-absolute ones");
  if (/onbeforeunload|beforeunload/.test(html)) warnings.push("beforeunload handler in index.html — an 'unsaved changes' prompt is a 1.14 violation");
  if (/<(audio|video)\b/i.test(html)) warnings.push("<audio>/<video> element in index.html — HTML media elements trigger the system media player (1.6.1.6 / 1.6.2.5); prefer Web Audio");
}

const jsFiles = files.filter((f) => f.endsWith(".js"));
let sawReady = false, sawLang = false, sawConsume = false, sawGetPurchases = false, sawPurchase = false, sawIntervalAd = false;
for (const f of jsFiles) {
  const js = await fs.readFile(path.join(srcDir, f), "utf8");
  if (/LoadingAPI/.test(js) && /ready\(/.test(js)) sawReady = true;
  if (/i18n/.test(js) && /\.lang/.test(js)) sawLang = true;
  if (/consumePurchase/.test(js)) sawConsume = true;
  if (/getPurchases/.test(js)) sawGetPurchases = true;
  if (/\.purchase\(/.test(js)) sawPurchase = true;
  if (/setInterval\([^;]{0,120}showFullscreenAdv/.test(js)) sawIntervalAd = true;
  for (const m of js.matchAll(/https:\/\/[a-z0-9.-]+\.games\.s3\.yandex\.net[^"'` ]*/g)) warnings.push(`Absolute Yandex S3 URL in ${f}: ${m[0]} (requirement 1.7)`);
}
if (jsFiles.length && !sawReady) errors.push("No LoadingAPI.ready() call found in the bundle (requirement 1.19.2)");
if (jsFiles.length && !sawLang) warnings.push("No environment.i18n.lang usage detected — automatic language detection is mandatory (requirement 2.14)");
if (sawPurchase && !sawConsume) errors.push("payments.purchase() is used but consumePurchase() never appears (requirement 1.13.1)");
if (sawPurchase && !sawGetPurchases) errors.push("payments.purchase() is used but getPurchases() never appears — unprocessed purchases must be checked at launch (requirement 1.13.1)");
if (sawIntervalAd) errors.push("setInterval(...showFullscreenAdv...) found — timer ads are only allowed with a notice in long real-time levels (requirement 4.4)");

// --- report --------------------------------------------------------------------

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${files.length} files, ${(total / 1048576).toFixed(2)} MB uncompressed`);
if (errors.length) {
  console.error(`\n${errors.length} error(s) — fix them before uploading.`);
  process.exit(1);
}
if (checkOnly) process.exit(0);

// --- zip writer (STORE for already-compressed formats, DEFLATE otherwise) ----------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}
const STORE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".ogg", ".m4a", ".aac", ".mp4", ".webm", ".woff", ".woff2", ".zip", ".glb", ".ktx2", ".basis"]);

const chunks = [];
const central = [];
let offset = 0;
const now = new Date();
for (const rel of files.sort()) {
  const data = await fs.readFile(path.join(srcDir, rel));
  const nameBuf = Buffer.from(rel, "utf8");
  const store = STORE_EXT.has(path.extname(rel).toLowerCase());
  const deflated = store ? data : zlib.deflateRawSync(data, { level: 9 });
  const useStore = store || deflated.length >= data.length;
  const body = useStore ? data : deflated;
  const method = useStore ? 0 : 8;
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime(now), 10);
  local.writeUInt16LE(dosDate(now), 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);               // version made by
  cd.writeUInt16LE(20, 6);               // version needed
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(dosTime(now), 12);
  cd.writeUInt16LE(dosDate(now), 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);               // extra
  cd.writeUInt16LE(0, 32);               // comment
  cd.writeUInt16LE(0, 34);               // disk
  cd.writeUInt16LE(0, 36);               // internal attrs
  cd.writeUInt32LE(0, 38);               // external attrs
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}
const cdStart = offset;
const cdBufs = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBufs.length, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);

await fs.writeFile(outFile, Buffer.concat([...chunks, cdBufs, eocd]));
const zipSize = (await fs.stat(outFile)).size;
console.log(`Wrote ${outFile}: ${files.length} entries, ${(zipSize / 1048576).toFixed(2)} MB compressed`);
if (files.length > 65535) console.error("More than 65535 entries — ZIP64 needed; reduce the file count.");
