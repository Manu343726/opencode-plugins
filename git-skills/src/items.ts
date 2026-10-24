/**
 * The items of a `skills` or `agents` list.
 *
 * An item is a plain reference string when it is enabled — the common case, and
 * what every existing configuration has — or an object carrying the reference
 * and its state:
 *
 *   "skills": [
 *     "homelable-docs@ssh://…:main",
 *     { "reference": "system-monitoring@ssh://…:main", "enabled": false }
 *   ]
 *
 * The state lives with the item rather than in a second list, because a second
 * list can disagree with the first: a reference present in both is neither
 * clearly on nor clearly off, and deleting one leaves the other behind.
 */

export interface Item {
  readonly reference: string;
  /** Missing means enabled: a plain string is the enabled form. */
  readonly enabled: boolean;
}

export interface ParsedItems {
  readonly items: readonly Item[];
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseItems(values: unknown): ParsedItems {
  if (!Array.isArray(values)) return { items: [], problems: [] };

  const items: Item[] = [];
  const problems: string[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      const reference = value.trim();
      if (reference !== "") items.push({ reference, enabled: true });
      continue;
    }

    if (isRecord(value)) {
      const reference = value.reference;
      if (typeof reference !== "string" || reference.trim() === "") {
        problems.push(`an item is an object without a "reference" string: ${JSON.stringify(value)}`);
        continue;
      }
      const enabled = value.enabled;
      if (enabled !== undefined && typeof enabled !== "boolean") {
        problems.push(`"enabled" must be a boolean in ${JSON.stringify(value)}`);
        continue;
      }
      items.push({ reference: reference.trim(), enabled: enabled !== false });
      continue;
    }

    problems.push(`an item is neither a reference nor an object: ${JSON.stringify(value)}`);
  }

  return { items, problems };
}

/** The enabled items, which are the ones the plugin loads. */
export function enabledItems(items: readonly Item[]): Item[] {
  return items.filter((item) => item.enabled);
}

/** The on-disk form: a string while enabled, an object once it is turned off. */
export function storedForm(item: Item): string | { reference: string; enabled: false } {
  return item.enabled ? item.reference : { reference: item.reference, enabled: false };
}

export function findItem(items: readonly Item[], reference: string): Item | undefined {
  const wanted = reference.trim();
  return items.find((item) => item.reference === wanted);
}
/** What a caller may hand us: the parsed item, or just its reference. */
export type ItemInput = string | Item;

export function toItem(value: ItemInput): Item {
  return typeof value === "string" ? { reference: value.trim(), enabled: true } : value;
}
