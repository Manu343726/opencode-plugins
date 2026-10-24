import test from "node:test";
import assert from "node:assert/strict";

import { parseAgent, parseSkillMeta } from "../src/agentfile.ts";

const AGENT = `---
description: Reviews changes for correctness
mode: subagent
---

Reply with exactly: SHARED-REVIEWER
`;

test("the body becomes the system prompt", () => {
  const { fields } = parseAgent(AGENT, "reviewer");
  assert.match(fields.system, /SHARED-REVIEWER/);
  assert.doesNotMatch(fields.system, /description:/);
});

test("the name falls back to the id", () => {
  assert.equal(parseAgent(AGENT, "reviewer").fields.name, "reviewer");
  assert.equal(parseAgent(`---\nname: Reviewer\n---\nx\n`, "reviewer").fields.name, "Reviewer");
});

test("mode defaults to primary, as OpenCode does", () => {
  assert.equal(parseAgent(`---\ndescription: x\n---\ny\n`, "a").fields.mode, "primary");
  assert.equal(parseAgent(`---\nmode: subagent\n---\ny\n`, "a").fields.mode, "subagent");
  assert.equal(parseAgent(`---\nmode: all\n---\ny\n`, "a").fields.mode, "all");
});

test("an invalid mode is reported and defaults", () => {
  const { fields, problems } = parseAgent(`---\nmode: sometimes\n---\ny\n`, "a");
  assert.equal(fields.mode, "primary");
  assert.match(problems[0] ?? "", /mode must be one of/);
});

test("permissions are carried over", () => {
  const text = `---
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: read
    resource: "src/**"
    effect: allow
---
body
`;
  const { fields, problems } = parseAgent(text, "a");
  assert.deepEqual(problems, []);
  assert.deepEqual(fields.permissions, [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "read", resource: "src/**", effect: "allow" },
  ]);
});

test("a malformed permission rule is reported, not applied", () => {
  const text = `---
permissions:
  - action: edit
---
body
`;
  const { fields, problems } = parseAgent(text, "a");
  assert.equal(fields.permissions?.length, 0);
  assert.match(problems[0] ?? "", /needs action, resource and effect/);
});

test("a model is parsed into provider, id and variant", () => {
  assert.deepEqual(parseAgent(`---\nmodel: anthropic/claude#high\n---\nx\n`, "a").fields.model, {
    providerID: "anthropic",
    id: "claude",
    variant: "high",
  });
  assert.deepEqual(parseAgent(`---\nmodel: litellm/deepseek-v4.1-flash\n---\nx\n`, "a").fields.model, {
    providerID: "litellm",
    id: "deepseek-v4.1-flash",
  });
});

test("a model in the wrong shape is reported", () => {
  const { fields, problems } = parseAgent(`---\nmodel: claude\n---\nx\n`, "a");
  assert.equal(fields.model, undefined);
  assert.match(problems[0] ?? "", /provider\/model/);
});

test("hidden, color and steps are carried over", () => {
  const { fields } = parseAgent(`---\nhidden: true\ncolor: "#ff6b6b"\nsteps: 8\n---\nx\n`, "a");
  assert.equal(fields.hidden, true);
  assert.equal(fields.color, "#ff6b6b");
  assert.equal(fields.steps, 8);
});

test("an unmapped field is reported instead of silently dropped", () => {
  const { problems } = parseAgent(`---\ntemperature: 0.2\n---\nx\n`, "a");
  assert.match(problems[0] ?? "", /"temperature" is not applied/);
});

test("the provenance block is not reported as an unmapped field", () => {
  const text = `---
description: x
metadata:
  opencode-git-skills:
    id: a@https://h/x.git:main
    commit: abc
    digest: sha256:def
---
body
`;
  assert.deepEqual(parseAgent(text, "a").problems, []);
});

test("a skill's name and description come from the frontmatter", () => {
  const meta = parseSkillMeta(
    `---\nname: Homelable Docs\ndescription: How to write docs\n---\n\n# Body\n`,
    "homelable-docs",
  );
  assert.equal(meta.name, "Homelable Docs");
  assert.equal(meta.description, "How to write docs");
  assert.match(meta.body, /# Body/);
  assert.doesNotMatch(meta.body, /Homelable Docs/);
});

test("a skill without a name falls back to its id", () => {
  assert.equal(parseSkillMeta(`---\ndescription: x\n---\ny\n`, "docs").name, "docs");
});