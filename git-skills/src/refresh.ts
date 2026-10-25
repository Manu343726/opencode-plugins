/**
 * Pulling the configured references again, and saying what moved.
 *
 * **One code path pulls.** The pull is `resolve()` — the same function `setup`
 * calls at startup and `status` reports from — and underneath it
 * `git.ts:ensureCheckout`, which is the only place in this plugin that clones or
 * fetches. A refresh is that call with the cache TTL bypassed: the TTL exists so
 * a read does not talk to the network, and a caller who asked for a refresh has
 * already decided to spend it.
 *
 * The browser reaches the same `ensureCheckout` through `scanTargets`, which
 * moved here from the terminal half so that both halves and the tool pull with
 * one implementation instead of two that can disagree.
 *
 * The comparison is pure: it takes the previous snapshot and the new pull and
 * returns what a caller has to be told — which references moved, which entries
 * changed, and which changed fields a *running* session cannot pick up.
 */

import { parseAgent, parseSkillMeta } from "./agentfile.ts";
import { knownTargets, shortLabel, type Target } from "./browse.ts";
import { readLists } from "./config.ts";
import { discover, type Entry } from "./discover.ts";
import { ensureCheckout } from "./git.ts";
import type { Kind } from "./ref.ts";
import { resolve, type Options, type Resolution, type Resolved } from "./resolve.ts";

/** One url+ref pair, as the last pull left it. */
export interface ReferenceState {
  readonly url: string;
  readonly ref: string;
  readonly sha: string;
}

/** What one checkout holds, as the browser and the refresh tool both read it. */
export interface Scan {
  readonly url: string;
  readonly ref: string;
  readonly commit: string;
  readonly entries: readonly Entry[];
  /** True when this call went to the network instead of reading the cache. */
  readonly updated: boolean;
  readonly warning?: string;
}

export interface ScanOptions {
  /** Where checkouts live. Absent, `git.ts` decides, which is what the TUI wants. */
  readonly cacheDir?: string;
  /**
   * Skip the cache TTL. Off by default so the browser's refresh keeps the
   * behaviour it had; on for the tool, where the caller asked for the network.
   */
  readonly force?: boolean;
}

/**
 * Pulls every target and reads what it holds.
 *
 * This is the body the terminal half used to keep to itself
 * (`git-skills/src/tui.ts:scanAll`), moved here unchanged apart from the options
 * parameter: the tool and `/git-skills` must not have two versions of it.
 */
export async function scanTargets(
  targets: readonly Target[],
  options: ScanOptions = {},
): Promise<Scan[]> {
  const scans: Scan[] = [];
  for (const target of targets) {
    const checkout = await ensureCheckout({
      url: target.url,
      ref: target.ref,
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
      ...(options.force === true ? { ttlMs: 0 } : {}),
    });
    if (checkout.commit === "") continue;
    const discovery = await discover(checkout.dir);
    scans.push({
      url: target.url,
      ref: target.ref,
      commit: checkout.commit,
      entries: discovery.entries,
      updated: checkout.updated,
      ...(checkout.warning === undefined ? {} : { warning: checkout.warning }),
    });
  }
  return scans;
}

/** A resolution plus the shas it came from: what the next pull is compared to. */
export interface Snapshot {
  readonly resolution: Resolution;
  readonly references: readonly ReferenceState[];
}

/** The result of a pull, with the scans of the browse-only repositories too. */
export interface Pull extends Snapshot {
  readonly scans: readonly Scan[];
  readonly problems: readonly string[];
}

export function snapshotOf(pull: Snapshot): Snapshot {
  return { resolution: pull.resolution, references: pull.references };
}

/**
 * Resolves every configured reference again, without trusting the cache.
 *
 * The lists are read from disk first, the same way the browser reads them, so a
 * reference added to the configuration since startup is picked up by the refresh
 * instead of waiting for the next session.
 */
export async function pull(projectDir: string, options: Options): Promise<Pull> {
  const lists = await readLists(projectDir);

  const resolution = await resolve(projectDir, {
    ...options,
    skills: lists.skills,
    agents: lists.agents,
    repos: lists.repos,
    // The whole point: `ttlMinutes: 0` makes `ensureCheckout` fetch instead of
    // answering from a checkout it already has.
    ttlMinutes: 0,
  });

  const references: ReferenceState[] = resolution.repositories.map((repository) => ({
    url: repository.url,
    ref: repository.ref,
    sha: repository.commit,
  }));

  // `repos[]` names repositories without naming an entry, so `resolve` never
  // touches it. The project still declared it, and the browser pulls it: the
  // refresh pulls the same set through the same scan.
  const pulled = new Set(references.map((reference) => pair(reference.url, reference.ref)));
  const rest = knownTargets(lists).filter((target) => !pulled.has(pair(target.url, target.ref)));
  const scans = await scanTargets(
    rest,
    options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  );
  for (const scan of scans) references.push({ url: scan.url, ref: scan.ref, sha: scan.commit });

  return { resolution, references, scans, problems: lists.problems };
}

