/**
 * The CLI half of the bundle.
 *
 * OpenCode loads a project's CLI plugins from `.opencode/plugins/` and
 * `~/.config/opencode/plugins/`, and resolves a directory plugin as
 * `<dir>/index.ts`. A package's own `tui.ts` is never picked up from the
 * `plugins` entry — measured — so a project that wants these panels re-exports
 * this file from its plugins directory:
 *
 *   // .opencode/plugins/opencode-plugins-tui.ts
 *   export { default } from "/path/to/opencode-plugins/tui.ts"
 */

import { Plugin } from "@opencode/plugin/tui";

import gitSkills from "./git-skills/src/tui.ts";
import subagentMonitor from "./subagent-monitor/tui.ts";

const TUI: Readonly<Record<string, Plugin.Definition>> = {
  "git-skills": gitSkills,
  "subagent-monitor": subagentMonitor,
};

export default Plugin.define({
  id: "manu343726.opencode-plugins.tui",

  async setup(context) {
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const options = context.options as Record<string, unknown>;
    const requested = Array.isArray(options.plugins)
      ? options.plugins.filter((name): name is string => typeof name === "string")
      : Object.keys(TUI);

    for (const name of requested) {
      const plugin = TUI[name];
      if (!plugin) continue;
      const own = options[name];
      const narrowed = own && typeof own === "object" && !Array.isArray(own) ? own : {};
      await plugin.setup({ ...context, options: narrowed as typeof context.options });
    }
  },
});
