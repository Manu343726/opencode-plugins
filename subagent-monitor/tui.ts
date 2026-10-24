/**
 * Subagent monitor: the session's subagents, as a sidebar widget.
 *
 * It claims `sidebar.content` — the same surface `@slkiser/opencode-quota`
 * uses — rather than a panel of its own: a widget that is always there needs no
 * command, no way to close it, and no split stealing space from the session.
 * The panel version needed all three and the user still had to know it existed.
 */

import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createSignal, onCleanup } from "solid-js";

import { Plugin, usePlugin } from "@opencode/plugin/tui";

import { collect, elapsed, prune, statusKind, type Outcome, type Row } from "./collect.ts";

/** Keeps a title short enough for a narrow sidebar. */
function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const h = jsx as unknown as (type: unknown, props?: Record<string, unknown>) => unknown;

const text = (content: string, attributes?: Record<string, unknown>) =>
  h("text", { ...attributes, children: content });

/**
 * How each subagent ended, and when a finished one was first seen.
 *
 * Module level on purpose: the slot re-creates the component whenever its props
 * change, so a map held in the component starts empty on every repaint and the
 * outcome — recorded by an event that has already been delivered — is lost. That
 * is why a finished subagent showed 'done' with no colour.
 */
const OUTCOMES = new Map<string, Outcome>();
const SEEN_FINISHED = new Map<string, number>();

const RESULT_LABEL: Record<string, string> = {
  running: "running",
  ok: "ok",
  error: "error",
  aborted: "aborted",
  unknown: "done",
};

/** How long a finished subagent stays in the list. */
function finishedTtlMs(context: { options?: Record<string, unknown> }): number {
  const configured = context.options?.finishedTtlMinutes;
  const minutes = typeof configured === "number" && configured >= 0 ? configured : 5;
  return minutes * 60_000;
}

