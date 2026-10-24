/**
 * Adopted entries: their on-disk locations, how they are written, and what
 * their state is against the repository they came from.
 *
 * An adopted entry is a plain copy in the standard layout — a skill under
 * `.agents/skills/<id>/`, an agent at `.opencode/agents/<id>.md` — plus the
 * provenance block in its frontmatter. It is the project's file from that
 * moment on, which is why the plugin stops registering the remote version of
 * that id and lets the copy be the single definition the model sees.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Entry } from "./discover.ts";
import type { Kind, Spec } from "./ref.ts";
import { formatSpec } from "./ref.ts";
import {
  PROVENANCE_KEY,
  canonicalize,
  digestEntry,
  digestFile,
  listFiles,
  readProvenance,
  splitFrontmatter,
  withProvenance,
  type Provenance,
} from "./provenance.ts";

export type State =
  | "in-sync"
  | "update-available"
  | "local-changes"
  | "both"
  | "missing-in-repo";

export const STATE_LABEL: Readonly<Record<State, string>> = {
  "in-sync": "✓ in sync",
  "update-available": "↑ update available",
  "local-changes": "✎ local changes",
  both: "⚠ local changes + update",
  "missing-in-repo": "✗ gone from the repo",
};

export interface Adopted {
  readonly kind: Kind;
  readonly id: string;
  readonly path: string;
  readonly provenance: Provenance;
}

export interface Snapshot {
  readonly adopted: Adopted;
  readonly state: State;
  /** Digest of what is on disk now, provenance excluded. */
  readonly localDigest: string;
  /** Digest of the entry at the ref, when the caller could read it. */
  readonly remoteDigest?: string;
}

/** Where an adopted skill lives. */
export function skillPath(projectDir: string, id: string): string {
  return path.join(projectDir, ".agents", "skills", id);
}

/** Where an adopted agent lives. */
export function agentPath(projectDir: string, id: string): string {
  return path.join(projectDir, ".opencode", "agents", `${id}.md`);
}

export function destination(projectDir: string, kind: Kind, id: string): string {
  return kind === "skill" ? skillPath(projectDir, id) : agentPath(projectDir, id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  const files = await listFiles(source);
  for (const relative of files) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    const stat = await fs.stat(from);
    await fs.chmod(to, stat.mode & 0o777);
  }
}

/**
 * Writes an entry into the project with its provenance block.
 *
 * The digest is computed from the **source** before anything is written: the
 * copy is then, by construction, "in sync" with the commit it was taken from.
 */
export async function adoptEntry(options: {
  readonly entry: Entry;
  readonly projectDir: string;
  readonly spec: Spec;
  readonly commit: string;
}): Promise<Adopted> {
  const { entry, projectDir, spec, commit } = options;
  const target = destination(projectDir, entry.kind, entry.id);
  const reference = formatSpec(spec);

  if (entry.kind === "skill") {
    const sourceFile = path.join(entry.path, "SKILL.md");
    const digest = await digestEntry(entry.path, "SKILL.md");
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await copyTree(entry.path, target);
    const text = await fs.readFile(sourceFile, "utf8");
    await fs.writeFile(
      path.join(target, "SKILL.md"),
      withProvenance(text, { id: reference, commit, digest }),
      "utf8",
    );
    return {
      kind: "skill",
      id: entry.id,
      path: target,
      provenance: { id: reference, commit, digest },
    };
  }

  const digest = await digestFile(entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const text = await fs.readFile(entry.path, "utf8");
  await fs.writeFile(target, withProvenance(text, { id: reference, commit, digest }), "utf8");
  return { kind: "agent", id: entry.id, path: target, provenance: { id: reference, commit, digest } };
}

/** Removes an adopted entry from the project. */
export async function removeAdopted(adopted: Adopted): Promise<void> {
  if (adopted.kind === "skill") {
    await fs.rm(adopted.path, { recursive: true, force: true });
  } else {
    await fs.rm(adopted.path, { force: true });
  }
}

async function adoptedAt(kind: Kind, id: string, file: string): Promise<Adopted | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const provenance = readProvenance(text);
  if (!provenance) return undefined;
  // A skill is its directory — it has neighbouring files that belong to it. An
  // agent is a single file, and pointing at its parent directory instead would
  // make `remove` delete every agent in the project.
  const target = kind === "skill" ? path.dirname(file) : file;
  return { kind, id, path: target, provenance };
}

