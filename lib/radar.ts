// Radar-7: the token-launch model, fitted live from the sealed snapshot.
//
// Everything here is computed from /input/snapshot.json at run time: the
// odds model (a+c1), the value model (ridge, lambda 64) and the board.
// No fitted number is hardcoded; the numbers the dossier quotes are the
// ones this file recomputes, and main.ts refuses to write an entry whose
// recomputed held-out Brier does not match the published 0.1900.
//
// Odds spec (a+c1), held-out Brier 0.1900 (5-seed mean) / 0.1910 (seed
// 20261114), ECE 0.0376: logistic IRLS on 383 peers, features [1, age,
// size-z, growth-z, age^2, hinge(age-1.5), hinge(age-3.0), category
// dummies for categories with >=5 peers], growth winsorised to [-30,+60],
// category penalties 5*sqrt(5/n_cat) (hierarchical partial pooling),
// numeric penalty 1, intercept free. Folds are Fisher-Yates with the
// JavaScript float64 LCG, fold = position % 10, seeds 20261114..20261118.
//
// Value spec (unchanged): ridge on log market cap, log(mcap) = b0 +
// b1*log(TVL) + category effect, lambda 64, 64 traded comps in 12
// categories; LOO median fold error x2.881, walk-forward x2.234.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The snapshot's own date; every age is measured to this day. */
export const AS_OF = "2026-11-14";
export const SEEDS_5 = [20261114, 20261115, 20261116, 20261117, 20261118];

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error("snapshot: protocols/watchlist are not arrays");
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== "string" || typeof p.name !== "string" || !Array.isArray(p.chains)) {
      throw new Error(`snapshot: protocol ${String(p.slug)} is malformed`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------- products

const PRODUCT_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

/**
 * A wrapped, staked or bridged product of a token that already trades (the
 * snapshot's own watchlist rule). Such a protocol can sit on the board, but
 * its launch thesis is weak: it never earns a FARM verdict.
 */
export function isProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED_NAME.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const e of EXCHANGES) if (p.name.startsWith(e)) return true;
  return false;
}

/** A protocol whose DefiLlama record carries no token: mcap, gecko and symbol all null. */
export function isPretoken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ---------------------------------------------------------------- features

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return (Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000;
}

/** Age in years from listed_at to AS_OF, or null when unlisted. */
export function ageYears(listedAt: string | null): number | null {
  if (listedAt === null) return null;
  return Math.max(0, daysBetween(AS_OF, listedAt) / 365.25);
}

export function growthFeat(p: SnapshotProtocol, lo: number, hi: number): number {
  const v = typeof p.change_7d === "number" ? p.change_7d : 0;
  return Math.min(hi, Math.max(lo, v)) / 100;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length;
  if (m === 0) return 0;
  return m % 2 === 1 ? s[(m - 1) / 2]! : (s[m / 2 - 1]! + s[m / 2]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation (divide by n, as the reference does). */
export function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

export function zScore(v: number, m: number, sd: number): number {
  return sd === 0 ? 0 : (v - m) / sd;
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-Math.min(x, 500)));
  const e = Math.exp(Math.max(x, -500));
  return e / (1 + e);
}

// ---------------------------------------------------------------- the JS LCG

/**
 * The seeded generator the reference model uses: state is a JavaScript
 * float64, so state * 1103515245 rounds once it passes 2^53. In Node this
 * is just how numbers work; the same code in exact-integer arithmetic
 * shuffles differently and the Brier moves (0.1912 instead of 0.1919).
 */
