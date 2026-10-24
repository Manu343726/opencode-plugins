/**
 * The browser: one large modal with two tabs.
 *
 * **Catalog** lists every entry in the known repositories; **Project** lists
 * what this project uses, with the state of each item. `tab` moves between
 * them, each has a search box, and the footer names the keys that apply.
 *
 * It is a custom dialog (`dialog.show`) rather than `dialog.select` because the
 * documentation is explicit about it: `select` has no size option, and the way
 * to get a large dialog is to draw it. That also gives the tabs a real home,
 * instead of two openings of the same picker.
 */

import { jsx } from "@opentui/solid/jsx-runtime";
import { For, Show, createMemo, createSignal } from "solid-js";

import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

import {
  adoptedChoice,
  decode,
  encode,
  declarationState,
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
} from "./adopt.ts";
import { addToList, readConfig, readLists, removeFromList, setEnabled, writeConfig } from "./config.ts";
import { discover, findEntry, type Entry } from "./discover.ts";
import { ensureCheckout } from "./git.ts";
import { formatSpec, parseSpec, type Kind, type Spec } from "./ref.ts";
import type { Item } from "./items.ts";

const h = jsx as unknown as (type: unknown, props?: Record<string, unknown>) => unknown;

/** Rows drawn at once; the window scrolls around the selection. */
const WINDOW = 14;

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
  readonly state: string;
  readonly group: string;
  readonly choice: Choice | undefined;
}

interface Data {
  readonly lists: Awaited<ReturnType<typeof readLists>>;
  readonly scans: readonly Scan[];
  readonly adopted: Awaited<ReturnType<typeof listAdopted>>;
  readonly warnings: readonly string[];
}

async function scanAll(targets: readonly Target[]): Promise<{ scans: Scan[]; warnings: string[] }> {
  const scans: Scan[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    const checkout = await ensureCheckout({ url: target.url, ref: target.ref });
    if (checkout.warning) warnings.push(`${target.url}@${target.ref}: ${checkout.warning}`);
    if (checkout.commit === "") {
      if (!checkout.warning) warnings.push(`${target.url}@${target.ref}: no commit`);
      continue;
    }
    const discovery = await discover(checkout.dir);
    scans.push({
      url: target.url,
      ref: target.ref,
      commit: checkout.commit,
      entries: discovery.entries,
      warning: checkout.warning,
    });
  }
  return { scans, warnings };
}

async function load(projectDir: string): Promise<Data> {
  const lists = await readLists(projectDir);
  const { scans, warnings } = await scanAll(knownTargets(lists));
  const adopted = await listAdopted(projectDir);
  return { lists, scans, adopted, warnings };
}

function catalogRows(data: Data): Row[] {
  const adoptedIds = new Set(data.adopted.map((item) => `${item.kind}:${item.id}`));
  const rows: Row[] = [];

  for (const scan of data.scans) {
    const target = { url: scan.url, ref: scan.ref };
    for (const entry of scan.entries) {
      if (adoptedIds.has(`${entry.kind}:${entry.id}`)) continue;
      const state = declarationState(entry, target, data.lists);
      rows.push({
        title: `${entry.kind} ${entry.id}`,
        state: state === "absent" ? "in the repository" : state,
        group: shortLabel(target),
        choice: {
          kind: entry.kind,
          id: entry.id,
          url: scan.url,
          ref: scan.ref,
          adopted: false,
          ...(state === "disabled" ? { disabled: true } : {}),
        },
      });
    }
  }
  return rows;
}

