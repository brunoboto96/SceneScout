/**
 * How a suite reads text and names paths when the checkout, or the path
 * under test, may be Windows. Line endings and separators differ by host;
 * comparisons here are of the content, so a file stored with CRLF and a
 * path spelled with `\` compare equal to the same file and place written
 * the other way.
 */
import fs from "node:fs";
import path from "node:path";

/** `\r\n` and a lone `\r` become `\n`. */
export function asLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Every line ending becomes `\r\n`. Text that is already CRLF is unchanged, not doubled. */
export function asCrlf(text: string): string {
  return asLf(text).replace(/\n/g, "\r\n");
}

/** A text file's contents as LF, so a Windows checkout compares equal to a POSIX one. */
export function readText(file: string): string {
  return asLf(fs.readFileSync(file, "utf8"));
}

/** Which platform's path rules a comparison uses. */
export type PathStyle = "posix" | "win32";

/** Join path segments the way that platform does, whatever host the suite is running on. */
export function joinPath(style: PathStyle, ...parts: string[]): string {
  return (style === "win32" ? path.win32 : path.posix).join(...parts);
}

/**
 * Whether two paths name the same place on that platform. Windows folds case
 * and treats `/` and `\` as one separator; a trailing separator does not make
 * them differ. The root itself is left intact.
 */
export function samePlace(style: PathStyle, a: string, b: string): boolean {
  const p = style === "win32" ? path.win32 : path.posix;
  const key = (s: string): string => {
    let n = p.normalize(s);
    if (n.length > p.parse(n).root.length) n = n.replace(/[\\/]+$/, "");
    return style === "win32" ? n.toLowerCase() : n;
  };
  return key(a) === key(b);
}
