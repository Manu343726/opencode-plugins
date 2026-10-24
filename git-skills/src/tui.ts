/**
 * The TUI: browse the known repositories, and manage what the project uses.
 *
 * It reads the project configuration and the disk itself rather than asking
 * the server, because `/api/agent` and `/api/skill` do not list file-based
 * definitions — measured on 2.0.31 — so the server cannot answer "what is
 * available here".
 */

import { Plugin } from "@opencode/plugin/tui";

import { adoptEntry, listAdopted, removeAdopted, remoteDigest, snapshot, STATE_LABEL } from "./adopt.ts";
import { addToList, readConfig, readLists, removeFromList, writeConfig } from "./config.ts";
import { discover, findEntry, type Entry } from "./discover.ts";
import { ensureCheckout } from "./git.ts";
import { encode, decode, isDeclared, knownTargets, type Choice } from "./browse.ts";
import { formatSpec, parseSpec, type Spec } from "./ref.ts";

interface RepoScan {
  readonly url: string;
  readonly ref: string;
  readonly dir: string;
  readonly commit: string;
  readonly entries: readonly Entry[];
  readonly warning?: string;
}

/** Clones or refreshes one repository and lists what it holds. */
async function scan(
  url: string,
  ref: string,
  cacheDir: string | undefined,
  offline: boolean,
): Promise<RepoScan | undefined> {
  const checkout = await ensureCheckout({ url, ref, cacheDir, offline });
  if (checkout.commit === "") return undefined;
  const discovery = await discover(checkout.dir);
  return {
    url,
    ref,
    dir: checkout.dir,
    commit: checkout.commit,
    entries: discovery.entries,
    warning: checkout.warning,
  };
}

