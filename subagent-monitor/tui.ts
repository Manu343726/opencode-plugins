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

import { collect, elapsed, prune, type Row } from "./collect.ts";

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

  const [tick, setTick] = createSignal(Date.now());
  const stop = context.data.listen(({ details }) => {
    if (details.type.startsWith("session.")) setTick(Date.now());
  });
  onCleanup(stop);

  // A finished subagent has to leave on its own schedule, not on the next event:
  // a quiet session emits nothing.
  const timer = setInterval(() => setTick(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));

  const seenFinished = new Map<string, number>();

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
                        fg: row.running ? context.theme?.text?.success : context.theme?.text?.muted,
                      }),
                      text(shorten(row.agent, 14)),
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