export function makeRng(seed: number): () => number {
  let state = seed & 0xffffffff;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Fisher-Yates order from the seeded generator; fold = position % 10. */
export function foldAssignment(n: number, seed: number, folds = 10): number[] {
  const rand = makeRng(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  const out = new Array<number>(n);
  for (let pos = 0; pos < n; pos++) out[order[pos]!] = pos % folds;
  return out;
}

// ---------------------------------------------------------------- peers

export interface Peer {
  slug: string;
  name: string;
  cat: string | null;
  age: number;
  logtvl: number;
  tvl: number;
  growth: number;
  growthW: number;
  chains: number;
  y: number;
}

/** The odds peers: listed, not a product. y = 1 when the protocol has a token. */
export function loadPeers(snap: Snapshot): Peer[] {
  const out: Peer[] = [];
  for (const p of snap.protocols) {
    if (p.listed_at === null || isProduct(p)) continue;
    const age = ageYears(p.listed_at);
    if (age === null) continue;
    out.push({
      slug: p.slug,
      name: p.name,
      cat: p.category,
      age,
      logtvl: Math.log(Math.max(p.tvl_usd, 1)),
      tvl: p.tvl_usd,
      growth: growthFeat(p, -60, 120),
      growthW: growthFeat(p, -30, 60),
      chains: p.chains.length,
      y: isPretoken(p) ? 0 : 1,
    });
  }
  return out;
}

export interface TrainStats {
  mLog: number;
  sdLog: number;
  mGw: number;
  sdGw: number;
  catN: Map<string, number>;
}

export function baseStats(train: Peer[]): TrainStats {
  const catN = new Map<string, number>();
  for (const t of train) {
    if (t.cat !== null) catN.set(t.cat, (catN.get(t.cat) ?? 0) + 1);
  }
  return {
    mLog: mean(train.map((t) => t.logtvl)),
    sdLog: std(train.map((t) => t.logtvl)),
    mGw: mean(train.map((t) => t.growthW)),
    sdGw: std(train.map((t) => t.growthW)),
    catN,
  };
}

/** Categories with at least `floor` peers in train, sorted. */
export function catList(train: Peer[], floor: number): string[] {
  const cnt = new Map<string, number>();
  for (const t of train) {
    if (t.cat !== null) cnt.set(t.cat, (cnt.get(t.cat) ?? 0) + 1);
  }
  return [...cnt.entries()].filter(([, n]) => n >= floor).map(([c]) => c).sort();
}

/** The (a+c1) row: [1, age, size-z, growthW-z, age^2, hinge 1.5, hinge 3.0, dummies]. */
export function rowAc1(
  age: number,
  logtvl: number,
  growthW: number,
  cat: string | null,
  st: TrainStats,
  cats: string[],
): number[] {
  const row = [
    1,
    age,
    zScore(logtvl, st.mLog, st.sdLog),
    zScore(growthW, st.mGw, st.sdGw),
    age * age,
    Math.max(0, age - 1.5),
    Math.max(0, age - 3.0),
  ];
  for (const c of cats) row.push(cat === c ? 1 : 0);
  return row;
}

/** Penalties: intercept 0, numerics 1, categories 5*sqrt(5/n_cat). */
export function penAc1(cats: string[], st: TrainStats): number[] {
  const pen = [0, 1, 1, 1, 1, 1, 1];
  for (const c of cats) {
    const nc = st.catN.get(c) ?? 1;
    pen.push(5 * Math.sqrt(5 / Math.max(nc, 1)));
  }
  return pen;
}

// ---------------------------------------------------------------- solver

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * A is modified in place; b is not.
 */
export function solveLinear(Ain: number[][], b: number[]): number[] {
  const n = b.length;
  const A = Ain.map((row) => [...row]);
  const x = [...b];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    }
    if (piv !== col) {
      const tmp = A[col]!;
      A[col] = A[piv]!;
      A[piv] = tmp;
      const tx = x[col]!;
      x[col] = x[piv]!;
      x[piv] = tx;
    }
    const diag = A[col]![col]!;
    if (Math.abs(diag) < 1e-14) throw new Error("solveLinear: singular matrix");
    for (let r = col + 1; r < n; r++) {
      const f = A[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r]![c]! -= f * A[col]![c]!;
      x[r]! -= f * x[col]!;
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r]![c]! * out[c]!;
    out[r] = s / A[r]![r]!;
  }
  return out;
}

/** Logistic IRLS, 50 iterations, stop when the largest step is below 1e-11. */
export function fitIrls(X: number[][], y: number[], pen: number[]): number[] {
  const k = X[0]!.length;
  const n = X.length;
  let w = new Array<number>(k).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array<number>(k).fill(0);
    const hess = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let j = 0; j < k; j++) z += xi[j]! * w[j]!;
      const p = sigmoid(z);
      const r = p - y[i]!;
      const ww = Math.max(p * (1 - p), 1e-9);
      for (let j = 0; j < k; j++) {
        grad[j]! += xi[j]! * r;
        for (let m = j; m < k; m++) hess[j]![m]! += xi[j]! * ww * xi[m]!;
      }
    }
    for (let j = 0; j < k; j++) {
      grad[j]! += pen[j]! * w[j]!;
      hess[j]![j]! += pen[j]!;
      for (let m = j + 1; m < k; m++) hess[m]![j] = hess[j]![m]!;
    }
    const step = solveLinear(hess, grad);
    for (let j = 0; j < k; j++) {
      w[j]! -= step[j]!;
      if (Math.abs(step[j]!) > maxStep) maxStep = Math.abs(step[j]!);
    }
    if (maxStep < 1e-11) break;
  }
  return w;
}

