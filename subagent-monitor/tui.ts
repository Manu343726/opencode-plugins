/**
 * Subagent monitor: the session's subagents, as a sidebar widget.
 *
 * It claims `sidebar.content` — the same surface `@slkiser/opencode-quota`
 * uses — rather than a panel of its own: a widget that is always there needs no
 * command, no way to close it, and no split stealing space from the session.
 * The panel version needed all three and the user still had to know it existed.
 */

import { jsx } from "@opentui/solid/jsx-runtime";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";

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
  const colorOf = (agentID: string): string | undefined => {
    const agents = context.data.location.agent.list(context.location) ?? [];
    const found = agents.find((agent) => agent.id === agentID);
    return found?.color;
  };

  const [tick, setTick] = createSignal(Date.now());

  // How each subagent ended, from the session events that say so. The session
  // itself only reports idle/running, so without this a finished subagent cannot
  // tell success from failure from an interruption.
  const outcomes = new Map<string, Outcome>();
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

  const seenFinished = new Map<string, number>();

  /**
   * The marker's colour: blue while it runs, green when it succeeded, red when
   * it failed, orange when it was interrupted. A session that is idle without a
   * seen ending stays uncoloured rather than claiming an outcome.
   */
  const markerColor = (kind: ReturnType<typeof statusKind>): string | undefined => {
    const text = context.theme?.text;
    switch (kind) {
      case "running":
        return text?.info ?? text?.accent;
      case "ok":
        return text?.success;
      case "error":
        return text?.error;
      case "aborted":
        return text?.warning;
      default:
        return text?.muted;
    }
  };

  const rows = createMemo<Row[]>(() => {
    const now = tick();
    const all = collect(context.data.session, props.sessionID);
    return [...prune(all, { now, ttlMs: props.ttlMs, seenFinished }).rows];
  });

  const running = createMemo(() => rows().filter((row) => row.running).length);

  return h("box", {
    flexDirection: "column",
    paddingTop: 1,
    children: [
      text(
        rows().length === 0
          ? "Subagents · none"
          : `Subagents · ${running()} running · ${rows().length}`,
        { fg: context.theme?.text?.muted },
      ),
      h(Show, {
        when: rows().length > 0,
        children: () =>
          h(For, {
            each: rows(),
            children: (row: Row) =>
              // Two lines per subagent: what is running it, then the task. The
              // sidebar is narrow, and the task is the part a person reads.
              h("box", {
                flexDirection: "column",
                children: [
                  h("box", {
                    flexDirection: "row",
                    gap: 1,
                    children: [
                      text(row.running ? "●" : "○", {
                        fg: markerColor(statusKind(row.running, outcomes.get(row.id))),
                      }),
                      text(shorten(row.agent, 14), { fg: colorOf(row.agent) }),
                      text(row.running ? elapsed(row.created, tick()) : "done", {
                        fg: context.theme?.text?.muted,
                      }),
                    ],
                  }),
                  text(`  ${shorten(row.title, 34)}`, {
                    fg: context.theme?.text?.muted,
                  }),
                ],
              }),
          }),
      }),
    ],
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