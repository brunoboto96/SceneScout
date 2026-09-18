/**
 * MCP wire-up check: spawns the built server over stdio, lists tools, calls
 * ft_scan to prove the protocol layer works end to end, and asserts the SKILL
 * documents every tool the server exposes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp-server.js");
const packageRoot = path.join(here, "..");

const EXPECTED_TOOLS = [
  "ft_scan", "ft_attach", "ft_session", "ft_journey", "ft_note", "ft_snapshot", "ft_click", "ft_type", "ft_upload", "ft_hover", "ft_select",
  "ft_navigate", "ft_back", "ft_press", "ft_scroll", "ft_screenshot", "ft_finding", "ft_crawl", "ft_run_plan", "ft_design_audit", "ft_resolve",
  "ft_coverage", "ft_report", "ft_close",
];

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
  const client = new Client({ name: "ft-check", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    console.error(`MCP CHECK FAILED — missing tools: ${missing.join(", ")}\nGot: ${names.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ server exposes ${names.length} tools`);

  // The SKILL is the agent's entire methodology — a tool it never mentions is
  // effectively unshipped, however well the engine implements it. ft_scroll
  // shipped a whole version before the skill described it, and nothing caught
  // that but a human noticing.
  const skillPath = path.join(packageRoot, "skill", "scenescout", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  const undocumented = names.filter((t) => !skill.includes(t));
  if (undocumented.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions: ${undocumented.join(", ")}\n` +
        `Every registered tool must appear in skill/scenescout/SKILL.md, or the agent will never use it.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents all ${names.length} tools`);

  // Tool-NAME coverage is the floor, not the ceiling. A parameter added to an
  // already-documented tool leaves the name present, so the check above stays
  // green while the agent has no idea the parameter exists — which is exactly
  // how ft_type's `value` alias shipped undocumented. Check the parameters too.
  //
  // Deliberately advisory-by-exception: `session` is on nearly every tool and
  // explaining it once is correct, and a handful of params are genuinely
  // internal detail. Everything else must be findable in the skill.
  const PARAM_EXEMPT = new Set(["session", "projectPath", "force", "full"]);
  const paramGaps: string[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
    for (const param of Object.keys(schema?.properties ?? {})) {
      if (PARAM_EXEMPT.has(param)) continue;
      if (!skill.includes(param)) paramGaps.push(`${tool.name}.${param}`);
    }
  }
  if (paramGaps.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions these parameters: ${paramGaps.join(", ")}\n` +
        `A parameter the skill doesn't name is a parameter the agent will never pass. Document it in\n` +
        `skill/scenescout/SKILL.md, or add it to PARAM_EXEMPT in this script if it is genuinely internal.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents every non-exempt tool parameter`);

  const result = await client.callTool({ name: "ft_scan", arguments: { projectPath: packageRoot } });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("");
  if (!text.includes("Project:")) {
    console.error(`MCP CHECK FAILED — ft_scan returned unexpected output:\n${text}`);
    process.exit(1);
  }
  console.log("✓ ft_scan round-trip works");

  await client.close();
  console.log("\nMCP CHECK PASSED");
}

main().catch((err) => {
  console.error("MCP CHECK CRASHED:", err);
  process.exit(1);
});
