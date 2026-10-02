/**
 * Whether a credential a scripted login was given turns up in its output or in
 * a file it left under .scenescout/. Pure functions of text, so
 * scripted-login-test can table-test them without a browser.
 *
 * A saved profile is JSON full of numbers and random tokens the app and the
 * browser chose: a cookie's `expires` is seconds with a microsecond fraction,
 * so roughly one cookie in a million has a fraction that spells a given
 * six-digit code. Searching the file's raw text reads that number as a leak.
 * In JSON, a credential the run typed can only be kept as a string (a cookie,
 * a storage entry, a key) or as a number that is the credential itself, so
 * strings are searched for it and numbers are compared whole.
 */

/** Every form a credential could take in output: as set, URL-encoded, with + for spaces, and the secret without its spaces. */
export function credentialForms(values: string[]): string[] {
  const forms = values.flatMap((v) => [v, encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), v.replace(/\s+/g, "")]);
  return [...new Set(forms.filter((s) => s.length > 0))];
}

/** The secrets, in any of their forms, that a text contains, ignoring case. */
export function leaked(text: string, secrets: string[]): string[] {
  const lower = text.toLowerCase();
  return credentialForms(secrets).filter((s) => lower.includes(s.toLowerCase()));
}

/**
 * The secrets, in any of their forms, that a file holds. A JSON file is read
 * value by value: every key and string is searched as text, and a number
 * counts only when it is a credential written as a number, never because its
 * digits happen to contain one. A file that is not JSON is searched as text.
 */
export function leakedInFile(text: string, secrets: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return leaked(text, secrets); // Not JSON: a log or a report, searched whole.
  }
  const forms = credentialForms(secrets);
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") for (const s of leaked(value, secrets)) found.add(s);
    else if (typeof value === "number") {
      if (forms.includes(String(value))) found.add(String(value));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        visit(k);
        visit(v);
      }
    }
  };
  visit(parsed);
  return [...found];
}
