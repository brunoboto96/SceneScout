/**
 * What is typed into a secret field is never written down. The fixture's two
 * fields differ only in their input type: what is typed into the password one,
 * and what it held before, is masked in the type result, the action log, the
 * session log, memory.json and a plan's transcript; what is typed into the text
 * one stays readable. A field named by nothing but its autocomplete token
 * (one-time-code) is masked too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "masked typing";

const SECRET = "Tr1cky-Phrase-77";
const OLD_SECRET = "Old-phrase-42";
const CODE = "482913";
const PLAN_SECRET = "Plan-phrase-31";
/** Letters in a number field: the browser refuses the fill, and Playwright's error quotes the value without escaping its quote. */
const REFUSED_PIN = 'Pin"refused-93';
const DIGIT = "7";
const TOGGLED_SECRET = "Shown-phrase-58";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("masked typing: a secret field's value never reaches the log, an ordinary field's does");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-masked-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "masked";
  try {
    await engine.attach({ url: `${baseUrl}/secret-fields.html`, projectDir, mode: "read-only" });
    const snap = await engine.snapshot(true);
    const refOf = (pattern: RegExp): string => {
      const m = snap.match(pattern);
      if (!m) throw new Error(`ref not found for ${pattern} in:\n${snap.slice(0, 1500)}`);
      return m[1];
    };
    const hidden = refOf(/(e\d+) textbox "Account phrase"(?! \(shown\))/);
    const shown = refOf(/(e\d+) textbox "Account phrase \(shown\)"/);
    const code = refOf(/(e\d+) textbox "Code from the app"/);

    const typedSecret = await engine.type(hidden, SECRET, false, true);
    check(
      "typing into a password field: the result shows a mask, not the value or what the field held",
      !typedSecret.includes(SECRET) && !typedSecret.includes(OLD_SECRET) && typedSecret.includes("← •••• (masked: password field)"),
      typedSecret.slice(0, 300),
    );
    check("...and says what it held was masked too", typedSecret.includes("existing content (masked: password field)"), typedSecret.slice(0, 300));

    const typedShown = await engine.type(shown, "New-shown-42", false, true);
    check(
      "...while the same kind of field as plain text keeps the value and what it held",
      typedShown.includes('← "New-shown-42"') && typedShown.includes('existing content "Old-shown-42"'),
      typedShown.slice(0, 300),
    );

    const typedCode = await engine.type(code, CODE, false, false);
    check(
      "a field named only by autocomplete=one-time-code is masked",
      !typedCode.includes(CODE) && typedCode.includes("masked: one-time code field"),
      typedCode.slice(0, 300),
    );

    let refused = "";
    try {
      refused = await engine.type(refOf(/(e\d+) [a-z]+ "PIN"/), REFUSED_PIN, false, true);
    } catch (err) {
      refused = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    check(
      "a fill the browser refuses on a PIN field fails without quoting the value",
      refused.startsWith("ERROR:") && !refused.includes("refused-93") && refused.includes("(masked)"),
      refused.slice(0, 400),
    );

    const typedDigit = await engine.type(refOf(/(e\d+) textbox "Digit 1"/), DIGIT, false, true);
    check(
      "a one-character box of a split code is masked, though nothing names it a code",
      !typedDigit.includes(`"${DIGIT}"`) && typedDigit.includes("masked: one-time code field"),
      typedDigit.slice(0, 300),
    );

    // A show-password toggle makes the field type=text, and nothing else about it names a secret.
    await engine.click(refOf(/(e\d+) button "Show phrase"/));
    const typedToggled = await engine.type(hidden, TOGGLED_SECRET, false, true);
    check(
      "after a show-password toggle the field is still masked, as it was a password when typed into before",
      !typedToggled.includes(TOGGLED_SECRET) && typedToggled.includes("← •••• (masked: password field)"),
      typedToggled.slice(0, 300),
    );

    const plan = await engine.runPlan([{ action: "type", target: "testid=phrase-hidden", value: PLAN_SECRET, replace: true }]);
    check("a plan's type step into the password field quotes neither value", !plan.includes(PLAN_SECRET) && !plan.includes(SECRET), plan.slice(0, 400));
    check("...and says the previous content was masked", plan.includes("existing content (masked: password field)"), plan.slice(0, 400));

    const log = JSON.stringify(engine.memory?.actionLog ?? []);
    check(
      "the action log holds no secret value and still holds the ordinary one",
      ![SECRET, OLD_SECRET, CODE, PLAN_SECRET, TOGGLED_SECRET, "refused-93"].some((s) => log.includes(s)) &&
        !log.includes(`"${DIGIT}"`) &&
        log.includes("New-shown-42"),
      log.slice(0, 600),
    );
  } finally {
    await engine.close();
  }
  // What reached disk: the session's JSONL log and memory.json.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|jsonl|md|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(projectDir);
  const leaking = files.filter((f) =>
    [SECRET, OLD_SECRET, CODE, PLAN_SECRET, TOGGLED_SECRET, "refused-93"].some((s) => fs.readFileSync(f, "utf8").includes(s)),
  );
  check(
    "no file the run wrote holds a secret value",
    files.length > 0 && leaking.length === 0,
    `${files.length} files; leaking: ${leaking.map((f) => path.basename(f)).join(", ")}`,
  );
  fs.rmSync(projectDir, { recursive: true, force: true });
}
