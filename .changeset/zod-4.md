---
"scenescout": patch
---

Move to zod 4.6.7. An array argument or file field with an upper bound (`.max()`) is now refused on its length before any element is checked, so an oversized array can no longer exhaust memory (GHSA-mrhx-c7xc-m3w5). A saved flow, a baselines file or a report template that is not valid reports zod 4's wording for a wrong type (for example `requirements Invalid input: expected array, received string`). The tools' JSON Schemas no longer print `additionalProperties: false` on argument objects; what a call may carry is unchanged.
