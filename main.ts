// Radar-7: a token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or
// --input <file|dir>), fits the odds model (a+c1) and the value model
// (ridge, lambda 64) from the snapshot itself, writes the ranked board to
// /output/board.json and the dashboard's data to /output/data.js, copies
// this repository's dashboard/ and screenshots/ to /output, and writes
// /output/dossier.json with this repository's own dossier writer.
//
// Two things this program refuses to do, on purpose. First, it re-derives
// the published fit numbers in TypeScript and stops when they drift: the
// held-out Brier must come out at 0.1900 (5-seed mean), the ECE at 0.0376,
// the value LOO at x2.881 (50.0% within 3x) and the walk-forward at x2.234
// (58.1% within 3x). Second, it enforces the bounty's own caps before it
// writes anything out: the dashboard source at 65,536 bytes, the dossier at
// 1.5 MiB, the screenshots at 4 of 512 KiB.
//
// The dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board. The
// verdict on each row is expected value, not size: EV = p(token) x gross -
// $12.60 of costs, FARM at EV >= $10, THIN at EV >= $0, SKIP below that;
// a product-category protocol never earns FARM, because its launch thesis
// is a wrapped or bridged copy of a token that already trades.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBoard,
  boardJson,
  dataScript,
  fitValue,
  fullFitOdds,
  loadComps,
  loadPeers,
  oofEval,
  parseSnapshot,
  validateBoard,
  valueRobustness,
} from "./lib/radar.ts";
import { buildDossier } from "./lib/dossier.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const DOSSIER_MAX_BYTES = 1_572_864;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The published fit numbers, from the research fit this program re-derives. */
const REF = {
  brierMean: 0.19,
  briers: [0.191, 0.1901, 0.1911, 0.1885, 0.1891],
  ece: 0.0376,
  looMedian: 2.881,
  looWithin3: 0.5,
  wfMedian: 2.234,
  wfWithin3: 0.581,
};

const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const snapshot = parseSnapshot(readFileSync(inputFile, "utf8"));
const peers = loadPeers(snapshot);
const comps = loadComps(snapshot);

// The odds fit, re-derived here in TypeScript; the program stops if the
// numbers drift from the published research fit.
const oof = oofEval(peers);
if (
  !close(oof.brierMean, REF.brierMean, 0.0002) ||
  oof.briers.some((b, i) => !close(b, REF.briers[i]!, 0.0002)) ||
  !close(oof.eceSeed20261114, REF.ece, 0.0002)
) {
  process.stderr.write(
    `token radar: the TypeScript odds fit does not reproduce the published numbers: briers ${oof.briers.map((b) => b.toFixed(4)).join("/")} mean ${oof.brierMean.toFixed(4)} ECE ${oof.eceSeed20261114.toFixed(4)} (published 0.1910/0.1901/0.1911/0.1885/0.1891 mean 0.1900 ECE 0.0376)\n`,
  );
  process.exit(1);
}

// The value fit, and its robustness numbers, re-derived the same way.
const value = fitValue(comps, 64);
const robustness = valueRobustness(comps, 64);
if (
  !close(robustness.loo.median, REF.looMedian, 0.001) ||
  !close(robustness.loo.within3, REF.looWithin3, 0.001) ||
  !close(robustness.wf.median, REF.wfMedian, 0.001) ||
  !close(robustness.wf.within3, REF.wfWithin3, 0.001)
) {
  process.stderr.write(
    `token radar: the TypeScript value fit does not reproduce the published numbers: LOO x${robustness.loo.median} (${robustness.loo.within3}<=3x) WF x${robustness.wf.median} (${robustness.wf.within3}<=3x) (published LOO x2.881 (0.500) WF x2.234 (0.581))\n`,
  );
  process.exit(1);
}

const odds = fullFitOdds(peers);
const board = buildBoard(snapshot, peers, odds, value);
validateBoard(board.rows, snapshot);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), boardJson(board.rows));
writeFileSync(join(out, "data.js"), dataScript(snapshot, peers, comps, odds, value, oof, robustness, board));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyFiles(join(here, "dashboard"), join(out, "dashboard"));
const dashBytes = dash.reduce((n, name) => n + statSync(join(here, "dashboard", name)).size, 0);
if (dashBytes > TEXT_MAX_BYTES) {
  process.stderr.write(`token radar: dashboard source is ${dashBytes} bytes, over the ${TEXT_MAX_BYTES} the gate allows\n`);
  process.exit(1);
}
const shots = copyFiles(join(here, "screenshots"), join(out, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
if (dossier.length > DOSSIER_MAX_BYTES) {
  process.stderr.write(`token radar: the dossier is ${dossier.length} bytes, over the ${DOSSIER_MAX_BYTES} the gate allows\n`);
  process.exit(1);
}
writeFileSync(join(out, "dossier.json"), dossier);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.rows.length} rows scored (${board.counts.FARM} FARM, ${board.counts.THIN} THIN, ${board.counts.SKIP} SKIP)\n` +
    `token radar: odds (a+c1) held-out Brier ${oof.brierMean.toFixed(4)} (5-seed mean), ECE ${oof.eceSeed20261114.toFixed(4)}; value LOO x${robustness.loo.median} WF x${robustness.wf.median}\n` +
    `token radar: board total implied value $${board.totalIv.toLocaleString("en-US")}; ${board.productRows} product rows; ${board.ageFallbackRows} rows on the median peer age (${board.medianPeerAge.toFixed(3)}y)\n` +
    `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")} (${dash.length} files, ${dashBytes} bytes), ${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")} (${dossier.length} bytes)\n`,
);
