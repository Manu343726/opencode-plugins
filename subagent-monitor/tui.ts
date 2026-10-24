/**
 * Subagent monitor: the agents working in this session, in the side panel.
 *
 * ## How this is built, and why it looks like this
 *
 * The elements are created by calling OpenTUI's JSX runtime directly instead of
 * using JSX syntax, and OpenTUI is pinned to the version the host itself runs.
 * Both are deliberate, and both were measured on OpenCode 2.0.31:
 *
 *   - a `.tsx` file in `.opencode/plugins/` is **not discovered** — the loader
 *     only picks up `.ts`/`.js`, and the file never appears in the log at any
 *     level. So the plugin cannot ship JSX syntax; it must be plain TypeScript.
 *   - JSX inside a `.ts` file has no transform: Bun falls back to React and the
 *     plugin dies with "Cannot find package 'react'".
 *   - importing `@opentui/solid` at 0.6.x loads a second `@opentui/core` whose
 *     global registration collides with the host's — "Environment variable
 *     OPENTUI_FORCE_UNICODE is already registered with different
 *     configuration", because 0.6 renamed what that variable means. **0.5.10 is
 *     the version the host runs** (same wording), which is why it is pinned
 *     exactly here: this is the arrangement `@slkiser/opencode-quota` uses, and
 *     it is the only one that loads.
 *
 * `jsx(type, props)` from `@opentui/solid/jsx-runtime` is exactly what the Solid
 * compiler emits — `createElement`/`createComponent` plus `spread` — so the
 * result is the same element tree, built without a build step.
 */

import { jsx } from "@opentui/solid/jsx-runtime";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";

import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";

import { collect, elapsed, type Row } from "./collect.ts";

export const PANEL = "subagent-monitor.list";

/**
 * `jsx` is typed for the compiler, whose props are `Record<string, unknown>`;
 * a component with declared props is not assignable to that signature even
 * though the runtime call is the same. This keeps the runtime, drops the check.
 */
const h = jsx as unknown as (type: unknown, props?: Record<string, unknown>) => unknown;

const text = (content: string, attributes?: Record<string, unknown>) =>
  h("text", { ...attributes, children: content });

const line = (children: unknown[], attributes?: Record<string, unknown>) =>
  h("box", { flexDirection: "row", gap: 1, ...attributes, children });

function PanelBody(props: { panel: PanelInput }) {
  const context = usePlugin();

  // Session events are the only thing that changes what is on screen: a child
  // created, started, finished or removed. The counter makes the memo below
  // recompute and also advances the elapsed readouts.
  const [tick, setTick] = createSignal(Date.now());
  const stop = context.data.listen(({ details }) => {
    if (details.type.startsWith("session.")) setTick(Date.now());
  });
  onCleanup(stop);

  const rows = createMemo<Row[]>(() => {
    tick();
    return collect(context.data.session, props.panel.sessionID);
  });

  const running = createMemo(() => rows().filter((row) => row.running).length);

  return h("box", {
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    children: [
      text(`Subagents · ${running()} running · ${rows().length} in this session`, {
        fg: context.theme?.text?.muted,
      }),
      h(Show, {
        when: rows().length > 0,
        fallback: text("No subagents yet. An agent launched in the background appears here.", {
          fg: context.theme?.text?.muted,
        }),
        children: () =>
          h(For, {
            each: rows(),
            children: (row: Row) =>
              line([
                text(row.running ? "●" : "○", {
                  fg: row.running ? context.theme?.text?.success : context.theme?.text?.muted,
                }),
                text(row.agent),
                text(row.title, { fg: context.theme?.text?.muted }),
                text(row.running ? elapsed(row.created, tick()) : "done", {
                  fg: context.theme?.text?.muted,
                }),
              ]),
          }),
      }),
    ],
  });
}

export default Plugin.define({
  id: "subagent-monitor",

  setup(context) {
    // A plugin file under `.opencode/plugins/` is discovered by the server
    // runner as well; only the CLI has a terminal, and the server's context has
    // no `ui`.
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const unclaim = context.ui.slot({
      append: "session.panel",
      render: (panel) => (panel.name === PANEL ? h(PanelBody, { panel }) : undefined),
    });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "subagent-monitor.open",
          title: "Show subagents in this session",
          group: "Agents",
          palette: true,
          slash: { name: "subagents" },
          run: () => {
            const opened = context.ui.panel.open(PANEL, { presentation: "panel" });
            if (!opened) {
              void context.ui.toast.show({
                title: "Subagents",
                message: "Open a session to see its subagents",
                variant: "info",
              });
            }
          },
        },
      ],
      bindings: ["subagent-monitor.open"],
    }));

    return () => {
      unclaim();
    };
  },
});