function SidebarBody(props: { sessionID: string; ttlMs: number }) {
  const context = usePlugin();

  // The agent's own colour, the one OpenCode uses for it in its banner. The
  // session only names the agent, so the definition is looked up by id; an
  // agent with no colour, or one that is not in the list, keeps the default.
  void context.data.location.agent.sync(context.location).catch(() => undefined);
  /**
   * A colour from the theme, by the names the theme actually has.
   *
   * `text.feedback.<kind>.base` and `text.base`/`muted` are the tokens; the first
   * attempt used `text.info`, `text.success` and friends, which do not exist and
   * resolved to nothing — the sidebar stayed grey.
   */
  const feedback = (kind: "success" | "warning" | "error" | "info"): unknown =>
    (context.theme?.text?.feedback as Record<string, { base?: unknown }> | undefined)?.[kind]?.base;

  /**
   * A stable colour derived from the id, for the agents that declare none.
   *
   * The built-in agents declare no colour at all (measured: build, general,
   * explore and plan all report `color: null`), so using only the declared one
   * leaves every name white and the feature invisible. A hash of the id into a
   * fixed palette keeps the same agent the same colour between sessions and
   * tells several agents apart.
   */
  const derived = (agentID: string): string => {
    const palette = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e", "#ff9e64"];
    let hash = 0;
    for (const char of agentID) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
    return palette[hash % palette.length] ?? "#7aa2f7";
  };

  const colorOf = (agentID: string): unknown => {
    const agents = context.data.location.agent.list(context.location) ?? [];
    const declared = agents.find((agent) => agent.id === agentID)?.color;
    if (!declared) return derived(agentID);
    if (declared.startsWith("#")) return declared;

    // An agent may name a theme colour rather than give a hex value.
    const named: Record<string, "base" | "muted" | "success" | "warning" | "error" | "info"> = {
      primary: "base",
      secondary: "muted",
      accent: "info",
      success: "success",
      warning: "warning",
      error: "error",
      info: "info",
    };
    const token = named[declared];
    if (!token) return undefined;
    if (token === "base") return context.theme?.text?.base;
    if (token === "muted") return context.theme?.text?.muted;
    return feedback(token);
  };

  const [tick, setTick] = createSignal(Date.now());

  // How each subagent ended, from the session events that say so. The session
  // itself only reports idle/running, so without this a finished subagent cannot
  // tell success from failure from an interruption.
  const outcomes = OUTCOMES;
  const sessionOf = (event: unknown): string | undefined => {
    const record = event as { durable?: { aggregateID?: string }; sessionID?: string } | undefined;
    return record?.durable?.aggregateID ?? record?.sessionID;
  };

  const stop = context.data.listen(({ details }) => {
    const id = sessionOf(details);
    switch (details.type) {
      case "session.execution.succeeded":
        if (id) outcomes.set(id, "ok");
        break;
      case "session.execution.failed":
        if (id) outcomes.set(id, "error");
        break;
      case "session.execution.interrupted":
        if (id) outcomes.set(id, "aborted");
        break;
      case "session.execution.started":
        if (id) outcomes.delete(id);
        break;
      default:
        break;
    }
    if (details.type.startsWith("session.")) setTick(Date.now());
  });
  onCleanup(stop);

  // A finished subagent has to leave on its own schedule, not on the next event:
  // a quiet session emits nothing.
  const timer = setInterval(() => setTick(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));

  const seenFinished = SEEN_FINISHED;

  /**
   * The marker's colour: blue while it runs, green when it succeeded, red when
   * it failed, orange when it was interrupted. A session that is idle without a
   * seen ending stays uncoloured rather than claiming an outcome.
   */
  const muted = (): string | undefined => context.theme?.text?.muted;

  const markerColor = (kind: ReturnType<typeof statusKind>): unknown => {
    switch (kind) {
      case "running":
        return feedback("info");
      case "ok":
        return feedback("success");
      case "error":
        return feedback("error");
      case "aborted":
        return feedback("warning");
      default:
        return context.theme?.text?.muted;
    }
  };

  const rows = createMemo<Row[]>(() => {
    const now = tick();
    // The subagents hang from the session's root: a session viewed inside a
    // tree reports its own family, which does not include them.
    const root = context.data.session.root(props.sessionID);
    const all = collect(context.data.session, root);
    return [...prune(all, { now, ttlMs: props.ttlMs, seenFinished }).rows];
  });

  const running = createMemo(() => rows().filter((row) => row.running).length);

  /**
   * The whole body is one binding.
   *
   * `Show` + `For` inside a slot did not draw their children here — the header
   * updated and the list stayed empty — so the body is rebuilt from the rows
   * whenever they change. One binding, one place to be wrong.
   */
  const body = (): unknown[] => {
    const list = rows();
    const header = h("text", {
      fg: muted(),
      children:
        list.length === 0
          ? "Subagents · none"
          : `Subagents · ${list.filter((row) => row.running).length} running · ${list.length}`,
    });

    const items = list.map((row) =>
      h("box", {
        flexDirection: "column",
        children: [
          h("box", {
            flexDirection: "row",
            gap: 1,
            children: [
              h("text", {
                fg: markerColor(statusKind(row.running, outcomes.get(row.id))),
                children: row.running ? "●" : "○",
              }),
              h("text", { fg: colorOf(row.agent), children: shorten(row.agent, 14) }),
              h("text", {
                fg: markerColor(statusKind(row.running, outcomes.get(row.id))),
                children: row.running
                  ? elapsed(row.created, tick())
                  : RESULT_LABEL[statusKind(false, outcomes.get(row.id))] ?? "done",
              }),
            ],
          }),
          h("text", { fg: muted(), children: `  ${shorten(row.title, 34)}` }),
        ],
      }),
    );

    return [header, ...items];
  };

  return h("box", {
    flexDirection: "column",
    paddingTop: 1,
    children: () => body(),
  });
}

export default Plugin.define({
  id: "subagent-monitor",

  setup(context) {
    // A plugin file under `.opencode/plugins/` is discovered by the server
    // runner as well, and that context has no terminal.
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const ttlMs = finishedTtlMs(context as unknown as { options?: Record<string, unknown> });

    const unclaim = context.ui.slot({
      append: "sidebar.content",
      render: (props) => h(SidebarBody, { sessionID: props.sessionID, ttlMs }),
    });

    return () => {
      unclaim();
    };
  },
});