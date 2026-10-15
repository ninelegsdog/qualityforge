/**
 * The shape of an element, without its content.
 *
 * `axe-core` reports the offending element as `node.html` — the outerHTML of
 * the node, as the browser serialised it. Measured on nine positions with a
 * token injected into a real page, that string carried page content in 10 of
 * 10 violation nodes, across nine different places: `onclick`, `value`, `id`,
 * `title`, `aria-label`, `data-*`, query strings in `href` and `src`, and the
 * element's own text. `redactText` covered part of that by accident, because it
 * matches a known key name, and the secret is in the *value*, not the name.
 *
 * So the rule this module implements is the one the project already uses for
 * URLs: **a filter only knows the names it was told about**, therefore drop the
 * content rather than filter it. What survives is the structure — tag names
 * and attribute names — because without it two nodes of the same rule are
 * indistinguishable, and *where* is half the message.
 *
 * Measured cost, stated rather than discovered later: `type="password"`,
 * `alt=""` and every concrete value are gone. Measured benefit: not one of the
 * nine observed leak positions survives.
 */

/** Longest shaped element kept per node, marked when cut. */
export const MAX_SHAPE_LENGTH = 2_000;

const WHITESPACE = /\s/;
const TAG_NAME_END = /[\s/>]/;
const ATTRIBUTE_NAME_END = /[\s=/>]/;

/**
 * Attribute names in the range `[from, to)`, values discarded.
 *
 * Values still have to be *parsed* to find where the attribute ends — an
 * unquoted value may legally contain `>` — so the scan skips them without
 * emitting them.
 */
function attributeNames(source: string, from: number, to: number): string {
  const names: string[] = [];
  let i = from;

  while (i < to) {
    while (i < to && WHITESPACE.test(source.charAt(i))) i++;
    if (i >= to) break;
    if (source.charAt(i) === "/") {
      i++;
      continue;
    }

    const start = i;
    while (i < to && !ATTRIBUTE_NAME_END.test(source.charAt(i))) i++;
    const name = source.slice(start, i);
    if (name === "") {
      i++;
      continue;
    }
    names.push(name);

    while (i < to && WHITESPACE.test(source.charAt(i))) i++;
    if (source.charAt(i) !== "=") continue;
    i++;
    while (i < to && WHITESPACE.test(source.charAt(i))) i++;

    const quote = source.charAt(i);
    if (quote === '"' || quote === "'") {
      i++;
      while (i < to && source.charAt(i) !== quote) i++;
      i++;
    } else {
      while (i < to && !WHITESPACE.test(source.charAt(i)) && source.charAt(i) !== ">") i++;
    }
  }

  return names.length === 0 ? "" : ` ${names.join(" ")}`;
}

/**
 * Where an opening tag ends, respecting quoted attribute values.
 *
 * `indexOf(">")` is wrong here, and not hypothetically: HTML allows `>` inside
 * a quoted value, so `<div title="a>b">` would be read as ending at the `>` in
 * the value — silently truncating the tag and promoting the rest of the value
 * to text, which this module then drops. Quoted spans are skipped whole.
 */
function findTagEnd(source: string, from: number): { end: number; selfClosing: boolean } | null {
  let i = from;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '"' || ch === "'") {
      const close = source.indexOf(ch, i + 1);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === ">") return { end: i, selfClosing: source[i - 1] === "/" };
    i++;
  }
  return null;
}

/**
 * Reduce an element to its structure: tag names and attribute names, no
 * attribute values and no text.
 *
 * Text is discarded wherever it appears, including inside nested elements —
 * that is the point of the rule, and a nested `<span>secret</span>` is exactly
 * one of the observed leak positions.
 */
export function elementShape(html: string, maxLength = MAX_SHAPE_LENGTH): string {
  let out = "";
  let i = 0;

  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open === -1) break;

    // Comments and doctypes carry no structure worth keeping.
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const end = html.indexOf(">", open);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // Closing tag: no attributes to lose.
    if (html[open + 1] === "/") {
      const end = html.indexOf(">", open);
      if (end === -1) break;
      out += html.slice(open, end + 1);
      i = end + 1;
      continue;
    }

    let nameEnd = open + 1;
    while (nameEnd < html.length && !TAG_NAME_END.test(html.charAt(nameEnd))) nameEnd++;

    const tagEnd = findTagEnd(html, nameEnd);
    if (tagEnd === null) break;

    out += `<${html.slice(open + 1, nameEnd)}`;
    out += attributeNames(html, nameEnd, tagEnd.end);
    out += tagEnd.selfClosing ? " />" : ">";
    i = tagEnd.end + 1;
  }

  if (out.length <= maxLength) return out;
  return `${out.slice(0, maxLength)}… [truncated ${out.length - maxLength} characters]`;
}
