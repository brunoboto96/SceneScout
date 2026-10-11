---
"scenescout": patch
---

Secret fields are painted over in pictures. Every field whose typed value the log masks (a password field, a card or one-time-code autocomplete, a label naming a secret) is covered with a solid `#FF00FF` box in `scout_screenshot`, `scout_capture`, a finding's picture, recorded frames, baselines and the live view's still pictures, including after a show-password toggle while the field's name, label or autocomplete still says password, and inside embedded frames. The paint is the same on every run, so baselines still compare; a baseline saved by an earlier version that pictured a secret field differs once at that field and needs `--baseline update`. A check's video and the live view's streamed screencast are not painted.
