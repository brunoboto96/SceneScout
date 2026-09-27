---
"scenescout": minor
---

Add `scenescout ci <url>`, an exploratory run with no person present: a model reached through the Anthropic Messages API or the OpenAI Responses API drives the scout_* tools by the SceneScout method and the run ends in the ordinary report. It reports and never gates: it exits 0 when the run ran, whatever it found, and 2 when it could not run.

- The key is read from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only and is redacted from everything the run prints or writes; with both set, `--provider` chooses. `--model`, `--effort` (default `low`) and `--base-url` override the defaults (`claude-sonnet-5`, `gpt-5.6-luna`).
- The run stops at the first of 40 turns, 1,500,000 tokens or 20 minutes (`--max-turns`, `--max-tokens`, `--max-minutes`), still writes the report, and says which cap ended it.
- It runs in `read-only` mode by default (`--mode observe|read-only|safe-write`, or `destructive` together with `--allow-destructive`) at level `medium` (`--level`).
- It writes `report.md`, `report.html`, `summary.md` (also on the GitHub job summary), `ci.json` and `ci.sarif`, with a usage line of turns, tokens, time and an estimated cost. `--price-in`, `--price-cached-in` and `--price-out` set the prices the estimate uses, for any model.
- A second GitHub Action, `brunoboto96/SceneScout/ci`, runs it; its inputs are the command's options.
