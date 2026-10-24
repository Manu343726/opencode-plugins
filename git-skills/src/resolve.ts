/**
 * Turning the declared options into concrete entries.
 *
 * This is the part that touches the network and the filesystem, kept separate
 * from the OpenCode API so it can be exercised against local repositories.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { discover, findEntry, type Discovery, type Entry } from "./discover.ts";
import { defaultCacheDir, ensureCheckout } from "./git.ts";
import { existingDefinition, listAdopted } from "./adopt.ts";
import { canonicalize, splitFrontmatter } from "./provenance.ts";
import { SpecError, formatSpec, parseReference, type Kind, type Spec } from "./ref.ts";
import { parseItems, toItem, type Item, type ItemInput } from "./items.ts";

export interface Options {
  readonly skills?: readonly ItemInput[];
  readonly agents?: readonly ItemInput[];
  readonly repos?: readonly string[];
  readonly cacheDir?: string;
  readonly ttlMinutes?: number;
  readonly offline?: boolean;
  readonly globalConfigDir?: string;
  /** Web root of the forge, for the compare URL and the pull request API. */
  readonly apiBase?: string;
  /** Token for the forge API; without it a proposal pushes a branch only. */
  readonly token?: string;
}

export interface Repository {
  readonly url: string;
  readonly ref: string;
  readonly dir: string;
  readonly commit: string;
  readonly warning?: string;
  readonly entries: readonly Entry[];
}

export interface Resolved {
  readonly spec: Spec;
  readonly entry: Entry;
  readonly commit: string;
  /** Absolute path of the checkout the entry lives in. */
  readonly checkout: string;
  /** Canonical text of the entry document, provenance excluded. */
  readonly document: string;
  /** Everything after the frontmatter. */
  readonly body: string;
}

export interface Skipped {
  readonly spec: Spec;
  readonly reason: "already-adopted" | "defined-in-project" | "disabled";
  readonly detail: string;
}

export interface Resolution {
  readonly entries: readonly Resolved[];
  readonly repositories: readonly Repository[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly skipped: readonly Skipped[];
}

interface Tagged {
  readonly kind: Kind;
  readonly spec: Spec;
  readonly enabled: boolean;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Reads the raw options into lists, reporting anything malformed. */
export function readOptions(raw: Readonly<Record<string, unknown>>): {
  options: Options;
  problems: string[];
} {
  const problems: string[] = [];
  const cacheDir = raw.cacheDir;
  const ttl = raw.ttlMinutes;
  if (cacheDir !== undefined && typeof cacheDir !== "string") {
    problems.push("options.cacheDir must be a string");
  }
  if (ttl !== undefined && typeof ttl !== "number") {
    problems.push("options.ttlMinutes must be a number");
  }
  if (raw.apiBase !== undefined && typeof raw.apiBase !== "string") {
    problems.push("options.apiBase must be a string");
  }
  return {
    options: {
      skills: parsed(raw.skills, "skills", problems),
      agents: parsed(raw.agents, "agents", problems),
      repos: stringList(raw.repos),
      cacheDir: typeof cacheDir === "string" ? cacheDir : undefined,
      ttlMinutes: typeof ttl === "number" ? ttl : undefined,
      offline: raw.offline === true,
      globalConfigDir: typeof raw.globalConfigDir === "string" ? raw.globalConfigDir : undefined,
      apiBase: typeof raw.apiBase === "string" ? raw.apiBase : undefined,
      token:
        typeof raw.token === "string" && raw.token !== ""
          ? raw.token
          : (process.env.GIT_SKILLS_TOKEN ?? process.env.FORGEJO_TOKEN),
    },
    problems,
  };
}

function parsed(value: unknown, key: string, problems: string[]): readonly Item[] {
  const { items, problems: itemProblems } = parseItems(value);
  for (const problem of itemProblems) problems.push(`options.${key}: ${problem}`);
  return items;
}

function parseAll(kind: Kind, values: readonly Item[], problems: string[]): Tagged[] {
  const tagged: Tagged[] = [];
  const key = kind === "skill" ? "skills" : "agents";
  for (const item of values) {
    try {
      const spec = parseReference(kind, item.reference);
      tagged.push({ kind, spec, enabled: item.enabled });
    } catch (error) {
      const message = error instanceof SpecError ? error.message : String(error);
      problems.push(`options.${key}: ${message}`);
    }
  }
  return tagged;
}

/**
 * Resolves every declared reference against its repository.
 *
 * A repository is cloned only when a reference needs it: `repos[]` exists for
 * browsing, and cloning ten repositories at startup because ten are listed
 * would make every session slower for nothing.
 */
export async function resolve(projectDir: string, raw: Options): Promise<Resolution> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const skipped: Skipped[] = [];

