/**
 * Discovery inside a checked-out repository.
 *
 * Two conventions, no configuration required:
 *
 *   - a **skill** is any directory holding a `SKILL.md`, and its id is the
 *     directory name. Skills are found anywhere in the tree, because a shared
 *     repo may keep them under `.opencode/skills/`, `skills/` or `.claude/skills/`.
 *   - an **agent** is a Markdown file under `agents/`, `.opencode/agents/`,
 *     `.claude/agents/` or `.agents/agents/`, and its id is its path below that
 *     root without the extension — so `agents/team/reviewer.md` is `team/reviewer`,
 *     which is exactly the id OpenCode gives the same layout in a project.
 *
 * A repository that does not follow either convention can ship a
 * `git-skills.json` at its root and declare both sections explicitly; a
 * declared section replaces the convention for that kind.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Kind } from "./ref.ts";
import { splitFrontmatter, listFiles } from "./provenance.ts";

export interface Entry {
  readonly kind: Kind;
  readonly id: string;
  /** The skill directory, or the agent file. */
  readonly path: string;
  /** File relative paths for a skill, or the single file name for an agent. */
  readonly files: readonly string[];
  readonly description?: string;
  /** Repository-relative path, for messages. */
  readonly origin: string;
}

export interface Discovery {
  readonly entries: readonly Entry[];
  /** Problems worth showing, never thrown: one bad entry must not hide the rest. */
  readonly problems: readonly string[];
}

// Ordered so the standard tree is read first: when `.opencode/agents` is a
// symlink to `.agents/agents` — the arrangement a project needs because
// OpenCode only discovers agents from the former — both roots resolve to the
// same directory, and the first one wins.
const AGENT_ROOTS = ["agents", ".agents/agents", ".opencode/agents", ".claude/agents"];
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".venv", "dist", "build"]);

export const MANIFEST = "git-skills.json";

interface Manifest {
  readonly skills?: Record<string, string>;
  readonly agents?: Record<string, string>;
  readonly repos?: readonly string[];
}

async function readManifest(root: string): Promise<Manifest | undefined> {
  try {
    const text = await fs.readFile(path.join(root, MANIFEST), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Manifest;
  } catch {
    return undefined;
  }
}

async function descriptionOf(file: string): Promise<string | undefined> {
  try {
    const { data } = splitFrontmatter(await fs.readFile(file, "utf8"));
    const value = data.description;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function findSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (names.has("SKILL.md") && dir !== root) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name));
    }
  };
  await walk(root);
  return found.sort();
}

/** Discovers both kinds in one pass over a checkout. */
export async function discover(root: string): Promise<Discovery> {
  const problems: string[] = [];
  const manifest = await readManifest(root);
  const entries: Entry[] = [];
  const seen = new Map<string, string>();

  const claim = (kind: Kind, id: string, origin: string): boolean => {
    const key = `${kind}:${id}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      problems.push(`${kind} id "${id}" is declared twice (${previous} and ${origin}); keeping the first`);
      return false;
    }
    seen.set(key, origin);
    return true;
  };

  if (manifest?.skills) {
    for (const [id, relative] of Object.entries(manifest.skills)) {
      const dir = path.join(root, relative);
      const file = path.join(dir, "SKILL.md");
      try {
        await fs.stat(file);
      } catch {
        problems.push(`git-skills.json lists skill "${id}" at "${relative}", which has no SKILL.md`);
        continue;
      }
      if (!claim("skill", id, relative)) continue;
      entries.push({
        kind: "skill",
        id,
        path: dir,
        files: await listFiles(dir),
        description: await descriptionOf(file),
        origin: relative,
      });
    }
  } else {
    const dirs = await findSkillDirs(root);
    for (const dir of dirs) {
      const id = path.basename(dir);
      const relative = path.relative(root, dir).split(path.sep).join("/");
      if (!claim("skill", id, relative)) continue;
      entries.push({
        kind: "skill",
        id,
        path: dir,
        files: await listFiles(dir),
        description: await descriptionOf(path.join(dir, "SKILL.md")),
        origin: relative,
      });
    }
  }

  if (manifest?.agents) {
    for (const [id, relative] of Object.entries(manifest.agents)) {
      const file = path.join(root, relative);
      try {
        await fs.stat(file);
      } catch {
        problems.push(`git-skills.json lists agent "${id}" at "${relative}", which does not exist`);
        continue;
      }
      if (!claim("agent", id, relative)) continue;
      entries.push({
        kind: "agent",
        id,
        path: file,
        files: [path.basename(file)],
        description: await descriptionOf(file),
        origin: relative,
      });
    }
  } else {
    // A root may be a symlink to another root; scanning both would report
    // every agent twice, so roots are deduplicated by their real path.
    const seenRoots = new Set<string>();
    for (const agentRoot of AGENT_ROOTS) {
      const absoluteRoot = path.join(root, agentRoot);
      let real: string;
      try {
        real = await fs.realpath(absoluteRoot);
      } catch {
        continue;
      }
      if (seenRoots.has(real)) continue;
      seenRoots.add(real);

      let files: string[];
      try {
        files = (await listFiles(absoluteRoot)).filter((file) => file.endsWith(".md"));
      } catch {
        continue;
      }
      for (const relative of files.sort()) {
        const id = relative.slice(0, -3);
        const origin = `${agentRoot}/${relative}`;
        if (!claim("agent", id, origin)) continue;
        entries.push({
          kind: "agent",
          id,
          path: path.join(absoluteRoot, relative),
          files: [path.basename(relative)],
          description: await descriptionOf(path.join(absoluteRoot, relative)),
          origin,
        });
      }
    }
  }

  entries.sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "skill" ? -1 : 1,
  );
  return { entries, problems };
}

export function findEntry(discovery: Discovery, kind: Kind, id: string): Entry | undefined {
  return discovery.entries.find((entry) => entry.kind === kind && entry.id === id);
}
