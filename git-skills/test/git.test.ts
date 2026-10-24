import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { checkoutDir, commitOf, ensureCheckout, run } from "../src/git.ts";
import { SKILL_MD, commitMore, exists, git, makeRepo, tmpdir } from "./helpers.ts";

async function cache(): Promise<string> {
  return tmpdir("ogs-cache-");
}

test("a fresh checkout reports the commit it landed on", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();

  const checkout = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir });
  assert.equal(checkout.commit, repo.commit);
  assert.equal(checkout.updated, true);
  assert.equal(checkout.warning, undefined);
  assert.ok(await exists(path.join(checkout.dir, "SKILL.md")));
});

test("a second call reuses the cached tree", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();

  const first = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir });
  const second = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir, ttlMs: 60_000 });

  assert.equal(second.dir, first.dir);
  assert.equal(second.updated, false);
  assert.equal(second.commit, repo.commit);
});

test("two refs never share a directory", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD }, tag: "v1.0.0" });
  const dir = await cache();

  const onMain = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir });
  const onTag = await ensureCheckout({ url: repo.url, ref: "v1.0.0", cacheDir: dir });

  assert.notEqual(onMain.dir, onTag.dir);
  assert.equal(onTag.commit, repo.commit);
});

test("a tag can be checked out even after the branch moved", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD }, tag: "v1.0.0" });
  const tagged = repo.commit;
  const moved = await commitMore(repo.dir, { "SKILL.md": SKILL_MD.replace("Body", "Body v2") });
  const dir = await cache();

  const checkout = await ensureCheckout({ url: repo.url, ref: "v1.0.0", cacheDir: dir });
  assert.equal(checkout.commit, tagged);
  assert.notEqual(checkout.commit, moved);
});

test("a commit sha can be checked out", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const first = repo.commit;
  await commitMore(repo.dir, { "SKILL.md": SKILL_MD.replace("Body", "Body v2") });
  const dir = await cache();

  const checkout = await ensureCheckout({ url: repo.url, ref: first, cacheDir: dir });
  assert.equal(checkout.commit, first);
});

test("a ref that does not exist is reported, not thrown", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();

  const checkout = await ensureCheckout({ url: repo.url, ref: "nope", cacheDir: dir });
  assert.equal(checkout.commit, "");
  assert.match(checkout.warning ?? "", /clone failed/);
});

test("offline without a cached tree is reported", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();

  const checkout = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir, offline: true });
  assert.equal(checkout.commit, "");
  assert.match(checkout.warning ?? "", /offline/);
});

test("a zero ttl refreshes the cached tree to the new commit", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();

  const first = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir });
  const moved = await commitMore(repo.dir, { "SKILL.md": SKILL_MD.replace("Body", "Body v2") });
  const second = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir, ttlMs: 0 });

  assert.equal(second.dir, first.dir);
  assert.equal(second.commit, moved);
  assert.equal(second.updated, true);
  assert.match(await fs.readFile(path.join(second.dir, "SKILL.md"), "utf8"), /Body v2/);
});

test("a failed refresh keeps the cached tree and warns", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  const dir = await cache();
  const first = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir });

  const remote = new URL(repo.url).pathname;
  await fs.rm(remote, { recursive: true, force: true });

  const second = await ensureCheckout({ url: repo.url, ref: "main", cacheDir: dir, ttlMs: 0 });
  assert.equal(second.commit, first.commit);
  assert.match(second.warning ?? "", /refresh failed/);
  assert.ok(await exists(path.join(second.dir, "SKILL.md")));
});

test("checkoutDir is stable for the same url and ref", () => {
  const left = checkoutDir("/cache", "https://host/a.git", "main");
  const right = checkoutDir("/cache", "https://host/a.git", "main");
  assert.equal(left, right);
  assert.notEqual(left, checkoutDir("/cache", "https://host/a.git", "dev"));
  assert.notEqual(left, checkoutDir("/cache", "https://host/b.git", "main"));
});

test("commitOf reads the tree it is given", async () => {
  const repo = await makeRepo({ files: { "SKILL.md": SKILL_MD } });
  assert.equal(await commitOf(repo.dir), repo.commit);
});

test("a command that does not exist never rejects", async () => {
  const result = await run("definitely-not-a-command", [], { timeoutMs: 5_000 });
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0);
});

test("arguments are never interpreted by a shell", async () => {
  const dir = await tmpdir();
  await git(dir, "init", "--quiet");
  const target = path.join(dir, "a file; touch injected");
  await fs.writeFile(target, "content", "utf8");
  await git(dir, "add", "--all");

  const result = await run("git", ["status", "--porcelain"], { cwd: dir });
  assert.equal(result.code, 0);
  assert.equal(await exists(path.join(dir, "injected")), false);
});