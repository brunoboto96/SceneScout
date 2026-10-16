/**
 * Whether a page's answer is a bot-protection challenge rather than the app.
 *
 * A check that crawls a challenge page measures the protection's checkbox and
 * link and calls that the app: a pass that tested nothing. The rules are kept
 * here, away from the browser, so each vendor's marker is table-tested with a
 * near miss beside it (check-test).
 *
 * A header a protection sets only when it challenges (Cloudflare's
 * `cf-mitigated: challenge`, AWS WAF's `x-amzn-waf-action`) decides on its own.
 * Every other marker counts only on a refusing status (403, 429 or 503), since
 * an app's ordinary page may load a vendor's script, and an app's own 403 page
 * names no vendor.
 */

/** The statuses a challenge or a block page answers with. A marker on any other status is the app's page. */
export const CHALLENGE_STATUSES: readonly number[] = [403, 429, 503];

/** How much of a refusing page's body is searched for markers: the markers sit in the head or near the top. */
export const CHALLENGE_BODY_LIMIT = 64 * 1024;

interface HeaderRule {
  vendor: string;
  header: string;
  /** Matched against the header's value, lowercased. */
  value: RegExp;
  /** Whether the header alone decides, whatever the status. */
  anyStatus: boolean;
}

/** Response headers that mark a challenge. Names are lowercase, as Playwright gives them. */
export const CHALLENGE_HEADERS: readonly HeaderRule[] = [
  { vendor: "Cloudflare", header: "cf-mitigated", value: /^challenge$/, anyStatus: true },
  { vendor: "AWS WAF", header: "x-amzn-waf-action", value: /^(captcha|challenge)$/, anyStatus: true },
  // DataDome sets this header on every answer it passes too; only a refusing status makes it a block.
  { vendor: "DataDome", header: "x-datadome", value: /./, anyStatus: false },
  { vendor: "Sucuri", header: "x-sucuri-block", value: /./, anyStatus: false },
];

/** Text in a refusing page's body that names the protection that served it. Matched lowercased. */
export const CHALLENGE_MARKERS: ReadonlyArray<{ vendor: string; marker: string }> = [
  { vendor: "Cloudflare", marker: "<title>just a moment...</title>" },
  { vendor: "Cloudflare", marker: "cf-chl-" },
  { vendor: "Cloudflare", marker: "_cf_chl_opt" },
  { vendor: "Cloudflare", marker: "challenges.cloudflare.com" },
  { vendor: "Cloudflare", marker: "<title>attention required! | cloudflare</title>" },
  { vendor: "Akamai", marker: "errors.edgesuite.net" },
  { vendor: "Akamai", marker: "sec-if-cpt" },
  { vendor: "Akamai", marker: "bm-verify" },
  { vendor: "DataDome", marker: "captcha-delivery.com" },
  { vendor: "PerimeterX (HUMAN)", marker: "px-captcha" },
  { vendor: "PerimeterX (HUMAN)", marker: "_pxappid" },
  { vendor: "PerimeterX (HUMAN)", marker: "px-cloud.net" },
  { vendor: "AWS WAF", marker: "awswafintegration" },
  { vendor: "AWS WAF", marker: "aws-waf-token" },
  { vendor: "AWS WAF", marker: ".token.awswaf.com" },
  { vendor: "Imperva", marker: "_incapsula_resource" },
  { vendor: "Sucuri", marker: "sucuri website firewall" },
];

/** What a route answered: its status, its headers (names lowercase) and, on a refusing status, the start of its body. */
export interface ChallengeAnswer {
  status: number;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

/** Whether the body is worth reading: only a refusing status can make a body marker count. */
export function challengeBodyMatters(status: number): boolean {
  return CHALLENGE_STATUSES.includes(status);
}

/** The protection that served this answer instead of the app, or null when it is the app's own. */
export function botChallenge(answer: ChallengeAnswer): string | null {
  const refusing = CHALLENGE_STATUSES.includes(answer.status);
  for (const rule of CHALLENGE_HEADERS) {
    const value = answer.headers[rule.header];
    if (value === undefined || !rule.value.test(value.trim().toLowerCase())) continue;
    if (rule.anyStatus || refusing) return rule.vendor;
  }
  if (!refusing || !answer.body) return null;
  const body = answer.body.slice(0, CHALLENGE_BODY_LIMIT).toLowerCase();
  return CHALLENGE_MARKERS.find((m) => body.includes(m.marker))?.vendor ?? null;
}

/** How the line an attach adds about a start page that is not the app begins: an unattended run stops on it (ci.ts attachFailure). */
export const START_PAGE_WARNING = "⚠ START PAGE";

/**
 * The line an attach adds when the page it opened is not the app: a bot
 * challenge, or any 4xx. Null for a page that answered as the app. An
 * interactive session reads it as a warning; an unattended run cannot go on.
 */
export function startPageWarning(url: string, status: number | null, challenge: string | null): string | null {
  if (challenge)
    return `${START_PAGE_WARNING} BLOCKED — blocked by bot protection (HTTP ${status ?? "no status"}): ${challenge} answered ${url} in the app's place, so nothing on it is the app. Let the browser through the protection, or use a deployment without it.`;
  if (status !== null && status >= 400 && status < 500)
    return `${START_PAGE_WARNING} REFUSED — ${url} answered HTTP ${status}, so nothing on it is the app. Check the URL${status === 401 || status === 403 ? ", or attach with a signed-in session" : ""}.`;
  return null;
}
