/**
 * Turning a shared agent's Markdown file into OpenCode agent fields.
 *
 * The file is the same format a project uses under `.opencode/agents/`, so the
 * mapping is deliberately literal: what the file says is what the agent gets.
 * Fields this plugin does not map are reported instead of dropped silently,
 * because a shared agent that loses its permissions on the way in would be a
 * security surprise rather than a cosmetic one.
 */

import { splitFrontmatter } from "./provenance.ts";

export type Mode = "primary" | "subagent" | "all";

export interface Permission {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

export interface AgentFields {
  readonly name: string;
  readonly description?: string;
  readonly mode: Mode;
  readonly system: string;
  readonly hidden?: boolean;
  readonly color?: string;
  readonly steps?: number;
  readonly permissions?: readonly Permission[];
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string };
}

export interface AgentParse {
  readonly fields: AgentFields;
  readonly problems: readonly string[];
}

const MODES: readonly Mode[] = ["primary", "subagent", "all"];
const MAPPED = new Set([
  "name",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "permissions",
  "model",
  "metadata",
  "variant",
]);

function asMode(value: unknown, problems: string[]): Mode {
  if (value === undefined) return "primary";
  if (typeof value === "string" && (MODES as readonly string[]).includes(value)) return value as Mode;
  problems.push(`mode must be one of primary, subagent, all (got ${JSON.stringify(value)})`);
  return "primary";
}

function asPermissions(value: unknown, problems: string[]): Permission[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push("permissions must be a list of rules");
    return undefined;
  }
  const rules: Permission[] = [];
  for (const rule of value) {
    if (!rule || typeof rule !== "object") {
      problems.push("a permission rule is not an object");
      continue;
    }
    const { action, resource, effect } = rule as Record<string, unknown>;
    if (typeof action !== "string" || typeof resource !== "string" || typeof effect !== "string") {
      problems.push("a permission rule needs action, resource and effect");
      continue;
    }
    rules.push({ action, resource, effect });
  }
  return rules;
}

function asModel(value: unknown, problems: string[]): AgentFields["model"] {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push("model must be written as provider/model or provider/model#variant");
    return undefined;
  }
  const match = /^([^/#]+)\/([^#]+)(?:#(.+))?$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    problems.push(`model ${JSON.stringify(value)} is not provider/model or provider/model#variant`);
    return undefined;
  }
  return match[3] === undefined
    ? { providerID: match[1], id: match[2] }
    : { providerID: match[1], id: match[2], variant: match[3] };
}

/**
 * Reads an agent document into fields.
 *
 * `name` falls back to the id, which is what OpenCode does for an agent file
 * with no display name.
 */
export function parseAgent(text: string, id: string): AgentParse {
  const problems: string[] = [];
  const { data, body } = splitFrontmatter(text);

  for (const key of Object.keys(data)) {
    if (!MAPPED.has(key)) problems.push(`frontmatter field "${key}" is not applied to the agent`);
  }

  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : id;
  const description =
    typeof data.description === "string" && data.description.trim() !== ""
      ? data.description.trim()
      : undefined;

  const hidden = typeof data.hidden === "boolean" ? data.hidden : undefined;
  const color = typeof data.color === "string" ? data.color : undefined;
  const steps =
    typeof data.steps === "number" && Number.isFinite(data.steps) ? Math.trunc(data.steps) : undefined;

  return {
    fields: {
      name,
      description,
      mode: asMode(data.mode, problems),
      system: body,
      hidden,
      color,
      steps,
      permissions: asPermissions(data.permissions, problems),
      model: asModel(data.model, problems),
    },
    problems,
  };
}

/** Name and description of a skill document, with the id as the fallback. */
export function parseSkillMeta(
  text: string,
  id: string,
): { name: string; description: string; body: string } {
  const { data, body } = splitFrontmatter(text);
  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : id;
  const description =
    typeof data.description === "string" && data.description.trim() !== ""
      ? data.description.trim()
      : "";
  return { name, description, body };
}