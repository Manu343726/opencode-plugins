import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  adoptEntry,
  existingDefinition,
  listAdopted,
  localDigest,
  removeAdopted,
  snapshot,
  remoteDigest,
  agentPath,
  skillPath,
} from "../src/adopt.ts";
import { readProvenance } from "../src/provenance.ts";
import { parseSpec } from "../src/ref.ts";
import { discover } from "../src/discover.ts";
import {
  AGENT_MD,
  SKILL_MD,
  commitMore,
  exists,
  git,
  makeRepo,
  tmpdir,
  writeFiles,
} from "./helpers.ts";

async function setupRepo() {
  const repo = await makeRepo({
    files: {
      "skills/docs/SKILL.md": SKILL_MD,
      "skills/docs/references/rules.md": "# rules\n",
      "agents/reviewer.md": AGENT_MD,
      "agents/team/orchestrator.md": AGENT_MD,
    },
  });
  const discovery = await discover(repo.dir);
  return { repo, discovery };
}

function entryOf(discovery: Awaited<ReturnType<typeof discover>>, kind: "skill" | "agent", id: string) {
  const entry = discovery.entries.find((candidate) => candidate.kind === kind && candidate.id === id);
  assert.ok(entry, `missing ${kind} ${id}`);
  return entry;
}

