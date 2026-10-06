---
"scenescout": minor
---

A seeded exploration schedule, opt-in. `scenescout ci --seed <seed>` (or `--seed auto`, or `SCENESCOUT_SEED`) crawls first and orders the routes by a shuffle keyed on the seed, and `scout_lane_brief {seed}` deals modules and orders each lane's routes the same way. Each seeded run records the routes it started with in the project's memory; the next seeded run puts those last (`--seed-exclusion back`, the default) or leaves them out (`skip`), so successive runs spread over the app. The same seed repeats its order. The seed is named in the report, `summary.md`, `ci.json` and the lane brief. The ci action and the benchmark workflow take a `seed` input. Without a seed, runs behave as before.
