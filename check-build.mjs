/* Effyra – prueft, ob index.html aus der aktuellen index.dev.html gebaut wurde.
 *
 * WARUM
 * index.html ist ein Build-Artefakt (build.mjs). Nichts erzwang den Build: wer
 * index.dev.html aenderte, committete und `node build.mjs` vergass, veroeffentlichte
 * die ALTE Fassung – ohne Fehler, ohne Hinweis, erst im Feld sichtbar. Bei
 * mehreren parallel arbeitenden Sitzungen ist das eine Frage der Zeit.
 *
 * WIE
 * build.mjs stempelt einen Fingerabdruck der Quelldatei in index.html
 * (<meta name="effyra-src">). Hier wird nur nachgerechnet. Bewusst OHNE Neubau:
 *
 *   - Ein Vergleich "neu bauen und Dateien gegenueberstellen" waere nicht
 *     moeglich, weil build.mjs eine ZEITBASIERTE Bau-Kennung einstempelt. Zwei
 *     Laeufe erzeugen nie dieselbe Datei; die Pruefung wuerde jeden Commit
 *     ablehnen, auch den frisch gebauten – und waere binnen eines Tages per
 *     --no-verify tot.
 *   - Der Fingerabdruck haengt dagegen nur am Inhalt der Quelle und ist damit
 *     reproduzierbar.
 *
 * Aufruf: node check-build.mjs   (Rueckgabe 0 = in Ordnung, 1 = veraltet)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = 'index.dev.html';
const OUT = 'index.html';

let src, out;
try {
  src = readFileSync(SRC);
  out = readFileSync(OUT, 'utf8');
} catch (e) {
  console.error(`check-build: ${e.message}`);
  process.exit(1);
}

const soll = createHash('sha256').update(src).digest('hex').slice(0, 16);
const m = /<meta name="effyra-src" content="([^"]*)">/.exec(out);

if (!m) {
  console.error(`check-build: ${OUT} traegt keinen Quell-Fingerabdruck.`);
  console.error('  -> node build.mjs ausfuehren und beide Dateien committen.');
  process.exit(1);
}

if (m[1] !== soll) {
  console.error('check-build: index.html ist NICHT aus der aktuellen index.dev.html gebaut.');
  console.error(`  erwartet ${soll}, gefunden ${m[1]}`);
  console.error('  -> node build.mjs ausfuehren, dann index.html mitcommitten.');
  process.exit(1);
}

console.log(`check-build: index.html passt zur Quelle (${soll}).`);
