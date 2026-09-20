/** What the two bench summarisers share: the directory argument, a token estimate and a markdown table. */

export function benchDir(usage: string): string {
  const dir = process.argv[2];
  if (!dir) {
    console.error(usage);
    process.exit(2);
  }
  return dir;
}

/** Rough token count: the ~4 chars/token estimate that holds for English and JSON alike. */
export const tokens = (s: string) => Math.round(s.length / 4);

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The separator is derived from the headers, so the column count cannot drift from them. */
export function printTable(headers: string[], rows: string[][]): void {
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`|${headers.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
}
