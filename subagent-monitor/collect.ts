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
  readonly time?: { readonly created?: number };
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