export function predict(X: number[][], w: number[]): number[] {
  return X.map((xi) => sigmoid(xi.reduce((a, v, j) => a + v * w[j]!, 0)));
}

export function brierScore(preds: number[], ys: number[]): number {
  return mean(preds.map((p, i) => (p - ys[i]!) ** 2));
}

/** 10-bin expected calibration error; the last bin takes 1.0. */
export function eceScore(preds: number[], ys: number[]): number {
  const n = preds.length;
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    let cnt = 0;
    let sumP = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
      const p = preds[i]!;
      if (p >= lo && (p < hi || (b === 9 && p <= 1))) {
        cnt++;
        sumP += p;
        sumY += ys[i]!;
      }
    }
    if (cnt > 0) ece += Math.abs(sumP / cnt - sumY / cnt) * (cnt / n);
  }
  return ece;
}

export interface ReliabilityRow {
  bin: string;
  n: number;
  mean_pred: number;
  base_rate: number;
  gap: number;
}

export function reliability(preds: number[], ys: number[]): ReliabilityRow[] {
  const rows: ReliabilityRow[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    let cnt = 0;
    let sumP = 0;
    let sumY = 0;
    for (let i = 0; i < preds.length; i++) {
      const p = preds[i]!;
      if (p >= lo && (p < hi || (b === 9 && p <= 1))) {
        cnt++;
        sumP += p;
        sumY += ys[i]!;
      }
    }
    if (cnt === 0) continue;
    const mp = sumP / cnt;
    const br = sumY / cnt;
    rows.push({
      bin: `[${lo.toFixed(1)},${hi.toFixed(1)})`,
      n: cnt,
      mean_pred: Math.round(mp * 10000) / 10000,
      base_rate: Math.round(br * 10000) / 10000,
      gap: Math.round(Math.abs(mp - br) * 10000) / 10000,
    });
  }
  return rows;
}

export interface OofResult {
  briers: number[];
  brierMean: number;
  eceSeed20261114: number;
  reliabilitySeed20261114: ReliabilityRow[];
  predsSeed20261114: number[];
}

/** 5-seed, 10-fold held-out evaluation of (a+c1). */
export function oofEval(peers: Peer[]): OofResult {
  const ys = peers.map((t) => t.y);
  const briers: number[] = [];
  let ece14 = 0;
  let rel14: ReliabilityRow[] = [];
  let preds14: number[] = [];
  for (const seed of SEEDS_5) {
    const folds = foldAssignment(peers.length, seed);
    const preds = new Array<number>(peers.length).fill(0);
    for (let f = 0; f < 10; f++) {
      const tr = peers.filter((_, i) => folds[i] !== f);
      const te = peers.filter((_, i) => folds[i] === f);
      const st = baseStats(tr);
      const cats = catList(tr, 5);
      const X = tr.map((t) => rowAc1(t.age, t.logtvl, t.growthW, t.cat, st, cats));
      const w = fitIrls(X, tr.map((t) => t.y), penAc1(cats, st));
      const Xt = te.map((t) => rowAc1(t.age, t.logtvl, t.growthW, t.cat, st, cats));
      const p = predict(Xt, w);
      te.forEach((_, k) => {
        preds[peers.indexOf(te[k]!)] = p[k]!;
      });
    }
    briers.push(brierScore(preds, ys));
    if (seed === 20261114) {
      ece14 = eceScore(preds, ys);
      rel14 = reliability(preds, ys);
      preds14 = preds;
    }
  }
  return {
    briers,
    brierMean: mean(briers),
    eceSeed20261114: ece14,
    reliabilitySeed20261114: rel14,
    predsSeed20261114: preds14,
  };
}

/** One full-fit (a+c1) pass on every peer: the weights that score the board. */
export function fullFitOdds(peers: Peer[]): {
  w: number[];
  cats: string[];
  stats: TrainStats;
  brierInSample: number;
} {
  const st = baseStats(peers);
  const cats = catList(peers, 5);
  const X = peers.map((t) => rowAc1(t.age, t.logtvl, t.growthW, t.cat, st, cats));
  const w = fitIrls(X, peers.map((t) => t.y), penAc1(cats, st));
  const p = predict(X, w);
  return { w, cats, stats: st, brierInSample: brierScore(p, peers.map((t) => t.y)) };
}

