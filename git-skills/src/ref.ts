/**
 * Parsing of the `id@url:ref` reference syntax.
 *
 * The grammar is ambiguous on purpose: a git URL may itself contain `@`
 * (`git@host:path`) and `:` (`host:2222`, `git@host:path`). The rule below is
 * the only one that resolves every form, because git refs cannot contain `:`
 * (see `git check-ref-format`):
 *
 *   - the id is everything before the FIRST `@`, and it may not be empty;
 *   - after the url scheme, the FIRST `:` that appears after the first `/`
 *     starts the ref — so `:feature/foo` is a ref with a slash, not a port;
 *   - a colon before any `/` belongs to the host (port) or to the scp-like
 *     `host:path` form, so it never starts a ref;
 *   - without a `/` at all, a second colon starts the ref;
 *   - no ref colon at all means the default ref.
 *
 * That is why `ssh://git@host:2222/x.git:main` splits into url
 * `ssh://git@host:2222/x.git` and ref `main`, while the same string without
 * the trailing `:main` keeps its default ref instead of mistaking `2222/x.git`
 * for a ref.
 */

export const DEFAULT_REF = "main";

export type Kind = "skill" | "agent";

export interface Spec {
  /** Local id: one segment for a skill, `/`-separated segments for an agent. */
  readonly id: string;
  /** Git url, exactly as written (no trailing `:ref`). */
  readonly url: string;
  /** Branch or tag. Never empty. */
  readonly ref: string;
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/** Splits a git URL into the URL itself and the ref, defaulting the ref. */
export function splitUrlAndRef(text: string): { url: string; ref: string } {
  const trimmed = text.trim();
  if (trimmed === "") throw new SpecError("empty git url");

  const scheme = trimmed.indexOf("://");
  const bodyStart = scheme >= 0 ? scheme + 3 : 0;
  const body = trimmed.slice(bodyStart);

  const slash = body.indexOf("/");
  if (slash >= 0) {
    const colon = body.indexOf(":", slash);
    if (colon < 0) return { url: trimmed, ref: DEFAULT_REF };
    return cut(trimmed, bodyStart + colon);
  }

  // No path separator: an scp-like `host:path` may still carry a second colon,
  // and that one is the ref. A colon at position 0 has no host before it, so
  // it is a ref with an empty url rather than an scp-like url.
  const first = body.indexOf(":");
  if (first === 0) return cut(trimmed, bodyStart);
  if (first > 0) {
    const second = body.indexOf(":", first + 1);
    if (second >= 0) return cut(trimmed, bodyStart + second);
  }
  return { url: trimmed, ref: DEFAULT_REF };
}

function cut(text: string, index: number): { url: string; ref: string } {
  const url = text.slice(0, index);
  const ref = text.slice(index + 1);
  if (url === "") throw new SpecError(`no url before the ref in ${JSON.stringify(text)}`);
  if (ref === "") throw new SpecError(`empty ref after the ':' in ${JSON.stringify(text)}`);
  return { url, ref };
}

/**
 * Parses one reference.
 *
 * Throws a `SpecError` whose message names the offending text, because the
 * caller reports it next to the config entry that produced it.
 */
export function parseSpec(text: string): Spec {
  if (typeof text !== "string") throw new SpecError("reference is not a string");
  const trimmed = text.trim();
  if (trimmed === "") throw new SpecError("empty reference");

  const at = trimmed.indexOf("@");
  if (at <= 0) {
    throw new SpecError(
      `expected "id@url:ref", got ${JSON.stringify(trimmed)} (no id before an '@')`,
    );
  }
  const id = trimmed.slice(0, at);
  const rest = trimmed.slice(at + 1);
  if (rest === "") throw new SpecError(`no url after the id in ${JSON.stringify(trimmed)}`);

  const { url, ref } = splitUrlAndRef(rest);
  return { id, url, ref };
}

const SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;
// An agent id is a path under `.opencode/agents`, so it may nest.
const AGENT_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Validates an id for its kind.
 *
 * A skill id must be a single segment: OpenCode derives the id of a
 * directory-based skill from its basename, so adopting `a/b` would land on
 * disk as `b` and the recorded provenance would point at an id that no longer
 * exists. An agent id may nest, because `.opencode/agents/team/reviewer.md`
 * is genuinely `team/reviewer`.
 */
export function validateId(kind: Kind, id: string): void {
  const pattern = kind === "skill" ? SKILL_ID : AGENT_ID;
  if (!pattern.test(id)) {
    const why =
      kind === "skill"
        ? "a skill id is a single lowercase segment"
        : "an agent id is lowercase segments joined by '/'";
    throw new SpecError(`invalid ${kind} id ${JSON.stringify(id)}: ${why}`);
  }
}

/** The canonical spelling of a reference, used as its identity everywhere. */
export function formatSpec(spec: Spec): string {
  return `${spec.id}@${spec.url}:${spec.ref}`;
}

/** Parses and validates in one step. */
export function parseReference(kind: Kind, text: string): Spec {
  const spec = parseSpec(text);
  validateId(kind, spec.id);
  return spec;
}