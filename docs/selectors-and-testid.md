# Selector policy

How to find elements, and what to avoid. The goal is tests that survive a
restyle and fail only when behaviour actually breaks.

## The order

Use the first option that identifies the element unambiguously.

| Rank | Locator            | Use when                                                                     |
| ---- | ------------------ | ---------------------------------------------------------------------------- |
| 1    | `getByRole`        | The element has an accessible role and name. Always prefer this.             |
| 2    | `getByLabel`       | It is a form control whose label is visible to the user.                     |
| 3    | `getByPlaceholder` | Only when no label exists. A placeholder disappears on input, so it is weak. |
| 4    | `getByText`        | The text itself is the contract, e.g. an error message.                      |
| 5    | `getByTestId`      | Last resort. Use for elements with no user-visible identity.                 |

```ts
// 1. role
await page.getByRole("button", { name: "Send" }).click();

// 2. label
await page.getByLabel("Email").fill("team@example.com");

// 3. text, when the message is the contract
await expect(page.getByText("Message sent")).toBeVisible();

// 4. test id, only when nothing above identifies the element
await expect(page.getByTestId("status")).toHaveText("ready");
```

## Never

```ts
// CSS class: a designer renaming the class breaks the test for no real reason
page.locator("button.buttonIcon.episode-actions-later");

// XPath: brittle and unreadable
page.locator("//div[@class='row']/span[2]");

// Positional index: breaks the moment an item is inserted above
page.getByRole("listitem").nth(0);

// Text as a CSS selector
page.locator("text=Submit");
```

The project lints out `page.waitForTimeout()` and `test.only()` already. CSS
selectors and XPath are not yet banned by lint, but they are against policy.

## The `data-testid` contract

`data-testid` is an explicit, stable handle for automated tests. If you add one,
these rules apply:

1. It must survive a visual redesign. Never tie it to layout or styling.
2. Prefer a semantic name: `status`, `entities`, `entity`. Not `div1`, `box-2`.
3. Do not scatter them. If an element needs an id for tests, that is usually a
   signal that it lacks an accessible role or label.
4. The attribute must exist in the markup, not be added by test-only JavaScript.
   An element that only appears after test code runs it is not part of the
   product's contract.

The demo app uses `data-testid` in exactly two places: `status` (a machine
readout with no meaningful role) and `entities` (a list whose identity is its
contents). Everything else is found by role or label.

## Assertions

Use web-first assertions. They retry until the condition holds or the timeout
expires.

```ts
// good: retries
await expect(page.getByText("Message sent")).toBeVisible();

// bad: checks once, immediately, and lies about async rendering
expect(await page.getByText("Message sent").isVisible()).toBe(true);
```

When you need to assert on a value you awaited yourself, make sure the await
itself was the synchronisation point. If it was not, the assertion is
racing.

## Waiting

| Instead of       | Use                                 |
| ---------------- | ----------------------------------- |
| `waitForTimeout` | `expect(locator).toBeVisible()`     |
| `waitForTimeout` | `page.waitForURL(...)`              |
| `waitForTimeout` | `page.waitForResponse(...)`         |
| `waitForTimeout` | `expect.poll(...)` for polled state |

## Isolation

Every test sets up its own state. No test may depend on another having run
first, and no test may rely on leftover data. If two tests need the same
arrangement, express it in a `beforeEach` or a fixture, not in ordering.

## Related

- [`../AGENTS.md`](../AGENTS.md) — hard rules
- [`architecture.md`](architecture.md)
- <https://playwright.dev/docs/best-practices>
