/**
 * The plugin: git repositories as per-project sources of skills and agents.
 *
 * Setup resolves the declared references, then registers what it found. Two
 * details are load-bearing and worth stating where they are implemented:
 *
 *   - a skill is registered with `editor.add`, which is documented;
 *   - an agent is registered with `editor.update` on an id that does not exist
 *     yet, which **creates** it. That is measured behaviour on 2.0.31, not
 *     documented, so it lives in `registerAgent` alone: if a future release
 *     stops creating, one function and one test fail instead of the feature
 *     disappearing quietly.
 *
 * Entries the project already owns — adopted copies and hand-written files —
 * are never registered, so an id has exactly one definition in a session.
 */

import { Agent, Plugin, Skill } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseAgent, parseSkillMeta } from "./agentfile.ts";
import { splitFrontmatter } from "./provenance.ts";
import { listAdopted, snapshot, STATE_LABEL } from "./adopt.ts";
import { proposeChange } from "./propose.ts";
import { readOptions, resolve, summarize, type Resolution } from "./resolve.ts";
import {
  compare,
  format,
  hasEntryChanges,
  pull,
  type Pull,
  type ReferenceState,
  type Report,
  type Snapshot,
} from "./refresh.ts";
import { projectDeclaresPlugin, readLists } from "./config.ts";

/**
 * Applies a branded-string schema when the runtime provides one, and falls
 * back to the plain string. The brand is a TypeScript device; at runtime these
 * are strings, and depending on `.make` existing would be a needless way to
 * break the plugin on a schema change.
 */
function branded(value: string, schema: unknown): unknown {
  const candidate = schema as { make?: (input: string) => unknown } | undefined;
  return typeof candidate?.make === "function" ? candidate.make(value) : value;
}

/** Registers an agent that only exists in a repository. */
function registerAgent(
  editor: { get(id: string): unknown; update(id: string, update: (agent: Record<string, unknown>) => void): void },
  id: string,
  text: string,
): void {
  if (editor.get(id) !== undefined) return;
  const { fields } = parseAgent(text, id);

  // `update` on a missing id creates the agent. Everything below is a field of
  // Agent.Info, so an unchanged field is left to its default.
  editor.update(id, (agent) => {
    agent.name = fields.name;
    agent.mode = fields.mode;
    agent.system = fields.system;
    if (fields.description !== undefined) agent.description = fields.description;
    if (fields.hidden !== undefined) agent.hidden = fields.hidden;
    if (fields.color !== undefined) agent.color = fields.color;
    if (fields.steps !== undefined) agent.steps = fields.steps;
    if (fields.permissions !== undefined) {
      // **Seeded with the defaults, then appended.**
      //
      // An agent created by `editor.update` on a missing id starts with no
      // permission rules at all, and the defaults carry a catch-all allow. Setting
      // only the file's rules leaves every action the file does not name denied —
      // which hides the plugin's own tool from the agent. A Markdown agent gets
      // the defaults plus its rules, which is why the same file on disk keeps its
      // tools. Measured: an agent created with no permissions at all could call
      // the tool, the library's verifier could not.
      let base: unknown[] = [];
      try {
        const created = (Agent.Info as unknown as {
          default: (id: string) => { permissions?: unknown };
        }).default(id);
        if (Array.isArray(created.permissions)) base = created.permissions as unknown[];
      } catch (error) {
        console.warn(`[git-skills] could not read the default permissions for ${id}: ${String(error)}`);
      }
      const existing = Array.isArray(agent.permissions) ? (agent.permissions as unknown[]) : [];
      const seeded = existing.length > 0 ? existing : base;
      agent.permissions = [...seeded, ...fields.permissions] as never;
    }
    if (fields.model !== undefined) {
      agent.model = {
        id: fields.model.id,
        providerID: fields.model.providerID,
        ...(fields.model.variant === undefined ? {} : { variant: fields.model.variant }),
      };
    }
  });
}

