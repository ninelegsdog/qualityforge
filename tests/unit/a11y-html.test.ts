import { expect, test } from "@playwright/test";
import { elementShape } from "../../src/a11y/html.js";

/**
 * Decision 4: `html` is kept, its values and its text are not.
 *
 * The cases below are the nine positions a real page carried a token in, taken
 * from a probe that injected one into each of them and then ran the real
 * `axe-core` — `onclick`, `value`, `id`, query in `href`, query in `src`,
 * `title`, `aria-label`, `data-*`, and the element's own text. Nine different
 * places is the argument against filtering by attribute name: the name is not
 * the secret, the value is.
 *
 * A hand-written fixture cannot prove this rule against someone else's output.
 * What it can prove is that *this function* drops values and text; the claim
 * that `axe-core` puts page content in `node.html` is proven separately, by
 * `tests/smoke/a11y-audit.smoke.spec.ts`, which runs the real engine.
 */

const TOKEN = "ghp_Zx8sTR0secretTOKENvalue";

test.describe("elementShape", () => {
  test("keeps the tag and the attribute names, drops the values", () => {
    expect(elementShape(`<button onclick="send('${TOKEN}')"></button>`)).toBe(
      "<button onclick></button>",
    );
    expect(elementShape(`<input type="text" id="inp_${TOKEN}" value="${TOKEN}">`)).toBe(
      "<input type id value>",
    );
    expect(elementShape(`<img src="/a.png" alt="pic" data-token="${TOKEN}">`)).toBe(
      "<img src alt data-token>",
    );
  });

  test("drops the element's text, nested text included", () => {
    expect(elementShape(`<div>text token: ${TOKEN}</div>`)).toBe("<div></div>");
    expect(elementShape(`<div>outer<span>${TOKEN}</span></div>`)).toBe("<div><span></span></div>");
  });

  test("keeps an attribute that had no value at all", () => {
    expect(elementShape("<input disabled>")).toBe("<input disabled>");
  });

  test("a value can never become a tag", () => {
    // The failure this guards is quiet: the value is dropped, so markup inside
    // it would otherwise be re-read as structure on the way back out.
    expect(elementShape(`<div title="<script>${TOKEN}</script>">x</div>`)).toBe(
      "<div title></div>",
    );
    expect(elementShape(`<div title='"><img src=x onerror="${TOKEN}">'>x</div>`)).toBe(
      "<div title></div>",
    );
  });

  test("finds the end of a tag whose quoted value contains >", () => {
    expect(elementShape(`<div title="a>b" id="${TOKEN}">x</div>`)).toBe("<div title id></div>");
  });

  test("marks a shape it had to cut", () => {
    const long = `<div ${Array.from({ length: 200 }, (_, i) => `data-a${i}="${TOKEN}"`).join(" ")}>`;
    const shaped = elementShape(long, 50);

    expect(shaped).toContain("[truncated");
    expect(shaped.length).toBeGreaterThan(50);
    expect(shaped).not.toContain(TOKEN);
  });

  test("the token does not survive any of the nine positions", () => {
    const positions = [
      `onclick="send('${TOKEN}')"`,
      `value="${TOKEN}"`,
      `id="x-${TOKEN}"`,
      `href="/x?access_token=${TOKEN}"`,
      `src="/y.png?token=${TOKEN}"`,
      `title="${TOKEN}"`,
      `aria-label="${TOKEN}"`,
      `data-session="${TOKEN}"`,
    ];
    for (const attribute of positions) {
      const shaped = elementShape(`<div ${attribute}>body ${TOKEN}</div>`);
      expect(shaped, attribute).not.toContain(TOKEN);
    }
  });
});
