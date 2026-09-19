---
"scenescout": minor
---

The engine now notices when a value it typed comes back as markup. Any markup-shaped value the agent types — `<script>…</script>`, `<img src=x onerror=…>`, a `<b>` — is remembered by shape, and every page seen afterwards is checked for an element of that shape. When one is found, a `dom_injection` violation (severity high) names the field it was typed into, the page it was typed on, the page it rendered on and the element it became: whoever opens that page runs the input, which is a stored or reflected XSS. The oracle never chooses what to type; the method asks for markup in the fuzzing pass, and the rest is the agent's judgment.
