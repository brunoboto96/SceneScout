/**
 * Redaction of credentials and personal data from text the engine is about to
 * persist or publish. memory.ts re-exports both functions, so importers that
 * reach them through the store are unchanged.
 */
import { FIELD_WORDS, maskSecretFieldValues, maskSecretParams, redactPersonal } from "./sensitive.js";

/**
 * Secrets an app leaks into its own error UI must not be re-published by the
 * tool that found them. Findings quote app output verbatim, and that output has
 * in practice included partial provider API keys; `.scenescout/` is gitignored
 * but still gets zipped and attached to tickets. Keep a short prefix so the
 * finding stays actionable, drop the rest.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // A private key's whole block, or its start to the end of the text when the end is cut off.
  [/-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}[\s\S]*?(?:-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY-{5}|$)/g, "[private key redacted]"],
  // Providers' key shapes, each by its fixed prefix, so the prefix alone ("the sk-ant prefix") is prose.
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-[redacted]"],
  [/\b(xox[abeprs])-[A-Za-z0-9-]{10,}/g, "$1-[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "glpat-[redacted]"],
  [/\bnpm_[A-Za-z0-9]{36,}/g, "npm_[redacted]"],
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
  // A bearer token of letters only is still a token when it is one unbroken run: prose joins its words with hyphens.
  // Not Basic: "basic internationalization" is prose of the same shape.
  [/\b(Bearer)\s+[A-Za-z._~+/=]{16,}(?![A-Za-z0-9._~+/=-])/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9._-]{20,}/g, "eyJ[redacted-jwt]"],
  // Keyword-led values need an entropy signal — a digit AND a letter, no
  // internal word breaks. Without it this matched ordinary English: "Password
  // requirements are not enforced" became "Password [redacted] are not
  // enforced", and a mangled finding just reads as the agent writing nonsense.
  [/\b(api[-_]?key|secret|password|token)(["'\s:=]+)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=]{12,}/gi, "$1$2[redacted]"],
  // A PIN or a sign-in code written after its word: four to eight digits after "PIN", six to eight after "code",
  // unless the code is an error, status, postal or product one.
  [/\b(PIN)(\s*(?:is\s+|[:=#]\s*)?)\d{4,8}(?!\d|[-./]\d)/gi, "$1$2[redacted]"],
  [
    /(?<!\b(?:error|status|postal|zip|product|area|country|exit|reference|promo|order|tracking|response|http|reason|discount)\s)\b((?:(?:verification|login|sign-in|security|one-time|otp|sms|2fa|mfa|auth|access|confirmation)\s+)?code)(\s*(?:is\s+|[:=]\s*)?)\d{6,8}(?!\d)/gi,
    "$1$2[redacted]",
  ],
];

/**
 * A secret's name set against a value with a colon or an equals sign
 * (`password: hunter2`, `"client_secret":"abc"`), whatever the value's length
 * or letters. Group 1 is the name, 2 the separator, 3 the value. A value of
 * letters only must end its clause and not be a word about the field, so
 * "Password: required" and "Token: missing after refresh" stay.
 */
const SET_SECRET_RE = /\b((?:[A-Za-z]+[-_]?)??(?:password|passwd|pwd|passphrase|secret|api[-_]?key|token))(\s*["']?\s*[:=]\s*["']?)(?!\[)([^\s"',;)}\]]+)/gi;

function maskSetSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(SET_SECRET_RE, (m, name: string, sep: string, raw: string, offset: number, whole: string) => {
    // A sentence's full stop is not part of the value.
    const stop = /\.+$/.exec(raw)?.[0] ?? "";
    const value = raw.slice(0, raw.length - stop.length);
    if (value === "") return m;
    if (/^\p{L}+$/u.test(value)) {
      if (FIELD_WORDS.has(value.toLowerCase())) return m;
      const after = stop + whole.slice(offset + m.length);
      if (!/^(?:\s*$|\s*[,;)}\]"'\n]|\.(?:\s|$))/.test(after)) return m;
    } else if (value.length < 3 && !/["']/.test(sep)) return m;
    hits += 1;
    return `${name}${sep}[redacted]${stop}`;
  });
  return { text: out, hits };
}

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
  const set = maskSetSecrets(params.text);
  let out = set.text;
  let hits = masked.hits + params.hits + set.hits;
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