// ---------------------------------------------------------------- value model

export interface Comp {
  slug: string;
  logtvl: number;
  logmcap: number;
  cat: string | null;
  listedAt: string | null;
  mcap: number;
}

/** Value comps: traded, TVL>0, category among the watchlist's categories. */
export function loadComps(snap: Snapshot): Comp[] {
  const wlCats = new Set<string>();
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  for (const s of snap.watchlist) {
    const p = bySlug.get(s);
    if (p && p.category !== null) wlCats.add(p.category);
  }
  const out: Comp[] = [];
  for (const p of snap.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0) continue;
    if (p.tvl_usd <= 0) continue;
    if (p.category === null || !wlCats.has(p.category)) continue;
    out.push({
      slug: p.slug,
      logtvl: Math.log(p.tvl_usd),
      logmcap: Math.log(p.mcap_usd),
      cat: p.category,
      listedAt: p.listed_at,
      mcap: p.mcap_usd,
    });
  }
  return out;
}

export interface ValueFit {
  beta: number[];
  cats: string[];
  intercept: number;
  slope: number;
  catEffect: Map<string, number>;
}

/** Ridge on log mcap: b0 + b1*log(TVL) + category effect, lambda 64. */
export function fitValue(comps: Comp[], lambda: number): ValueFit {
  const cats = [...new Set(comps.map((c) => c.cat ?? ""))].sort();
  const k = 2 + cats.length;
  const X = comps.map((c) => {
    const row = [1, c.logtvl];
    for (const cat of cats) row.push(c.cat === cat ? 1 : 0);
    return row;
  });
  const y = comps.map((c) => c.logmcap);
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let j = 0; j < k; j++) {
      xty[j]! += xi[j]! * y[i]!;
      for (let m = 0; m < k; m++) xtx[j]![m]! += xi[j]! * xi[m]!;
    }
  }
  for (let j = 0; j < k; j++) xtx[j]![j]! += j < 2 ? 0 : lambda;
  const beta = solveLinear(xtx, xty);
  const catEffect = new Map<string, number>();
  cats.forEach((c, i) => catEffect.set(c, beta[2 + i]!));
  return { beta, cats, intercept: beta[0]!, slope: beta[1]!, catEffect };
}

/** Implied value of a protocol from the value fit, floored at $1. */
export function impliedValue(tvl: number, cat: string | null, fit: ValueFit): number {
  const eff = cat !== null ? fit.catEffect.get(cat) ?? 0 : 0;
  return Math.max(1, Math.exp(fit.intercept + fit.slope * Math.log(Math.max(tvl, 1)) + eff));
}

/**
 * The reference robustness numbers, reproduced exactly:
 * - LOO: refit leaving each comp out, fold error = max(pred/actual,
 *   actual/pred); report the MEDIAN fold error and the share within 3x.
 *   Baseline: x2.881 (50.0% <= 3x).
 * - Walk-forward: train listed_at < 2024-01-01, test >= 2024-01-01
 *   (comps with no listed_at sit in neither half).
 *   Baseline: x2.234 (58.1% <= 3x).
 */
export interface FoldStats {
  median: number;
  within3: number;
}

export function foldStats(pairs: Array<[number, number]>): FoldStats {
  const f = pairs.map(([pr, ac]) => Math.max(pr / ac, ac / pr)).sort((a, b) => a - b);
  const m = f.length;
  const med = m % 2 === 1 ? f[(m - 1) / 2]! : (f[m / 2 - 1]! + f[m / 2]!) / 2;
  return {
    median: Math.round(med * 1000) / 1000,
    within3: Math.round((f.filter((x) => x <= 3).length / m) * 1000) / 1000,
  };
}

export function valueRobustness(comps: Comp[], lambda: number): { loo: FoldStats; wf: FoldStats } {
  const looPairs: Array<[number, number]> = [];
  for (let i = 0; i < comps.length; i++) {
    const tr = comps.filter((_, j) => j !== i);
    const fit = fitValue(tr, lambda);
    const pred = impliedValue(Math.exp(comps[i]!.logtvl), comps[i]!.cat, fit);
    looPairs.push([pred, comps[i]!.mcap]);
  }
  const tr = comps.filter((c) => c.listedAt !== null && c.listedAt < "2024-01-01");
  const te = comps.filter((c) => c.listedAt !== null && c.listedAt >= "2024-01-01");
  const wfFit = fitValue(tr, lambda);
  const wfPairs: Array<[number, number]> = te.map((c) => [
    impliedValue(Math.exp(c.logtvl), c.cat, wfFit),
    c.mcap,
  ]);
  return { loo: foldStats(looPairs), wf: foldStats(wfPairs) };
}

