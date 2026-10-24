import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolve, readOptions, summarize } from "../src/resolve.ts";
import { adoptEntry, listAdopted } from "../src/adopt.ts";
import { parseSpec } from "../src/ref.ts";
import { discover } from "../src/discover.ts";
import { AGENT_MD, SKILL_MD, tmpdir, writeFiles } from "./helpers.ts";

async function fixture() {
  const repoDir = await tmpdir("ogs-src-");
  await writeFiles(repoDir, {
    "skills/docs/SKILL.md": SKILL_MD,
    "skills/code-review/SKILL.md": SKILL_MD,
    "agents/reviewer.md": AGENT_MD,
  });
  const { git } = await import("./helpers.ts");
  await git(repoDir, "init", "--quiet", "--initial-branch=main");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  await git(repoDir, "add", "--all");
  await git(repoDir, "commit", "--quiet", "-m", "initial");
  const commit = await git(repoDir, "rev-parse", "HEAD");

  const project = await tmpdir("ogs-project-");
  const cacheDir = await tmpdir("ogs-cache-");
  return { url: `file://${repoDir}`, repoDir, commit, project, cacheDir };
}

test("a skill and an agent are resolved from one repository", async () => {
  const { url, commit, project, cacheDir } = await fixture();

  const resolution = await resolve(project, {
    skills: [`docs@${url}`],
    agents: [`reviewer@${url}`],
    cacheDir,
  });

  assert.deepEqual(resolution.problems, []);
  assert.equal(resolution.repositories.length, 1);
  assert.deepEqual(
    resolution.entries.map((entry) => `${entry.entry.kind}:${entry.spec.id}`),
    ["skill:docs", "agent:reviewer"],
  );
  for (const entry of resolution.entries) assert.equal(entry.commit, commit);

  const skill = resolution.entries.find((entry) => entry.entry.kind === "skill");
  assert.match(skill?.body ?? "", /Body of the skill\./);
  const agent = resolution.entries.find((entry) => entry.entry.kind === "agent");
  assert.match(agent?.body ?? "", /SHARED-REVIEWER/);
});

test("two references to the same repo and ref clone it once", async () => {
  const { url, project, cacheDir } = await fixture();

  const resolution = await resolve(project, {
    skills: [`docs@${url}`, `code-review@${url}`],
    cacheDir,
  });

  assert.equal(resolution.repositories.length, 1);
  assert.equal(resolution.entries.length, 2);
});

test("an unknown id reports what the repository does have", async () => {
  const { url, project, cacheDir } = await fixture();

  const resolution = await resolve(project, { skills: [`nope@${url}`], cacheDir });

  assert.equal(resolution.entries.length, 0);
  assert.equal(resolution.problems.length, 1);
  assert.match(resolution.problems[0] ?? "", /no skill "nope"/);
  assert.match(resolution.problems[0] ?? "", /available: code-review, docs/);
});

test("asking for a skill where only agents exist says so", async () => {
  const { url, project, cacheDir } = await fixture();
  const agentsOnly = await tmpdir("ogs-agents-");
  await writeFiles(agentsOnly, { "agents/reviewer.md": AGENT_MD });
  const { git } = await import("./helpers.ts");
  await git(agentsOnly, "init", "--quiet", "--initial-branch=main");
  await git(agentsOnly, "config", "user.email", "test@example.com");
  await git(agentsOnly, "config", "user.name", "Test");
  await git(agentsOnly, "add", "--all");
  await git(agentsOnly, "commit", "--quiet", "-m", "initial");

  const resolution = await resolve(project, {
    skills: [`reviewer@file://${agentsOnly}`],
    agents: [`reviewer@file://${agentsOnly}`],
    cacheDir,
  });

  assert.equal(resolution.problems.length, 1);
  assert.match(resolution.problems[0] ?? "", /none of that kind/);
  assert.equal(resolution.entries.length, 1);
  assert.equal(url.length > 0, true);
});

test("a malformed reference is a problem, not a crash", async () => {
  const { project, cacheDir } = await fixture();

  const resolution = await resolve(project, { skills: ["no-id-here"], cacheDir });
  assert.equal(resolution.problems.length, 1);
  assert.match(resolution.problems[0] ?? "", /options\.skills/);
});

test("repos[] alone clones nothing", async () => {
  const { url, project, cacheDir } = await fixture();

  const resolution = await resolve(project, { repos: [url], cacheDir });

  assert.deepEqual(resolution.entries, []);
  assert.deepEqual(resolution.problems, []);
  const cached = await fs.readdir(cacheDir);
  assert.deepEqual(cached, []);
});

test("an adopted entry is skipped so it is not defined twice", async () => {
  const { url, project, cacheDir, repoDir, commit } = await fixture();
  const discovery = await discover(repoDir);
  const entry = discovery.entries.find((candidate) => candidate.id === "docs");
  assert.ok(entry);

  await adoptEntry({
    entry,
    projectDir: project,
    spec: parseSpec(`docs@${url}`),
    commit,
  });
  assert.equal((await listAdopted(project)).length, 1);

  const resolution = await resolve(project, { skills: [`docs@${url}`], cacheDir });
  assert.equal(resolution.entries.length, 0);
  assert.equal(resolution.skipped.length, 1);
  assert.equal(resolution.skipped[0]?.reason, "already-adopted");
});

test("a hand-written definition wins over the remote one", async () => {
  const { url, project, cacheDir } = await fixture();
  const local = path.join(project, ".opencode", "agents", "reviewer.md");
  await writeFiles(project, { ".opencode/agents/reviewer.md": AGENT_MD });

  const resolution = await resolve(project, { agents: [`reviewer@${url}`], cacheDir });
  assert.equal(resolution.entries.length, 0);
  assert.equal(resolution.skipped[0]?.reason, "defined-in-project");
  assert.equal(resolution.skipped[0]?.detail, local);
});

test("readOptions accepts the documented shape and reports the rest", () => {
  const { options, problems } = readOptions({
    skills: ["a@https://h/x.git"],
    agents: ["b@https://h/x.git:v1"],
    repos: ["https://h/x.git"],
    ttlMinutes: 10,
    offline: true,
    unexpected: "ignored",
  });

  assert.deepEqual(problems, []);
  assert.deepEqual(options.skills, ["a@https://h/x.git"]);
  assert.deepEqual(options.agents, ["b@https://h/x.git:v1"]);
  assert.equal(options.ttlMinutes, 10);
  assert.equal(options.offline, true);
});

test("readOptions reports a malformed option value", () => {
  const { problems } = readOptions({ skills: "not-an-array", ttlMinutes: "soon" });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /ttlMinutes/);
});

test("summarize names what was loaded and what was skipped", async () => {
  const { url, project, cacheDir } = await fixture();
  const resolution = await resolve(project, { skills: [`docs@${url}`], cacheDir });
  const text = summarize(resolution);
  assert.match(text, /1 skill\(s\), 0 agent\(s\)/);
  assert.match(text, /skill docs @/);
});