/** Lists every adopted entry in a project, from disk. */
export async function listAdopted(projectDir: string): Promise<Adopted[]> {
  const found: Adopted[] = [];

  const skillsRoot = path.join(projectDir, ".agents", "skills");
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(skillsRoot, entry.name, "SKILL.md");
      const adopted = await adoptedAt("skill", entry.name, file);
      if (adopted) found.push(adopted);
    }
  } catch {
    // no adopted skills
  }

  const agentsRoot = path.join(projectDir, ".opencode", "agents");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const id = relative.slice(0, -3);
        const adopted = await adoptedAt("agent", id, absolute);
        if (adopted) found.push(adopted);
      }
    }
  };
  await walk(agentsRoot, "");

  return found.sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "skill" ? -1 : 1,
  );
}

/** Digest of an adopted entry as it is right now. */
export async function localDigest(adopted: Adopted): Promise<string> {
  if (adopted.kind === "skill") return digestEntry(adopted.path, "SKILL.md");
  return digestFile(adopted.path);
}

/**
 * Compares an adopted entry with its repository.
 *
 * The comparison is by **content**, not by commit: an entry only reports an
 * update when its own files differ from what the ref holds now. Comparing
 * commits would flag every adopted entry whenever anything else in the
 * repository changed, which is noise — measured on a repository where one
 * skill's edit marked three unrelated entries as updatable.
 *
 * When `remote` is absent the caller could not read the checkout, and only
 * local drift is reported.
 */
export async function snapshot(adopted: Adopted, remote?: string): Promise<Snapshot> {
  const digest = await localDigest(adopted);
  const localChanged = digest !== adopted.provenance.digest;
  const remoteChanged = remote !== undefined && remote !== "" && remote !== adopted.provenance.digest;

  let state: State;
  if (localChanged && remoteChanged) state = "both";
  else if (localChanged) state = "local-changes";
  else if (remoteChanged) state = "update-available";
  else state = "in-sync";

  return { adopted, state, localDigest: digest, remoteDigest: remote };
}

/** The digest an entry has at the ref right now, from its checkout. */
export async function remoteDigest(entry: { kind: Kind; path: string }): Promise<string> {
  return entry.kind === "skill" ? digestEntry(entry.path, "SKILL.md") : digestFile(entry.path);
}

/**
 * Whether the project already defines this id by hand, outside our convention.
 *
 * A hand-written definition always wins over the remote one: the project owner
 * wrote it, and silently shadowing or overriding it would be the kind of
 * surprise this plugin exists to avoid.
 */
export async function existingDefinition(
  projectDir: string,
  kind: Kind,
  id: string,
  globalConfigDir?: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (kind === "skill") {
    for (const root of [".agents/skills", ".opencode/skills", ".claude/skills"]) {
      candidates.push(path.join(projectDir, root, id, "SKILL.md"));
    }
    if (globalConfigDir) candidates.push(path.join(globalConfigDir, "skills", id, "SKILL.md"));
  } else {
    candidates.push(path.join(projectDir, ".opencode", "agents", `${id}.md`));
    candidates.push(path.join(projectDir, ".claude", "agents", `${id}.md`));
    if (globalConfigDir) candidates.push(path.join(globalConfigDir, "agents", `${id}.md`));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** Reads a definition's text and returns it without the provenance block. */
export async function definitionText(file: string): Promise<string> {
  const text = await fs.readFile(file, "utf8");
  return canonicalize(text);
}

export { PROVENANCE_KEY, splitFrontmatter };
