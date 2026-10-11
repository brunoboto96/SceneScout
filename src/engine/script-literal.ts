/**
 * A value written into an inline `<script>` as a JavaScript literal.
 *
 * JSON alone is not enough there: the HTML parser ends a script element at the
 * first `</script`, and `<!--` or `<script` inside it change how the rest is
 * read, before any JavaScript runs. Every `<` is written as `<`, which
 * the string reads back as the same character, so none of those can appear.
 */
export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
