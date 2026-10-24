/**
 * Reading and editing the project configuration.
 *
 * The plugin has no top-level config key: the OpenCode schema rejects unknown
 * roots, so everything lives in its `plugins` entry `options`. Editing that by
 * hand is fine, but the TUI adds and removes references, so the edit has to
 * preserve comments, formatting and every unrelated setting — which is why it
 * goes through `jsonc-parser` and applies a minimal patch instead of
 * re-serialising the document.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser";

import { parseItems, storedForm, toItem, type Item, type ItemInput } from "./items.ts";

/**
 * A list item is a reference string when it is enabled, which is the implicit
 * `enabled: true` this plugin assumes everywhere: `"a@url:ref"` and
 * `{ "reference": "a@url:ref", "enabled": true }` are the same item, and the
 * second form is never written — only the object that turns something off is.
 */

/** How the plugin recognises its own entry in `plugins`. */
export const PACKAGE_NAME = "opencode-git-skills";

/** How the bundle recognises itself in `plugins`. */
export const BUNDLE_NAME = "opencode-plugins";

/**
 * The key this plugin's options live under when it is loaded through the
 * `opencode-plugins` bundle. Its lists are nested one level down there, so that
 * two plugins in the same bundle cannot collide on a key; loaded on its own,
 * they stay at the top of the entry's `options`.
 */
export const PLUGIN_KEY = "git-skills";

export type ListKey = "skills" | "agents" | "repos";

export interface FoundEntry {
  readonly index: number;
  readonly options: Record<string, unknown>;
}

const CANDIDATES = [
  ".opencode/opencode.jsonc",
  ".opencode/opencode.json",
  "opencode.jsonc",
  "opencode.json",
];

/** Where the machine's own configuration lives. */
export function globalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (override && override.trim() !== "") return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

/**
 * The configuration file that governs a directory, preferring the project's own.
 *
 * A plugin installed globally — the normal case for personal plugins — has its
 * entry in `~/.config/opencode/opencode.json(c)` and no project file at all, so
 * falling back to the global one is what makes the browser show anything in a
 * project that declares nothing. Measured: without the fallback, `references`
 * answered "(no project config)" in the repository that installed the plugin
 * globally.
 */
export async function findConfigFile(projectDir: string): Promise<string | undefined> {
  return (await findProjectConfigFile(projectDir)) ?? (await findGlobalConfigFile());
}

/** The path the TUI creates when the project has no configuration yet. */
export function defaultConfigFile(projectDir: string): string {
  return path.join(projectDir, ".opencode", "opencode.jsonc");
}

function isOurEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(PACKAGE_NAME) || value.includes(BUNDLE_NAME);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      typeof record.package === "string" &&
      (record.package.includes(PACKAGE_NAME) || record.package.includes(BUNDLE_NAME))
    );
  }
  return false;
}

function isBundle(value: unknown): boolean {
  if (typeof value === "string") return value.includes(BUNDLE_NAME);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return typeof record.package === "string" && record.package.includes(BUNDLE_NAME);
  }
  return false;
}

/**
 * Where this plugin's options are, in the entry it was found in.
 *
 * The bundle nests them under `PLUGIN_KEY`; a standalone installation has them
 * at the top. Reading the wrong level is silent — the lists come back empty —
 * which is exactly the bug this function exists to prevent.
 */
function optionScope(
  entry: FoundEntry,
  bundle: boolean,
): { readonly key: string | null; readonly values: Record<string, unknown> } {
  const nested = entry.options[PLUGIN_KEY];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { key: PLUGIN_KEY, values: nested as Record<string, unknown> };
  }
  if (bundle) return { key: PLUGIN_KEY, values: {} };
  return { key: null, values: entry.options };
}

/** The first entry of ours, with where its options live and whether it is the bundle. */
function locate(text: string): {
  readonly index: number;
  readonly bundle: boolean;
  readonly scope: { readonly key: string | null; readonly values: Record<string, unknown> };
} | undefined {
  const errors: ParseError[] = [];
  const data: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !data || typeof data !== "object") return undefined;
  const plugins = (data as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return undefined;

  for (let index = 0; index < plugins.length; index += 1) {
    const entry = plugins[index];
    if (!isOurEntry(entry)) continue;
    const options =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? ((entry as Record<string, unknown>).options as Record<string, unknown> | undefined) ?? {}
        : {};
    const bundle = isBundle(entry);
    return { index, bundle, scope: optionScope({ index, options }, bundle) };
  }
  return undefined;
}

