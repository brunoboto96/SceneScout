#!/bin/zsh
# The lane-report benchmark, run headless so effort and timing are controlled.
#
# Every lane gets the same observation log and the same judging task; only the
# shape of the reply differs (prose report vs the typed lane report). Each
# (shape, effort) pair runs N times, all launched at once, and each run writes
# Claude Code's own `--output-format json` result (duration, tokens, cost).
#
#   N=3 EFFORTS="low medium high xhigh max" MODEL=sonnet OUT=/tmp/lane-runs scripts/bench/run-headless.sh
#   npx tsx scripts/bench/summarize-headless.ts /tmp/lane-runs
#
# SHAPES picks the prompts (`prompt-<shape>.md` beside this script); a shape
# other than `prose` is expected to reply with the typed lane report. OUT must
# be empty or absent unless APPEND=1, so two invocations cannot be summarised
# as one by mistake. A run whose `claude` call fails is recorded as FAILED in
# wall.txt and fails the script.
#
# It needs a signed-in `claude` on PATH. Each run is a full Claude Code turn,
# so budget accordingly.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
N=${N:-3}
MODEL=${MODEL:-sonnet}
OUT=${OUT:-/tmp/lane-runs}
if [[ -d "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" && "${APPEND:-0}" != "1" ]]; then
  echo "$OUT is not empty; pass APPEND=1 to add to it or choose another OUT" >&2
  exit 2
fi
mkdir -p "$OUT"
[[ -r "$here/lane-observations.md" ]] || { echo "missing $here/lane-observations.md" >&2; exit 2; }
log="$(sed -n '/^| id | Where/,/^Routes covered/p' "$here/lane-observations.md")"
[[ -n "$log" ]] || { echo "the observation table in lane-observations.md was not found (its heading changed?)" >&2; exit 2; }
for shape in ${=SHAPES:-prose schema}; do
  [[ -r "$here/prompt-$shape.md" ]] || { echo "unknown shape '$shape': no $here/prompt-$shape.md" >&2; exit 2; }
done
pids=()
for effort in ${=EFFORTS:-low high}; do
  for shape in ${=SHAPES:-prose schema}; do
    prompt="$(cat "$here/prompt-$shape.md")

$log"
    for n in $(seq 1 "$N"); do
      (
        start=$(date +%s.%N)
        if env -u CLAUDECODE claude -p "$prompt" --model "$MODEL" --effort "$effort" --tools "" \
          --output-format json --no-session-persistence > "$OUT/$shape-$effort-$n.json" 2> "$OUT/$shape-$effort-$n.err"; then
          end=$(date +%s.%N)
          echo "$shape $effort $n $(echo "$end - $start" | bc)" >> "$OUT/wall.txt"
        else
          rc=$?
          echo "$shape $effort $n FAILED rc=$rc" >> "$OUT/wall.txt"
          exit "$rc"
        fi
      ) &
      pids+=($!)
    done
  done
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
if (( failed > 0 )); then
  echo "$failed run(s) failed; see the FAILED lines in $OUT/wall.txt and the .err files" >&2
  exit 1
fi
echo "runs written to $OUT"
