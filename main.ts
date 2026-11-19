// gta6-trophy-rarity-forecast-01's house baseline (Node 22, standard library only): persistence. It forecasts that every
// trophy's earn rate on Exophase at the case's target is the rate in the case's last read, with a spread that widens
// like a random walk's on the logit scale:
//
//   q_tau = 100 / (1 + exp(-(logit(r) + z_tau * 0.5 * sqrt(d)))), rounded to 4 decimals
//
// for each trophy, where r is its rate in the last read of the case's history (percent, clamped to 0.01..99.99 before
// the logit, as the scorer clamps), d the case's horizon in days (horizon_minutes / 1440), 0.5 the spread in logit
// units per square-root day, and z_tau the standard normal's quantile at each level tau (0.05, 0.25, 0.5, 0.75, 0.95):
// -1.645, -0.674, 0, 0.674, 1.645. Its numbers are fixed in advance, never tuned on any data. A prize needs a loss
// strictly below the best house entry's.
//
// The kit's starter/main.ts is this program byte for byte (starter/main.py the same numbers in Python): start your entry
// from it. What an entry must do:
//   - read every <id>.in in the input directory (the grader runs one case at a time, with only that case's file there):
//     JSON {"schema":"makefun/gta6-trophies-case/v1","id","at","horizon_minutes","target","levels","game","trophies",
//     "history","notes"}, where `trophies` lists the case's trophies {id, name, description, tier, points, secret} and
//     `history` every read before `at`, oldest first, each {slot, at, players_tracked, trophies_earned, rates}, `rates`
//     in the order of `trophies` (null where that read lacked the trophy);
//   - write <id>.out to the output directory: {"trophies":[{"id":1,"q":[q05,q25,q50,q75,q95]}, ...]}, one row for each
//     of the case's trophies, each id once, no other key, each q five finite numbers from 0 to 100 (percent),
//     non-decreasing; at most 65,536 bytes. Anything else is an invalid case, scored as if every quantile equalled the
//     trophy's rate in the last read, and an entry with an invalid case takes no prize.
// It runs offline, with no network, under the case's time cap: everything it knows is in the case file.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The spread of a rate's move, in logit units per square-root day. */
const SIGMA = 0.5;

interface Case {
  levels: number[];
  horizon_minutes: number;
  trophies: Array<{ id: number }>;
  history: Array<{ rates: Array<number | null> }>;
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const last = c.history[c.history.length - 1];
  if (last === undefined) throw new Error(`${file} has no history`);
  const spread = SIGMA * Math.sqrt(c.horizon_minutes / 1440);
  const trophies = c.trophies.map((t, i) => {
    const l = logit(last.rates[i] ?? 0);
    return { id: t.id, q: Z.map((z) => round4(100 / (1 + Math.exp(-(l + z * spread))))) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
