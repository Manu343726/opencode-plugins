/**
 * Git access for the plugin.
 *
 * Every command goes through `spawn` with an argument array and `shell: false`,
 * so a url or a ref can never turn into a second command. Nothing here touches
 * the project itself: checkouts live under the cache directory, one per
 * url+ref pair, so two projects pinned to different refs never share a tree.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs a command and never rejects on a non-zero exit: callers decide what a
 * failure means, and the stderr is what they report.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code: number | null) => {
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

export function defaultCacheDir(): string {
  const override = process.env.OPENCODE_GIT_SKILLS_CACHE;
  if (override && override.trim() !== "") return override;
  return path.join(os.homedir(), ".cache", "opencode", "git-skills");
}

function hash(text: string, length = 32): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** Where one url+ref pair is checked out. Ref names may contain `/`, hence a hash. */
export function checkoutDir(cacheDir: string, url: string, ref: string): string {
  return path.join(cacheDir, hash(url), hash(ref, 16));
}

export interface Checkout {
  readonly dir: string;
  /** The commit the working tree is at. Empty when git could not be read. */
  readonly commit: string;
  /** True when the tree came from the network during this call. */
  readonly updated: boolean;
  /** Set when a refresh was attempted and failed; the cached tree is still usable. */
  readonly warning?: string;
}

export interface EnsureOptions {
  readonly url: string;
  readonly ref: string;
  readonly cacheDir?: string;
  /** How long a cached tree is trusted before a refresh is attempted. */
  readonly ttlMs?: number;
  /** Skip the network entirely and use whatever is cached. */
  readonly offline?: boolean;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function head(dir: string): Promise<string> {
  const result = await run("git", ["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 15_000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

/**
 * Clones into a temporary sibling and renames on success, so an interrupted
 * clone leaves no half-tree behind that later looks like a valid checkout.
 */
async function cloneFresh(url: string, ref: string, dir: string): Promise<RunResult> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(tmp, { recursive: true, force: true });

  let result = await run(
    "git",
    ["clone", "--depth", "1", "--single-branch", "--branch", ref, "--", url, tmp],
    { timeoutMs: 120_000 },
  );

  if (result.code !== 0) {
    // `--branch` rejects a commit sha and some ref spellings. The portable
    // fallback is an explicit init+fetch, which also works for a sha.
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });
    const steps: Array<[string, string[]]> = [
      ["init", ["init", "--quiet"]],
      ["remote", ["remote", "add", "origin", url]],
      ["fetch", ["fetch", "--depth", "1", "origin", ref]],
      ["checkout", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]],
    ];
    for (const [label, args] of steps) {
      const step = await run("git", args, { cwd: tmp, timeoutMs: 120_000 });
      if (step.code !== 0) {
        await fs.rm(tmp, { recursive: true, force: true });
        return { code: step.code, stdout: step.stdout, stderr: `${label}: ${step.stderr}` };
      }
    }
    result = { code: 0, stdout: "", stderr: "" };
  }

  await fs.rename(tmp, dir);
  return result;
}

async function fetchedAt(dir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(dir, ".fetched-at"), "utf8");
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Returns a checkout for url+ref, cloning or refreshing as needed.
 *
 * A failed refresh is never fatal: the cached tree is returned with a warning,
 * because losing the network must not leave a project without its skills.
 */
export async function ensureCheckout(options: EnsureOptions): Promise<Checkout> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const dir = checkoutDir(cacheDir, options.url, options.ref);

  const present = await exists(path.join(dir, ".git"));
  if (!present) {
    if (options.offline) {
      return { dir, commit: "", updated: false, warning: "not cached and offline mode is on" };
    }
    const clone = await cloneFresh(options.url, options.ref, dir);
    if (clone.code !== 0) {
      return {
        dir,
        commit: "",
        updated: false,
        warning: `clone failed: ${firstLine(clone.stderr)}`,
      };
    }
    await fs.writeFile(path.join(dir, ".fetched-at"), String(Date.now()), "utf8");
    return { dir, commit: await head(dir), updated: true };
  }

  const commitBefore = await head(dir);
  if (options.offline) return { dir, commit: commitBefore, updated: false };

  const age = Date.now() - (await fetchedAt(dir));
  if (age < ttlMs) return { dir, commit: commitBefore, updated: false };

  const fetched = await run("git", ["fetch", "--depth", "1", "origin", options.ref], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  if (fetched.code !== 0) {
    return {
      dir,
      commit: commitBefore,
      updated: false,
      warning: `refresh failed, using the cached tree: ${firstLine(fetched.stderr)}`,
    };
  }

  const reset = await run("git", ["reset", "--hard", "--quiet", "FETCH_HEAD"], { cwd: dir });
  if (reset.code !== 0) {
    return {
      dir,
      commit: commitBefore,
      updated: false,
      warning: `refresh failed, using the cached tree: ${firstLine(reset.stderr)}`,
    };
  }

  await fs.writeFile(path.join(dir, ".fetched-at"), String(Date.now()), "utf8");
  return { dir, commit: await head(dir), updated: true };
}

/** The commit a ref currently points at, read from an existing checkout. */
export async function commitOf(dir: string): Promise<string> {
  return head(dir);
}

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line ?? "(no output)";
}
