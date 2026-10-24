import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  PROVENANCE_KEY,
  canonicalize,
  digestEntry,
  digestFile,
  listFiles,
  readProvenance,
  splitFrontmatter,
  withProvenance,
} from "../src/provenance.ts";
import { AGENT_MD, SKILL_MD, tmpdir, writeFiles } from "./helpers.ts";

const provenance = {
  id: "docs@file:///repo:main",
  commit: "9f3c1a2b8d4e5f60718293a4b5c6d7e8f9012345",
  digest: "sha256:4b1c",
};

test("frontmatter and body are split", () => {
  const { data, body } = splitFrontmatter(SKILL_MD);
  assert.equal(data.name, "Homelable Docs");
  assert.match(body, /Body of the skill\./);
});

test("a document without frontmatter is all body", () => {
  const { data, body } = splitFrontmatter("# Just a body\n");
  assert.deepEqual(data, {});
  assert.equal(body, "# Just a body\n");
});

test("CRLF and trailing whitespace do not change the canonical form", () => {
  const plain = "---\nname: a\n---\n\nBody\n";
  const crlf = "---\r\nname: a\r\n---\r\n\r\nBody   \r\n";
  assert.equal(canonicalize(plain), canonicalize(crlf));
});

test("reordering YAML keys does not change the canonical form", () => {
  const left = "---\nname: a\ndescription: b\n---\nBody\n";
  const right = "---\ndescription: b\nname: a\n---\nBody\n";
  assert.equal(canonicalize(left), canonicalize(right));
});

test("the provenance block is written where it can be read back", () => {
  const written = withProvenance(SKILL_MD, provenance);
  assert.deepEqual(readProvenance(written), provenance);
  assert.match(written, new RegExp(PROVENANCE_KEY));
});

test("writing the provenance block leaves the rest of the document intact", () => {
  const written = withProvenance(SKILL_MD, provenance);
  const { data, body } = splitFrontmatter(written);
  assert.equal(data.name, "Homelable Docs");
  assert.equal(data.description, "How to write and maintain the homelab documentation");
  assert.match(body, /Body of the skill\./);
});

test("the canonical form ignores the provenance block", () => {
  const written = withProvenance(SKILL_MD, provenance);
  assert.equal(canonicalize(written), canonicalize(SKILL_MD));
});

test("an entry that was never adopted has no provenance", () => {
  assert.equal(readProvenance(SKILL_MD), undefined);
});

test("an unrelated metadata block is preserved", () => {
  const text = "---\nname: a\nmetadata:\n  other: 1\n---\nBody\n";
  const written = withProvenance(text, provenance);
  const { data } = splitFrontmatter(written);
  assert.deepEqual(data.metadata, { other: 1, [PROVENANCE_KEY]: { ...provenance } });
});

test("canonicalising removes an empty metadata block entirely", () => {
  const withOnlyOurs = `---\nname: a\nmetadata:\n  ${PROVENANCE_KEY}:\n    id: x@y:z\n    commit: c\n    digest: sha256:d\n---\nBody\n`;
  const { data } = splitFrontmatter(canonicalize(withOnlyOurs));
  assert.equal(data.metadata, undefined);
});

test("the digest of a skill is stable across a provenance rewrite", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, {
    "SKILL.md": SKILL_MD,
    "references/rules.md": "# rules\n",
  });
  const before = await digestEntry(dir, "SKILL.md");

  await fs.writeFile(path.join(dir, "SKILL.md"), withProvenance(SKILL_MD, provenance), "utf8");
  const after = await digestEntry(dir, "SKILL.md");
  assert.equal(after, before);
});

test("the digest changes when the body changes", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "SKILL.md": SKILL_MD });
  const before = await digestEntry(dir, "SKILL.md");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    withProvenance(SKILL_MD.replace("Body of the skill.", "Body of the skill, edited."), provenance),
    "utf8",
  );
  const after = await digestEntry(dir, "SKILL.md");
  assert.notEqual(after, before);
});

test("the digest changes when a frontmatter value changes", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "SKILL.md": SKILL_MD });
  const before = await digestEntry(dir, "SKILL.md");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    withProvenance(SKILL_MD.replace("Homelable Docs", "Renamed"), provenance),
    "utf8",
  );
  assert.notEqual(await digestEntry(dir, "SKILL.md"), before);
});

test("the digest changes when a neighbouring file changes", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "SKILL.md": SKILL_MD, "references/rules.md": "# rules\n" });
  const before = await digestEntry(dir, "SKILL.md");
  await fs.writeFile(path.join(dir, "references/rules.md"), "# rules, edited\n", "utf8");
  assert.notEqual(await digestEntry(dir, "SKILL.md"), before);
});

test("the digest changes when a file is added", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "SKILL.md": SKILL_MD });
  const before = await digestEntry(dir, "SKILL.md");
  await writeFiles(dir, { "scripts/extra.sh": "#!/bin/sh\n" });
  assert.notEqual(await digestEntry(dir, "SKILL.md"), before);
});

test("an agent digest ignores its provenance block", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "reviewer.md": AGENT_MD });
  const file = path.join(dir, "reviewer.md");
  const before = await digestFile(file);
  await fs.writeFile(file, withProvenance(AGENT_MD, provenance), "utf8");
  assert.equal(await digestFile(file), before);
});

test("listFiles is sorted and relative", async () => {
  const dir = await tmpdir();
  await writeFiles(dir, { "b.txt": "", "a/c.txt": "", "a/b.txt": "" });
  assert.deepEqual(await listFiles(dir), ["a/b.txt", "a/c.txt", "b.txt"]);
});