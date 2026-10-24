import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { adoptEntry, listAdopted } from "../src/adopt.ts";
import { discover } from "../src/discover.ts";
import { parseSpec } from "../src/ref.ts";
import {
  branchName,
  composeBody,
  proposeChange,
  ProposeError,
  repositoryOf,
  webBaseOf,
} from "../src/propose.ts";
import { AGENT_MD, SKILL_MD, git, makeRepo, tmpdir, writeFiles } from "./helpers.ts";

test("owner and repo come out of every url shape the plugin accepts", () => {
  assert.deepEqual(repositoryOf("ssh://git@forgejo:2222/homelab/Homelab.git"), {
    owner: "homelab",
    repo: "Homelab",
  });
  assert.deepEqual(repositoryOf("https://git.example.com/me/skills"), {
    owner: "me",
    repo: "skills",
  });
  assert.deepEqual(repositoryOf("git@host:org/repo.git"), { owner: "org", repo: "repo" });
  assert.equal(repositoryOf("https://host/only-one-part"), undefined);
});

test("a web base is derived only from a web url", () => {
  assert.equal(webBaseOf("https://git.example.com/me/skills.git"), "https://git.example.com");
  assert.equal(webBaseOf("ssh://git@forgejo:2222/me/skills.git"), undefined);
});

test("a branch says what it is, and when", () => {
  const branch = branchName("agent", "team/reviewer", Date.UTC(2026, 9, 24, 12, 34, 56));
  assert.equal(branch, "propose/agent-team-reviewer-20261024123456");
  assert.match(branch, /^propose\//);
});

test("the body carries the motivation, the diff and the provenance", () => {
  const body = composeBody({
    kind: "skill",
    id: "docs",
    title: "Teach the skill about tags",
    motivation: "Tags are how we pin a library; the skill never mentions them.",
    details: "Adds a section on pinning.",
    files: ["SKILL.md", "references/tags.md"],
    stat: " SKILL.md | 4 ++++",
    reference: "docs@ssh://git@host/o/r.git:main",
  });

  assert.match(body, /Tags are how we pin a library/);
  assert.match(body, /## What changed/);
  assert.match(body, /SKILL\.md \| 4 \+\+\+\+/);
  assert.match(body, /- `references\/tags\.md`/);
  assert.match(body, /## Details/);
  assert.match(body, /Adopted from `docs@ssh:\/\/git@host\/o\/r\.git:main`/);
});

test("without a motivation the title is the opening sentence", () => {
  const body = composeBody({
    kind: "agent",
    id: "reviewer",
    title: "Be stricter about secrets",
    files: [],
    stat: "",
    reference: "reviewer@x",
  });
  assert.ok(body.startsWith("Be stricter about secrets"));
  assert.match(body, /\(no diff\)/);
});

async function adoptOne(options?: { localEdit?: string }) {
  const repo = await makeRepo({
    files: {
      "skills/docs/SKILL.md": SKILL_MD,
      "skills/docs/references/rules.md": "# rules\n",
      "agents/reviewer.md": AGENT_MD,
    },
  });
  const project = await tmpdir("ogs-project-");
  const discovery = await discover(repo.dir);
  const entry = discovery.entries.find((candidate) => candidate.kind === "skill" && candidate.id === "docs");
  assert.ok(entry);

  const adopted = await adoptEntry({
    entry,
    projectDir: project,
    spec: parseSpec(`docs@${repo.url}:main`),
    commit: repo.commit,
  });

  if (options?.localEdit) {
    // Edit in place: the provenance block is part of the file and must survive,
    // exactly as it does when a person edits it.
    const file = path.join(adopted.path, "SKILL.md");
    const current = await fs.readFile(file, "utf8");
    await fs.writeFile(file, current.replace("Body of the skill.", options.localEdit), "utf8");
  }
  return { repo, project, adopted };
}

test("proposing refuses when the copy has no local changes", async () => {
  const { project } = await adoptOne();
  await assert.rejects(
    () => proposeChange({ projectDir: project, kind: "skill", id: "docs", title: "x" }),
    ProposeError,
  );
});

test("proposing pushes a branch with the adopted changes", async () => {
  const { repo, project, adopted } = await adoptOne({
    localEdit: "Body of the skill, improved.",
  });

  const proposal = await proposeChange({
    projectDir: project,
    kind: "skill",
    id: "docs",
    title: "Improve the body",
    motivation: "The body was vague.",
    author: { name: "Test", email: "test@example.com" },
  });

  assert.equal(proposal.pushed, true);
  assert.ok(proposal.branch.startsWith("propose/skill-docs-"));
  assert.deepEqual([...proposal.files].sort(), ["SKILL.md", "references/rules.md"]);

  // The branch exists on the remote, with exactly one commit on top of main.
  const branches = await git(repo.dir, "branch", "--list", proposal.branch);
  assert.match(branches, /propose\/skill-docs-/);

  await git(repo.dir, "checkout", "--quiet", proposal.branch);
  const message = await git(repo.dir, "log", "-1", "--pretty=%B");
  assert.match(message, /Improve the body/);
  assert.match(message, /The body was vague\./);
  const content = await fs.readFile(path.join(repo.dir, "skills/docs/SKILL.md"), "utf8");
  assert.match(content, /improved/);

  // The adopted copy is untouched: proposing does not rewrite the project.
  assert.match(await fs.readFile(path.join(adopted.path, "SKILL.md"), "utf8"), /improved/);
  const adoptedNow = await listAdopted(project);
  assert.equal(adoptedNow.length, 1);
});

test("an agent is proposed as its single file", async () => {
  const repo = await makeRepo({ files: { "agents/reviewer.md": AGENT_MD } });
  const project = await tmpdir("ogs-project-");
  const discovery = await discover(repo.dir);
  const entry = discovery.entries.find((candidate) => candidate.kind === "agent");
  assert.ok(entry);

  const adopted = await adoptEntry({
    entry,
    projectDir: project,
    spec: parseSpec(`reviewer@${repo.url}`),
    commit: repo.commit,
  });
  const agentFile = await fs.readFile(adopted.path, "utf8");
  await fs.writeFile(adopted.path, agentFile.replace("SHARED-REVIEWER", "STRICTER"), "utf8");

  const proposal = await proposeChange({
    projectDir: project,
    kind: "agent",
    id: "reviewer",
    title: "Be stricter",
    author: { name: "Test", email: "test@example.com" },
  });

  assert.deepEqual(proposal.files, ["reviewer.md"]);
  await git(repo.dir, "checkout", "--quiet", proposal.branch);
  assert.match(await fs.readFile(path.join(repo.dir, "agents/reviewer.md"), "utf8"), /STRICTER/);
});

test("without a token the branch is pushed and the caller is told why there is no PR", async () => {
  const { project } = await adoptOne({ localEdit: "Body of the skill, again." });
  const proposal = await proposeChange({
    projectDir: project,
    kind: "skill",
    id: "docs",
    title: "Again",
    author: { name: "Test", email: "test@example.com" },
  });
  assert.equal(proposal.pullRequestUrl, undefined);
  assert.match(proposal.warnings.join(" "), /no token configured/);
  // A local repository has no web base, so no compare url either.
  assert.equal(proposal.compareUrl, undefined);
});

test("proposing an entry that is not adopted is refused", async () => {
  const project = await tmpdir("ogs-project-");
  await writeFiles(project, { "opencode.jsonc": "{}" });
  await assert.rejects(
    () => proposeChange({ projectDir: project, kind: "skill", id: "nope", title: "x" }),
    ProposeError,
  );
});