export default Plugin.define({
  id: "git-skills",

  async setup(ctx) {
    const projectDir = ctx.location.directory;

    // Loaded from an ancestor's configuration is not the same as declared here.
    // Without this, a configuration at the root of `$HOME` activates the plugin
    // in every project below it.
    if ((await projectDeclaresPlugin(projectDir)) === undefined) {
      console.warn(
        `[git-skills] not declared in a configuration of ${projectDir}; staying idle`,
      );
      return;
    }

    const { options, problems: optionProblems } = readOptions(ctx.options);

    for (const problem of optionProblems) console.warn(`[git-skills] ${problem}`);

    // What a project uses is read from **its own** file plus the machine's, and
    // from nowhere else.
    //
    // The options OpenCode hands the plugin are the configuration merged from
    // every ancestor directory, which here means that a configuration at the
    // root of `$HOME` would leak into every project under it. Content is not
    // inherited from parents: a project declares what it uses.
    const lists = await readLists(projectDir);
    for (const problem of lists.problems) console.warn(`[git-skills] ${problem}`);

    let resolution: Resolution;
    try {
      resolution = await resolve(projectDir, {
        // Scalars still come from the entry: they are settings, not content.
        cacheDir: options.cacheDir,
        ttlMinutes: options.ttlMinutes,
        offline: options.offline,
        skills: lists.skills,
        agents: lists.agents,
        repos: lists.repos,
        globalConfigDir: options.globalConfigDir ?? path.join(os.homedir(), ".config", "opencode"),
      });
    } catch (error) {
      console.warn(`[git-skills] could not resolve the declared references: ${String(error)}`);
      return;
    }

    for (const problem of resolution.problems) console.warn(`[git-skills] ${problem}`);
    for (const warning of resolution.warnings) console.warn(`[git-skills] ${warning}`);
    for (const skipped of resolution.skipped) {
      console.warn(`[git-skills] ${skipped.spec.id} is not registered (${skipped.reason}: ${skipped.detail})`);
    }

    // What the transforms register is read from here, not from a captured
    // constant: a refresh replaces it and reloads, and `reload()` rebuilds a
    // registry by replaying every active transform onto a fresh value — so this
    // variable is the only channel between a pull and the session.
    let current: Resolution = resolution;

    // What the last replay actually left in each registry, per id. A transform
    // running is not the same as a registry holding the new text: the caller of
    // a refresh reads this back and checks, instead of reporting success because
    // the code ran.
    const applied = { skills: new Map<string, string>(), agents: new Map<string, string>() };

    // The shas the session started from, replaced by every successful pull. The
    // report's "old sha" is the one the session was actually running on, not
    // whatever the checkout held a minute ago.
    let lastReferences: readonly ReferenceState[] = resolution.repositories.map((repository) => ({
      url: repository.url,
      ref: repository.ref,
      sha: repository.commit,
    }));

    // One refresh at a time: two would each pull, each reload, and whichever
    // finished last would decide what the session holds.
    let refreshing = false;

    // The plugin's own skill: what it is, what the tool answers, and the patterns
    // that keep an agent from guessing. It ships beside the code, so the text an
    // agent reads is the text of the version that is loaded. Read before the
    // transform, which must be synchronous.
    const guideFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");
    let guide: { description: string; body: string } | undefined;
    try {
      const text = await fs.readFile(guideFile, "utf8");
      const meta = splitFrontmatter(text);
      guide = {
        description:
          typeof meta.data.description === "string"
            ? meta.data.description
            : "How this project gets skills and agents from git repositories",
        body: meta.body,
      };
    } catch (error) {
      console.warn(`[git-skills] could not load its own skill from ${guideFile}: ${String(error)}`);
    }

    const skillRegistration = await ctx.skill.transform((editor) => {
      if (guide && editor.get("git-skills") === undefined) {
        editor.add({
          id: branded("git-skills", Skill.ID) as never,
          name: branded("Git skills and agents", Skill.Name) as never,
          description: guide.description,
          path: branded(guideFile, (Skill.Info as unknown as { fields: { path: unknown } }).fields.path) as never,
          content: guide.body,
        });
      }

      for (const resolved of current.entries) {
        if (resolved.entry.kind !== "skill") continue;
        const id = resolved.spec.id;
        if (editor.get(id) !== undefined) continue;
        const meta = parseSkillMeta(resolved.document, id);
        editor.add({
          id: branded(id, Skill.ID) as never,
          name: branded(meta.name, Skill.Name) as never,
          description: meta.description,
          path: branded(
            path.join(resolved.entry.path, "SKILL.md"),
            (Skill.Info as unknown as { fields: { path: unknown } }).fields.path,
          ) as never,
          content: meta.body,
        });
        const registered = editor.get(id) as { content?: unknown } | undefined;
        if (registered !== undefined) applied.skills.set(id, String(registered.content ?? ""));
      }
    });

    const agentRegistration = await ctx.agent.transform((editor) => {
      for (const resolved of current.entries) {
        if (resolved.entry.kind !== "agent") continue;
        registerAgent(editor, resolved.spec.id, resolved.document);
        const registered = editor.get(resolved.spec.id) as { system?: unknown } | undefined;
        if (registered !== undefined) applied.agents.set(resolved.spec.id, String(registered.system ?? ""));
      }
    });

    /**
     * What only the caller can know: whether the rebuilt registry holds the text
     * the pull found.
     *
     * A reload that did nothing, or a definition something else overrode, must
     * not read as a successful refresh — the plugin has already shipped one
     * silent failure, and this is the check that keeps the next one out.
     */
    function verified(report: Report, pulled: Pull): string[] {
      const stale: string[] = [];
      for (const entry of report.changed) {
        const wanted = pulled.resolution.entries.find(
          (resolved) => resolved.entry.kind === entry.kind && resolved.spec.id === entry.id,
        );
        if (wanted === undefined) continue;
        const held = entry.kind === "skill" ? applied.skills.get(entry.id) : applied.agents.get(entry.id);
        if (held !== wanted.body) stale.push(`${entry.kind} ${entry.id}`);
      }

      if (stale.length > 0) {
        return [
          `problem: the session's registry still holds the previous text of ${stale.join(", ")} — that part of the reload did not take effect, and a new session is the only way to pick it up.`,
        ];
      }
      return report.changed.length === 0
        ? []
        : [
            `verified: the session's registry holds the new text of ${report.changed.length} changed entry(ies).`,
          ];
    }

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "git_skills",
        description:
          "The skills and agents this project loads from git repositories: report what is loaded, which references the configuration declares, which copies the project adopted and whether they drifted, pull every configured reference again so a merged change to a role takes effect (refresh), and propose an adopted copy's changes back to its repository",
        options: { codemode: true },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "adopted", "references", "refresh", "propose"],
              description:
                "status: what is loaded from repositories; adopted: copies in the project and whether they drifted; references: what the project config declares; refresh: pulls every configured reference again and says which shas moved, which entries changed, and what will not take effect until a new session; propose: pushes the local changes of every drifted copy to its repository and opens a pull request for each",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          const action = (input as { action?: string }).action ?? "status";
          if (action === "propose") {
            const adopted = await listAdopted(projectDir);
            const drifted: typeof adopted = [];
            for (const item of adopted) {
              const state = (await snapshot(item)).state;
              if (state === "local-changes" || state === "both") drifted.push(item);
            }
            if (drifted.length === 0) {
              return { content: "No adopted entry has local changes to propose." };
            }

            const lines: string[] = [];
            for (const item of drifted) {
              try {
                const proposal = await proposeChange({
                  projectDir,
                  kind: item.kind,
                  id: item.id,
                  title: `Update ${item.kind} ${item.id}`,
                  motivation: `Proposes the local changes of \`${item.id}\` back to the repository it was adopted from.`,
                  apiBase: options.apiBase,
                  token: options.token,
                });
                lines.push(
                  `${item.kind} ${item.id}: pushed ${proposal.branch} (${proposal.commit.slice(0, 8)})`,
                  ...(proposal.pullRequestUrl ? [`  pull request: ${proposal.pullRequestUrl}`] : []),
                  ...(proposal.compareUrl && !proposal.pullRequestUrl
                    ? [`  open it: ${proposal.compareUrl}`]
                    : []),
                  ...proposal.warnings.map((warning) => `  note: ${warning}`),
                );
              } catch (error) {
                lines.push(`${item.kind} ${item.id}: ${String(error)}`);
              }
            }
            return { content: lines.join("\n") };
          }

          if (action === "references") {
            const lists = await readLists(projectDir);
            const show = (items: typeof lists.skills): string =>
              items.length === 0
                ? "(none)"
                : items
                    .map((item) => (item.enabled ? item.reference : `${item.reference} (disabled)`))
                    .join(", ");

            return {
              content: [
                `${lists.file ?? "(no config)"}`,
                ...(lists.files.length > 1 ? [`merged from: ${lists.files.join(", ")}`] : []),
                `skills: ${show(lists.skills)}`,
                `agents: ${show(lists.agents)}`,
                `repos: ${lists.repos.join(", ") || "(none)"}`,
              ].join("\n"),
            };
          }

          if (action === "adopted") {
            const adopted = await listAdopted(projectDir);
            if (adopted.length === 0) return { content: "No entries are adopted into this project." };
            const lines: string[] = [];
            for (const item of adopted) {
              const state = await snapshot(item);
              lines.push(
                `${item.kind} ${item.id} — ${STATE_LABEL[state.state]} (${item.provenance.id}, commit ${item.provenance.commit.slice(0, 8)})`,
              );
            }
            return { content: lines.join("\n") };
          }

          if (action === "refresh") {
            if (refreshing) {
              return { content: "A refresh is already running; nothing was pulled twice." };
            }
            refreshing = true;
            try {
              const before: Snapshot = { resolution: current, references: lastReferences };

              // The same pull `setup` uses, with the cache TTL bypassed: one
              // implementation of "pull every configured reference", two callers.
              const pulled = await pull(projectDir, options);
              const report = compare(before, pulled);
              lastReferences = pulled.references;

              if (!hasEntryChanges(report)) return { content: format(report) };

              // Before the reload, not after: the transforms read `current`, and
              // the reload is what replays them onto a fresh registry.
              current = pulled.resolution;
              await ctx.skill.reload();
              await ctx.agent.reload();
              // A reload marks the registries dirty; the rebuild happens on the
              // next read, and the rebuild is what runs the transforms again.
              await ctx.skill.list();
              await ctx.agent.list();

              return { content: format(report, verified(report, pulled)) };
            } catch (error) {
              return { content: `Refresh failed: ${String(error)}` };
            } finally {
              refreshing = false;
            }
          }

          return { content: summarize(current) };
        },
      });
    });

    // Local files can appear or disappear while the server runs; a reload
    // replays the transforms against the new state without restarting.
    const refresh = async () => {
      try {
        await ctx.skill.reload();
        await ctx.agent.reload();
      } catch (error) {
        console.warn(`[git-skills] reload failed: ${String(error)}`);
      }
    };
    const timer = setInterval(() => void refresh(), 10 * 60_000);
    if (typeof timer.unref === "function") timer.unref();

    return async () => {
      clearInterval(timer);
      await skillRegistration.dispose();
      await agentRegistration.dispose();
      await toolRegistration.dispose();
    };
  },
});