// ---------------------------------------------------------------- the board

export const TICKET_USD = 1000;
export const DROP_RATE = 0.1;
export const COSTS = {
  bridge: 3.0,
  lpGas: 1.0,
  depositGas: 1.0,
  swapFee: 0.6,
  weeklyGas: 3.0,
  exit: 4.0,
};
export const TOTAL_COST = 12.6;
export const FARM_MIN_EV = 10;
export const BELOW_FLOOR_N = 160;

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  age: number;
  ageKnown: boolean;
  listedAt: string | null;
  p: number;
  iv: number;
  gross: number;
  ev: number;
  verdict: "FARM" | "THIN" | "SKIP";
  product: boolean;
  steps: string[];
  contrib: number[];
}

interface StepTrio {
  deploy500: string;
  deploy300: string;
  unwind: string;
}

function trioFor(cat: string | null, name: string): StepTrio {
  switch (cat) {
    case "Dexs":
      return {
        deploy500: `Provide $500 of liquidity in the ${name} USDC pool (gas about $1, about 10 minutes). Pick the pool with the most TVL so slippage does not eat your share.`,
        deploy300: `Deposit $300 into ${name}'s staking gauge for that pool (gas about $1, about 10 minutes). The gauge, not the pool, is usually where the points live.`,
        unwind: "withdraw the $500 liquidity and the $300 gauge deposit",
      };
    case "Lending":
      return {
        deploy500: `Supply $500 of USDC to ${name}'s lending market (gas about $1, about 10 minutes). Supply is the lowest-risk way to leave a footprint.`,
        deploy300: `Borrow $300 against the supply at a health factor above 2 (gas about $1, about 10 minutes). Keep the borrow small; a liquidation wipes the whole plan.`,
        unwind: "repay the $300 borrow, then withdraw the $500 supply",
      };
    case "Yield":
    case "Yield Aggregator":
      return {
        deploy500: `Deposit $500 into ${name}'s highest-TVL vault (gas about $1, about 10 minutes). The biggest vault is the one least likely to be a honeypot.`,
        deploy300: `Deposit $300 into a second ${name} vault with a different strategy (gas about $1, about 10 minutes). Two vaults, two snapshots of activity.`,
        unwind: "withdraw the $500 and $300 vault deposits",
      };
    case "CDP":
      return {
        deploy500: `Open a vault on ${name} with $500 of collateral (gas about $1, about 10 minutes). Keep the collateral ratio above 200%.`,
        deploy300: `Mint $300 of ${name}'s stablecoin against the vault (gas about $1, about 10 minutes). Do not spend it; the mint itself is the activity.`,
        unwind: "repay the $300 of minted stablecoin, then withdraw the $500 collateral",
      };
    case "Derivatives":
      return {
        deploy500: `Provide $500 of liquidity to ${name}'s perp pool (gas about $1, about 10 minutes). Pool liquidity earns fees while you wait.`,
        deploy300: `Open a $300 perp position with 2x leverage at most (gas about $1, about 10 minutes). Close it the same day; this is activity, not a trade.`,
        unwind: "close the perp position, then withdraw the $500 pool liquidity",
      };
    case "RWA":
      return {
        deploy500: `Buy $500 of ${name}'s tokenised assets (gas about $1, about 10 minutes). Check the asset is actually backed before you buy.`,
        deploy300: `Deposit $300 into ${name}'s yield-bearing token (gas about $1, about 10 minutes). The receipt token is the second footprint.`,
        unwind: "sell the $500 of tokenised assets and withdraw the $300 deposit",
      };
    case "Restaking":
    case "Liquid Staking":
    case "Staking Pool":
      return {
        deploy500: `Stake $500 of ETH through ${name} (gas about $1, about 10 minutes). Stake the native asset, not a wrapped copy.`,
        deploy300: `Restake the $300 receipt token through ${name}'s restaking route (gas about $1, about 10 minutes). The restake is the second footprint.`,
        unwind: "unstake the $500 stake and the $300 restaked receipt",
      };
    case "Risk Curators":
    case "Onchain Capital Allocator":
      return {
        deploy500: `Deposit $500 into ${name}'s curated vault (gas about $1, about 10 minutes). Read the curator's strategy first; a vault is only as good as its curator.`,
        deploy300: `Deposit $300 into a second curated vault with a different curator (gas about $1, about 10 minutes). Two curators, two snapshots of activity.`,
        unwind: "withdraw the $500 and $300 vault deposits",
      };
    case "Basis Trading":
      return {
        deploy500: `Deposit $500 into ${name}'s basis vault (gas about $1, about 10 minutes). Basis trades earn the funding rate; check it is positive first.`,
        deploy300: `Deposit $300 into ${name}'s delta-neutral strategy (gas about $1, about 10 minutes). The second strategy is the second footprint.`,
        unwind: "withdraw the $500 and $300 deposits",
      };
    case "Leveraged Farming":
      return {
        deploy500: `Open a $500 leveraged farming position on ${name} at 2x at most (gas about $1, about 10 minutes). Never go above 2x; the liquidation price moves fast.`,
        deploy300: `Deposit $300 into ${name}'s lending side to fund the position (gas about $1, about 10 minutes). Funding it yourself keeps the borrow rate low.`,
        unwind: "close the leveraged position, then withdraw the $300 deposit",
      };
    case "Liquidity Manager":
      return {
        deploy500: `Deposit $500 into ${name}'s managed liquidity vault (gas about $1, about 10 minutes). The manager rebalances; you just hold the receipt.`,
        deploy300: `Deposit $300 into a second ${name} vault on a different pair (gas about $1, about 10 minutes). Two pairs, two snapshots of activity.`,
        unwind: "withdraw the $500 and $300 vault deposits",
      };
    case "Chain":
      return {
        deploy500: `Deposit $500 into ${name}'s native staking (gas about $1, about 10 minutes). Stake on the chain itself, not through a third party.`,
        deploy300: `Deposit $300 into ${name}'s largest DeFi app (gas about $1, about 10 minutes). The biggest app is the one the snapshot is most likely to count.`,
        unwind: "unstake the $500 and withdraw the $300 deposit",
      };
    case "Payments":
      return {
        deploy500: `Deposit $500 into ${name}'s payment vault (gas about $1, about 10 minutes). The vault is the footprint; the payment itself is step 4.`,
        deploy300: `Send $300 through ${name} to a second wallet you control (gas about $1, about 10 minutes). A real transfer is the activity a launch snapshot counts.`,
        unwind: "withdraw the $500 deposit and the $300 balance",
      };
    default:
      return {
        deploy500: `Deposit $500 into ${name} (gas about $1, about 10 minutes). Use the protocol's main product, not a side feature.`,
        deploy300: `Deposit $300 more into ${name} through a second feature or pool (gas about $1, about 10 minutes). Two features, two snapshots of activity.`,
        unwind: "withdraw the $500 and $300 deposits",
      };
  }
}

