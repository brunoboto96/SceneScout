---
"scenescout": minor
---

A saved flow can take a `type` or `select` value from the environment with `${env:NAME}`, so a one-time code or a password stays in the CI's secret store rather than in the flow file. A variable that is not set stops the check before it starts, naming the flow and the variable, and every substituted value of four characters or more is masked as `[$NAME]` in everything the check writes and prints.
