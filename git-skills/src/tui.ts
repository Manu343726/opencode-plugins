/**
 * The browser: a large modal with two tabs.
 *
 * - **Catalog** — every entry in the known repositories, searched with the
 *   dialog's own search box. Enter enables it in the project; `ctrl+a` adopts a
 *   copy.
 * - **Project** — what the project uses right now: the references its
 *   configuration declares and the copies it owns, each with its state.
 *   `ctrl+u` updates an adopted copy, `ctrl+d` disables a declared entry or
 *   deletes a copy.
 *
 * `tab` moves between them. The tabs are two openings of the same dialog rather
 * than one custom view: `ctrl+/tab` closes it and reopens the other, which keeps
 * the host's search box, its key handling and its scrolling instead of
 * reimplementing all three. `dialog.set` is what makes it large.
 */

import {
  adoptedChoice,
  declarationState,
  decode,
  encode,
  knownTargets,
  shortLabel,
  type Choice,
  type Target,
} from "./browse.ts";
import {
  adoptEntry,
  existingDefinition,
  listAdopted,
  removeAdopted,
  remoteDigest,
  snapshot,
  STATE_LABEL,
  type State,
} from "./adopt.ts";
import { addToList, readConfig, readLists, removeFromList, setEnabled, writeConfig } from "./config.ts";
import type { Item } from "./items.ts";
import { discover, findEntry, type Entry } from "./discover.ts";
import { ensureCheckout } from "./git.ts";
import { formatSpec, parseSpec, type Kind, type Spec } from "./ref.ts";
import { Plugin } from "@opencode/plugin/tui";

export const PANEL = "git-skills.browser";

type View = "catalog" | "project";

interface Scan {
  readonly url: string;
  readonly ref: string;
  readonly commit: string;
  readonly entries: readonly Entry[];
  readonly warning?: string;
}

interface Row {
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly value: string;
}

const TABS: Readonly<Record<View, { title: string; other: View; otherLabel: string }>> = {
  catalog: { title: "Git skills · catalog", other: "project", otherLabel: "Project" },
  project: { title: "Git skills · project", other: "catalog", otherLabel: "Catalog" },
};

async function scanAll(targets: readonly Target[]): Promise<Scan[]> {
  const scans: Scan[] = [];
  for (const target of targets) {
    const checkout = await ensureCheckout({ url: target.url, ref: target.ref });
    if (checkout.commit === "") continue;
    const discovery = await discover(checkout.dir);
    scans.push({
      url: target.url,
      ref: target.ref,
      commit: checkout.commit,
      entries: discovery.entries,
      warning: checkout.warning,
    });
  }
  return scans;
}

function rowsForCatalog(
  scans: readonly Scan[],
  adoptedIds: ReadonlySet<string>,
  lists: { skills: readonly Item[]; agents: readonly Item[] },
): Row[] {
  const rows: Row[] = [];
  for (const scan of scans) {
    const target = { url: scan.url, ref: scan.ref };
    for (const entry of scan.entries) {
      if (adoptedIds.has(`${entry.kind}:${entry.id}`)) continue;
      const declared = declarationState(entry, target, lists);
      const prefix = declared === "enabled" ? "enabled — " : declared === "disabled" ? "disabled — " : "";
      rows.push({
        title: `${entry.kind} ${entry.id}`,
        description: `${prefix}${entry.description ?? entry.origin}`,
        category: shortLabel(target),
        value: encode({
          kind: entry.kind,
          id: entry.id,
          url: scan.url,
          ref: scan.ref,
          adopted: false,
        }),
      });
    }
  }
  return rows;
}

