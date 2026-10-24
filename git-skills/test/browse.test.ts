import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptedChoice,
  decode,
  encode,
  isDeclared,
  knownTargets,
  shortLabel,
  type Choice,
} from "../src/browse.ts";

const choice: Choice = {
  kind: "agent",
  id: "team/reviewer",
  url: "https://h/x.git",
  ref: "v1.2.0",
  adopted: false,
};

test("a choice survives the round trip", () => {
  assert.deepEqual(decode(encode(choice)), choice);
});

test("an adopted row is encoded as adopted", () => {
  const adopted: Choice = { ...choice, adopted: true, url: "", ref: "" };
  assert.deepEqual(decode(encode(adopted)), adopted);
});

test("a malformed value is rejected instead of guessed", () => {
  assert.equal(decode("not json"), undefined);
  assert.equal(decode("{}"), undefined);
  assert.equal(decode(JSON.stringify({ ...choice, kind: "other" })), undefined);
  assert.equal(decode(JSON.stringify({ ...choice, id: "" })), undefined);
  assert.equal(decode(JSON.stringify({ ...choice, url: 1 })), undefined);
});

test("targets come from both kinds and from repos", () => {
  const targets = knownTargets({
    skills: ["docs@https://h/a.git"],
    agents: ["reviewer@https://h/a.git:v1", "other@https://h/b.git"],
    repos: ["https://h/c.git"],
  });

  assert.deepEqual(targets, [
    { url: "https://h/a.git", ref: "main" },
    { url: "https://h/a.git", ref: "v1" },
    { url: "https://h/b.git", ref: "main" },
    { url: "https://h/c.git", ref: "main" },
  ]);
});

test("the same repository and ref is listed once", () => {
  const targets = knownTargets({
    skills: ["docs@https://h/a.git:main"],
    agents: ["reviewer@https://h/a.git:main"],
    repos: ["https://h/a.git"],
  });
  assert.equal(targets.length, 1);
});

test("a malformed reference does not stop the browser", () => {
  const targets = knownTargets({
    skills: ["no-id-here", "docs@https://h/a.git"],
    agents: [],
    repos: [],
  });
  assert.deepEqual(targets, [{ url: "https://h/a.git", ref: "main" }]);
});

test("an entry already in the config is recognised", () => {
  const lists = { skills: ["docs@https://h/a.git:v1"], agents: [] };
  assert.equal(isDeclared({ kind: "skill", id: "docs" }, { url: "https://h/a.git", ref: "v1" }, lists), true);
  assert.equal(isDeclared({ kind: "skill", id: "docs" }, { url: "https://h/a.git", ref: "main" }, lists), false);
  assert.equal(isDeclared({ kind: "agent", id: "docs" }, { url: "https://h/a.git", ref: "v1" }, lists), false);
});

test("a malformed declaration is not mistaken for a match", () => {
  const lists = { skills: ["garbage"], agents: [] };
  assert.equal(isDeclared({ kind: "skill", id: "docs" }, { url: "https://h/a.git", ref: "main" }, lists), false);
});
test("a repository label is short enough to leave the title room", () => {
  assert.equal(
    shortLabel({ url: "ssh://git@forgejo:2222/homelab/Homelab.git", ref: "main" }),
    "Homelab@main",
  );
  assert.equal(shortLabel({ url: "https://git.example/a/b/skills", ref: "v1.2.0" }), "skills@v1.2.0");
  assert.equal(shortLabel({ url: "git@host:org/repo.git", ref: "main" }), "repo@main");
});

test("an adopted row carries the repository it came from", () => {
  const choice = adoptedChoice("agent", "reviewer", "reviewer@ssh://git@host:2222/o/r.git:v1");
  assert.deepEqual(choice, {
    kind: "agent",
    id: "reviewer",
    url: "ssh://git@host:2222/o/r.git",
    ref: "v1",
    adopted: true,
  });
  assert.deepEqual(decode(encode(choice)), choice);
});

test("an adopted row with unreadable provenance is still a row", () => {
  const choice = adoptedChoice("skill", "docs", "not a reference");
  assert.equal(choice.adopted, true);
  assert.equal(choice.url, "");
});
