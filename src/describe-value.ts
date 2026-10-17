/**
 * One way to describe an unexpected value in a validation message.
 *
 * There are three validators in this repository that write messages to the person
 * editing a file, and they had each grown their own formatting helper. That is
 * three places to change the wording, three places to get `[object Object]`
 * wrong, and three places for a reader to meet a different voice depending on
 * which contract rejected them.
 *
 * The rule the formats disagree about: an object never goes through bare
 * `String()`, which yields `[object Object]` and tells the reader nothing about
 * what was actually configured. Arrays and objects are named by shape; numbers
 * and booleans by value; anything left over by its `typeof`.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return `a ${typeof value}`;
}