async function rowsForProject(
  scans: readonly Scan[],
  projectDir: string,
  lists: { skills: readonly Item[]; agents: readonly Item[] },
): Promise<Row[]> {
  const rows: Row[] = [];
  const adopted = await listAdopted(projectDir);

  for (const item of adopted) {
    let remote: string | undefined;
    try {
      const spec = parseSpec(item.provenance.id);
      const scan = scans.find((candidate) => candidate.url === spec.url && candidate.ref === spec.ref);
      const entry = scan ? findEntry({ entries: scan.entries, problems: [] }, item.kind, item.id) : undefined;
      if (entry) remote = await remoteDigest(entry);
    } catch {
      // provenance unreadable: report the local state only
    }
    const state = (await snapshot(item, remote)).state;
    rows.push({
      title: `${item.kind} ${item.id}`,
      description: `${STATE_LABEL[state]} · adopted · ${item.provenance.id}`,
      category: "adopted",
      value: encode(adoptedChoice(item.kind, item.id, item.provenance.id)),
    });
  }

  for (const [kind, items] of [
    ["skill", lists.skills],
    ["agent", lists.agents],
  ] as const) {
    for (const item of items) {
      let spec: Spec;
      try {
        spec = parseSpec(item.reference);
      } catch {
        rows.push({
          title: `${kind} ${item.reference}`,
          description: "malformed reference",
          category: "declared",
          value: "",
        });
        continue;
      }
      if (adopted.some((item) => item.kind === kind && item.id === spec.id)) continue;
      const scan = scans.find((candidate) => candidate.url === spec.url && candidate.ref === spec.ref);
      const entry = scan ? findEntry({ entries: scan.entries, problems: [] }, kind, spec.id) : undefined;
      rows.push({
        title: `${kind} ${spec.id}`,
        description: entry ? "enabled · from the repository" : "enabled · not found in the repository",
        category: shortLabel({ url: spec.url, ref: spec.ref }),
        value: encode({ kind, id: spec.id, url: spec.url, ref: spec.ref, adopted: false }),
      });
    }
  }

  return rows;
}

