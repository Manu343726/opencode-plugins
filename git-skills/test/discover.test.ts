import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { discover, findEntry } from "../src/discover.ts";
import { AGENT_MD, SKILL_MD, makeRepo, tmpdir, writeFiles } from "./helpers.ts";

test("finds a skill anywhere in the tree and names it after its directory", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    ".opencode/skills/homelable-docs/SKILL.md": SKILL_MD,
    "skills/code-review/SKILL.md": SKILL_MD,
    "README.md": "# not a skill\n",
    "node_modules/pkg/SKILL.md": SKILL_MD,
  });

  const { entries, problems } = await discover(dir);
  const skills = entries.filter((entry) => entry.kind === "skill").map((entry) => entry.id);
  assert.deepEqual(skills, ["code-review", "homelable-docs"]);
  assert.deepEqual(problems, []);
});

test("a skill keeps its neighbouring files", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    "skills/docs/SKILL.md": SKILL_MD,
    "skills/docs/references/rules.md": "# rules\n",
    "skills/docs/scripts/run.sh": "#!/bin/sh\n",
  });

  const { entries } = await discover(dir);
  const skill = entries.find((entry) => entry.id === "docs");
  assert.ok(skill);
  assert.deepEqual(skill.files, ["SKILL.md", "references/rules.md", "scripts/run.sh"]);
});

test("an agent id is its path below the agents root", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    "agents/reviewer.md": AGENT_MD,
    "agents/team/orchestrator.md": AGENT_MD,
    ".opencode/agents/explorer.md": AGENT_MD,
    ".claude/agents/claude-only.md": AGENT_MD,
  });

  const { entries } = await discover(dir);
  const agents = entries.filter((entry) => entry.kind === "agent").map((entry) => entry.id);
  assert.deepEqual(agents, ["claude-only", "explorer", "reviewer", "team/orchestrator"]);
});

test("the description comes from the frontmatter", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "skills/docs/SKILL.md": SKILL_MD });
  const { entries } = await discover(dir);
  assert.equal(entries[0]?.description, "How to write and maintain the homelab documentation");
});

test("a duplicate id keeps the first and reports the second", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    "skills/docs/SKILL.md": SKILL_MD,
    "vendor-mirror/docs/SKILL.md": SKILL_MD,
  });
  const { entries, problems } = await discover(dir);
  assert.equal(entries.filter((entry) => entry.id === "docs").length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /declared twice/);
});

test("a manifest replaces the convention for the kinds it declares", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    "git-skills.json": JSON.stringify({
      skills: { documentation: "packs/docs" },
      agents: { "team/reviewer": "packs/reviewer.md" },
    }),
    "packs/docs/SKILL.md": SKILL_MD,
    "packs/reviewer.md": AGENT_MD,
    "elsewhere/ignored/SKILL.md": SKILL_MD,
  });

  const { entries, problems } = await discover(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    entries.map((entry) => `${entry.kind}:${entry.id}`),
    ["skill:documentation", "agent:team/reviewer"],
  );
});

test("a manifest pointing at nothing is a problem, not a crash", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "git-skills.json": JSON.stringify({ skills: { gone: "packs/gone" } }) });
  const { entries, problems } = await discover(dir);
  assert.deepEqual(entries, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /no SKILL\.md/);
});

test("findEntry matches kind and id exactly", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "agents/team/reviewer.md": AGENT_MD, "skills/reviewer/SKILL.md": SKILL_MD });
  const discovery = await discover(dir);
  assert.equal(findEntry(discovery, "agent", "team/reviewer")?.kind, "agent");
  assert.equal(findEntry(discovery, "skill", "team/reviewer"), undefined);
  assert.equal(findEntry(discovery, "skill", "reviewer")?.kind, "skill");
});

test("a discovered entry points at a real absolute path", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "skills/docs/SKILL.md": SKILL_MD });
  const { entries } = await discover(dir);
  assert.ok(entries[0]);
  assert.ok(path.isAbsolute(entries[0].path));
});

test("discovery works on a real checkout", async () => {
  const repo = await makeRepo({
    files: {
      "skills/homelable-docs/SKILL.md": SKILL_MD,
      "agents/reviewer.md": AGENT_MD,
    },
  });
  const { entries } = await discover(repo.dir);
  assert.deepEqual(
    entries.map((entry) => `${entry.kind}:${entry.id}`),
    ["skill:homelable-docs", "agent:reviewer"],
  );
});
test("an agents root that is a symlink to another root is not scanned twice", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { ".agents/agents/reviewer.md": AGENT_MD });
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true });
  await fs.symlink("../.agents/agents", path.join(dir, ".opencode", "agents"));

  const { entries, problems } = await discover(dir);
  const agents = entries.filter((entry) => entry.kind === "agent");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.id, "reviewer");
  assert.deepEqual(problems, []);
});

test("the standard tree wins when it is the real one", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { ".agents/agents/reviewer.md": AGENT_MD });
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true });
  await fs.symlink("../.agents/agents", path.join(dir, ".opencode", "agents"));

  const { entries } = await discover(dir);
  assert.equal(entries.find((entry) => entry.kind === "agent")?.origin, ".agents/agents/reviewer.md");
});