/** Every entry of ours in a document, with its index and options. */
export function findEntries(text: string): FoundEntry[] {
  const errors: ParseError[] = [];
  const data: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !data || typeof data !== "object") return [];
  const plugins = (data as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return [];

  const found: FoundEntry[] = [];
  plugins.forEach((entry, index) => {
    if (!isOurEntry(entry)) return;
    const options =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? ((entry as Record<string, unknown>).options as Record<string, unknown> | undefined) ?? {}
        : {};
    found.push({ index, options });
  });
  return found;
}

export function describeParseErrors(text: string): string | undefined {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length === 0) return undefined;
  const first = errors[0];
  if (!first) return undefined;
  return `${printParseErrorCode(first.error)} at offset ${first.offset}`;
}

function apply(text: string, pathToValue: (string | number)[], value: unknown): string {
  const edits = modify(text, pathToValue, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(text, edits);
}

function newEntry(
  listKey: ListKey,
  value: string | { reference: string; enabled: false },
): Record<string, unknown> {
  return { package: PACKAGE_NAME, options: { [listKey]: [value] } };
}

/**
 * Adds a value to one of the plugin's lists.
 *
 * When the project has no entry for the plugin yet, the entry is appended with
 * the value already in it, so one call is enough to start using a repository.
 */
export function addToList(text: string, listKey: ListKey, value: string | { reference: string; enabled: false }): string {
  const found = locate(text);

  if (!found) {
    const errors: ParseError[] = [];
    const data: unknown = parse(text, errors, { allowTrailingComma: true });
    const plugins =
      data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).plugins)
        ? ((data as Record<string, unknown>).plugins as unknown[])
        : undefined;
    if (plugins) return apply(text, ["plugins", -1], newEntry(listKey, value));
    return apply(text, ["plugins"], [newEntry(listKey, value)]);
  }

  const path =
    found.scope.key === null
      ? ["plugins", found.index, "options", listKey]
      : ["plugins", found.index, "options", found.scope.key, listKey];

  const current = found.scope.values[listKey];
  const existing = Array.isArray(current) ? current : [];

  const wanted = typeof value === "string" ? value : value.reference;
  const index = existing.findIndex((entry) =>
    typeof entry === "string" ? entry === wanted : entry?.reference === wanted,
  );
  if (index >= 0) {
    // Present already: the only thing that may change is its state.
    return apply(text, [...path, index], value);
  }
  return apply(text, [...path, -1], value);
}

/** Removes a value from one of the plugin's lists, leaving the rest untouched. */
export function removeFromList(text: string, listKey: ListKey, value: string): string {
  const found = locate(text);
  if (!found) return text;
  const current = found.scope.values[listKey];
  if (!Array.isArray(current)) return text;
  const index = current.findIndex((entry) =>
    typeof entry === "string" ? entry === value : entry?.reference === value,
  );
  if (index < 0) return text;

  const path =
    found.scope.key === null
      ? ["plugins", found.index, "options", listKey]
      : ["plugins", found.index, "options", found.scope.key, listKey];
  return apply(text, [...path, index], undefined);
}

/**
 * Merges item lists by reference: later sources win.
 *
 * This is what makes a project see the sum of the global configuration and its
 * own. The global file says what every project gets; the project file adds what
 * is dedicated to it, and may also override the state of an inherited entry —
 * which is the only way to turn off, in one project, something declared for all
 * of them.
 */
export function mergeItems(sources: readonly (readonly ItemInput[])[]): Item[] {
  const merged: Item[] = [];
  const index = new Map<string, number>();

  for (const source of sources) {
    for (const raw of source) {
      const item = toItem(raw);
      const at = index.get(item.reference);
      if (at === undefined) {
        index.set(item.reference, merged.length);
        merged.push(item);
      } else {
        merged[at] = item;
      }
    }
  }
  return merged;
}

export async function readConfig(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }
}

