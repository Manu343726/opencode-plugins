/**
 * Proposing an adopted copy's local changes back to its repository.
 *
 * An adopted entry is the project's file: it can be edited freely, and the
 * provenance records where it came from. This takes those edits, puts them on a
 * branch of the *source* repository, and opens a pull request against the ref
 * the entry was adopted from.
 *
 * The push goes through the checkout's own remote, so it uses whatever the
 * machine already uses to reach the repository. Opening the pull request needs
 * the forge's API and a token; without one, the branch is pushed and the compare
 * URL is returned, which is the same work minus the click.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { listAdopted, localDigest, type Adopted } from "./adopt.ts";
import { discover, findEntry } from "./discover.ts";
import { ensureCheckout, run } from "./git.ts";
import { readProvenance } from "./provenance.ts";
import { parseSpec, type Kind } from "./ref.ts";

export interface ProposeOptions {
  readonly projectDir: string;
  /** Which adopted copy to propose. */
  readonly kind: Kind;
  readonly id: string;
  /** Title of the pull request, and of the commit. */
  readonly title: string;
  /** Why the change is wanted, in the proposer's words. */
  readonly motivation?: string;
  /** Extra detail to include verbatim. */
  readonly details?: string;
  /** Base URL of the forge's API, e.g. `https://git.example.com`. */
  readonly apiBase?: string;
  /** Token for the forge's API. Without it, the branch is pushed and no PR is opened. */
  readonly token?: string;
  readonly author?: { readonly name: string; readonly email: string };
  /** Branch name; derived from the entry when absent. */
  readonly branch?: string;
}

export interface Proposal {
  readonly branch: string;
  readonly commit: string;
  readonly files: readonly string[];
  /** True when the branch exists on the remote. */
  readonly pushed: boolean;
  /** URL a human can open to create the pull request themselves. */
  readonly compareUrl?: string;
  /** The pull request, when a token was available. */
  readonly pullRequestUrl?: string;
  /** Anything that went wrong after the push, so the caller can report it. */
  readonly warnings: readonly string[];
}

export class ProposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposeError";
  }
}

