import type { Locator, Page } from "@playwright/test";

/**
 * Reference page objects for the bundled demo application.
 *
 * This file is the "leave a copy in your project" example: consumers of
 * QualityForge are expected to copy it and adapt it, and the pattern is the
 * point, not the demo app it is written against. The selectors follow the
 * repository policy (docs/selectors-and-testid.md), which is lint-guarded:
 * role first, then label, then text, and `data-testid` only where nothing
 * user-visible identifies the element — the demo app uses it in exactly two
 * places, `status` and `entities`.
 *
 * Design notes, each one a rule a copied object keeps:
 *
 * - A page object is a relation to a page, not to a browser. It takes the
 *   page from a Playwright fixture and stays inert until a method is called,
 *   so any test that has a page can construct it — including this package's
 *   `quality-context` fixture, which is what attaches evidence.
 * - Elements are declared once, as narrow locators, and asserted through
 *   auto-retrying `expect` in the spec. No `locator()` strings appear here:
 *   the policy has no CSS or XPath, and lint enforces that now.
 * - Navigation lives on the page object, so "how this page is reached" is
 *   one fact with one home, and a change of route touches one file.
 * - `open()` waits for readiness the way every other test does — nothing
 *   here sleeps or polls by hand.
 */
export abstract class BasePage {
  /** The brand link in the header, present on every page of the app. */
  readonly brand: Locator;

  constructor(protected readonly page: Page) {
    this.brand = page.getByRole("link", { name: "QualityForge" });
  }

  /** Navigate to this page and wait for the navigation to settle. */
  async open(path: string): Promise<void> {
    await this.page.goto(path);
  }
}

/** The overview page: the heading, the status readout and the entity list. */
export class OverviewPage extends BasePage {
  readonly heading = this.page.getByRole("heading", {
    level: 1,
    name: "Browser Quality Core",
  });
  /** A machine readout with no meaningful role — the first of the two test ids. */
  readonly status = this.page.getByTestId("status");
  /** The list container; its items are located through the contract too. */
  readonly entities = this.page.getByTestId("entities");
  readonly entityItems = this.page.getByTestId("entity");

  override async open(): Promise<void> {
    await super.open("/");
  }
}

/** The contact page: a form with labelled fields and an alert region. */
export class ContactPage extends BasePage {
  readonly email = this.page.getByLabel("Email");
  readonly message = this.page.getByLabel("Message");
  readonly submit = this.page.getByRole("button", { name: "Send" });
  /** The first validation problem, announced to assistive tech. */
  readonly validationError = this.page.getByRole("alert");
  /** The confirmation region shown after a valid submission. */
  readonly success = this.page.getByRole("status");

  override async open(): Promise<void> {
    await super.open("/contact");
  }

  /** Fill and submit the form; validation runs on submit, not on typing. */
  async submitWith(email: string, message: string): Promise<void> {
    await this.email.fill(email);
    await this.message.fill(message);
    await this.submit.click();
  }
}
