import test from "node:test";
import assert from "node:assert/strict";

import {
  addToList,
  findConfigFile,
  globalConfigDir,
  mergeItems,
  findEntries,
  readLists,
  removeFromList,
  setEnabled,
} from "../src/config.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import { tmpdir, writeFiles } from "./helpers.ts";

// Every readLists in this file is isolated from the machine's own global
// configuration, which is merged in production and would leak into assertions.
process.env.OPENCODE_CONFIG_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ogs-global-iso-"));

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
  assert.deepEqual(lists.skills, [{ reference: "a@https://h/x.git", enabled: true }]);
  assert.deepEqual(lists.agents, [{ reference: "b@https://h/x.git", enabled: true }]);
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
    const lists = await readLists(project);
    assert.deepEqual(lists.skills, []);
    assert.deepEqual(lists.agents, []);
    assert.deepEqual(lists.repos, []);
    assert.deepEqual(lists.files, []);
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
  assert.deepEqual(lists.skills, [{ reference: "a@https://h/x.git", enabled: true }]);
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
    assert.deepEqual(lists.skills.map((item) => item.reference), ["a@https://h/x.git"]);
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
    assert.deepEqual(lists.skills.map((item) => item.reference), [
      "a@https://h/x.git",
      "local@https://h/y.git",
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("disabling keeps the reference and only flips its state", () => {
  const text = addToList(BASE, "skills", "a@https://h/x.git");
  const off = setEnabled(text, "skills", "a@https://h/x.git", false);

  const parsed = parseJsonc(off) as {
    plugins: Array<{ options: Record<string, unknown> }>;
  };
  const skills = parsed.plugins[0]?.options.skills as unknown[];
  assert.deepEqual(skills, [{ reference: "a@https://h/x.git", enabled: false }]);
  assert.match(off, /\/\/ a comment that has to survive/);
});

test("enabling writes the compact string back", () => {
  const text = addToList(BASE, "skills", "a@https://h/x.git");
  const off = setEnabled(text, "skills", "a@https://h/x.git", false);
  const on = setEnabled(off, "skills", "a@https://h/x.git", true);

  const parsed = parseJsonc(on) as { plugins: Array<{ options: Record<string, unknown> }> };
  assert.deepEqual(parsed.plugins[0]?.options.skills, ["a@https://h/x.git"]);
});

test("an item reads back with the state it was written with", async () => {
  const project = await tmpdir("ogs-project-");
  const text = setEnabled(addToList(BASE, "skills", "a@https://h/x.git"), "skills", "a@https://h/x.git", false);
  await writeFiles(project, { "opencode.jsonc": text });

  const lists = await readLists(project);
  assert.deepEqual(lists.skills, [{ reference: "a@https://h/x.git", enabled: false }]);
});

test("removing a disabled item removes the object, not a twin", () => {
  const text = setEnabled(addToList(BASE, "skills", "a@https://h/x.git"), "skills", "a@https://h/x.git", false);
  const next = removeFromList(text, "skills", "a@https://h/x.git");
  const parsed = parseJsonc(next) as { plugins: Array<{ options: Record<string, unknown> }> };
  assert.deepEqual(parsed.plugins[0]?.options.skills, []);
});

test("adding an already disabled item does not duplicate it", () => {
  const text = setEnabled(addToList(BASE, "skills", "a@https://h/x.git"), "skills", "a@https://h/x.git", false);
  const again = addToList(text, "skills", "a@https://h/x.git");
  const parsed = parseJsonc(again) as { plugins: Array<{ options: Record<string, unknown> }> };
  assert.equal((parsed.plugins[0]?.options.skills as unknown[]).length, 1);
});

test("a project sees the sum of the global configuration and its own", async () => {
  const project = await tmpdir("ogs-project-");
  const global = await tmpdir("ogs-global-");
  await writeFiles(global, {
    "opencode.jsonc": addToList(
      addToList(BASE, "skills", "everywhere@https://h/a.git"),
      "agents",
      "reviewer@https://h/a.git",
    ),
  });
  await writeFiles(project, {
    "opencode.jsonc": addToList(BASE, "skills", "dedicated@https://h/b.git"),
  });

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = global;
  try {
    const lists = await readLists(project);
    assert.deepEqual(lists.skills.map((item) => item.reference), [
      "everywhere@https://h/a.git",
      "dedicated@https://h/b.git",
    ]);
    assert.deepEqual(lists.agents.map((item) => item.reference), ["reviewer@https://h/a.git"]);
    assert.equal(lists.files.length, 2);
  } finally {
    process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("a project can turn off what the global configuration enables", async () => {
  const project = await tmpdir("ogs-project-");
  const global = await tmpdir("ogs-global-");
  await writeFiles(global, {
    "opencode.jsonc": addToList(BASE, "skills", "everywhere@https://h/a.git"),
  });
  // The project writes only the override: the reference it inherits, off.
  await writeFiles(project, {
    "opencode.jsonc": setEnabled(
      addToList(BASE, "repos", "https://h/a.git"),
      "skills",
      "everywhere@https://h/a.git",
      false,
    ),
  });

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = global;
  try {
    const lists = await readLists(project);
    assert.deepEqual(lists.skills, [{ reference: "everywhere@https://h/a.git", enabled: false }]);
  } finally {
    process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("merging keeps the order and lets the later source win", () => {
  const merged = mergeItems([
    ["a@u", { reference: "b@u", enabled: true }],
    [{ reference: "b@u", enabled: false }, "c@u"],
  ]);
  assert.deepEqual(merged, [
    { reference: "a@u", enabled: true },
    { reference: "b@u", enabled: false },
    { reference: "c@u", enabled: true },
  ]);
});
