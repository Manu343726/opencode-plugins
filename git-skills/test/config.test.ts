import test from "node:test";
import assert from "node:assert/strict";

import {
  addToList,
  findConfigFile,
  findEntries,
  readLists,
  removeFromList,
} from "../src/config.ts";
import { tmpdir, writeFiles } from "./helpers.ts";

const BASE = `{
  // a comment that has to survive
  "$schema": "https://opencode.ai/config.json",
  "model": "litellm/deepseek-v4.1-flash"
}
`;

test("adding the first reference creates the plugin entry", () => {
  const next = addToList(BASE, "skills", "docs@https://h/x.git");
  const entries = findEntries(next);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.options.skills, ["docs@https://h/x.git"]);
  assert.match(next, /\/\/ a comment that has to survive/);
  assert.match(next, /"model": "litellm\/deepseek-v4\.1-flash"/);
});

test("adding to an existing entry appends to its list", () => {
  const once = addToList(BASE, "skills", "a@https://h/x.git");
  const twice = addToList(once, "skills", "b@https://h/x.git");
  assert.deepEqual(findEntries(twice)[0]?.options.skills, [
    "a@https://h/x.git",
    "b@https://h/x.git",
  ]);
});

test("the two kinds live in their own lists", () => {
  const withSkill = addToList(BASE, "skills", "a@https://h/x.git");
  const withBoth = addToList(withSkill, "agents", "reviewer@https://h/x.git");
  const options = findEntries(withBoth)[0]?.options;
  assert.deepEqual(options?.skills, ["a@https://h/x.git"]);
  assert.deepEqual(options?.agents, ["reviewer@https://h/x.git"]);
});

test("adding the same reference twice changes nothing", () => {
  const once = addToList(BASE, "skills", "a@https://h/x.git");
  assert.equal(addToList(once, "skills", "a@https://h/x.git"), once);
});

test("adding to an existing plugins array keeps the other entries", () => {
  const text = `{
  "plugins": ["./local-plugin"]
}
`;
  const next = addToList(text, "skills", "a@https://h/x.git");
  assert.match(next, /\.\/local-plugin/);
  assert.equal(findEntries(next).length, 1);
});

test("a project without a plugins array gets one", () => {
  const next = addToList('{\n  "model": "x"\n}\n', "repos", "https://h/x.git");
  assert.deepEqual(findEntries(next)[0]?.options.repos, ["https://h/x.git"]);
});

test("removing a reference keeps the rest", () => {
  const withTwo = addToList(addToList(BASE, "skills", "a@https://h/x.git"), "skills", "b@https://h/x.git");
  const next = removeFromList(withTwo, "skills", "a@https://h/x.git");
  assert.deepEqual(findEntries(next)[0]?.options.skills, ["b@https://h/x.git"]);
});

test("removing something that is not there changes nothing", () => {
  const once = addToList(BASE, "skills", "a@https://h/x.git");
  assert.equal(removeFromList(once, "skills", "nope@https://h/x.git"), once);
});

test("comments survive a removal", () => {
  const once = addToList(BASE, "skills", "a@https://h/x.git");
  const withTwo = addToList(once, "skills", "b@https://h/x.git");
  const next = removeFromList(withTwo, "skills", "b@https://h/x.git");
  assert.match(next, /\/\/ a comment that has to survive/);
});

test("the edited document still parses", () => {
  const next = addToList(BASE, "skills", "a@https://h/x.git");
  const parsed = JSON.parse(
    next
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  ) as Record<string, unknown>;
  assert.ok(Array.isArray(parsed.plugins));
});

test("readLists reads both kinds from the project config", async () => {
  const project = await tmpdir("ogs-project-");
  const text = addToList(addToList(BASE, "skills", "a@https://h/x.git"), "agents", "b@https://h/x.git");
  await writeFiles(project, { "opencode.jsonc": text });

  const lists = await readLists(project);
  assert.deepEqual(lists.skills, ["a@https://h/x.git"]);
  assert.deepEqual(lists.agents, ["b@https://h/x.git"]);
  assert.deepEqual(lists.repos, []);
  assert.match(lists.file ?? "", /opencode\.jsonc$/);
});

test("readLists tolerates a project with no config", async () => {
  const project = await tmpdir("ogs-project-");
  const lists = await readLists(project);
  assert.deepEqual(lists, { skills: [], agents: [], repos: [] });
});

test("the .opencode config is preferred over the root one", async () => {
  const project = await tmpdir("ogs-project-");
  await writeFiles(project, {
    "opencode.jsonc": "{}",
    ".opencode/opencode.jsonc": "{}",
  });
  const file = await findConfigFile(project);
  assert.match(file ?? "", /\.opencode/);
});