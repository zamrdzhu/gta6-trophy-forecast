// GTA VI trophy rarity forecast — gta6-trophy-rarity-forecast-01.
//
// Model: per-trophy growth in logit space, fitted against log time since
// release, shrunk toward tier pools, blended with a tier prior, extrapolated
// to the target under a saturating ceiling, with an honest spread that
// accounts for random-walk drift, fit residual and Exophase refresh lag.
//
// Deterministic: pure function of the case file. No randomness, no clock,
// no network, Node standard library only.
//
// Usage: MAKEFUN_INPUT_DIR=<dir> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
// Reads every *.in file in the input dir (name order) and writes
// <id>.out per case: {"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}]}.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// Release of GTA VI: 2026-11-19 00:00 UTC. All time is measured from here;
// x(t) = ln(1 + hours since release) is the clock the growth fits run on.
const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z");
const HOUR_MS = 3600_000;
const DAY_MIN = 1440;

// Saturating ceilings (percent) by tier: no trophy is forecast above these.
// Week-one platinum is bounded hardest — it needs every other trophy first.
// Bronze is capped high only because early-story bronze trophies really do
// reach most of the tracked population within a week.
const CEILING_PCT: Record<string, number> = {
  platinum: 8,
  gold: 30,
  silver: 55,
  bronze: 85,
};

// Prior logit gain per ln(1 + horizon days) when the fitted trend says
// nothing: easy/common trophies rise fastest, the platinum slowest.
const PRIOR_GAIN_RATE: Record<string, number> = {
  platinum: 0.15,
  gold: 0.35,
  silver: 0.45,
  bronze: 0.55,
};

// Fallback last-rate guess (percent) if a case somehow carries no reads.
const FALLBACK_LAST_PCT: Record<string, number> = {
  platinum: 0.6,
  gold: 1.0,
  silver: 0.8,
  bronze: 1.0,
};

const FIT_WINDOW_MS = 24 * HOUR_MS;
const MIN_Q = 0.01;
const MAX_Q = 99.99;

interface Trophy {
  id: number;
  name: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: (number | null)[];
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function logitPct(pct: number): number {
  const p = clamp(pct, MIN_Q, MAX_Q) / 100;
  return Math.log(p / (1 - p));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** x-coordinate of a read: log time since release, in hours. */
function xOf(ms: number): number {
  const hours = Math.max(0, (ms - RELEASE_MS) / HOUR_MS);
  return Math.log1p(hours);
}

interface Fit {
  slope: number | null; // logit per unit x, null when unidentified
  residSd: number | null; // residual SD in logit space
  n: number; // points used
}

/** Ordinary least squares of y on x; slope null when x has no spread. */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n < 2) return { slope: null, residSd: null, n };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx < 1e-12) return { slope: null, residSd: null, n };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  const dof = Math.max(1, n - 2);
  return { slope, residSd: Math.sqrt(rss / dof), n };
}

