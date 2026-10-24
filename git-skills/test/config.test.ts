import test from "node:test";
import assert from "node:assert/strict";

import {
  addToList,
  findConfigFile,
  globalConfigDir,
  findEntries,
  readLists,
  removeFromList,
} from "../src/config.ts";
import { parse as parseJsonc } from "jsonc-parser";

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
  // Isolated from this machine's own global config, which may well name the plugin.
  const empty = await tmpdir("ogs-global-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = empty;
  try {
    assert.deepEqual(await readLists(project), { skills: [], agents: [], repos: [] });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
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
const BUNDLED = `{
  // bundle shape: this plugin's options are nested under its name
  "plugins": [
    {
      "package": "git+ssh://git@forgejo:2222/u/opencode-plugins.git#main",
      "options": {
        "plugins": ["git-skills"],
        "git-skills": { "skills": ["a@https://h/x.git"] }
      }
    }
  ]
}
`;

test("a bundled installation is read from the nested options", async () => {
  const project = await tmpdir("ogs-project-");
  await writeFiles(project, { "opencode.jsonc": BUNDLED });

  const lists = await readLists(project);
  assert.deepEqual(lists.skills, ["a@https://h/x.git"]);
  assert.deepEqual(lists.agents, []);
});

test("adding to a bundled installation stays nested", () => {
  const next = addToList(BUNDLED, "agents", "reviewer@https://h/x.git");
  const parsed = parseJsonc(next) as { plugins: Array<{ options: Record<string, unknown> }> };
  const options = parsed.plugins[0]?.options ?? {};
  assert.deepEqual((options["git-skills"] as Record<string, unknown>).agents, ["reviewer@https://h/x.git"]);
  assert.equal(options.agents, undefined, "nothing may be written outside the plugin's own object");
});

test("removing from a bundled installation stays nested", () => {
  const next = removeFromList(BUNDLED, "skills", "a@https://h/x.git");
  const parsed = parseJsonc(next) as { plugins: Array<{ options: Record<string, unknown> }> };
  assert.deepEqual((parsed.plugins[0]?.options["git-skills"] as Record<string, unknown>).skills, []);
});

test("a bundled installation with no object yet gets one", () => {
  const text = `{
  "plugins": [{ "package": "git+ssh://h/opencode-plugins.git#main", "options": { "plugins": ["git-skills"] } }]
}
`;
  const next = addToList(text, "repos", "https://h/x.git");
  const parsed = parseJsonc(next) as { plugins: Array<{ options: Record<string, unknown> }> };
  assert.deepEqual((parsed.plugins[0]?.options["git-skills"] as Record<string, unknown>).repos, ["https://h/x.git"]);
});

test("a globally installed plugin is found when the project declares nothing", async () => {
  const project = await tmpdir("ogs-project-");
  const global = await tmpdir("ogs-global-");
  await writeFiles(global, { "opencode.jsonc": BUNDLED });

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = global;
  try {
    const file = await findConfigFile(project);
    assert.match(file ?? "", /opencode\.jsonc$/);
    const lists = await readLists(project);
    assert.deepEqual(lists.skills, ["a@https://h/x.git"]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("the project's own config wins over the global one", async () => {
  const project = await tmpdir("ogs-project-");
  const global = await tmpdir("ogs-global-");
  await writeFiles(global, { "opencode.jsonc": BUNDLED });
  await writeFiles(project, { "opencode.jsonc": addToList(BASE, "skills", "local@https://h/y.git") });

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = global;
  try {
    const lists = await readLists(project);
    assert.deepEqual(lists.skills, ["local@https://h/y.git"]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});