/** `owner/repo` from any git url shape this plugin accepts. */
export function repositoryOf(url: string): { owner: string; repo: string } | undefined {
  const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");

  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(cleaned);
  const pathPart = scp ? scp[1] : cleaned.replace(/^[a-z+]+:\/\/[^/]+\//i, "");

  const parts = (pathPart ?? "").split("/").filter((part) => part !== "");
  if (parts.length < 2) return undefined;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/** A branch name that says what it is and who asked for it. */
export function branchName(kind: Kind, id: string, now: number): string {
  const slug = `${kind}-${id}`.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `propose/${slug}-${stamp}`;
}

/** The pull request body: why, what changed, and where it came from. */
export function composeBody(input: {
  readonly kind: Kind;
  readonly id: string;
  readonly title: string;
  readonly motivation?: string;
  readonly details?: string;
  readonly files: readonly string[];
  readonly stat: string;
  readonly reference: string;
}): string {
  const lines = [
    input.motivation?.trim() ? input.motivation.trim() : input.title,
    "",
    `This proposes the local changes of the adopted ${input.kind} \`${input.id}\` back to the`,
    "repository it was adopted from.",
    "",
    "## What changed",
    "",
    "```",
    input.stat.trim() || "(no diff)",
    "```",
    "",
    ...(input.files.length > 0
      ? ["Files:", "", ...input.files.map((file) => `- \`${file}\``), ""]
      : []),
    ...(input.details?.trim() ? ["## Details", "", input.details.trim(), ""] : []),
    "## Where it came from",
    "",
    `Adopted from \`${input.reference}\`.`,
    "",
    "---",
    "",
    "Opened from the project that adopted it, through opencode-git-skills.",
  ];
  return lines.join("\n");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run("git", args, { cwd, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new ProposeError(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

async function copyEntryFiles(source: Adopted, destinationRoot: string): Promise<string[]> {
  // The adopted copy is the source of truth: whatever is on disk now.
  const absolute = source.path;
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) {
    const name = path.basename(absolute);
    await fs.writeFile(path.join(destinationRoot, name), await fs.readFile(absolute));
    return [name];
  }

  const written: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(from, relative);
        continue;
      }
      const to = path.join(destinationRoot, relative);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, await fs.readFile(from));
      written.push(relative);
    }
  };
  await walk(absolute, "");
  return written;
}

/**
 * Pushes the adopted copy's changes to a branch of its repository and, when a
 * token is given, opens the pull request.
 *
 * The entry is located again in the checkout to learn its path inside the
 * repository — the provenance records the reference, not the layout — so a
 * library that moves its files keeps working.
 */
export async function proposeChange(options: ProposeOptions): Promise<Proposal> {
  const adopted = (await listAdopted(options.projectDir)).find(
    (item) => item.kind === options.kind && item.id === options.id,
  );
  if (!adopted) {
    throw new ProposeError(`${options.kind} ${options.id} is not adopted in this project`);
  }

  const digest = await localDigest(adopted);
  if (digest === adopted.provenance.digest) {
    throw new ProposeError(
      `${options.kind} ${options.id} has no local changes to propose`,
    );
  }

  const spec = parseSpec(adopted.provenance.id);
  const checkout = await ensureCheckout({ url: spec.url, ref: spec.ref, ttlMs: 0 });
  if (checkout.commit === "") {
    throw new ProposeError(`${spec.url} is not reachable`);
  }

  const discovery = await discover(checkout.dir);
  const entry = findEntry({ entries: discovery.entries, problems: [] }, options.kind, options.id);
  if (!entry) {
    throw new ProposeError(`${options.kind} ${options.id} is no longer in ${spec.url}`);
  }

  const branch = options.branch ?? branchName(options.kind, options.id, Date.now());
  const author = options.author ?? { name: "opencode-git-skills", email: "git-skills@localhost" };

  // A clean branch from the ref the entry came from, so the diff is only ours.
  await git(checkout.dir, "checkout", "--quiet", "--force", "-B", branch, checkout.commit);

  const target = entry.kind === "skill" ? entry.path : path.dirname(entry.path);
  // Only the entry's own files are replaced: the rest of the repository stays as
  // the ref has it.
  const written = await copyEntryFiles(adopted, target);

  await git(checkout.dir, "add", "--all", "--", path.relative(checkout.dir, entry.path) || ".");
  const staged = await git(checkout.dir, "diff", "--cached", "--name-only");
  if (staged.trim() === "") {
    throw new ProposeError(
      `${options.kind} ${options.id} matches the repository: nothing to propose`,
    );
  }

  const stat = await git(checkout.dir, "diff", "--cached", "--stat");
  const body = composeBody({
    kind: options.kind,
    id: options.id,
    title: options.title,
    motivation: options.motivation,
    details: options.details,
    files: written,
    stat,
    reference: adopted.provenance.id,
  });

  await git(
    checkout.dir,
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "--quiet",
    "-m",
    options.title,
    "-m",
    body,
  );
  const commit = (await git(checkout.dir, "rev-parse", "HEAD")).trim();

  const push = await run("git", ["push", "--force", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: checkout.dir,
    timeoutMs: 120_000,
  });
  if (push.code !== 0) {
    throw new ProposeError(`could not push ${branch}: ${push.stderr.trim()}`);
  }

  const warnings: string[] = [];
  const repository = repositoryOf(spec.url);
  const webBase = options.apiBase ?? webBaseOf(spec.url);
  const compareUrl =
    webBase && repository
      ? `${webBase}/${repository.owner}/${repository.repo}/compare/${encodeURIComponent(spec.ref)}...${encodeURIComponent(branch)}`
      : undefined;

  let pullRequestUrl: string | undefined;
  if (options.token && webBase && repository) {
    try {
      pullRequestUrl = await openPullRequest({
        base: webBase,
        token: options.token,
        owner: repository.owner,
        repo: repository.repo,
        head: branch,
        into: spec.ref,
        title: options.title,
        body,
      });
    } catch (error) {
      warnings.push(`the branch was pushed, but the pull request was not opened: ${String(error)}`);
    }
  } else if (!options.token) {
    warnings.push("no token configured: the branch is pushed, the pull request is yours to open");
  }

  return { branch, commit, files: written, pushed: true, compareUrl, pullRequestUrl, warnings };
}

/** The web root of a forge, when the url makes it obvious. */
export function webBaseOf(url: string): string | undefined {
  const https = /^(https?):\/\/([^/]+)\//.exec(url);
  if (https) return `${https[1]}://${https[2]}`;
  return undefined;
}

async function openPullRequest(input: {
  base: string;
  token: string;
  owner: string;
  repo: string;
  head: string;
  into: string;
  title: string;
  body: string;
}): Promise<string> {
  const response = await fetch(
    `${input.base}/api/v1/repos/${input.owner}/${input.repo}/pulls`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `token ${input.token}`,
      },
      body: JSON.stringify({ head: input.head, base: input.into, title: input.title, body: input.body }),
    },
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const created = (await response.json()) as { html_url?: string; url?: string };
  return created.html_url ?? created.url ?? `${input.base}/${input.owner}/${input.repo}/pulls`;
}

/** Reads the provenance of an adopted file without loading the whole list. */
export async function provenanceOf(file: string): Promise<string | undefined> {
  try {
    return readProvenance(await fs.readFile(file, "utf8"))?.id;
  } catch {
    return undefined;
  }
}