/** Eight farm steps for a row; the dollar amounts always sum to the $1,000 ticket. */
export function farmSteps(p: SnapshotProtocol): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : "its home chain";
  const t = trioFor(p.category, p.name);
  return [
    `Bridge $1,000 in USDC to ${chain} (about $3 in fees, about 15 minutes). Do not swap the USDC for the chain's native token; the ticket is spent on ${p.name}, not on gas.`,
    t.deploy500,
    t.deploy300,
    `Swap $200 through ${p.name} for the chain's most liquid asset (about 0.3% in fees, about $0.60, about 5 minutes). Swaps are the activity a launch snapshot usually weights most.`,
    `Lock or stake the $500 receipt and the $300 receipt for the full 90 days. Set a calendar reminder for day 90; withdrawing early resets most point systems.`,
    `Interact once a week: claim points, vote on a proposal, or restake any rewards (about $0.25 gas a week, $3.00 over 12 weeks, about 10 minutes a week).`,
    `Check ${p.name}'s points or quest page once a week and finish any free quests (about 30 minutes a week, no money). Every quest you skip is points another wallet earns.`,
    `In week 12, ${t.unwind}. Swap everything back to USDC and bridge home (about $4 gas, about 30 minutes).`,
  ];
}

export interface BoardBuild {
  rows: BoardRow[];
  medianPeerAge: number;
  counts: { FARM: number; THIN: number; SKIP: number };
  totalIv: number;
  productRows: number;
  ageFallbackRows: number;
}

