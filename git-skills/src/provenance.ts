/**
 * Provenance: the block an adopted entry carries, and the digest that detects
 * local edits.
 *
 * The digest has to answer one question — "did a human change this file?" —
 * and it must not answer yes merely because the provenance block was rewritten
 * or a YAML key moved. So both sides of the comparison are pushed through the
 * same canonical form first: the provenance block removed, the frontmatter
 * re-serialised with sorted keys, the body newline-normalised.
 *
 * That makes the digest insensitive to formatting and sensitive to content,
 * which is what the state table in `state.ts` relies on.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** The key under `metadata` that marks an entry as adopted. */
export const PROVENANCE_KEY = "opencode-git-skills";

export interface Provenance {
  /** The reference it came from, in canonical `id@url:ref` form. */
  readonly id: string;
  /** The commit the copy was taken from. */
  readonly commit: string;
  /** Digest of the entry as adopted, with the provenance block excluded. */
  readonly digest: string;
}

export interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly raw?: string;
}

const OPEN = /^---\r?\n/;
const CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a Markdown document into its YAML frontmatter and its body. */
export function splitFrontmatter(text: string): Frontmatter {
  const match = OPEN.exec(text);
  if (!match) return { data: {}, body: normalizeBody(text) };

  const rest = text.slice(match[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { data: {}, body: normalizeBody(text) };

  const raw = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A frontmatter that does not parse is not ours to interpret; the entry is
    // treated as having none, so the caller reports it rather than guessing.
    data = {};
  }
  return { data, body: normalizeBody(body) };
}

function normalizeBody(body: string): string {
  const unified = body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return unified === "" ? "" : `${unified}\n`;
}

function serialize(frontmatter: string, body: string): string {
  if (frontmatter === "") return body;
  return `---\n${frontmatter}---\n${body}`;
}

function canonicalYaml(data: Record<string, unknown>): string {
  return stringifyYaml(data, { lineWidth: 0, sortMapEntries: true });
}

function withoutProvenance(data: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(data) as Record<string, unknown>;
  const metadata = copy.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const rest = { ...(metadata as Record<string, unknown>) };
    delete rest[PROVENANCE_KEY];
    if (Object.keys(rest).length === 0) delete copy.metadata;
    else copy.metadata = rest;
  }
  return copy;
}

/**
 * The canonical form of a document: provenance removed, keys sorted, body
 * normalised. Two files with the same content produce the same string no
 * matter how their YAML was laid out.
 */
export function canonicalize(text: string): string {
  const { data, body } = splitFrontmatter(text);
  const stripped = withoutProvenance(data);
  if (Object.keys(stripped).length === 0) return normalizeBody(body);
  return serialize(canonicalYaml(stripped), body);
}

/** Reads the provenance block, or `undefined` when the entry was not adopted. */
export function readProvenance(text: string): Provenance | undefined {
  const { data } = splitFrontmatter(text);
  const metadata = data.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const block = (metadata as Record<string, unknown>)[PROVENANCE_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const { id, commit, digest } = block as Record<string, unknown>;
  if (typeof id !== "string" || typeof commit !== "string" || typeof digest !== "string") {
    return undefined;
  }
  return { id, commit, digest };
}

/**
 * Writes the provenance block into a document, leaving everything else as it
 * was. The block goes under `metadata`, which OpenCode accepts and does not
 * interpret, so it never reaches the model as configuration.
 */
export function withProvenance(text: string, provenance: Provenance): string {
  const { data, body } = splitFrontmatter(text);
  const next = structuredClone(data) as Record<string, unknown>;
  const metadata =
    next.metadata && typeof next.metadata === "object" && !Array.isArray(next.metadata)
      ? { ...(next.metadata as Record<string, unknown>) }
      : {};
  metadata[PROVENANCE_KEY] = {
    id: provenance.id,
    commit: provenance.commit,
    digest: provenance.digest,
  };
  next.metadata = metadata;

  const ordered = Object.fromEntries(
    Object.entries(next).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return serialize(canonicalYaml(ordered), body);
}

export function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Every file under a directory, as `/`-joined relative paths, sorted. */
export async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  };

  await walk(root, "");
  return found.sort();
}

/**
 * Digest of an entry: a skill is every file under its directory, an agent is
 * its single Markdown file. The entry document is canonicalised; the other
 * files are hashed as bytes, because a script is not YAML.
 */
export async function digestEntry(directory: string, entryFile: string): Promise<string> {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(directory, relative);
    hash.update(`${relative}\0`);
    if (relative === entryFile) {
      hash.update(createHash("sha256").update(canonicalize(await fs.readFile(absolute, "utf8"))).digest());
    } else {
      hash.update(createHash("sha256").update(await fs.readFile(absolute)).digest());
    }
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Digest of a single Markdown file, for agents. */
export async function digestFile(file: string): Promise<string> {
  return digestOf(canonicalize(await fs.readFile(file, "utf8")));
}