export async function writeConfig(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

/** Reads the plugin's lists from a project, tolerating every absence. */
export interface Lists {
  readonly file?: string;
  readonly files: readonly string[];
  readonly skills: Item[];
  readonly agents: Item[];
  readonly repos: string[];
  readonly problems: string[];
}

async function listsFrom(file: string): Promise<{
  skills: Item[];
  agents: Item[];
  repos: string[];
  problems: string[];
}> {
  const text = await readConfig(file);
  const found = locate(text);
  const values = found?.scope.values ?? {};
  const problems: string[] = [];
  const items = (key: "skills" | "agents"): Item[] => {
    const parsed = parseItems(values[key]);
    for (const problem of parsed.problems) problems.push(`${path.basename(file)}: ${key}: ${problem}`);
    return [...parsed.items];
  };
  const repos = Array.isArray(values.repos)
    ? values.repos.filter((item): item is string => typeof item === "string")
    : [];
  return { skills: items("skills"), agents: items("agents"), repos, problems };
}

/**
 * Every list a directory sees: the global configuration first, then its own.
 *
 * The order is the rule — global entries apply everywhere, the project's entries
 * add to them and may override an inherited one's state, which is how a project
 * turns off something declared for all projects.
 */
export async function readLists(projectDir: string): Promise<Lists> {
  const projectFile = await findProjectConfigFile(projectDir);
  const globalFile = await findGlobalConfigFile();

  const sources: string[] = [];
  if (globalFile) sources.push(globalFile);
  if (projectFile && projectFile !== globalFile) sources.push(projectFile);
  if (sources.length === 0) {
    return { files: [], skills: [], agents: [], repos: [], problems: [] };
  }

  const read = await Promise.all(sources.map((file) => listsFrom(file)));
  const skills = mergeItems(read.map((entry) => entry.skills));
  const agents = mergeItems(read.map((entry) => entry.agents));
  const repos = [...new Set(read.flatMap((entry) => entry.repos))];

  return {
    file: projectFile ?? globalFile,
    files: sources,
    skills,
    agents,
    repos,
    problems: read.flatMap((entry) => entry.problems),
  };
}

/** The project's own configuration, without the global fallback. */
export async function findProjectConfigFile(projectDir: string): Promise<string | undefined> {
  for (const candidate of CANDIDATES) {
    const absolute = path.join(projectDir, candidate);
    try {
      await fs.stat(absolute);
      return absolute;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The machine's configuration. */
export async function findGlobalConfigFile(): Promise<string | undefined> {
  const globalDir = globalConfigDir();
  for (const candidate of CANDIDATES) {
    const absolute = path.join(globalDir, candidate);
    try {
      await fs.stat(absolute);
      return absolute;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Applies one edit to the project's configuration file. */
export async function editList(
  projectDir: string,
  listKey: ListKey,
  value: string,
  action: "add" | "remove",
): Promise<{ file: string; text: string }> {
  const file = (await findConfigFile(projectDir)) ?? defaultConfigFile(projectDir);
  const text = await readConfig(file);
  const next =
    action === "add" ? addToList(text, listKey, value) : removeFromList(text, listKey, value);
  if (next !== text) await writeConfig(file, next);
  return { file, text: next };
}

/**
 * Sets the enabled state of a reference that is already in the list.
 *
 * Enabling writes the plain string back — the compact form every existing
 * configuration uses — and disabling writes the object, so the file stays
 * readable and the state cannot drift from the item it belongs to.
 */
export function setEnabled(text: string, listKey: "skills" | "agents", reference: string, enabled: boolean): string {
  const found = locate(text);
  if (!found) return text;

  const current = found.scope.values[listKey];
  const existing = Array.isArray(current) ? current : [];
  const index = existing.findIndex((entry) =>
    typeof entry === "string" ? entry === reference : entry?.reference === reference,
  );

  // Not in this file: it is inherited from the global one, so write an override
  // here. That is what lets a project turn off what every project receives, and
  // it is also the path taken when the list does not exist yet.
  if (index < 0) return addToList(text, listKey, storedForm({ reference, enabled }));

  const path =
    found.scope.key === null
      ? ["plugins", found.index, "options", listKey]
      : ["plugins", found.index, "options", found.scope.key, listKey];

  return apply(text, [...path, index], storedForm({ reference, enabled }));
}

/**
 * The project's own configuration, when it declares this plugin.
 *
 * A plugin loaded from an ancestor directory is loaded *because of that
 * directory*, not because of this project: on a machine whose `$HOME` is a
 * repository, everything under it inherits the entry. This is what lets the
 * plugin stay dormant where nobody asked for it.
 */
export async function projectDeclaresPlugin(projectDir: string): Promise<string | undefined> {
  const file = await findProjectConfigFile(projectDir);
  if (!file) return undefined;
  const text = await readConfig(file);
  return locate(text) === undefined ? undefined : file;
}
