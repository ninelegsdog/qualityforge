/**
 * The field-path grammar used by API expectations.
 *
 * Chosen against a measurement rather than by taste. The demo app's only JSON
 * response, `GET /api/items`, is an **array** — its top-level keys are `0`, `1`,
 * `2` — so a grammar that can only name object keys would have been able to
 * express nothing about it. Indices are therefore part of the language, and
 * `[0].id` is how you say "the first item has an id".
 *
 * Deliberately absent: wildcards. "Every element has an id" is a real need and a
 * different claim from "the first element has an id"; it is a test's job, not a
 * configuration entry's. Adding `[]` later is additive, so the omission costs
 * nothing now and guessing its semantics would.
 *
 * Deliberately absent too: path templates like `/users/{id}`. An expectation
 * matches one concrete exchange, and a matcher that interpolated a segment would
 * be able to pass on a request the application never meant to make.
 *
 * `checkFieldPath` decides whether a declared path is well formed;
 * `parseFieldPath` turns a well-formed one into steps. They are kept apart
 * because only the second is needed to walk a body, and a capture layer that
 * validated while walking would have to re-check a configuration the loader had
 * already refused to let through.
 */

/** One step of a field path. */
export type FieldPathStep = { kind: "key"; key: string } | { kind: "index"; index: number };

/** A key: a letter or underscore, then letters, digits, `_` or `-`. */
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** An index: `0`, or digits with no leading zero, so `[01]` is a typo not a value. */
const INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * Check one declared field path.
 *
 * Returns `null` when the path is well formed, and the reason when it is not.
 * The reason is written for the person editing `config/project.json`, in the
 * same voice as the rest of the loader.
 *
 * @param value The path as written in the configuration.
 * @param at    Where it was written, for the message: `api.expectations[1].responseRequires[0]`.
 * @returns `null`, or a message naming the specific mistake.
 */
export function checkFieldPath(value: string, at: string): string | null {
  if (value === "") {
    return `${at} must not be empty`;
  }

  let index = 0;
  let steps = 0;

  while (index < value.length) {
    const character = value[index];

    if (character === ".") {
      if (steps === 0) {
        return `${at} must not start with "."`;
      }
      const next = value[index + 1];
      if (next === undefined) {
        return `${at} must not end with "."`;
      }
      if (next === ".") {
        return `${at} must not contain an empty segment`;
      }
      if (next === "[") {
        return `${at} must not put "." before "["`;
      }
      index += 1;
      continue;
    }

    if (character === "[") {
      const close = value.indexOf("]", index);
      if (close === -1) {
        return `${at} has an unclosed "["`;
      }
      const inner = value.slice(index + 1, close);
      if (!INDEX.test(inner)) {
        return (
          `${at} index must be 0 or digits without a leading zero, ` +
          `got ${JSON.stringify(inner)}`
        );
      }
      const after = value[close + 1];
      if (after !== undefined && after !== "." && after !== "[") {
        return `${at} needs "." or "[" after "]"`;
      }
      steps += 1;
      index = close + 1;
      continue;
    }

    let end = index;
    while (end < value.length && value[end] !== "." && value[end] !== "[") {
      end += 1;
    }
    const segment = value.slice(index, end);
    if (!KEY.test(segment)) {
      return (
        `${at} segment must start with a letter or "_" and hold only letters, ` +
        `digits, "_" or "-", got ${JSON.stringify(segment)}`
      );
    }
    steps += 1;
    index = end;
  }

  return steps === 0 ? `${at} must not be empty` : null;
}

/**
 * Turn a declared field path into steps.
 *
 * Only call this on a path {@link checkFieldPath} has accepted. An unparsable
 * path is a programming error rather than a configuration one, and throwing says
 * so instead of silently walking the wrong thing.
 *
 * @param path A path that passed `checkFieldPath`.
 */
export function parseFieldPath(path: string): FieldPathStep[] {
  const steps: FieldPathStep[] = [];
  let index = 0;

  while (index < path.length) {
    // Land on separators rather than stepping over them. An earlier draft set
    // `index = end + 1` after a key, which jumped *past* the "[" of a following
    // index and read `data.items[1].id` as the key "1]" — a path that validated
    // and then matched nothing.
    if (path[index] === ".") {
      index += 1;
      continue;
    }

    if (path[index] === "[") {
      const close = path.indexOf("]", index);
      steps.push({ kind: "index", index: Number(path.slice(index + 1, close)) });
      index = close + 1;
      continue;
    }

    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") {
      end += 1;
    }
    steps.push({ kind: "key", key: path.slice(index, end) });
    index = end;
  }

  return steps;
}