async function projectRows(data: Data, projectDir: string): Promise<Row[]> {
  const rows: Row[] = [];

  for (const item of data.adopted) {
    let remote: string | undefined;
    try {
      const spec = parseSpec(item.provenance.id);
      const scan = data.scans.find((candidate) => candidate.url === spec.url && candidate.ref === spec.ref);
      const entry = scan ? findEntry({ entries: scan.entries, problems: [] }, item.kind, item.id) : undefined;
      if (entry) remote = await remoteDigest(entry);
    } catch {
      // unreadable provenance: report the local state only
    }
    const state = (await snapshot(item, remote)).state;
    rows.push({
      title: `${item.kind} ${item.id}`,
      state: `${STATE_LABEL[state]} · adopted`,
      group: "adopted",
      choice: adoptedChoice(item.kind, item.id, item.provenance.id),
    });
  }

  for (const [kind, items] of [
    ["skill", data.lists.skills],
    ["agent", data.lists.agents],
  ] as const) {
    for (const item of items) {
      let spec: Spec;
      try {
        spec = parseSpec(item.reference);
      } catch {
        rows.push({
          title: `${kind} ${item.reference}`,
          state: "malformed reference",
          group: "declared",
          choice: undefined,
        });
        continue;
      }
      if (data.adopted.some((entry) => entry.kind === kind && entry.id === spec.id)) continue;

      const scan = data.scans.find(
        (candidate) => candidate.url === spec.url && candidate.ref === spec.ref,
      );
      const entry = scan ? findEntry({ entries: scan.entries, problems: [] }, kind, spec.id) : undefined;
      rows.push({
        title: `${kind} ${spec.id}`,
        state: item.enabled ? "enabled" : "disabled",
        group: entry ? shortLabel({ url: spec.url, ref: spec.ref }) : "not in the repository",
        choice: {
          kind,
          id: spec.id,
          url: spec.url,
          ref: spec.ref,
          adopted: false,
          ...(item.enabled ? {} : { disabled: true }),
        },
      });
    }
  }

  return rows;
}

const LINE = (row: Row, selected: boolean): string =>
  `${selected ? "▸" : " "} ${row.title}  ${"·"}  ${row.state}  ${"·"}  ${row.group}`;