export default Plugin.define({
  id: "git-skills.tui",

  setup(context) {
    // The same file can be loaded by the server runner as well — a plugin file
    // under `.opencode/plugins/` is discovered by both — and only the CLI has a
    // terminal. Measured on 2.0.31: calling `context.keymap.layer` there fails
    // with "undefined is not an object", so the TUI half stands down instead of
    // breaking the session.
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const projectDir = (): string => context.location?.directory ?? process.cwd();

    const toast = (message: string, variant: "success" | "error" | "info" = "info"): void => {
      void context.ui.toast.show({ title: "Git skills", message, variant, duration: 4000 });
    };

    const browse = async (): Promise<void> => {
      const lists = await readLists(projectDir());
      const targets = knownTargets(lists);
      const adopted = await listAdopted(projectDir());

      if (targets.length === 0 && adopted.length === 0) {
        toast("No repositories declared. Add one to the plugin's options.repos first.", "info");
        return;
      }

      const scans: RepoScan[] = [];
      for (const target of targets) {
        try {
          const result = await scan(target.url, target.ref, undefined, false);
          if (result) scans.push(result);
          else toast(`${target.url}@${target.ref} is unavailable`, "error");
        } catch (error) {
          toast(`${target.url}@${target.ref}: ${String(error)}`, "error");
        }
      }

      const options: { title: string; value: string; description?: string; category?: string }[] = [];

      for (const item of adopted) {
        // Compare with the entry as the ref holds it now, so an unrelated
        // commit upstream does not mark every adopted entry as updatable.
        let remote: string | undefined;
        try {
          const spec = parseSpec(item.provenance.id);
          const repository = scans.find(
            (candidate) => candidate.url === spec.url && candidate.ref === spec.ref,
          );
          const entry = repository
            ? findEntry({ entries: repository.entries, problems: [] }, item.kind, item.id)
            : undefined;
          if (entry) remote = await remoteDigest(entry);
        } catch {
          // An unreadable provenance reference leaves the state at local-only.
        }
        const state = await snapshot(item, remote);
        options.push({
          title: `${item.kind} ${item.id}`,
          value: encode({
            kind: item.kind,
            id: item.id,
            url: "",
            ref: "",
            adopted: true,
          }),
          description: `${STATE_LABEL[state.state]} — ${item.provenance.id}`,
          category: "Adopted",
        });
      }

      for (const repo of scans) {
        for (const entry of repo.entries) {
          const alreadyAdopted = adopted.some(
            (item) => item.kind === entry.kind && item.id === entry.id,
          );
          if (alreadyAdopted) continue;
          const declared = isDeclared(entry, { url: repo.url, ref: repo.ref }, lists);
          options.push({
            title: `${entry.kind} ${entry.id}`,
            value: encode({
              kind: entry.kind,
              id: entry.id,
              url: repo.url,
              ref: repo.ref,
              adopted: false,
            }),
            description: `${declared ? "in config — " : ""}${entry.description ?? entry.origin}`,
            category: `${repo.url}@${repo.ref}`,
          });
        }
        if (repo.warning) toast(repo.warning, "error");
      }

      const act = async (choice: Choice | undefined, action: string): Promise<void> => {
        if (!choice) return;
        if (action === "update" && !choice.adopted) {
          toast("Only an adopted entry can be updated", "error");
          return;
        }

        const repository = scans.find((repo) => repo.url === choice.url && repo.ref === choice.ref);
        const entry = repository
          ? findEntry({ entries: repository.entries, problems: [] }, choice.kind, choice.id)
          : undefined;

        if ((action === "adopt" || action === "update") && (!repository || !entry)) {
          toast("The entry is not in the repository any more", "error");
          return;
        }

        if (action === "adopt" || action === "update") {
          const spec: Spec = { id: choice.id, url: choice.url, ref: choice.ref };
          await adoptEntry({
            entry: entry as Entry,
            projectDir: projectDir(),
            spec,
            commit: repository?.commit ?? "",
          });
          toast(`${choice.kind} ${choice.id} ${action === "adopt" ? "adopted" : "updated"}`, "success");
          return;
        }

        if (action === "remove") {
          if (choice.adopted) {
            const item = adopted.find(
              (candidate) => candidate.kind === choice.kind && candidate.id === choice.id,
            );
            if (item) await removeAdopted(item);
            toast(`${choice.kind} ${choice.id} deleted`, "success");
          } else {
            const spec: Spec = { id: choice.id, url: choice.url, ref: choice.ref };
            const file = (await readLists(projectDir())).file;
            if (file) {
              const text = await readConfig(file);
              const key = choice.kind === "skill" ? "skills" : "agents";
              const next = removeFromList(text, key, formatSpec(spec));
              await writeConfig(file, next);
            }
            toast(`${choice.kind} ${choice.id} removed from the config`, "success");
          }
        }
      };

      const selected = await context.ui.dialog.select({
        title: "Git skills and agents",
        options,
        search: (query, all) =>
          all.filter((option) =>
            `${option.title} ${option.description ?? ""} ${option.category ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          ),
        actions: [
          {
            bind: "ctrl+a",
            title: "Adopt",
            onTrigger: (value) => void act(decode(String(value)), "adopt"),
          },
          {
            bind: "ctrl+u",
            title: "Update",
            onTrigger: (value) => void act(decode(String(value)), "update"),
          },
          {
            bind: "ctrl+d",
            title: "Remove",
            onTrigger: (value) => void act(decode(String(value)), "remove"),
          },
          {
            bind: "ctrl+r",
            title: "Refresh",
            selection: "none",
            onTrigger: () => void browse(),
          },
        ],
      });

      const choice = selected === undefined ? undefined : decode(String(selected));
      if (!choice) return;

      // Choosing a repository entry declares it for the project.
      if (!choice.adopted && choice.url !== "") {
        const spec: Spec = { id: choice.id, url: choice.url, ref: choice.ref };
        const file = (await readLists(projectDir())).file;
        if (file) {
          const text = await readConfig(file);
          const key = choice.kind === "skill" ? "skills" : "agents";
          await writeConfig(file, addToList(text, key, formatSpec(spec)));
          toast(`${choice.kind} ${choice.id} added to the project config`, "success");
        } else {
          toast("This project has no opencode config to edit", "error");
        }
      }
    };

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "git-skills.browse",
          title: "Browse git skills and agents",
          group: "Git skills",
          palette: true,
          slash: { name: "git-skills" },
          run: () => void browse(),
        },
      ],
      bindings: ["git-skills.browse"],
    }));
  },
});
