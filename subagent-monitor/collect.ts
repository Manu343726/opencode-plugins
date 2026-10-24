/**
 * What the panel shows, computed without a terminal.
 *
 * A background subagent is an ordinary child session — the `subagent` tool
 * creates it with the current session as its parent — so the data is the
 * session tree the TUI already keeps live: `family()` for the ids and
 * `status()` for what each one is doing. Nothing is asked of the model.
 */

export interface SessionInfoLike {
  readonly title?: string;
  readonly agent?: { readonly id?: string } | string;
  readonly time?: { readonly created?: number; readonly updated?: number };
}

/** The slice of `data.session` this needs, so it can be faked in a test. */
export interface SessionsLike {
  family(sessionID: string): string[];
  get(sessionID: string): SessionInfoLike | undefined;
  status(sessionID: string): "idle" | "running";
}

export interface Row {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly running: boolean;
  readonly created: number;
  /** When the session last changed, which for a finished one is when it ended. */
  readonly updated: number;
}

function agentOf(info: SessionInfoLike | undefined): string {
  const agent = info?.agent;
  if (typeof agent === "string") return agent;
  if (agent && typeof agent === "object" && typeof agent.id === "string") return agent.id;
  return "agent";
}

/**
 * The subagents of one session: its direct children, running first, newest
 * first. A child that has finished is still listed, because "it ran and ended"
 * is what a person looking for a missing subagent needs to see.
 */
export function collect(sessions: SessionsLike, sessionID: string): Row[] {
  return sessions
    .family(sessionID)
    .filter((id) => id !== sessionID)
    .map((id) => {
      const info = sessions.get(id);
      return {
        id,
        title: info?.title ?? id,
        agent: agentOf(info),
        running: sessions.status(id) === "running",
        created: info?.time?.created ?? 0,
        updated: info?.time?.updated ?? info?.time?.created ?? 0,
      };
    })
    .sort((left, right) => {
      if (left.running !== right.running) return left.running ? -1 : 1;
      return right.created - left.created;
    });
}

export function elapsed(since: number, now: number): string {
  if (!Number.isFinite(since) || since <= 0) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One line for the panel and the toast.
 *
 * The panel body is a string rather than a rendered tree on purpose: see the
 * note in `tui.ts` — importing the TUI's element runtime from a plugin fails on
 * this build, and a string is what can be handed to the host without it.
 */
export function summary(rows: readonly Row[], now: number): string {
  const running = rows.filter((row) => row.running).length;
  const head = `Subagents · ${running} running · ${rows.length} in this session`;
  if (rows.length === 0) {
    return `${head} — none yet; an agent launched in the background appears here`;
  }
  const parts = rows.map((row) =>
    row.running ? `● ${row.agent} (${elapsed(row.created, now) || "running"})` : `○ ${row.agent} done`,
  );
  return `${head} — ${parts.join(" · ")}`;
}
export interface PruneOptions {
  readonly now: number;
  /** How long a finished subagent stays visible. `0` keeps them forever. */
  readonly ttlMs: number;
  /** When each finished subagent was first seen finished. Mutated in place. */
  readonly seenFinished: Map<string, number>;
}

export interface Pruned {
  readonly rows: readonly Row[];
  /** Ids dropped by this call, so a caller can forget them. */
  readonly removed: readonly string[];
}

/**
 * Drops subagents that finished more than `ttlMs` ago.
 *
 * The moment a subagent finished is the session's `time.updated` — its last
 * change — with a local fallback for the first time this monitor saw it idle:
 * a session that finished before the widget was mounted still has an `updated`,
 * but one whose timestamp is missing would otherwise never expire.
 *
 * A subagent that runs again is forgotten, so a restarted one gets its full
 * time again instead of disappearing on the tail of its previous run.
 */
export function prune(rows: readonly Row[], options: PruneOptions): Pruned {
  if (options.ttlMs <= 0) return { rows, removed: [] };

  const removed: string[] = [];
  const kept: Row[] = [];

  for (const row of rows) {
    if (row.running) {
      options.seenFinished.delete(row.id);
      kept.push(row);
      continue;
    }

    const first = options.seenFinished.get(row.id);
    const since = first ?? (row.updated > 0 ? row.updated : options.now);
    if (first === undefined) options.seenFinished.set(row.id, since);

    if (options.now - since >= options.ttlMs) {
      options.seenFinished.delete(row.id);
      removed.push(row.id);
      continue;
    }
    kept.push(row);
  }

  return { rows: kept, removed };
}
/** How a subagent ended, as far as the session events told us. */
export type Outcome = "ok" | "error" | "aborted";

export type StatusKind = "running" | "ok" | "error" | "aborted" | "unknown";

/**
 * What the status marker means.
 *
 * Running wins over everything: a session that is executing again after a
 * failure is running, not failed. `unknown` is a session that is idle and whose
 * ending this monitor never saw — it was already finished when the widget
 * mounted — and it is shown without claiming an outcome it cannot know.
 */
export function statusKind(running: boolean, outcome?: Outcome): StatusKind {
  if (running) return "running";
  return outcome ?? "unknown";
}