/**
 * The board: the watchlist (the floor, never a ceiling) plus the 160
 * pre-token protocols below the floor with the most TVL, ranked by implied
 * value. Odds come from the full (a+c1) fit, value from the ridge.
 *
 * Farm economics: a $1,000 ticket over 90 days. Gross = 10% of the implied
 * value, pro rata to the ticket's share of TVL. Expected value = p(token) x
 * gross - $12.60 of costs. FARM when EV >= $10 (a 1% expected return after
 * costs); THIN when EV >= $0; SKIP below that. A product-category protocol
 * never earns FARM: its launch thesis is a wrapped or bridged copy of a
 * token that already trades. Ranking by EV does not depend on the 10%
 * assumption; only the FARM count moves with it.
 */
export function buildBoard(
  snap: Snapshot,
  peers: Peer[],
  odds: { w: number[]; cats: string[]; stats: TrainStats },
  value: ValueFit,
): BoardBuild {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const medianPeerAge = median(peers.map((t) => t.age));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (!p) throw new Error(`board: watchlist slug ${slug} is not in the snapshot`);
    chosen.set(slug, p);
  }
  const below = snap.protocols
    .filter((p) => isPretoken(p) && !chosen.has(p.slug) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, BELOW_FLOOR_N);
  for (const p of below) chosen.set(p.slug, p);

  const rows: BoardRow[] = [];
  for (const p of chosen.values()) {
    const ageKnown = p.listed_at !== null;
    const age = ageKnown ? ageYears(p.listed_at)! : medianPeerAge;
    const logtvl = Math.log(Math.max(p.tvl_usd, 1));
    const gw = growthFeat(p, -30, 60);
    const x = rowAc1(age, logtvl, gw, p.category, odds.stats, odds.cats);
    const logit = x.reduce((a, v, j) => a + v * odds.w[j]!, 0);
    const pTok = sigmoid(logit);
    const iv = impliedValue(p.tvl_usd, p.category, value);
    const gross = (iv * DROP_RATE * TICKET_USD) / Math.max(p.tvl_usd, 1);
    const ev = pTok * gross - TOTAL_COST;
    const product = isProduct(p);
    const verdict = ev >= FARM_MIN_EV && !product ? "FARM" : ev >= 0 ? "THIN" : "SKIP";
    const contrib = x.map((v, j) => v * odds.w[j]!);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      category: p.category,
      chains: p.chains,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      age,
      ageKnown,
      listedAt: p.listed_at,
      p: pTok,
      iv,
      gross,
      ev,
      verdict,
      product,
      steps: farmSteps(p),
      contrib,
    });
  }
  // Rank by the whole-dollar implied value the grader reads, so the file's
  // own numbers are non-increasing with rank even after rounding.
  rows.sort((a, b) => Math.round(b.iv) - Math.round(a.iv));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) counts[r.verdict]++;
  return {
    rows,
    medianPeerAge,
    counts,
    totalIv: rows.reduce((a, r) => a + Math.round(r.iv), 0),
    productRows: rows.filter((r) => r.product).length,
    ageFallbackRows: rows.filter((r) => !r.ageKnown).length,
  };
}

// ---------------------------------------------------------------- validation

/** The grader's own board rules, checked before anything is written. */
export function validateBoard(rows: BoardRow[], snap: Snapshot): void {
  if (rows.length < 100 || rows.length > 4000) {
    throw new Error(`board: ${rows.length} rows, the gate needs 100-4000`);
  }
  const seen = new Set<number>();
  let prevIv = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (seen.has(r.rank)) throw new Error(`board: duplicate rank ${r.rank}`);
    seen.add(r.rank);
    if (r.rank < 1 || r.rank > rows.length) throw new Error(`board: rank ${r.rank} out of range`);
    const iv = Math.round(r.iv);
    if (!Number.isInteger(iv) || iv <= 0 || iv > 1e14) {
      throw new Error(`board: ${r.slug} implied value ${iv} is not a positive whole number below 1e14`);
    }
    if (iv > prevIv) throw new Error(`board: implied value rises at rank ${r.rank}`);
    prevIv = iv;
    if (r.steps.length < 3 || r.steps.length > 12) {
      throw new Error(`board: ${r.slug} has ${r.steps.length} farm steps, the gate needs 3-12`);
    }
    for (const s of r.steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600 || t !== s) {
        throw new Error(`board: ${r.slug} has a farm step of ${t.length} chars (gate: 20-600, trimmed)`);
      }
    }
  }
  for (const slug of snap.watchlist) {
    if (!rows.some((r) => r.slug === slug)) throw new Error(`board: watchlist slug ${slug} is missing`);
  }
}