function forecastCase(c: CaseFile): { trophies: { id: number; q: number[] }[] } {
  const trophies = c.trophies ?? [];
  const history = (c.history ?? []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const checkpointMs = Date.parse(c.at);
  const horizonDays = (c.horizon_minutes ?? 0) / DAY_MIN;
  const targetMs = Number.isFinite(Date.parse(c.target))
    ? Date.parse(c.target)
    : checkpointMs + (c.horizon_minutes ?? 0) * 60_000;
  const xTarget = xOf(targetMs);
  const xLast = history.length > 0 ? xOf(Date.parse(history[history.length - 1].at)) : xOf(checkpointMs);
  const dx = Math.max(0, xTarget - xLast);

  // Per-trophy series: last rate, and (x, logit rate) points.
  interface Series {
    lastPct: number;
    xs: number[];
    ys: number[];
    winXs: number[];
    winYs: number[];
  }
  const series: Series[] = trophies.map((t, i) => {
    const s: Series = { lastPct: FALLBACK_LAST_PCT[t.tier] ?? 1.0, xs: [], ys: [], winXs: [], winYs: [] };
    for (const r of history) {
      const rate = r.rates ? r.rates[i] : null;
      if (typeof rate !== "number" || !Number.isFinite(rate)) continue;
      const ms = Date.parse(r.at);
      const x = xOf(ms);
      const y = logitPct(rate);
      s.xs.push(x);
      s.ys.push(y);
      if (ms >= checkpointMs - FIT_WINDOW_MS) {
        s.winXs.push(x);
        s.winYs.push(y);
      }
    }
    // Last rate: from the newest read that lists this trophy.
    for (let k = history.length - 1; k >= 0; k--) {
      const rate = history[k].rates ? history[k].rates[i] : null;
      if (typeof rate === "number" && Number.isFinite(rate)) {
        s.lastPct = rate;
        break;
      }
    }
    return s;
  });

  // First pass: fit each trophy on its last-24h window (all reads if <3).
  const fits: Fit[] = series.map((s) => {
    const useWin = s.winXs.length >= 3;
    const xs = useWin ? s.winXs : s.xs;
    const ys = useWin ? s.winYs : s.ys;
    return ols(xs, ys);
  });

  // Pool slopes and residuals by tier (median), with a global fallback.
  const poolSlopeByTier = new Map<string, number>();
  const tiers = [...new Set(trophies.map((t) => t.tier))];
  const allSlopes = fits.filter((f) => f.slope !== null).map((f) => f.slope as number);
  const globalPoolSlope = median(allSlopes);
  for (const tier of tiers) {
    const ss: number[] = [];
    trophies.forEach((t, i) => {
      if (t.tier === tier && fits[i].slope !== null) ss.push(fits[i].slope as number);
    });
    poolSlopeByTier.set(tier, ss.length >= 2 ? median(ss) : globalPoolSlope);
  }
  const allResid = fits.filter((f) => f.residSd !== null).map((f) => f.residSd as number);
  const poolResid = allResid.length > 0 ? median(allResid) : 0.3;

  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < trophies.length; i++) {
    const t = trophies[i];
    const s = series[i];
    const fit = fits[i];
    const tier = t.tier;
    const ceilingPct = CEILING_PCT[tier] ?? 85;
    const ceilingLogit = logitPct(ceilingPct);
    const lastLogit = logitPct(s.lastPct);

    // Shrink the fitted slope toward the tier pool. Weight grows with the
    // number of fitted points; with a frozen launch-night history the fit
    // is unidentified and the pool (also ~0 there) carries it.
    let slope: number;
    if (fit.slope === null) {
      slope = poolSlopeByTier.get(tier) ?? 0;
    } else {
      const w = fit.n / (fit.n + 4);
      slope = w * fit.slope + (1 - w) * (poolSlopeByTier.get(tier) ?? 0);
    }

    // Fitted gain over the horizon, blended with the tier prior gain.
    // The prior matters most when the fit is flat or noisy; the 0.7/0.3
    // blend keeps the data in charge while never forecasting a dead-flat
    // week for a trophy the data cannot speak about yet.
    const gainFit = slope * dx;
    const gainPrior = (PRIOR_GAIN_RATE[tier] ?? 0.4) * Math.log1p(Math.max(0, horizonDays));
    let gain = 0.7 * gainFit + 0.3 * gainPrior;
    gain = clamp(gain, -3.5, 3.5);

    // Saturating median: never above the tier ceiling — but the ceiling only
    // binds when it sits above the last rate. A trophy already above its
    // tier ceiling (notably the 100% trophy, which stayed at 100% even after
    // the tracked population grew 6x) must not be dragged down to it.
    let medLogit = lastLogit + gain;
    if (ceilingLogit > lastLogit) medLogit = Math.min(medLogit, ceilingLogit);
    // A 100% trophy stays ~100%.
    if (s.lastPct >= 99.99) medLogit = Math.min(medLogit, logitPct(99.99));

    // Spread in logit space: random-walk drift over the horizon, the fit's
    // residual (shrunk toward the pool), refresh-lag uncertainty (Exophase
    // refreshes on its own schedule, so the target read is the last refresh
    // before it, not the target instant), and a constant model term.
    const resid = fit.residSd !== null ? clamp(fit.residSd, 0.15, 0.8) : poolResid;
    const rw = 0.5 * Math.sqrt(Math.max(0, horizonDays));
    const refresh = 0.25 + 0.08 * Math.sqrt(Math.max(0, horizonDays));
    const sigma = clamp(Math.sqrt(rw * rw + resid * resid + refresh * refresh + 0.2 * 0.2), 0.25, 2.0);

    const q = Z.map((z) => round4(clamp(100 * sigmoid(medLogit + z * sigma), MIN_Q, MAX_Q)));
    // Rounding can only preserve order, but enforce non-decreasing anyway.
    for (let k = 1; k < q.length; k++) {
      if (q[k] < q[k - 1]) q[k] = q[k - 1];
    }
    rows.push({ id: t.id, q });
  }
  rows.sort((a, b) => a.id - b.id);
  return { trophies: rows };
}

/** Fallback forecast for a case that cannot be parsed normally: carry the
 *  last rates forward with the house random-walk spread, so the output is
 *  still valid rather than missing. */
function fallbackForecast(c: Partial<CaseFile>): { trophies: { id: number; q: number[] }[] } {
  const trophies = c.trophies ?? [];
  const history = c.history ?? [];
  const horizonDays = (c.horizon_minutes ?? 0) / DAY_MIN;
  const rw = 0.5 * Math.sqrt(Math.max(0, horizonDays));
  const sigma = clamp(Math.sqrt(rw * rw + 0.35 * 0.35), 0.25, 2.0);
  const rows = trophies.map((t, i) => {
    let lastPct = FALLBACK_LAST_PCT[t.tier] ?? 1.0;
    for (let k = history.length - 1; k >= 0; k--) {
      const rate = history[k].rates ? history[k].rates[i] : null;
      if (typeof rate === "number" && Number.isFinite(rate)) {
        lastPct = rate;
        break;
      }
    }
    const m = logitPct(lastPct);
    const q = Z.map((z) => round4(clamp(100 * sigmoid(m + z * sigma), MIN_Q, MAX_Q)));
    return { id: t.id, q };
  });
  rows.sort((a, b) => a.id - b.id);
  return { trophies: rows };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input/";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output/";
  mkdirSync(outputDir, { recursive: true });
  if (!existsSync(inputDir)) {
    console.error(`input dir not found: ${inputDir}`);
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  for (const file of files) {
    const id = file.replace(/\.in$/, "");
    try {
      const raw = readFileSync(join(inputDir, file), "utf8");
      const c = JSON.parse(raw) as CaseFile;
      if (!c || !Array.isArray(c.trophies)) throw new Error("case has no trophies array");
      const out = forecastCase(c);
      writeFileSync(join(outputDir, `${id}.out`), JSON.stringify(out), "utf8");
    } catch (err) {
      console.error(`case ${id} failed (${err instanceof Error ? err.message : err}); writing fallback`);
      try {
        const raw = readFileSync(join(inputDir, file), "utf8");
        const c = JSON.parse(raw) as Partial<CaseFile>;
        const out = fallbackForecast(c);
        writeFileSync(join(outputDir, `${id}.out`), JSON.stringify(out), "utf8");
      } catch {
        console.error(`case ${id}: fallback also failed; no output written`);
        process.exitCode = 1;
      }
    }
  }
}

main();
