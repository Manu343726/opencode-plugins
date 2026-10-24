/**
 * The pure part of the browser: what the project knows about, and how a chosen
 * row is encoded.
 *
 * Kept apart from the TUI wiring so it can be tested without a terminal — the
 * dialog, the keymap and the toasts are the only untested surface left.
 */

import { parseSpec, type Kind } from "./ref.ts";
import { toItem, type Item, type ItemInput } from "./items.ts";

export interface Choice {
  readonly kind: Kind;
  readonly id: string;
  readonly url: string;
  readonly ref: string;
  readonly adopted: boolean;
  /** Declared in the project but turned off: still listed, not loaded. */
  readonly disabled?: boolean;
}

export interface Target {
  readonly url: string;
  readonly ref: string;
}

export function encode(choice: Choice): string {
  return JSON.stringify(choice);
}

/** Decodes a dialog value, rejecting anything that is not a well-formed choice. */
export function decode(value: string): Choice | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
  if (typeof candidate.url !== "string") return undefined;
  if (typeof candidate.ref !== "string") return undefined;
  if (candidate.kind !== "skill" && candidate.kind !== "agent") return undefined;
  return {
    kind: candidate.kind,
    id: candidate.id,
    url: candidate.url,
    ref: candidate.ref,
    adopted: candidate.adopted === true,
    ...(candidate.disabled === true ? { disabled: true } : {}),
  };
}

/**
 * Every url+ref the project knows about: the ones its references point at, plus
 * the ones listed in `repos[]`, which are for browsing only.
 *
 * Malformed references are skipped rather than thrown: the plugin reports them
 * when it resolves, and the browser should still open.
 */
export function knownTargets(lists: {
  readonly skills: readonly ItemInput[];
  readonly agents: readonly ItemInput[];
  readonly repos: readonly string[];
}): Target[] {
  const targets = new Map<string, Target>();
  const add = (text: string): void => {
    try {
      const spec = parseSpec(text);
      targets.set(`${spec.url}\0${spec.ref}`, { url: spec.url, ref: spec.ref });
    } catch {
      // reported elsewhere
    }
  };

  for (const item of lists.skills) add(toItem(item).reference);
  for (const item of lists.agents) add(toItem(item).reference);
  // A bare repository has no reference of its own, so it is browsed on the
  // default branch.
  for (const url of lists.repos) targets.set(`${url}\0main`, { url, ref: "main" });

  return [...targets.values()];
}

/**
 * The row for an adopted copy.
 *
 * Its provenance names the repository it came from, and the update action needs
 * that: an adopted row encoded with an empty url cannot be matched to a scanned
 * repository, so updating it answered "the entry is not in the repository any
 * more" — measured, and the reason this function exists.
 */
/**
 * Whether an entry is declared in the configuration, and whether it is on.
 *
 * `absent` is not a state of the project: it means the catalog row is only in
 * the repository. `disabled` is the interesting one — the reference is kept,
 * with `enabled: false` on the item itself, so re-enabling it is one edit.
 */
export function declarationState(
  entry: { kind: Kind; id: string },
  target: Target,
  lists: { readonly skills: readonly ItemInput[]; readonly agents: readonly ItemInput[] },
): "enabled" | "disabled" | "absent" {
  const items = (entry.kind === "skill" ? lists.skills : lists.agents).map(toItem);
  for (const item of items) {
    try {
      const spec = parseSpec(item.reference);
      if (spec.id === entry.id && spec.url === target.url && spec.ref === target.ref) {
        return item.enabled ? "enabled" : "disabled";
      }
    } catch {
      // a malformed entry is not a match
    }
  }
  return "absent";
}

export function adoptedChoice(kind: Kind, id: string, provenanceID: string): Choice {
  try {
    const spec = parseSpec(provenanceID);
    return { kind, id, url: spec.url, ref: spec.ref, adopted: true };
  } catch {
    return { kind, id, url: "", ref: "", adopted: true };
  }
}


/**
 * A short label for a repository, for a row where the width is shared.
 *
 * The dialog sizes the title column from what is left after the category, so a
 * full clone url as the category squeezes every title to a few characters —
 * measured: "skill homelab-control-dev" rendered as "skil" beside
 * "ssh://git@forgejo:2222/homelab/Homelab.git@main".
 */
export function shortLabel(target: Target): string {
  const withoutScheme = target.url.replace(/^[a-z+]+:\/\//i, "");
  const afterHost = withoutScheme.includes("/")
    ? withoutScheme.slice(withoutScheme.indexOf("/") + 1)
    : withoutScheme;
  const parts = afterHost.split("/").filter((part) => part !== "");
  const repo = parts.at(-1) ?? withoutScheme;
  const bare = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
  return `${bare}@${target.ref}`;
}
