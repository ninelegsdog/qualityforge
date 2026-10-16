/**
 * The one pattern a hand-written identifier has to match.
 *
 * Shared rather than repeated, because this project has already paid for the
 * alternative twice: a documented tool count sat wrong in three documents for
 * days because nothing kept them together, and a duplicated shape rule would have
 * drifted for the same reason. Two consumers today — the defect id derived from
 * a test title, and the `name` of an API expectation a human writes — and they
 * must produce the same shape of identifier, because both end up in an artifact
 * id and a consumer reads them side by side.
 *
 * Lowercase, digits, single hyphens between groups: no leading or trailing
 * hyphen, no underscores, no uppercase.
 */
export const KEBAB_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
