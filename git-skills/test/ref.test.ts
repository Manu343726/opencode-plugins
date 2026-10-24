import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REF,
  SpecError,
  formatSpec,
  parseReference,
  parseSpec,
  splitUrlAndRef,
  validateId,
} from "../src/ref.ts";

test("a url without a ref keeps the default", () => {
  assert.deepEqual(parseSpec("docs@https://git.example/homelab/skills.git"), {
    id: "docs",
    url: "https://git.example/homelab/skills.git",
    ref: DEFAULT_REF,
  });
});

test("an explicit ref is split off the url", () => {
  assert.deepEqual(parseSpec("docs@https://git.example/homelab/skills.git:v1.2.0"), {
    id: "docs",
    url: "https://git.example/homelab/skills.git",
    ref: "v1.2.0",
  });
});

test("a scp-like url keeps its own colon when no ref follows", () => {
  assert.deepEqual(parseSpec("reviewer@git@forgejo:homelab/skills.git"), {
    id: "reviewer",
    url: "git@forgejo:homelab/skills.git",
    ref: DEFAULT_REF,
  });
});

test("a scp-like url with a port keeps the port when no ref follows", () => {
  assert.deepEqual(parseSpec("reviewer@ssh://git@forgejo:2222/homelab/skills.git"), {
    id: "reviewer",
    url: "ssh://git@forgejo:2222/homelab/skills.git",
    ref: DEFAULT_REF,
  });
});

test("a scp-like url with a port and a ref splits at the last colon", () => {
  assert.deepEqual(parseSpec("reviewer@ssh://git@forgejo:2222/homelab/skills.git:main"), {
    id: "reviewer",
    url: "ssh://git@forgejo:2222/homelab/skills.git",
    ref: "main",
  });
});

test("the id may be an agent path", () => {
  assert.equal(parseSpec("team/reviewer@https://host/x.git").id, "team/reviewer");
});

test("surrounding whitespace is ignored", () => {
  assert.equal(parseSpec("  docs@https://host/x.git:dev  ").ref, "dev");
});

test("a reference without an id is rejected", () => {
  assert.throws(() => parseSpec("https://host/x.git"), SpecError);
  assert.throws(() => parseSpec("@https://host/x.git"), SpecError);
});

test("an empty reference is rejected", () => {
  assert.throws(() => parseSpec("   "), SpecError);
});

test("an empty url or ref is rejected", () => {
  assert.throws(() => parseSpec("docs@"), SpecError);
  assert.throws(() => parseSpec("docs@:main"), SpecError);
  assert.throws(() => parseSpec("docs@https://host/x.git:"), SpecError);
});

test("splitUrlAndRef reports both halves", () => {
  assert.deepEqual(splitUrlAndRef("https://h/a.git:dev"), {
    url: "https://h/a.git",
    ref: "dev",
  });
  assert.deepEqual(splitUrlAndRef("https://h/a.git"), {
    url: "https://h/a.git",
    ref: DEFAULT_REF,
  });
});

test("a skill id is a single segment", () => {
  assert.doesNotThrow(() => validateId("skill", "homelable-docs"));
  assert.doesNotThrow(() => validateId("skill", "a.b_c-d"));
  assert.throws(() => validateId("skill", "team/reviewer"), SpecError);
  assert.throws(() => validateId("skill", "Homelable"), SpecError);
  assert.throws(() => validateId("skill", "../escape"), SpecError);
  assert.throws(() => validateId("skill", ""), SpecError);
});

test("an agent id may nest", () => {
  assert.doesNotThrow(() => validateId("agent", "reviewer"));
  assert.doesNotThrow(() => validateId("agent", "team/reviewer"));
  assert.doesNotThrow(() => validateId("agent", "a/b/c"));
  assert.throws(() => validateId("agent", "/leading"), SpecError);
  assert.throws(() => validateId("agent", "trailing/"), SpecError);
  assert.throws(() => validateId("agent", "a//b"), SpecError);
  assert.throws(() => validateId("agent", "a/../b"), SpecError);
});

test("parseReference validates the id for its kind", () => {
  assert.throws(
    () => parseReference("skill", "team/reviewer@https://host/x.git"),
    SpecError,
  );
  assert.doesNotThrow(() =>
    parseReference("agent", "team/reviewer@https://host/x.git"),
  );
});

test("formatSpec is the canonical spelling", () => {
  const spec = parseSpec("docs@https://host/a.git:dev");
  assert.equal(formatSpec(spec), "docs@https://host/a.git:dev");
  assert.deepEqual(parseSpec(formatSpec(spec)), spec);
});