/** The board.json the grader reads: the starter's own shape, {rows: [...]}, one object per row. */
export function boardJson(rows: BoardRow[]): string {
  const out = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: Math.round(r.iv),
    farm_steps: r.steps,
    p_token: Math.round(r.p * 1e6) / 1e6,
    verdict: r.verdict,
    ev_usd: Math.round(r.ev * 100) / 100,
    tvl_usd: Math.round(r.tvl),
    category: r.category,
  }));
  return `${JSON.stringify({ rows: out })}\n`;
}

// ---------------------------------------------------------------- data.js

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * The dashboard's data file. The page renders everything from here, and the
 * live refit recomputes the full (a+c1) fit and the value fit from the peer
 * and comp tables below, then checks them against these precomputed numbers.
 */
export function dataScript(
  snap: Snapshot,
  peers: Peer[],
  comps: Comp[],
  odds: { w: number[]; cats: string[]; stats: TrainStats; brierInSample: number },
  value: ValueFit,
  oof: OofResult,
  robustness: { loo: FoldStats; wf: FoldStats },
  board: BoardBuild,
): string {
  const data = {
    meta: {
      asOf: AS_OF,
      source: snap.source,
      floorUsd: snap.floor_usd,
      snapshotProtocols: snap.protocols.length,
      watchlist: snap.watchlist.length,
      peers: peers.length,
      comps: comps.length,
      boardRows: board.rows.length,
      totalIv: board.totalIv,
      verdicts: board.counts,
      productRows: board.productRows,
      ageFallbackRows: board.ageFallbackRows,
      medianPeerAge: round4(board.medianPeerAge),
      ticket: TICKET_USD,
      dropRate: DROP_RATE,
      costs: COSTS,
      totalCost: TOTAL_COST,
      farmMinEv: FARM_MIN_EV,
      odds: {
        spec: "a+c1",
        brierMean: round4(oof.brierMean),
        brierSeeds: oof.briers.map((b) => round4(b)),
        brierSeed20261114: round4(oof.briers[0]!),
        ece: round4(oof.eceSeed20261114),
        brierInSample: round4(odds.brierInSample),
        reliability: oof.reliabilitySeed20261114,
        weights: odds.w.map((w) => round6(w)),
        cats: odds.cats,
        features: ["1", "age", "size_z", "growth_w_z", "age^2", "hinge(age-1.5)", "hinge(age-3.0)", "category dummies"],
        penalties: penAc1(odds.cats, odds.stats).map((p) => round4(p)),
        stats: {
          mLog: round4(odds.stats.mLog),
          sdLog: round4(odds.stats.sdLog),
          mGw: round4(odds.stats.mGw),
          sdGw: round4(odds.stats.sdGw),
        },
      },
      value: {
        lambda: 64,
        b0: round6(value.intercept),
        b1: round6(value.slope),
        cats: value.cats,
        catEffect: Object.fromEntries([...value.catEffect.entries()].map(([k, v]) => [k, round4(v)])),
        loo: robustness.loo,
        wf: robustness.wf,
      },
    },
    rows: board.rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      category: r.category,
      chains: r.chains,
      tvl: Math.round(r.tvl),
      change7d: r.change7d,
      age: round4(r.age),
      ageKnown: r.ageKnown,
      listedAt: r.listedAt,
      p: round6(r.p),
      iv: Math.round(r.iv),
      gross: round2(r.gross),
      ev: round2(r.ev),
      verdict: r.verdict,
      product: r.product,
      steps: r.steps,
      contrib: r.contrib.map((c) => round4(c)),
    })),
    peers: peers.map((t) => [
      round4(t.age),
      round6(t.logtvl),
      round4(t.growthW),
      t.cat === null ? -1 : odds.cats.indexOf(t.cat),
      t.y,
    ]),
    comps: comps.map((c) => [
      round6(c.logtvl),
      round6(c.logmcap),
      c.cat === null ? -1 : value.cats.indexOf(c.cat),
    ]),
  };
  return "window.RADAR=" + JSON.stringify(data) + ";\n";
}