export default Plugin.define({
  id: "git-skills.browser",

  setup(context) {
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const projectDir = (): string => context.location?.directory ?? process.cwd();
    const toast = (message: string, variant: "success" | "error" | "info" = "info"): void => {
      void context.ui.toast.show({ title: "Git skills", message, variant, duration: 5000 });
    };

    const browse = async (): Promise<void> => {
      const lists = await readLists(projectDir());
      const targets = knownTargets(lists);
      const adopted = await listAdopted(projectDir());

      if (targets.length === 0 && adopted.length === 0) {
        toast("No repositories declared. Add one to the plugin's options.repos.");
        return;
      }

      const scans = await scanAll(targets);
      for (const scan of scans) if (scan.warning) toast(scan.warning, "error");

      let view: View = "catalog";
      for (;;) {
        const adoptedIds = new Set(adopted.map((item) => `${item.kind}:${item.id}`));
        const rows =
          view === "catalog"
            ? rowsForCatalog(scans, adoptedIds, lists)
            : await rowsForProject(scans, projectDir(), lists);

        let switched = false;
        const tab: { title: string; other: View; otherLabel: string } = TABS[view];

        try {
          context.ui.dialog.set({ size: "xlarge" });
        } catch {
          // The dialog may not be active yet on this build; the size is cosmetic.
        }

        const pending = context.ui.dialog.select({
          title: tab.title,
          placeholder:
            view === "catalog" ? "Search every known repository" : "Search what this project uses",
          options: rows,
          search: (query, all) =>
            all.filter((option) =>
              `${option.title} ${option.description ?? ""} ${option.category ?? ""}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ),
          actions: [
            view === "catalog"
              ? {
                  bind: "ctrl+a",
                  title: "Adopt",
                  onTrigger: (value) => void adopt(decode(String(value))),
                }
              : {
                  bind: "ctrl+u",
                  title: "Update",
                  onTrigger: (value) => void update(decode(String(value))),
                },
            view === "catalog"
              ? {
                  bind: "ctrl+e",
                  title: "Enable",
                  onTrigger: (value) => void enable(decode(String(value))),
                }
              : {
                  bind: "ctrl+d",
                  title: "Disable/Enable",
                  onTrigger: (value) => void toggle(decode(String(value))),
                },
            view === "catalog"
              ? {
                  bind: "ctrl+r",
                  title: "Refresh",
                  selection: "none",
                  onTrigger: () => void browse(),
                }
              : {
                  bind: "ctrl+x",
                  title: "Delete",
                  onTrigger: (value) => void remove(decode(String(value))),
                },
            {
              bind: "tab",
              title: tab.otherLabel,
              selection: "none",
              onTrigger: () => {
                switched = true;
                context.ui.dialog.clear();
              },
            },
          ],
        });
        // The dialog is active now, and `set` applies to the active one: this is
        // the order the documentation and opencode-quota both use.
        context.ui.dialog.set({ size: "xlarge", centered: true });

        const selected = await pending;

        if (switched) {
          view = tab.other;
          continue;
        }

        const choice = selected === undefined ? undefined : decode(String(selected));
        if (!choice) return;

        // Enter on a catalog row enables it; on a project row there is nothing
        // to enable, so it only reports.
        if (view === "catalog") await enable(choice);
        else toast(summaryOf(choice));
        return;
      }
    };

    function summaryOf(choice: Choice): string {
      return `${choice.kind} ${choice.id} · ${choice.adopted ? "adopted copy" : "enabled from a repository"}`;
    }

    async function enable(choice: Choice | undefined): Promise<void> {
      if (!choice) return;
      if (choice.adopted) {
        toast(`${choice.kind} ${choice.id} is an adopted copy; nothing to enable`);
        return;
      }
      const file = (await readLists(projectDir())).file;
      if (!file) {
        toast("No configuration file to edit", "error");
        return;
      }
      const key = choice.kind === "skill" ? "skills" : "agents";
      const reference = formatSpec({ id: choice.id, url: choice.url, ref: choice.ref });
      const text = await readConfig(file);
      const next = addToList(text, key, reference);
      if (next === text) {
        toast(`${choice.kind} ${choice.id} is already enabled`);
        return;
      }
      await writeConfig(file, next);
      toast(`${choice.kind} ${choice.id} enabled`, "success");
    }

    /**
     * Turns a declared reference off without losing it: the item stays in the
     * list with `enabled: false`, which the loader skips and the browser shows
     * as disabled. An adopted copy has no reference to keep, so it is deleted.
     */
    async function toggle(choice: Choice | undefined): Promise<void> {
      if (!choice) return;

      if (choice.adopted) {
        const item = (await listAdopted(projectDir())).find(
          (candidate) => candidate.kind === choice.kind && candidate.id === choice.id,
        );
        if (item) await removeAdopted(item);
        toast(`${choice.kind} ${choice.id} deleted`, "success");
        return;
      }

      const file = (await readLists(projectDir())).file;
      if (!file) return;
      const key = choice.kind === "skill" ? "skills" : "agents";
      const reference = formatSpec({ id: choice.id, url: choice.url, ref: choice.ref });
      const next = setEnabled(await readConfig(file), key, reference, choice.disabled === true);
      await writeConfig(file, next);
      toast(`${choice.kind} ${choice.id} ${choice.disabled ? "enabled" : "disabled"}`, "success");
    }

    /** Removes the reference from the configuration entirely. */
    async function remove(choice: Choice | undefined): Promise<void> {
      if (!choice) return;

      if (choice.adopted) {
        const item = (await listAdopted(projectDir())).find(
          (candidate) => candidate.kind === choice.kind && candidate.id === choice.id,
        );
        if (item) await removeAdopted(item);
        toast(`${choice.kind} ${choice.id} deleted`, "success");
        return;
      }

      const file = (await readLists(projectDir())).file;
      if (!file) return;
      const key = choice.kind === "skill" ? "skills" : "agents";
      const reference = formatSpec({ id: choice.id, url: choice.url, ref: choice.ref });
      const next = removeFromList(await readConfig(file), key, reference);
      if (next !== null) await writeConfig(file, next);
      toast(`${choice.kind} ${choice.id} removed from the project`, "success");
    }

    async function adopt(choice: Choice | undefined): Promise<void> {
      if (!choice) return;
      if (choice.adopted) {
        toast(`${choice.kind} ${choice.id} is already adopted`);
        return;
      }
      const conflict = await existingDefinition(projectDir(), choice.kind, choice.id);
      if (conflict) {
        toast(`${choice.kind} ${choice.id} already exists here, and was not adopted: ${conflict}`, "error");
        return;
      }
      const checkout = await ensureCheckout({ url: choice.url, ref: choice.ref });
      if (checkout.commit === "") {
        toast(`${choice.kind} ${choice.id}: repository unavailable`, "error");
        return;
      }
      const discovery = await discover(checkout.dir);
      const entry = findEntry({ entries: discovery.entries, problems: [] }, choice.kind, choice.id);
      if (!entry) {
        toast(`${choice.kind} ${choice.id} is not in the repository any more`, "error");
        return;
      }
      await adoptEntry({
        entry,
        projectDir: projectDir(),
        spec: { id: choice.id, url: choice.url, ref: choice.ref },
        commit: checkout.commit,
      });
      toast(`${choice.kind} ${choice.id} adopted`, "success");
    }

    async function update(choice: Choice | undefined): Promise<void> {
      if (!choice || !choice.adopted) {
        toast("Only an adopted copy can be updated", "error");
        return;
      }
      await adopt(choice);
    }

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

export type { State };