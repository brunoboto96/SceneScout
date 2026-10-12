/**
 * Redaction of credentials and personal data from text the engine is about to
 * persist or publish. memory.ts re-exports both functions, so importers that
 * reach them through the store are unchanged.
 */
import { maskSecretFieldValues, maskSecretParams, redactPersonal } from "./sensitive.js";

/**
 * Secrets an app leaks into its own error UI must not be re-published by the
 * tool that found them. Findings quote app output verbatim, and that output has
 * in practice included partial provider API keys; `.scenescout/` is gitignored
 * but still gets zipped and attached to tickets. Keep a short prefix so the
 * finding stays actionable, drop the rest.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Needs the environment marker (sk_live_…) or a digit in the tail, or it
  // eats ordinary identifiers: "pk_customer_identifier" became "pk_[redacted]".
  [/\b(sk|pk|rk)[-_](?:(?:live|test|proj)[-_][A-Za-z0-9]{8,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,})/g, "$1_[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh?_[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA[redacted]"],
  // Keep the scheme that actually matched: rewriting a Basic-auth finding to
  // say "Bearer" silently changes what the finding claims.
  // Same entropy requirement as the keyword rule: "Basic authentication-required"
  // is prose, and redacting it rewrote a sentence into nonsense.
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9._-]{20,}/g, "eyJ[redacted-jwt]"],
  // Keyword-led values need an entropy signal — a digit AND a letter, no
  // internal word breaks. Without it this matched ordinary English: "Password
  // requirements are not enforced" became "Password [redacted] are not
  // enforced", and a mangled finding just reads as the agent writing nonsense.
  [/\b(api[-_]?key|secret|password|token)(["'\s:=]+)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=]{12,}/gi, "$1$2[redacted]"],
];

/**
 * Strip anything that looks like a credential from text we are about to
 * persist: credential shapes, a value typed into a field whose label names a
 * secret (`textbox "Password" ← "…"`, whatever its length), the value of a
 * parameter named for one (`?password=…`), and personal data
 * (email addresses and card numbers, sensitive.ts).
 *
 * Silent edits are their own hazard, so a redaction announces itself: a reader
 * who sees mangled-looking text needs to know the tool did it deliberately.
 * Credentials and masked values are counted in a trailing note; personal data
 * is replaced by a marker that names it (`[email redacted]`).
 */
export function redactSecrets(text: string): string {
  const masked = maskSecretFieldValues(text);
  // A parameter named for a secret (`?pin=…` from a GET form) is masked whatever its value looks like.
  const params = maskSecretParams(masked.text);
  let out = params.text;
  let hits = masked.hits + params.hits;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      hits += 1;
      return replacement.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ""));
    });
  }
  out = redactPersonal(out);
  return hits > 0 ? `${out} [${hits} secret${hits === 1 ? "" : "s"} redacted]` : out;
}

/**
 * Routes are links the app printed, and a link can carry a token
 * (`?reset=…`, `?api_key=…`). Evidence is redacted where issues are built;
 * this does the same for every route string before anything is written.
 */
export function redactRoute(route: string): string {
  // The trailing "[n secrets redacted]" note belongs to prose; in a route it would read as part of the path.
  return redactSecrets(route).replace(/ \[\d+ secrets? redacted\]$/, "");
}