  const tagged = [
    ...parseAll("skill", (raw.skills ?? []).map(toItem), problems),
    ...parseAll("agent", (raw.agents ?? []).map(toItem), problems),
  ];



  const cacheDir = raw.cacheDir ?? defaultCacheDir();
  const ttlMs = (raw.ttlMinutes ?? 5) * 60_000;

  // Only the enabled references need a checkout: a disabled one is listed in
  // the configuration, not loaded, so cloning it would be work for nothing.
  const wanted = new Map<string, { url: string; ref: string }>();
  for (const { spec, enabled } of tagged) {
    if (!enabled) continue;
    wanted.set(`${spec.url}\0${spec.ref}`, { url: spec.url, ref: spec.ref });
  }

  const checkouts = new Map<string, Repository>();
  await Promise.all(
    [...wanted.entries()].map(async ([key, { url, ref }]) => {
      const checkout = await ensureCheckout({ url, ref, cacheDir, ttlMs, offline: raw.offline });
      if (checkout.warning) warnings.push(`${url}@${ref}: ${checkout.warning}`);
      if (checkout.commit === "") {
        checkouts.set(key, { url, ref, dir: checkout.dir, commit: "", entries: [] });
        return;
      }
      const discovery: Discovery = await discover(checkout.dir);
      for (const problem of discovery.problems) warnings.push(`${url}@${ref}: ${problem}`);
      checkouts.set(key, {
        url,
        ref,
        dir: checkout.dir,
        commit: checkout.commit,
        entries: discovery.entries,
      });
    }),
  );

  const adopted = await listAdopted(projectDir);
  const adoptedKeys = new Set(adopted.map((item) => `${item.kind}:${item.id}`));

  const entries: Resolved[] = [];

  for (const { kind, spec, enabled } of tagged) {
    const repository = checkouts.get(`${spec.url}\0${spec.ref}`);
    const label = formatSpec(spec);

    if (!enabled) {
      skipped.push({ spec, reason: "disabled", detail: label });
      continue;
    }


    if (!repository || repository.commit === "") {
      problems.push(`${label}: repository is not available`);
      continue;
    }

    const entry = findEntry({ entries: repository.entries, problems: [] }, kind, spec.id);
    if (!entry) {
      const available = repository.entries
        .filter((candidate) => candidate.kind === kind)
        .map((candidate) => candidate.id);
      problems.push(
        available.length === 0
          ? `${label}: the repository has no ${kind} "${spec.id}" (it has none of that kind)`
          : `${label}: the repository has no ${kind} "${spec.id}" (available: ${available.join(", ")})`,
      );
      continue;
    }

    if (adoptedKeys.has(`${kind}:${spec.id}`)) {
      const relative = kind === "skill" ? ".agents/skills" : ".opencode/agents";
      skipped.push({
        spec,
        reason: "already-adopted",
        detail: `${relative}/${spec.id}`,
      });
      continue;
    }

    const onDisk = await existingDefinition(projectDir, kind, spec.id, raw.globalConfigDir);
    if (onDisk) {
      skipped.push({ spec, reason: "defined-in-project", detail: onDisk });
      continue;
    }

    const target = kind === "skill" ? path.join(entry.path, "SKILL.md") : entry.path;
    const text = await fs.readFile(target, "utf8");
    const { body } = splitFrontmatter(text);
    entries.push({
      spec,
      entry,
      commit: repository.commit,
      checkout: repository.dir,
      document: canonicalize(text),
      body,
    });
  }

  return {
    entries,
    repositories: [...checkouts.values()],
    problems,
    warnings,
    skipped,
  };
}

/** A one-line summary of a resolution, for logs and the status tool. */
export function summarize(resolution: Resolution): string {
  const lines: string[] = [];
  const skills = resolution.entries.filter((entry) => entry.entry.kind === "skill");
  const agents = resolution.entries.filter((entry) => entry.entry.kind === "agent");
  lines.push(`${skills.length} skill(s), ${agents.length} agent(s) from ${resolution.repositories.length} repository/ies`);
  for (const entry of resolution.entries) {
    lines.push(`  ${entry.entry.kind} ${entry.spec.id} @ ${entry.commit.slice(0, 8)}`);
  }
  for (const item of resolution.skipped) {
    lines.push(`  skipped ${item.spec.id} (${item.reason}: ${item.detail})`);
  }
  for (const warning of resolution.warnings) lines.push(`  warning: ${warning}`);
  for (const problem of resolution.problems) lines.push(`  problem: ${problem}`);
  return lines.join("\n");
}