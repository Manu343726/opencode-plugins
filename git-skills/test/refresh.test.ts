/**
 * The refresh: what moved, what changed, and what a running session cannot see.
 *
 * These tests use real repositories, like the rest of the suite, because the
 * interesting part is the sha a fetch actually moved — a stubbed `git` would
 * only prove that the comparison compares.
 *
 * `OPENCODE_CONFIG_DIR` is pointed at an empty directory before the first pull.
 * `readLists` merges the machine's configuration with the project's, and this
 * machine's declares a dozen references from `agent-skills-library`: without the
 * override, a test run would clone them over the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { compare, format, hasChanges, pull, snapshotOf } from "../src/refresh.ts";
import { AGENT_MD, SKILL_MD, commitMore, makeRepo, tmpdir } from "./helpers.ts";

const PRIMARY_REVIEWER = `---
description: Reviews changes for correctness
mode: primary
permissions:
  - action: shell
    resource: "*"
    effect: deny
---

Reply with exactly: SHARED-REVIEWER
`;

const EDITED_REVIEWER = `---
description: Reviews changes for correctness
mode: subagent
---

Reply with exactly: SHARED-REVIEWER, and name the files you read.
`;

const EDITED_SKILL_MD = `---
name: Homelable Docs
description: How to write and maintain the homelab documentation
---

# Homelable Docs

Body of the skill, now with one line more.
`;

async function fixture() {
  const repo = await makeRepo({
    files: {
      "skills/docs/SKILL.md": SKILL_MD,
      "agents/reviewer.md": AGENT_MD,
    },
  });

  const project = await tmpdir("ogs-project-");
  const cacheDir = await tmpdir("ogs-cache-");
  const globalConfigDir = await tmpdir("ogs-global-");
  process.env.OPENCODE_CONFIG_DIR = globalConfigDir;

  await projectConfig(project, {
    skills: [`docs@${repo.url}`],
    agents: [`reviewer@${repo.url}`],
  });

  return { ...repo, project, cacheDir };
}

/** Writes the project's own configuration, the shape the bundle takes. */
async function projectConfig(project: string, gitSkills: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(project, "opencode.jsonc"),
    JSON.stringify(
      {
        plugins: [
          {
            package: "git+ssh://git@forgejo:2222/manu343726/opencode-plugins.git#main",
            options: { plugins: ["git-skills"], "git-skills": gitSkills },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

test("a refresh reports the shas it moved, and which entry changed", async () => {
  const { dir, project, cacheDir, commit } = await fixture();

  const first = await pull(project, { cacheDir });
  assert.deepEqual(first.resolution.problems, []);
  assert.equal(first.resolution.entries.length, 2);
  assert.equal(first.references.length, 1);
  assert.equal(first.references[0]?.sha, commit);

  const moved = await commitMore(dir, { "agents/reviewer.md": EDITED_REVIEWER }, "edit the reviewer");
  const second = await pull(project, { cacheDir });
  const report = compare(snapshotOf(first), second);

  assert.equal(hasChanges(report), true);
  assert.equal(report.references[0]?.oldSha, commit);
  assert.equal(report.references[0]?.newSha, moved);
  assert.equal(report.references[0]?.moved, true);

  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0]?.kind, "agent");
  assert.equal(report.changed[0]?.id, "reviewer");
  assert.deepEqual(report.changed[0]?.fields, ["content"]);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.deferred, []);

  const text = format(report);
  assert.match(text, /1 reference\(s\) moved/);
  assert.match(text, /agent reviewer: content/);
  assert.match(text, /agents\/reviewer\.md/);
});

test("a changed skill names the directory it came from, not just SKILL.md", async () => {
  const { dir, project, cacheDir } = await fixture();

  const first = await pull(project, { cacheDir });
  await commitMore(dir, { "skills/docs/SKILL.md": EDITED_SKILL_MD }, "edit the docs skill");
  const report = compare(snapshotOf(first), await pull(project, { cacheDir }));

  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0]?.kind, "skill");
  assert.equal(report.changed[0]?.id, "docs");
  assert.deepEqual(report.changed[0]?.fields, ["content"]);
  assert.equal(report.changed[0]?.origin, "skills/docs");

  const text = format(report);
  assert.match(text, /skill docs: content/);
  assert.match(text, /— skills\/docs/);
});

test("a second refresh reports no change and reuses the checkout", async () => {
  const { project, cacheDir } = await fixture();

  const first = await pull(project, { cacheDir });
  const checkout = first.resolution.repositories[0]?.dir;
  assert.ok(checkout);
  const before = await fs.stat(checkout);

  const second = await pull(project, { cacheDir });
  const report = compare(snapshotOf(first), second);

  assert.equal(report.references[0]?.moved, false);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.removed, []);
  assert.equal(hasChanges(report), false);
  assert.match(format(report), /no change/);

  // A clone renames a fresh temporary tree into place, so a new inode is the
  // signature of a re-clone. A fetch leaves the directory alone.
  const after = await fs.stat(checkout);
  assert.equal(after.ino, before.ino);
});

test("a commit that touches no entry moves the sha and leaves the entries alone", async () => {
  const { dir, project, cacheDir } = await fixture();

  const first = await pull(project, { cacheDir });
  await commitMore(dir, { "README.md": "an unrelated change\n" }, "touch something else");
  const report = compare(snapshotOf(first), await pull(project, { cacheDir }));

  assert.equal(report.references[0]?.moved, true);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.added, []);
  assert.equal(report.unchanged, 2);
});

test("a changed mode and permission list are reported as needing a new session", async () => {
  const { dir, project, cacheDir } = await fixture();

  const first = await pull(project, { cacheDir });
  await commitMore(dir, { "agents/reviewer.md": PRIMARY_REVIEWER }, "the reviewer becomes primary");
  const report = compare(snapshotOf(first), await pull(project, { cacheDir }));

  assert.equal(report.changed.length, 1);
  assert.deepEqual(report.changed[0]?.fields, ["mode", "permissions"]);

  assert.equal(report.deferred.length, 1);
  assert.equal(report.deferred[0]?.kind, "agent");
  assert.equal(report.deferred[0]?.id, "reviewer");
  assert.deepEqual(report.deferred[0]?.fields, ["mode", "permissions"]);

  const text = format(report);
  assert.match(text, /not in effect until a new session/);
  assert.match(text, /agent reviewer: mode, permissions/);
  assert.match(text, /start a new session/);
});

test("a first pull against no previous snapshot reports everything as added", async () => {
  const { project, cacheDir } = await fixture();

  const report = compare(undefined, await pull(project, { cacheDir }));

  assert.deepEqual(report.changed, []);
  assert.equal(report.added.length, 2);
  assert.deepEqual(
    report.added.map((entry) => `${entry.kind}:${entry.id}`),
    ["skill:docs", "agent:reviewer"],
  );
});

test("a repository the project only browses is pulled too", async () => {
  const first = await fixture();
  const browseOnly = await makeRepo({ files: { "skills/extra/SKILL.md": SKILL_MD } });

  await projectConfig(first.project, {
    skills: [`docs@${first.url}`],
    agents: [`reviewer@${first.url}`],
    repos: [browseOnly.url],
  });

  const pulled = await pull(first.project, { cacheDir: first.cacheDir });

  assert.equal(pulled.references.length, 2);
  assert.equal(pulled.scans.length, 1);
  assert.equal(pulled.scans[0]?.url, browseOnly.url);
  assert.equal(pulled.scans[0]?.commit, browseOnly.commit);
  assert.equal(
    pulled.references.some((reference) => reference.url === browseOnly.url),
    true,
  );
});