test("a skill is adopted into .agents/skills with its neighbours", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}:main`);

  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  const target = skillPath(project, "docs");
  assert.equal(adopted.path, target);
  assert.ok(await exists(path.join(target, "SKILL.md")));
  assert.ok(await exists(path.join(target, "references", "rules.md")));

  const text = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
  const provenance = readProvenance(text);
  assert.deepEqual(provenance, {
    id: `docs@${repo.url}:main`,
    commit: repo.commit,
    digest: provenance?.digest,
  });
  assert.match(provenance?.digest ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("an agent is adopted into .opencode/agents as a single file", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`reviewer@${repo.url}`);

  await adoptEntry({
    entry: entryOf(discovery, "agent", "reviewer"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  const target = agentPath(project, "reviewer");
  assert.equal(target, path.join(project, ".opencode", "agents", "reviewer.md"));
  const provenance = readProvenance(await fs.readFile(target, "utf8"));
  assert.equal(provenance?.id, `reviewer@${repo.url}:main`);
});

test("a nested agent id keeps its directory", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`team/orchestrator@${repo.url}`);

  const adopted = await adoptEntry({
    entry: entryOf(discovery, "agent", "team/orchestrator"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  assert.equal(adopted.id, "team/orchestrator");
  assert.ok(await exists(path.join(project, ".opencode", "agents", "team", "orchestrator.md")));
});

test("right after adopting, the entry is in sync", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);

  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  const state = await snapshot(adopted, await remoteDigest(entryOf(discovery, "skill", "docs")));
  assert.equal(state.state, "in-sync");
  assert.equal(state.localDigest, adopted.provenance.digest);
});

test("a local edit is reported as local changes, not as an update", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  const file = path.join(adopted.path, "SKILL.md");
  const text = await fs.readFile(file, "utf8");
  await fs.writeFile(file, text.replace("Body of the skill.", "Edited locally."), "utf8");

  const state = await snapshot(adopted, await remoteDigest(entryOf(discovery, "skill", "docs")));
  assert.equal(state.state, "local-changes");
});

test("a new upstream commit is reported as an update", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  await commitMore(repo.dir, { "skills/docs/SKILL.md": SKILL_MD.replace("Body", "Body v2") });
  const refreshed = await discover(repo.dir);
  const state = await snapshot(adopted, await remoteDigest(entryOf(refreshed, "skill", "docs")));
  assert.equal(state.state, "update-available");
});

test("local changes and an upstream commit together are reported as both", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  await fs.writeFile(path.join(adopted.path, "SKILL.md"), "---\nname: x\n---\nlocal\n", "utf8");
  await commitMore(repo.dir, { "skills/docs/SKILL.md": SKILL_MD.replace("Body", "Body v2") });
  const refreshed = await discover(repo.dir);

  assert.equal((await snapshot(adopted, await remoteDigest(entryOf(refreshed, "skill", "docs")))).state, "both");
});

test("updating overwrites a local edit and returns to in sync", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);
  const first = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec,
    commit: repo.commit,
  });

  await fs.writeFile(path.join(first.path, "SKILL.md"), "---\nname: x\n---\nlocal\n", "utf8");
  const moved = await commitMore(repo.dir, {
    "skills/docs/SKILL.md": SKILL_MD.replace("Body of the skill.", "Body v2."),
  });
  await git(repo.dir, "checkout", "--quiet", "main");

  const refreshing = await discover(repo.dir);
  const second = await adoptEntry({
    entry: entryOf(refreshing, "skill", "docs"),
    projectDir: project,
    spec,
    commit: moved,
  });

  const text = await fs.readFile(path.join(second.path, "SKILL.md"), "utf8");
  assert.match(text, /Body v2\./);
  assert.equal(
    (await snapshot(second, await remoteDigest(entryOf(refreshing, "skill", "docs")))).state,
    "in-sync",
  );
});

test("adopting twice replaces the copy instead of merging it", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const spec = parseSpec(`docs@${repo.url}`);

  await adoptEntry({ entry: entryOf(discovery, "skill", "docs"), projectDir: project, spec, commit: repo.commit });
  await writeFiles(project, { ".agents/skills/docs/stray.md": "left over\n" });

  await adoptEntry({ entry: entryOf(discovery, "skill", "docs"), projectDir: project, spec, commit: repo.commit });
  assert.equal(await exists(path.join(project, ".agents/skills/docs/stray.md")), false);
});

test("listAdopted finds both kinds and ignores hand-written files", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");

  await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec: parseSpec(`docs@${repo.url}`),
    commit: repo.commit,
  });
  await adoptEntry({
    entry: entryOf(discovery, "agent", "team/orchestrator"),
    projectDir: project,
    spec: parseSpec(`team/orchestrator@${repo.url}`),
    commit: repo.commit,
  });
  await writeFiles(project, { ".opencode/agents/hand-written.md": AGENT_MD });

  const adopted = await listAdopted(project);
  assert.deepEqual(
    adopted.map((item) => `${item.kind}:${item.id}`),
    ["skill:docs", "agent:team/orchestrator"],
  );
});

test("removing an adopted entry deletes it", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec: parseSpec(`docs@${repo.url}`),
    commit: repo.commit,
  });

  await removeAdopted(adopted);
  assert.equal(await exists(adopted.path), false);
  assert.deepEqual(await listAdopted(project), []);
});

test("a hand-written definition is detected before registering", async () => {
  const project = await tmpdir("ogs-project-");
  await writeFiles(project, { ".opencode/agents/reviewer.md": AGENT_MD });

  assert.equal(
    await existingDefinition(project, "agent", "reviewer"),
    path.join(project, ".opencode", "agents", "reviewer.md"),
  );
  assert.equal(await existingDefinition(project, "agent", "other"), undefined);
});

test("a global definition counts as existing too", async () => {
  const project = await tmpdir("ogs-project-");
  const global = await tmpdir("ogs-global-");
  await writeFiles(global, { "skills/docs/SKILL.md": SKILL_MD });

  assert.equal(
    await existingDefinition(project, "skill", "docs", global),
    path.join(global, "skills", "docs", "SKILL.md"),
  );
});

test("the local digest matches the recorded one until a file changes", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "skill", "docs"),
    projectDir: project,
    spec: parseSpec(`docs@${repo.url}`),
    commit: repo.commit,
  });

  assert.equal(await localDigest(adopted), adopted.provenance.digest);
  await writeFiles(project, { ".agents/skills/docs/references/rules.md": "# rules, edited\n" });
  assert.notEqual(await localDigest(adopted), adopted.provenance.digest);
});
test("an adopted agent's path is its file, so removing it cannot wipe the directory", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const reviewer = await adoptEntry({
    entry: entryOf(discovery, "agent", "reviewer"),
    projectDir: project,
    spec: parseSpec(`reviewer@${repo.url}`),
    commit: repo.commit,
  });
  const team = await adoptEntry({
    entry: entryOf(discovery, "agent", "team/orchestrator"),
    projectDir: project,
    spec: parseSpec(`team/orchestrator@${repo.url}`),
    commit: repo.commit,
  });

  const listed = await listAdopted(project);
  const reviewerEntry = listed.find((item) => item.id === "reviewer");
  assert.equal(reviewerEntry?.path, path.join(project, ".opencode", "agents", "reviewer.md"));
  assert.equal(reviewer.path, reviewerEntry?.path);

  // Running a snapshot must not fail on a directory, and removing one agent
  // must leave its sibling in place.
  assert.equal((await snapshot(reviewerEntry!, await remoteDigest(entryOf(discovery, "agent", "reviewer")))).state, "in-sync");
  await removeAdopted(reviewerEntry!);
  assert.equal(await exists(path.join(project, ".opencode", "agents", "reviewer.md")), false);
  assert.equal(await exists(team.path), true);
  assert.equal((await listAdopted(project)).length, 1);
});

test("a commit that does not touch the entry is not an update", async () => {
  const { repo, discovery } = await setupRepo();
  const project = await tmpdir("ogs-project-");
  const adopted = await adoptEntry({
    entry: entryOf(discovery, "agent", "reviewer"),
    projectDir: project,
    spec: parseSpec(`reviewer@${repo.url}`),
    commit: repo.commit,
  });

  // Something else in the repository moves; the agent's own file does not.
  await commitMore(repo.dir, { "README.md": "# unrelated change\n" });
  const refreshed = await discover(repo.dir);

  const state = await snapshot(adopted, await remoteDigest(entryOf(refreshed, "agent", "reviewer")));
  assert.equal(state.state, "in-sync");
});
