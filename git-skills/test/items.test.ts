import test from "node:test";
import assert from "node:assert/strict";

import { enabledItems, findItem, parseItems, storedForm, toItem } from "../src/items.ts";

test("a plain string is an enabled item", () => {
  const { items, problems } = parseItems(["docs@https://h/a.git:main"]);
  assert.deepEqual(problems, []);
  assert.deepEqual(items, [{ reference: "docs@https://h/a.git:main", enabled: true }]);
});

test("an object states the state, and enabled defaults to true", () => {
  assert.deepEqual(parseItems([{ reference: "a@https://h/x.git" }]).items, [
    { reference: "a@https://h/x.git", enabled: true },
  ]);
  assert.deepEqual(parseItems([{ reference: "a@https://h/x.git", enabled: false }]).items, [
    { reference: "a@https://h/x.git", enabled: false },
  ]);
});

test("the two spellings of an enabled item are the same item", () => {
  const asString = parseItems(["a@https://h/x.git"]).items[0];
  const asObject = parseItems([{ reference: "a@https://h/x.git", enabled: true }]).items[0];
  assert.deepEqual(asString, asObject);
});

test("only enabled items are loaded", () => {
  const { items } = parseItems([
    "on@https://h/x.git",
    { reference: "off@https://h/x.git", enabled: false },
  ]);
  assert.deepEqual(enabledItems(items).map((item) => item.reference), ["on@https://h/x.git"]);
});

test("a malformed item is reported instead of guessed", () => {
  assert.equal(parseItems([{ enabled: false }]).problems.length, 1);
  assert.equal(parseItems([{ reference: "a@h/x" , enabled: "no" }]).problems.length, 1);
  assert.equal(parseItems([42]).problems.length, 1);
});

test("the stored form is a string while enabled and an object while not", () => {
  assert.equal(storedForm({ reference: "a@https://h/x.git", enabled: true }), "a@https://h/x.git");
  assert.deepEqual(storedForm({ reference: "a@https://h/x.git", enabled: false }), {
    reference: "a@https://h/x.git",
    enabled: false,
  });
});

test("references are matched exactly, after trimming", () => {
  const items = [toItem(" a@https://h/x.git "), toItem({ reference: "b@https://h/x.git", enabled: false })];
  assert.equal(findItem(items, "a@https://h/x.git")?.enabled, true);
  assert.equal(findItem(items, "b@https://h/x.git")?.enabled, false);
  assert.equal(findItem(items, "c@https://h/x.git"), undefined);
});
