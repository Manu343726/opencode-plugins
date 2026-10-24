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
  for (const candidate of CANDIDATES) {
    const absolute = path.join(projectDir, candidate);
    try {
      await fs.stat(absolute);
      return absolute;
    } catch {
      // keep looking
    }
  }

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

function newEntry(listKey: ListKey, value: string): Record<string, unknown> {
  return { package: PACKAGE_NAME, options: { [listKey]: [value] } };
}

/**
 * Adds a value to one of the plugin's lists.
 *
 * When the project has no entry for the plugin yet, the entry is appended with
 * the value already in it, so one call is enough to start using a repository.
 */
export function addToList(text: string, listKey: ListKey, value: string): string {
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
  if (Array.isArray(current) && current.includes(value)) return text;
  if (Array.isArray(current)) return apply(text, [...path, -1], value);
  return apply(text, path, [value]);
}

/** Removes a value from one of the plugin's lists, leaving the rest untouched. */
export function removeFromList(text: string, listKey: ListKey, value: string): string {
  const found = locate(text);
  if (!found) return text;
  const current = found.scope.values[listKey];
  if (!Array.isArray(current)) return text;
  const index = current.indexOf(value);
  if (index < 0) return text;

  const path =
    found.scope.key === null
      ? ["plugins", found.index, "options", listKey]
      : ["plugins", found.index, "options", found.scope.key, listKey];
  return apply(text, [...path, index], undefined);
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
export async function readLists(projectDir: string): Promise<{
  file?: string;
  skills: string[];
  agents: string[];
  repos: string[];
}> {
  const file = await findConfigFile(projectDir);
  if (!file) return { skills: [], agents: [], repos: [] };
  const text = await readConfig(file);
  const found = locate(text);
  const values = found?.scope.values ?? {};
  const list = (key: ListKey): string[] => {
    const value = values[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  return { file, skills: list("skills"), agents: list("agents"), repos: list("repos") };
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
