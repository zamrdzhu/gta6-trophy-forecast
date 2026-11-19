# gta6-trophy-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/zamrdzhu/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/zamrdzhu/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every GTA VI (PS5) trophy's earn rate on Exophase at 2026-11-26T00:00:00Z — a per-trophy growth model in logit space, fitted to the house's recorded reads and extrapolated to week one. Node 22, standard library only, deterministic.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Reads every `*.in` case in the input dir (name order) and writes one `<id>.out` per case: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}]}`.

## The model

**Assumptions.** Earn rates move multiplicatively in odds space, so growth is modelled on the logit scale, where a 1% → 2% move counts like a 33% → 50% move — the same scale the scoring uses. Two forces move a rate over week one: the tracked population broadens (new players join Exophase's count, which *dilutes* rates — launch night showed exactly this: the first refresh grew tracked players 638 → 3,868 and pushed every rate but the 100% one down) and tracked players progress through the game (which *raises* rates, fastest for early/easy trophies). Both forces slow in log time since release, so trajectories are fitted against `x = ln(1 + hours since 2026-11-19T00:00Z)`, not against raw clock time. Exophase refreshes on its own schedule, so the target read reflects the last refresh before the target, not the target instant — that lag is genuine uncertainty, not noise to fit away.

**Formula.** For each trophy, per case:

1. Fit OLS of `logit(rate)` on `x` over the last 24 h of reads (all reads if fewer than 3), giving slope `s` and residual SD.
2. Shrink the slope toward the tier-pooled median slope, weight `n / (n + 4)` on the trophy's own fit — with a frozen launch-night history the fit is unidentified and the pool carries it.
3. Extrapolate: `gain = 0.7 · s_shrunk · (x_target − x_last) + 0.3 · prior_gain`, where `prior_gain = rate_tier · ln(1 + horizon_days)` with `rate_tier` = 0.15 (platinum), 0.35 (gold), 0.45 (silver), 0.55 (bronze). The data leads; the prior keeps a trophy the data cannot speak about yet from being forecast dead flat over a week.
4. Saturate: the median logit is capped at a tier ceiling (platinum 8%, gold 30%, silver 55%, bronze 85%) — a straight line in logit space would otherwise run away for the fastest growers. The ceiling never drags a trophy *down* to it: a trophy already above its ceiling (notably the 100% trophy, which held 100% through the 6× refresh) stays there.
5. Spread (logit SD): `σ = √(rw² + resid² + refresh² + 0.2²)`, clamped to [0.25, 2.0], where `rw = 0.5·√(horizon_days)` is the house random walk, `resid` the fit residual (clamped [0.15, 0.8], pooled fallback), and `refresh = 0.25 + 0.08·√(horizon_days)` the refresh-lag term. Quantiles are `100 · sigmoid(median_logit + z_τ · σ)` at the standard normal quantiles, rounded to 4 decimals.

**Why it beats carry-forward.** The house baseline holds every rate flat and only widens the band; on the final's 4.5-day horizon its median is the rate as of the deadline, while the real week-one rates for early trophies will have moved several-fold in odds. This model follows each trophy's own fitted trajectory, so trophies that were climbing into the deadline keep climbing (toward a ceiling), trophies diluted by new joiners keep their downward drift (tempered by the prior), and the spread is honest about refresh lag instead of pretending the target read is an instant snapshot.

**Validation done.** Run twice on the practice cases (p00, p01): byte-identical outputs, ~0.21 s per run, both files 2,792 bytes, 55 rows, ids 1–55 each once, quantiles non-decreasing in [0.01, 99.99]. Practice histories are frozen (all reads identical), so the fit is correctly unidentified there and the forecast is carry-forward plus a wider band (σ ≈ 0.39 vs the house's 0.125) — the wider band is deliberate: the practice answers are the post-refresh page, and the house baseline's narrow band scores ~1.51 with ~0 coverage. Practice answers are not in the kit, so no local pinball score is possible; shape, determinism and runtime were verified instead. The final case cannot be scored locally either — it is scored on the Nov 26 read. As a check of the final regime, a synthetic final was built (111 reads over Nov 19–21 with per-trophy logit growth in log time plus a first-refresh dilution dip, checkpoint Nov 21 11:30, target Nov 26): the model scored mean pinball 0.263 vs the house baseline's 0.768, with 90% coverage 1.00 vs 0.84 — the growth extrapolation, not the spread, does the work. (The synthetic law matches the model family, so treat the margin as directional, not a promise.)

**Limitations.** The model has no data on which trophies are story beats vs grinds beyond what their launch rates and trajectories imply, so the tier ceilings and prior gains are coarse priors, not per-trophy knowledge. If Exophase's refresh cadence changes near the target, the refresh term may be too wide or too narrow. If a trophy's last-24 h slope is dominated by one refresh jump, the fit can over-extrapolate — the shrinkage and the ceiling are the guards, not a cure.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ta9jpaag&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