export interface ReferenceReport {
  readonly url: string;
  readonly ref: string;
  /** Empty for a reference no previous pull recorded. */
  readonly oldSha: string;
  readonly newSha: string;
  readonly moved: boolean;
}

export interface EntryChange {
  readonly kind: Kind;
  readonly id: string;
  /** Repository-relative path, for a message a reader can act on. */
  readonly origin: string;
  readonly files: readonly string[];
  readonly oldSha: string;
  readonly newSha: string;
  /** Which fields differ, in the vocabulary of the entry's frontmatter. */
  readonly fields: readonly string[];
}

export interface RemovedEntry {
  readonly kind: Kind;
  readonly id: string;
  readonly sha: string;
}

export interface Deferred {
  readonly kind: Kind;
  readonly id: string;
  readonly fields: readonly string[];
  readonly why: string;
}

export interface Report {
  readonly references: readonly ReferenceReport[];
  readonly changed: readonly EntryChange[];
  readonly added: readonly EntryChange[];
  readonly removed: readonly RemovedEntry[];
  readonly unchanged: number;
  /**
   * Changed fields a running session cannot pick up. Empty is the normal case
   * for a text edit; an agent whose mode or permissions moved lands here.
   */
  readonly deferred: readonly Deferred[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Fields a session resolves when it starts instead of reading on every request.
 *
 * `mode` decides whether the agent can be started and how, and `permissions` is
 * the ordered rule list the permission layer consults — both belong to the agent
 * the session stored. OpenCode does not replace the agent stored on an existing
 * session (the same reason changing `default_agent` leaves a running session
 * alone), so a refresh can re-register them for the next session and no more.
 * Saying otherwise would be the comfortable lie this tool exists to avoid.
 */
const SESSION_ONLY: readonly string[] = ["mode", "permissions"];

const SESSION_WHY =
  "mode and permissions are resolved when a session starts, and OpenCode does not replace " +
  "the agent stored on a running session: start a new session to run under them";

export function hasChanges(report: Report): boolean {
  return (
    report.changed.length > 0 ||
    report.added.length > 0 ||
    report.removed.length > 0 ||
    report.references.some((reference) => reference.moved)
  );
}

/**
 * Whether the reload has anything to do.
 *
 * A sha that moved without changing an entry is a commit somewhere else in the
 * repository: there is new text to load only when an entry's document differs.
 * Reloading on a bare sha change would rebuild both registries for nothing.
 */
export function hasEntryChanges(report: Report): boolean {
  return report.changed.length > 0 || report.added.length > 0 || report.removed.length > 0;
}

/** Which fields of one entry differ between two versions of its document. */
function fieldsChanged(kind: Kind, id: string, before: string, after: string): string[] {
  const fields: string[] = [];

  if (kind === "skill") {
    const previous = parseSkillMeta(before, id);
    const next = parseSkillMeta(after, id);
    if (previous.name !== next.name) fields.push("name");
    if (previous.description !== next.description) fields.push("description");
    if (previous.body !== next.body) fields.push("content");
    return fields;
  }

  const previous = parseAgent(before, id).fields;
  const next = parseAgent(after, id).fields;
  if (previous.name !== next.name) fields.push("name");
  if (previous.description !== next.description) fields.push("description");
  if (previous.mode !== next.mode) fields.push("mode");
  if (previous.system !== next.system) fields.push("content");
  if (previous.hidden !== next.hidden) fields.push("hidden");
  if (previous.color !== next.color) fields.push("color");
  if (previous.steps !== next.steps) fields.push("steps");
  if (stable(previous.permissions) !== stable(next.permissions)) fields.push("permissions");
  if (stable(previous.model) !== stable(next.model)) fields.push("model");
  return fields;
}

/** Field-by-field equality for the parsed values, which are plain JSON shapes. */
function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function pair(url: string, ref: string): string {
  return `${url}\0${ref}`;
}

export function compareReferences(
  previous: readonly ReferenceState[],
  next: readonly ReferenceState[],
): ReferenceReport[] {
  const before = new Map<string, string>(
    previous.map((reference) => [pair(reference.url, reference.ref), reference.sha] as const),
  );
  return next.map((reference) => {
    const oldSha = before.get(pair(reference.url, reference.ref)) ?? "";
    return {
      url: reference.url,
      ref: reference.ref,
      oldSha,
      newSha: reference.sha,
      moved: oldSha !== "" && reference.sha !== "" && oldSha !== reference.sha,
    };
  });
}

/**
 * What a refresh has to report.
 *
 * `before` is the snapshot the session started from — or the last refresh — and
 * `undefined` on a first pull, where everything is an addition.
 */
export function compare(before: Snapshot | undefined, after: Pull): Report {
  const previousEntries = new Map<string, Resolved>();
  for (const entry of before?.resolution.entries ?? []) {
    previousEntries.set(`${entry.entry.kind}:${entry.spec.id}`, entry);
  }

  const changed: EntryChange[] = [];
  const added: EntryChange[] = [];
  const deferred: Deferred[] = [];
  let unchanged = 0;

  const seen = new Set<string>();
  for (const entry of after.resolution.entries) {
    const identity = `${entry.entry.kind}:${entry.spec.id}`;
    seen.add(identity);
    const previous = previousEntries.get(identity);
    const fields = previous
      ? fieldsChanged(entry.entry.kind, entry.spec.id, previous.document, entry.document)
      : ["new"];

    const change: EntryChange = {
      kind: entry.entry.kind,
      id: entry.spec.id,
      origin: entry.entry.origin,
      files: entry.entry.files,
      oldSha: previous?.commit ?? "",
      newSha: entry.commit,
      fields,
    };

    if (previous === undefined) {
      added.push(change);
      continue;
    }
    if (fields.length === 0) {
      unchanged += 1;
      continue;
    }

    changed.push(change);
    const sessionOnly = fields.filter((field) => SESSION_ONLY.includes(field));
    if (entry.entry.kind === "agent" && sessionOnly.length > 0) {
      deferred.push({ kind: "agent", id: entry.spec.id, fields: sessionOnly, why: SESSION_WHY });
    }
  }

  const removed: RemovedEntry[] = [];
  for (const [identity, entry] of previousEntries) {
    if (seen.has(identity)) continue;
    removed.push({ kind: entry.entry.kind, id: entry.spec.id, sha: entry.commit });
  }

  return {
    references: compareReferences(before?.references ?? [], after.references),
    changed,
    added,
    removed,
    unchanged,
    deferred,
    problems: [...after.resolution.problems, ...after.problems],
    warnings: [
      ...after.resolution.warnings,
      ...after.scans.flatMap((scan) => (scan.warning === undefined ? [] : [scan.warning])),
    ].filter((warning): warning is string => typeof warning === "string" && warning.trim() !== ""),
  };
}

function shortSha(sha: string): string {
  return sha === "" ? "unknown" : sha.slice(0, 8);
}

/**
 * Where the entry came from, as one path a reader can open.
 *
 * `Entry.origin` is the repository-relative path — `agents/reviewer.md`, or the
 * directory that holds a skill's `SKILL.md`. `files` is what adopting copies,
 * and for an agent it is only the basename: `reviewer.md` names nothing on its
 * own the moment a skill and an agent share it. Origin comes first and `files`
 * is the fallback for an entry that somehow has none, which is not a case
 * `discover` produces today.
 */
function where(entry: { readonly origin: string; readonly files: readonly string[] }): string {
  const origin = entry.origin.trim();
  return origin === "" ? entry.files.join(", ") : origin;
}

/**
 * The report as text: what moved, what changed, and what a running session will
 * not see. `notes` is where the caller adds what only it can know — whether the
 * rebuilt registry actually holds the new text.
 */
export function format(report: Report, notes: readonly string[] = []): string {
  const lines: string[] = [];
  const moved = report.references.filter((reference) => reference.moved);

  lines.push(
    hasChanges(report)
      ? `Refresh: ${moved.length} reference(s) moved, ${report.changed.length} changed, ${report.added.length} added, ${report.removed.length} removed.`
      : `Refresh: no change — ${report.references.length} reference(s) at the same commit, ${report.unchanged} entry(ies) unchanged.`,
  );

  if (report.references.length > 0) {
    lines.push("references:");
    for (const reference of report.references) {
      const label = shortLabel(reference);
      lines.push(
        reference.moved
          ? `  ${label}: ${shortSha(reference.oldSha)} → ${shortSha(reference.newSha)}`
          : `  ${label}: ${shortSha(reference.newSha)} (unchanged)`,
      );
    }
  }

  if (report.changed.length > 0) {
    lines.push("changed:");
    for (const entry of report.changed) {
      lines.push(
        `  ${entry.kind} ${entry.id}: ${entry.fields.join(", ")} (${shortSha(entry.oldSha)} → ${shortSha(entry.newSha)}) — ${where(entry)}`,
      );
    }
  }

  if (report.added.length > 0) {
    lines.push("added:");
    for (const entry of report.added) {
      lines.push(`  ${entry.kind} ${entry.id} @ ${shortSha(entry.newSha)} — ${where(entry)}`);
    }
  }

  if (report.removed.length > 0) {
    lines.push("no longer loaded:");
    for (const entry of report.removed) {
      lines.push(
        `  ${entry.kind} ${entry.id} (was ${shortSha(entry.sha)}) — the reload stops registering it, and a new session never sees it`,
      );
    }
  }

  if (report.deferred.length > 0) {
    lines.push("not in effect until a new session:");
    for (const item of report.deferred) {
      lines.push(`  ${item.kind} ${item.id}: ${item.fields.join(", ")} — ${item.why}`);
    }
  }

  for (const note of notes) lines.push(note);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const problem of report.problems) lines.push(`problem: ${problem}`);

  return lines.join("\n");
}
