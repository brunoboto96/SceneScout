/**
 * A second engine on the same project: cross-run memory, safe-write ownership, the double-submit probe, uploads, and written assumptions.
 */
import fs from "node:fs";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, settle, until, type SmokeContext } from "./harness.ts";

export const title = "cross-run memory, safe-write, uploads";

export async function run({ baseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const engine2 = new BrowserEngine();
  try {
    console.log("memory survives a new engine (cross-run persistence)");
    await engine2.attach({ url: baseUrl, projectDir, mode: "read-only" });
    const snap4 = await engine2.snapshot();
    check("second run sees prior coverage", snap4.includes("(revisited)"), snap4);

    console.log("write policy: observe lets nothing but GETs leave the page");
    // read-only lets an ordinary form POST through, because submitting forms is
    // how validation bugs are found. On a target holding real data that POST
    // creates a record somebody has to clean up. observe is the mode for that.
    await engine2.attach({ url: baseUrl, projectDir, mode: "observe" });
    const obSnap = await engine2.snapshot(true);
    const obRef = obSnap.match(/(e\d+) button "Create item"/)?.[1];
    if (!obRef) throw new Error("Create item button not found");
    const postsBefore = stats.itemPosts;
    const obResult = await engine2.click(obRef);
    await settle(400);
    check("observe: a plain create POST is reported as blocked", obResult.includes("WRITE-POLICY blocked (observe)") && obResult.includes("POST"), obResult);
    check("observe: the POST never reaches the server", stats.itemPosts === postsBefore, `server received ${stats.itemPosts - postsBefore} POST(s)`);
    check("observe: the blocked request is not also reported as a possible mutation", !obResult.includes("may have mutated"), obResult);

    console.log("write policy: safe-write allows create + own-resource mutations only");
    await engine2.attach({ url: baseUrl, projectDir, mode: "safe-write" });
    const swSnap = await engine2.snapshot(true);
    const swRefOf = (label: string): string => {
      const m = swSnap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
      if (!m) throw new Error(`ref not found for ${label}`);
      return m[1];
    };
    await engine2.click(swRefOf("Create item"));
    await until("item creation to register", () => engine2.createdResources.some((r) => r.includes("/api/items") && r.includes("id=42")));
    check(
      "creation tracked with id + collection",
      engine2.createdResources.some((r) => r.includes("/api/items") && r.includes("id=42")),
      JSON.stringify(engine2.createdResources),
    );
    const ownResult = await engine2.click(swRefOf("Sync own item"));
    check("PUT on own resource allowed", !ownResult.includes("WRITE-POLICY blocked"), ownResult);
    await engine2.click(swRefOf("Create document"));
    await until("document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=99")));
    check(
      "creation tracked when the response names its id after the resource (document_id, not id)",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=99")),
      JSON.stringify(engine2.createdResources),
    );
    const ownDocResult = await engine2.click(swRefOf("Sync own document"));
    check("PUT on own document (owned via document_id) allowed", !ownDocResult.includes("WRITE-POLICY blocked"), ownDocResult);
    await engine2.click(swRefOf("Create quick document"));
    await until("quick-document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=250")));
    check(
      "own id tracked (document_id) even when an unrelated server-derived foreign key (owner_id) rides along",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=250")),
      JSON.stringify(engine2.createdResources),
    );
    check(
      "server-derived foreign key (owner_id=3, never echoed anywhere) is NOT claimed as owned",
      !engine2.createdResources.some((r) => r.includes("id=3")),
      JSON.stringify(engine2.createdResources),
    );
    await engine2.click(swRefOf("Create document from template"));
    await until("templated-document creation to register", () => engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=199")));
    check(
      "own id tracked even when a foreign key rides along in the same 201 response",
      engine2.createdResources.some((r) => r.includes("/api/documents") && r.includes("id=199")),
      JSON.stringify(engine2.createdResources),
    );
    check(
      "foreign key echoed in the request body (template_id=5) is NOT claimed as owned, despite the 201",
      !engine2.createdResources.some((r) => r.includes("id=5")),
      JSON.stringify(engine2.createdResources),
    );
    const ownTmplDocResult = await engine2.click(swRefOf("Sync templated document"));
    check(
      "PUT on the plain resource path (/api/documents/199) allowed even though creation went through an RPC-style action URL (/api/documents/from-template/5)",
      !ownTmplDocResult.includes("WRITE-POLICY blocked"),
      ownTmplDocResult,
    );
    await engine2.click(swRefOf("Create and save document"));
    // The create half of the chain registers id=301; waiting for that means the
    // PUT that follows it has had its ownership question answered.
    await until("the create+save chain to register its id", () => engine2.createdResources.some((r) => r.includes("id=301")));
    const raceSnap = await engine2.snapshot(true);
    check(
      "create-then-immediately-PUT chained in one click (no artificial delay) is not wrongly blocked by the ownership-registration race",
      raceSnap.includes("create+save 200"),
      raceSnap.match(/[^\n]*wp-result-label[^\n]*/)?.[0] ?? raceSnap,
    );
    console.log("impatient-user probe (double-submit)");
    const dblUnguarded = await engine2.click(swRefOf("Create item"), 2);
    check("unguarded submit fires duplicate requests on rapid double-click and is flagged", dblUnguarded.includes("DOUBLE-SUBMIT SIGNAL"), dblUnguarded);
    const dblGuarded = await engine2.click(swRefOf("Guarded create"), 2);
    check("self-disabling submit fires once and is reported as guarded", dblGuarded.includes("double-submit appears guarded"), dblGuarded);

    const foreignResult = await engine2.click(swRefOf("Sync foreign item"));
    check("DELETE on foreign resource blocked in safe-write", foreignResult.includes("WRITE-POLICY blocked"), foreignResult);
    const delOwn = await engine2.click(swRefOf("Delete all widgets"));
    check("safe-write does NOT label-block (network layer owns policy)", !delOwn.includes("REFUSED by read-only policy"), delOwn);
    await engine2.click(swRefOf("Sync existing item"));
    // Asserting a NEGATIVE (the upsert's echoed id must never be claimed), so
    // there is no positive condition to poll for — the id legitimately never
    // appears. A bounded settle is the honest tool here; `until` would just be
    // a fixed delay wearing a poll's clothes.
    await settle(300);
    check("upsert-echoed id is not claimed as owned", !engine2.createdResources.some((r) => r.includes("id=7")), JSON.stringify(engine2.createdResources));
    const foreignAfterUpsert = await engine2.click(swRefOf("Sync foreign item"));
    check("upsert-echoed id does not grant ownership (DELETE still blocked)", foreignAfterUpsert.includes("WRITE-POLICY blocked"), foreignAfterUpsert);

    console.log("uploads: file inputs get files, not text");
    const refByTestid = (snap: string, testid: string): string => {
      const m = snap.match(new RegExp(`(e\\d+) [a-z]+ "[^"]*" \\[testid=${testid}[,\\]]`));
      if (!m) throw new Error(`ref not found for testid ${testid}`);
      return m[1];
    };
    await engine2.navigate("/index.html");
    const upSnap = await engine2.snapshot(true);
    check(
      "a file input is listed with its own role, not as a textbox",
      /e\d+ file "Attachment" \[testid=upload-attachment-input/.test(upSnap),
      upSnap.match(/[^\n]*upload-attachment-input[^\n]*/)?.[0] ?? upSnap,
    );
    const attachmentRef = refByTestid(upSnap, "upload-attachment-input");
    const typedIntoFile = await engine2.type(attachmentRef, "not a file");
    check("typing into a file input is redirected to scout_upload instead of throwing", typedIntoFile.includes("scout_upload"), typedIntoFile);
    const direct = await engine2.upload({ ref: attachmentRef });
    check(
      "a visible file input takes a generated fixture, kind inferred from accept=.pdf",
      direct.includes("OK: upload") && direct.includes("scenescout-fixture.pdf") && direct.includes("inferred from accept"),
      direct,
    );
    check("selection without a request says the form still needs its submit", direct.includes("click it next"), direct);
    await engine2.click(refByTestid(upSnap, "upload-submit-action"));
    await until("the multipart upload to land", () => stats.uploadLog.some((u) => u.filename === "scenescout-fixture.pdf"));
    check(
      "the uploaded bytes reached the server as a real PDF (multipart body carried %PDF-)",
      stats.uploadLog.some((u) => u.filename === "scenescout-fixture.pdf" && u.sawPdf),
      JSON.stringify(stats.uploadLog),
    );
    check(
      "an upload counts as filling the form (the gap ledger's rule sees it)",
      Object.values(engine2.memory!.states).some((st) => Object.values(st.elements).some((e) => e.lastAction === "upload")),
    );
    const mismatch = await engine2.upload({ ref: attachmentRef, fixture: "txt", name: "notes.txt" });
    check("a file that violates the input's accept attribute is called out", mismatch.includes("does NOT match"), mismatch);
    const escaped = await engine2.upload({ ref: attachmentRef, filePath: "../../../../etc/hosts" });
    check("filePath outside the attached project is refused (fenced like the origin)", escaped.startsWith("REFUSED"), escaped);
    // The other way out of the fence: a path INSIDE the project that is a
    // symlink to a file outside it. Only realpath catches this.
    fs.symlinkSync("/etc/hosts", path.join(projectDir, "escape-link"));
    const viaSymlink = await engine2.upload({ ref: attachmentRef, filePath: "escape-link" });
    check("a symlink inside the project pointing outside it is refused too", viaSymlink.startsWith("REFUSED"), viaSymlink);
    fs.writeFileSync(path.join(projectDir, "real-fixture.csv"), "a,b\n1,2\n");
    const fromDisk = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv" });
    check("a file inside the project uploads from disk", fromDisk.includes("OK: upload") && fromDisk.includes("from disk: real-fixture.csv"), fromDisk);
    const renamed = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv", name: "renamed.csv" });
    check("a disk file can be uploaded under another name", renamed.includes("as renamed.csv"), renamed);
    await engine2.click(refByTestid(upSnap, "upload-submit-action"));
    await until("the renamed upload to land", () => stats.uploadLog.some((u) => u.filename === "renamed.csv"));
    check(
      "…and the server receives the override name, not the disk name",
      stats.uploadLog.some((u) => u.filename === "renamed.csv"),
      JSON.stringify(stats.uploadLog),
    );
    const both = await engine2.upload({ ref: attachmentRef, filePath: "real-fixture.csv", fixture: "pdf" });
    check("filePath and fixture together are refused rather than one silently winning", both.includes("not both"), both);
    // A refused disk path must be refused BEFORE the trigger is clicked: the
    // click is the app's own control (state-changing in safe-write) and would
    // leave an intercepted chooser hanging. "Create item" fires a POST on
    // click, so a request in the log would prove the click happened.
    const itemPostsBefore = stats.itemPosts;
    const refusedBeforeClick = await engine2.upload({ ref: refByTestid(upSnap, "wp-create-item"), filePath: "no-such-file.pdf" });
    // Asserting an ABSENCE (no click, so no POST) — nothing to poll for.
    await settle(300);
    check(
      "a bad filePath is refused without clicking the trigger first",
      refusedBeforeClick.includes("not found") && stats.itemPosts === itemPostsBefore,
      `${refusedBeforeClick}\nPOST /api/items count: ${itemPostsBefore} → ${stats.itemPosts}`,
    );
    const ambiguous = await engine2.upload({ fixture: "pdf" });
    check(
      "with no ref on a page with several file inputs, the refusal names them instead of guessing",
      ambiguous.includes("file inputs on this page") && ambiguous.includes("upload-attachment-input") && ambiguous.includes("upload-logo-input"),
      ambiguous,
    );
    const noChooserAmbiguous = await engine2.upload({ ref: refByTestid(upSnap, "widgets-save-noop") });
    check(
      "a control that opens no chooser on a page with several file inputs is refused with the candidates listed",
      noChooserAmbiguous.includes("opened no file chooser") && noChooserAmbiguous.includes("upload-logo-input"),
      noChooserAmbiguous,
    );
    const locked = await engine2.upload({ ref: refByTestid(upSnap, "upload-locked-input") });
    check("a disabled file input is refused, not reported as uploaded", locked.includes("is disabled") && !locked.includes("OK: upload"), locked);

    await engine2.navigate("/page2.html");
    const hiddenSnap = await engine2.snapshot(true);
    check(
      "a hidden file input is disclosed on a FILE INPUTS line instead of vanishing",
      hiddenSnap.includes("FILE INPUTS") && hiddenSnap.includes("upload-avatar-input") && hiddenSnap.includes("accept=image/*"),
      hiddenSnap,
    );
    const viaChooser = await engine2.upload({ ref: refByTestid(hiddenSnap, "upload-avatar-trigger") });
    check("a styled trigger routes the file through the chooser it opens", viaChooser.includes("via the file chooser"), viaChooser);
    check("accept=image/* picked a PNG fixture", viaChooser.includes("scenescout-fixture.png"), viaChooser);
    await until("the upload-on-select request", () => stats.uploadLog.some((u) => u.filename === "scenescout-fixture.png"));
    check(
      "upload-on-select carried real PNG bytes",
      stats.uploadLog.some((u) => u.filename === "scenescout-fixture.png" && u.sawPng),
      JSON.stringify(stats.uploadLog),
    );
    check("an app that uploads on selection is reported as such", viaChooser.includes("sent a request on selection"), viaChooser);
    const noRef = await engine2.upload({ fixture: "png", name: "avatar-2.png" });
    check("with no ref, the page's only (hidden) file input is targeted directly", noRef.includes("OK: upload") && noRef.includes("only file input"), noRef);
    await until("the ref-less upload to land", () => stats.uploadLog.some((u) => u.filename === "avatar-2.png"));
    // A REPEAT upload to the same endpoint: the mutation report dedups per
    // endpoint, so reading the verdict out of that text said "no request
    // fired" the second time. The verdict must come from the request log.
    check("a repeat upload to an already-reported endpoint is still reported as sent on selection", noRef.includes("sent a request on selection"), noRef);
    const noChooserSingle = await engine2.upload({ ref: refByTestid(hiddenSnap, "page2-noop-action"), fixture: "png", name: "avatar-3.png" });
    check(
      "a control that opens no chooser falls back to the page's only file input, and says so",
      noChooserSingle.includes("opened no file chooser, so the file was set on the page's only file input"),
      noChooserSingle,
    );
    await until("the fallback upload to land", () => stats.uploadLog.some((u) => u.filename === "avatar-3.png"));

    const uploadPlan = await engine2.runPlan([
      { action: "navigate", target: "/index.html" },
      { action: "upload", target: "testid=upload-attachment-input", value: "pdf" },
      { action: "click", target: "testid=upload-submit-action" },
    ]);
    check("plans support upload steps", /2\. upload testid=upload-attachment-input → OK/.test(uploadPlan), uploadPlan);
    await until("the plan's upload to land", () => stats.uploadLog.filter((u) => u.filename === "scenescout-fixture.pdf").length >= 2);
    const typePlan = await engine2.runPlan([{ action: "type", target: "testid=upload-attachment-input", value: "x" }]);
    check("a plan type step on a file input points at the upload step", typePlan.includes("FAILED") && typePlan.includes('{action:"upload"}'), typePlan);

    console.log("assumptions — cumulative written knowledge");
    const noted = engine2.memory!.addAssumption("roles", "qa-role reviews and approves quality records; cannot administer users", "smoke");
    check("assumption recorded", noted === true);
    check(
      "duplicate assumption rejected",
      engine2.memory!.addAssumption("roles", "qa-role reviews and approves quality records; cannot administer users", "smoke") === false,
    );
    check(
      "assumptions read back as prose",
      engine2.memory!.readAssumptions().includes("qa-role reviews and approves"),
      engine2.memory!.readAssumptions().slice(0, 300),
    );
  } finally {
    await engine2.close().catch(() => {});
  }
}
