/*
 * Effyra Build – minifiziert NUR inline-JS und -CSS.
 *
 * Quelle (lesbar, bearbeiten):  index.dev.html
 * Ausgabe (deployen):           index.html   (minifiziert)
 *
 * Bewusst NICHT:
 *   - keine HTML-Minifizierung (die HTML hat tolerante Eigenheiten, die
 *     ein strenger HTML-Parser ablehnt – Browser tolerieren sie)
 *   - keine Identifier-Umbenennung (minifyIdentifiers:false), damit globale
 *     Funktionen / inline-Handler / window-Referenzen NICHT brechen
 *
 * Nutzung:  node build.mjs   (bzw.  npm run build)
 * Einmalig vorher:  npm install
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { transform } from 'esbuild';

const SRC = 'index.dev.html';
const OUT = 'index.html';
const SW  = 'sw.js';
const VER = 'version.json';
const JS_TYPES = /^(?:text\/javascript|application\/javascript|module)$/;

/* Bau-Kennung YYYYMMDD-HHMM (UTC). Bewusst lexikografisch sortierbar: der Vergleich
   im Client ist ein reiner String-Vergleich. Ein anderes Format – etwa ohne führende
   Null oder mit lokaler Zeitzone – würde ihn still falsch machen. */
const BUILD = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

let html = readFileSync(SRC, 'utf8');
let styleCount = 0, scriptCount = 0, skipped = 0;

// ---- CSS: inline <style> ... </style> ----
const styleBlocks = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
for (const m of styleBlocks) {
  const [full, attrs, css] = m;
  if (!css.trim()) continue;
  const { code } = await transform(css, { loader: 'css', minify: true });
  const rep = `<style${attrs}>${code.trimEnd()}</style>`;
  html = html.replace(full, () => rep);   // Funktion -> keine $-Muster-Interpretation
  styleCount++;
}

// ---- JS: inline <script> ... </script> (externe/Nicht-JS überspringen) ----
const scriptBlocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
for (const m of scriptBlocks) {
  const [full, attrs, js] = m;
  if (/\bsrc\s*=/i.test(attrs)) { skipped++; continue; }          // externes Script
  const t = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
  if (t && !JS_TYPES.test(t[1].toLowerCase())) { skipped++; continue; } // z. B. application/json
  if (!js.trim()) continue;
  const { code } = await transform(js, {
    loader: 'js',
    target: 'es2015',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: true,    // sicher: keine inline-Handler / kein window.X / kein eval; alles in IIFEs
    legalComments: 'none',
  });
  const rep = `<script${attrs}>${code.trimEnd()}</script>`;
  html = html.replace(full, () => rep);   // Funktion -> keine $-Muster-Interpretation
  scriptCount++;
}

/* ---- Bau-Kennung stempeln ----
   Harte Fehler statt stiller Nicht-Ersetzung: fällt einer der drei Stempel aus,
   melden Clients entweder nie ein Update oder dauerhaft eines. Beides fiele erst
   im Feld auf. */
const srcHash = createHash('sha256').update(readFileSync(SRC)).digest('hex').slice(0, 16);
 const srcRe = /(<meta name="effyra-src" content=")[^"]*(">)/;
if (!srcRe.test(html)) throw new Error(`Meta-Tag effyra-src fehlt in ${SRC} - check-build.mjs koennte veraltete Builds nicht erkennen.`);
html = html.replace(srcRe, (m, a, b) => a + srcHash + b);

const metaRe = /(<meta name="effyra-build" content=")[^"]*(">)/;
if (!metaRe.test(html)) throw new Error(`Meta-Tag effyra-build fehlt in ${SRC} – Versionsabgleich waere still wirkungslos.`);
html = html.replace(metaRe, (m, a, b) => a + BUILD + b);

writeFileSync(OUT, html);

/* sw.js mitstempeln: bleibt die Datei byte-gleich, installiert der Browser keinen
   neuen Service Worker und im laufenden Tab feuert nie 'updatefound'. Ersetzt das
   Hochzaehlen des Cache-Namens von Hand (RUNBOOK Abschnitt 3). */
const swRe = /const BUILD = '[^']*';/;
const swSrc = readFileSync(SW, 'utf8');
if (!swRe.test(swSrc)) throw new Error(`Zeile "const BUILD = '...';" fehlt in ${SW}.`);
writeFileSync(SW, swSrc.replace(swRe, () => `const BUILD = '${BUILD}';`));

/* version.json: einzige Quelle fuer "welcher Build ist aktuell" und fuer eine
   erzwungene Mindestversion. min wird von Hand gepflegt und hier bewusst aus der
   vorhandenen Datei uebernommen – wuerde der Build es zuruecksetzen, loeste jeder
   Deploy die Sperre stillschweigend wieder auf. */
let min = '';
try { min = String(JSON.parse(readFileSync(VER, 'utf8')).min || ''); } catch (e) {}
writeFileSync(VER, JSON.stringify({ build: BUILD, min }, null, 2) + '\n');
console.log(`\nBau-Kennung ${BUILD} gestempelt in ${OUT}, ${SW}, ${VER}` + (min ? ` (Mindestversion ${min})` : ''));

const kb = n => (n / 1024).toFixed(0);
const srcSize = statSync(SRC).size, outSize = statSync(OUT).size;
const srcGz = gzipSync(readFileSync(SRC)).length, outGz = gzipSync(readFileSync(OUT)).length;
console.log(`\nMinifiziert: ${styleCount} <style>, ${scriptCount} <script> (${skipped} uebersprungen)`);
console.log(`Quelle  ${SRC}: ${kb(srcSize)} KB roh | ${kb(srcGz)} KB gzip`);
console.log(`Ausgabe ${OUT}: ${kb(outSize)} KB roh | ${kb(outGz)} KB gzip`);
console.log(`Ersparnis: ${(100 - outSize / srcSize * 100).toFixed(0)}% roh, ${(100 - outGz / srcGz * 100).toFixed(0)}% gzip\n`);
