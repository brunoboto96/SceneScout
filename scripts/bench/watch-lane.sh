#!/bin/zsh
# Watch one lane reply as it is generated: the same prompt the benchmark uses,
# streamed to the terminal. Thinking is shown dimmed, the reply in full, and a
# failed run says so instead of printing a done line. Needs `jq`.
#
#   scripts/bench/watch-lane.sh [shape] [effort]      # defaults: schema medium
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
shape=${1:-schema}
effort=${2:-medium}
command -v jq >/dev/null || { echo "watch-lane.sh needs jq on PATH" >&2; exit 2; }
[[ -r "$here/prompt-$shape.md" ]] || { echo "unknown shape '$shape': no $here/prompt-$shape.md" >&2; exit 2; }
log="$(sed -n '/^| id | Where/,/^Routes covered/p' "$here/lane-observations.md")"
[[ -n "$log" ]] || { echo "the observation table in lane-observations.md was not found" >&2; exit 2; }
prompt="$(cat "$here/prompt-$shape.md")

$log"
echo "lane: $shape @ $effort (${MODEL:-sonnet}) — streaming" >&2
env -u CLAUDECODE claude -p "$prompt" --model "${MODEL:-sonnet}" --effort "$effort" --tools "" \
  --output-format stream-json --include-partial-messages --verbose --no-session-persistence |
  jq -rj '
    if .type == "stream_event" then
      (.event.delta.thinking // empty | "\u001b[2m" + . + "\u001b[0m"),
      (.event.delta.text // empty)
    elif .type == "result" then
      if .is_error or .subtype != "success" then
        "\n\n— FAILED (\(.subtype // "unknown")): \(.result // "no result text")\n"
      else
        "\n\n— done in \((.duration_ms // 0) / 1000 | floor)s, \(.usage.output_tokens // 0) output tokens (\(.usage.output_tokens_details.thinking_tokens // 0) thinking), $\(((.total_cost_usd // 0) * 1000 | floor) / 1000)\n"
      end
    else empty end'
