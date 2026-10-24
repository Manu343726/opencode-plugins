/**
 * Test helpers: real git repositories in a temporary directory.
 *
 * The core is tested against git itself rather than a stub, because the
 * interesting failures — a ref that does not exist, a shallow clone of a sha,
 * a tree that moved under the cache — only exist when git is real.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function tmpdir(prefix = "ogs-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

export interface RepoOptions {
  readonly files: Record<string, string>;
  readonly branch?: string;
  readonly tag?: string;
  readonly message?: string;
}

/** Creates a repository with one commit, and optionally a tag. */
export async function makeRepo(options: RepoOptions): Promise<{ dir: string; url: string; commit: string }> {
  const dir = await tmpdir("ogs-repo-");
  const branch = options.branch ?? "main";
  await git(dir, "init", "--quiet", `--initial-branch=${branch}`);
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await writeFiles(dir, options.files);
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "-m", options.message ?? "initial");
  if (options.tag) await git(dir, "tag", options.tag);
  const commit = await git(dir, "rev-parse", "HEAD");
  return { dir, url: `file://${dir}`, commit };
}

/** Adds a commit to an existing repository. */
export async function commitMore(
  dir: string,
  files: Record<string, string>,
  message = "change",
): Promise<string> {
  await writeFiles(dir, files);
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export const SKILL_MD = `---
name: Homelable Docs
description: How to write and maintain the homelab documentation
---

# Homelable Docs

Body of the skill.
`;

export const AGENT_MD = `---
description: Reviews changes for correctness
mode: subagent
---

Reply with exactly: SHARED-REVIEWER
`;