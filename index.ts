/**
 * The bundle: one package, one entrypoint, several plugins.
 *
 * OpenCode resolves a plugin package as `<package>/index.ts` — measured on
 * 2.0.31, and not through `package.json` `exports` or `main`. That is why this
 * file exists: the plugins live in subdirectories, and a project that adds this
 * repository by URL gets them through here.
 *
 * Each plugin keeps its own `setup` and its own options. The bundle forwards
 * the context with the options narrowed to the plugin's own object, so two
 * plugins can never read each other's settings:
 *
 *   {
 *     "package": "git+ssh://git@forgejo:2222/manu343726/opencode-plugins.git#main",
 *     "options": {
 *       "plugins": ["git-skills"],
 *       "git-skills": { "skills": ["..."], "agents": ["..."] }
 *     }
 *   }
 *
 * `plugins` is optional: absent, every plugin in the repository is activated.
 */

import { Plugin } from "@opencode/plugin";

import gitSkills from "./git-skills/index.ts";

/** Every plugin this repository ships, by the name used in the configuration. */
const PLUGINS: Readonly<Record<string, Plugin.Plugin>> = {
  "git-skills": gitSkills,
};

export default Plugin.define({
  id: "manu343726.opencode-plugins",

  async setup(ctx) {
    const options = ctx.options as Record<string, unknown>;
    const requested = Array.isArray(options.plugins)
      ? options.plugins.filter((name): name is string => typeof name === "string")
      : Object.keys(PLUGINS);

    const cleanups: Array<() => unknown> = [];

    for (const name of requested) {
      const plugin = PLUGINS[name];
      if (!plugin) {
        console.warn(
          `[opencode-plugins] no plugin named "${name}" (available: ${Object.keys(PLUGINS).join(", ")})`,
        );
        continue;
      }
      const own = options[name];
      const narrowed = own && typeof own === "object" && !Array.isArray(own) ? own : {};
      try {
        const cleanup = await plugin.setup({ ...ctx, options: narrowed as typeof ctx.options });
        if (typeof cleanup === "function") cleanups.push(cleanup);
      } catch (error) {
        console.warn(`[opencode-plugins] ${name} failed to start: ${String(error)}`);
      }
    }

    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    };
  },
});
