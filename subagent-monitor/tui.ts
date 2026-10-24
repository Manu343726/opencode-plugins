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

import { collect, elapsed, type Row } from "./collect.ts";

/** Keeps a title short enough for a narrow sidebar. */
function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const h = jsx as unknown as (type: unknown, props?: Record<string, unknown>) => unknown;

const text = (content: string, attributes?: Record<string, unknown>) =>
  h("text", { ...attributes, children: content });

function SidebarBody(props: { sessionID: string }) {
  const context = usePlugin();

  const [tick, setTick] = createSignal(Date.now());
  const stop = context.data.listen(({ details }) => {
    if (details.type.startsWith("session.")) setTick(Date.now());
  });
  onCleanup(stop);

  const rows = createMemo<Row[]>(() => {
    tick();
    return collect(context.data.session, props.sessionID);
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
              h("box", {
                flexDirection: "row",
                gap: 1,
                children: [
                  text(row.running ? "●" : "○", {
                    fg: row.running ? context.theme?.text?.success : context.theme?.text?.muted,
                  }),
                  text(shorten(row.agent, 12)),
                  text(row.running ? elapsed(row.created, tick()) : "done", {
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

    const unclaim = context.ui.slot({
      append: "sidebar.content",
      render: (props) => h(SidebarBody, { sessionID: props.sessionID }),
    });

    return () => {
      unclaim();
    };
  },
});