function Browser(props: {
  context: Context;
  directory: string;
  initial: Data;
  done: () => void;
}) {
  const [view, setView] = createSignal<View>("catalog");
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [data, setData] = createSignal<Data | undefined>(props.initial);
  const [project, setProject] = createSignal<Row[]>([]);
  const [busy, setBusy] = createSignal(true);
  const [failure, setFailure] = createSignal<string | undefined>(undefined);

  const reload = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      const loaded = await load(props.directory);
      setData(loaded);
      // The project view is the expensive one; a failure there must not hide
      // the catalog, so it is reported beside it rather than replacing it.
      try {
        setProject(await projectRows(loaded, props.directory));
      } catch (error) {
        setProject([]);
        setFailure(`project view: ${String(error)}`);
      }
    } catch (error) {
      setData(undefined);
      setProject([]);
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  };

  const all = createMemo<Row[]>(() => {
    const current = data();
    if (!current) return [];
    return view() === "catalog" ? catalogRows(current) : project();
  });

  const rows = createMemo<Row[]>(() => {
    const needle = query().trim().toLowerCase();
    const list = all();
    return needle === ""
      ? list
      : list.filter((row) => `${row.title} ${row.state} ${row.group}`.toLowerCase().includes(needle));
  });

  const offset = createMemo(() => {
    const total = rows().length;
    const index = Math.min(selected(), Math.max(0, total - 1));
    return Math.max(0, Math.min(index - WINDOW + 1, Math.max(0, total - WINDOW)));
  });

  const toast = (message: string, variant: "success" | "error" | "info" = "info"): void => {
    void props.context.ui.toast.show({ title: "Git skills", message, variant, duration: 5000 });
  };

  const current = (): Row | undefined => rows()[Math.min(selected(), Math.max(0, rows().length - 1))];

  const close = (): void => {
    props.context.ui.dialog.clear();
    props.done();
  };

  async function enable(choice: Choice | undefined): Promise<void> {
    if (!choice) return;
    if (choice.adopted) {
      toast(`${choice.kind} ${choice.id} is an adopted copy`);
      return;
    }
    if (choice.disabled) {
      await toggle(choice);
      return;
    }
    const file = (await readLists(props.directory)).file;
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
    await reload();
  }

  /** Keeps the reference and flips its state; an adopted copy is deleted instead. */
  async function toggle(choice: Choice | undefined): Promise<void> {
    if (!choice) return;
    if (choice.adopted) {
      const item = (await listAdopted(props.directory)).find(
        (candidate) => candidate.kind === choice.kind && candidate.id === choice.id,
      );
      if (item) await removeAdopted(item);
      toast(`${choice.kind} ${choice.id} deleted`, "success");
      await reload();
      return;
    }
    const file = (await readLists(props.directory)).file;
    if (!file) return;
    const key = choice.kind === "skill" ? "skills" : "agents";
    const reference = formatSpec({ id: choice.id, url: choice.url, ref: choice.ref });
    const next = setEnabled(await readConfig(file), key, reference, choice.disabled === true);
    await writeConfig(file, next);
    toast(`${choice.kind} ${choice.id} ${choice.disabled ? "enabled" : "disabled"}`, "success");
    await reload();
  }

  async function remove(choice: Choice | undefined): Promise<void> {
    if (!choice) return;
    const file = (await readLists(props.directory)).file;
    if (!file) return;
    const key = choice.kind === "skill" ? "skills" : "agents";
    const reference = formatSpec({ id: choice.id, url: choice.url, ref: choice.ref });
    await writeConfig(file, removeFromList(await readConfig(file), key, reference));
    if (choice.adopted) {
      const item = (await listAdopted(props.directory)).find(
        (candidate) => candidate.kind === choice.kind && candidate.id === choice.id,
      );
      if (item) await removeAdopted(item);
    }
    toast(`${choice.kind} ${choice.id} removed from the project`, "success");
    await reload();
  }

  async function adopt(choice: Choice | undefined): Promise<void> {
    if (!choice) return;
    if (choice.adopted) {
      toast(`${choice.kind} ${choice.id} is already adopted`);
      return;
    }
    const conflict = await existingDefinition(props.directory, choice.kind, choice.id);
    if (conflict) {
      toast(`${choice.kind} ${choice.id} exists here and was not adopted: ${conflict}`, "error");
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
      projectDir: props.directory,
      spec: { id: choice.id, url: choice.url, ref: choice.ref },
      commit: checkout.commit,
    });
    toast(`${choice.kind} ${choice.id} adopted`, "success");
    await reload();
  }

  const act = async (name: "enter" | "adopt" | "update" | "toggle" | "remove"): Promise<void> => {
    const row = current();
    if (!row?.choice) return;
    if (name === "enter") await enable(row.choice);
    if (name === "adopt") await adopt(row.choice);
    if (name === "update") await adopt(row.choice);
    if (name === "toggle") await toggle(row.choice);
    if (name === "remove") await remove(row.choice);
  };

  const onKey = (event: { name?: string; ctrl?: boolean; preventDefault?: () => void }): void => {
    const name = event.name ?? "";
    const stop = (): void => event.preventDefault?.();

    if (name === "escape") {
      stop();
      close();
      return;
    }
    if (name === "tab" || name === "left" || name === "right") {
      stop();
      const next: View = view() === "catalog" ? "project" : "catalog";
      if (name === "left" && view() === "catalog") return;
      if (name === "right" && view() === "project") return;
      setView(next);
      setSelected(0);
      return;
    }
    if (name === "up") {
      stop();
      setSelected((index) => Math.max(0, index - 1));
      return;
    }
    if (name === "down") {
      stop();
      setSelected((index) => Math.min(rows().length - 1, index + 1));
      return;
    }
    if (name === "return") {
      stop();
      void act("enter");
      return;
    }
    if (!event.ctrl) return;

    const actions: Record<string, "adopt" | "update" | "toggle" | "remove"> = {
      a: "adopt",
      u: "update",
      d: "toggle",
      x: "remove",
    };
    const action = actions[name];
    if (action) {
      stop();
      void act(action);
      return;
    }
    if (name === "r") {
      stop();
      void reload();
    }
  };

  const muted = (): string | undefined => props.context.theme?.text?.muted;
  const accent = (): string | undefined => props.context.theme?.text?.accent;

  /**
   * Everything reactive is a getter.
   *
   * Without the Solid compiler nothing wraps an expression in one for us: a
   * prop holding a computed value is evaluated once, at build time, and the
   * dialog then shows the values it was born with — measured as a modal stuck
   * on "Loading…" with zero items while the load itself took 164 ms. Passing
   * `() => …` is what the compiler would have produced.
   */
  const visible = (): Row[] => rows().slice(offset(), offset() + WINDOW);
  const selectedRow = (): Row | undefined => current();

  const tab = (id: View, label: string) =>
    h("text", {
      fg: () => (view() === id ? accent() : muted()),
      children: () => (view() === id ? `[${label}]` : ` ${label} `),
    });

  return h("box", {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    gap: 0,
    children: [
      h("box", {
        flexDirection: "row",
        gap: 2,
        children: [tab("catalog", "Catalog"), tab("project", "Project")],
      }),
      h("input", {
        focused: true,
        placeholder: "Search",
        onInput: (value: string) => {
          setQuery(value);
          setSelected(0);
        },
        onKeyDown: onKey,
      }),
      h(Show, {
        when: () => !busy() && rows().length > 0,
        fallback: () =>
          h("text", {
            fg: () => muted(),
            children: () =>
              busy() ? "Loading…" : (failure() ?? "Nothing matches."),
          }),
        children: () =>
          h(For, {
            each: visible(),
            children: (row: Row) =>
              h("text", {
                fg: () => (selectedRow() === row ? undefined : muted()),
                children: () => LINE(row, selectedRow() === row),
              }),
          }),
      }),
      h("text", {
        fg: () => muted(),
        children: () =>
          view() === "catalog"
            ? "enter enable · ctrl+a adopt · ctrl+d disable · → project · esc close"
            : "enter enable · ctrl+u update · ctrl+d enable/disable · ctrl+x delete · ← catalog · esc close",
      }),
      h("text", {
        fg: () => muted(),
        children: () => `${rows().length} item(s) · ${props.directory}`,
      }),
      h(Show, {
        when: () => (data()?.warnings.length ?? 0) > 0,
        children: () =>
          h("text", {
            fg: () => props.context.theme?.text?.error,
            children: () => data()?.warnings.join(" · ") ?? "",
          }),
      }),
    ],
  });
}

export default Plugin.define({
  id: "git-skills.browser",

  setup(context) {
    const terminal = context as unknown as { keymap?: { layer?: unknown } };
    if (typeof terminal.keymap?.layer !== "function") return;

    const projectDir = (): string => context.location?.directory ?? process.cwd();

    /**
     * The data is loaded before the dialog is shown, in the command's own
     * context. Loading inside the component did not work: the modal painted its
     * chrome and stayed on "Loading…" with zero items, with no error and no log
     * line, while the same load takes 164 ms when called directly.
     */
    const browse = async (): Promise<void> => {
      const directory = projectDir();
      let initial: Data;
      try {
        initial = await load(directory);
      } catch (error) {
        void context.ui.toast.show({
          title: "Git skills",
          message: `Could not read the repositories: ${String(error)}`,
          variant: "error",
          duration: 8000,
        });
        return;
      }

      await new Promise<void>((resolve) => {
        context.ui.dialog.show(
          () => h(Browser, { context, directory, initial, done: resolve }),
          () => resolve(),
        );
        // The documentation's own order: show, then size the dialog that is open.
        context.ui.dialog.set({ size: "xlarge", centered: true });
      });
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

export { encode, decode };
export type { Choice };