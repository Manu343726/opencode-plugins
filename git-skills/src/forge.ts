/**
 * The forges this plugin knows how to open a change on.
 *
 * Every one of them calls it something different and puts it at a different
 * path, so the shape of the request is decided here and nowhere else:
 *
 * | Forge | Endpoint | Header |
 * |---|---|---|
 * | GitHub | `/repos/{owner}/{repo}/pulls` | `Authorization: Bearer` |
 * | GitLab | `/projects/{namespace%2Frepo}/merge_requests` | `PRIVATE-TOKEN` |
 * | Forgejo / Gitea | `/api/v1/repos/{owner}/{repo}/pulls` | `Authorization: token` |
 * | Gerrit | none — a change is a push to `refs/for/<branch>` | — |
 *
 * Gerrit has no pull request to open: the change *is* the commit pushed to
 * `refs/for/`, and it needs a `Change-Id` trailer to be recognised. That is not
 * a detail this plugin may skip, so it is modelled here rather than treated as
 * an unknown forge.
 */

export type ForgeKind = "github" | "gitlab" | "forgejo" | "gerrit" | "unknown";

export interface Forge {
  readonly kind: ForgeKind;
  /** Where a human opens the web UI. */
  readonly webBase?: string;
  /** Where the API lives, when it is not the same host. */
  readonly apiBase?: string;
}

/** A change to open: one shape, translated per forge. */
export interface ChangeRequest {
  readonly owner: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface ChangeResult {
  readonly url?: string;
  readonly warnings: readonly string[];
}

/** Reads the forge out of the remote url. */
export function detectForge(url: string, apiBase?: string): Forge {
  const { host, port } = hostAndPort(url);
  const webBase = apiBase ?? (host ? `https://${host}` : undefined);

  if (host) {
    if (host === "github.com" || host.endsWith(".github.com")) {
      return { kind: "github", webBase, apiBase: apiBase ?? "https://api.github.com" };
    }
    if (host.includes("gitlab")) {
      return { kind: "gitlab", webBase, apiBase: apiBase };
    }
    // Gerrit is often just `review.<domain>`; its SSH port is the reliable tell,
    // and the host name is the other one.
    if (host.includes("gerrit") || port === "29418" || /\/gerrit\b/.test(url)) {
      return { kind: "gerrit", webBase };
    }
  }

  // A Forgejo or Gitea instance is the default for a self-hosted git that is not
  // one of the above: its API is the one this plugin was written against, and an
  // explicit `apiBase` says so without guessing.
  if (apiBase !== undefined) return { kind: "forgejo", webBase, apiBase };
  return { kind: host ? "forgejo" : "unknown", webBase, apiBase: webBase };
}

function hostAndPort(url: string): { host?: string; port?: string } {
  const trimmed = url.trim();

  const scp = /^[^@]+@([^:/]+)(?::(\d+))?[:/]/.exec(trimmed);
  if (scp?.[1]) return { host: scp[1], port: scp[2] };

  const withScheme = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::(\d+))?/i.exec(trimmed);
  return { host: withScheme?.[1], port: withScheme?.[2] };
}

/** The commit trailer Gerrit needs to group the revisions of one change. */
export function changeId(seed: string): string {
  let hash = 0x811c9dc5;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, "0").repeat(5).slice(0, 40);
  return `I${hex}`;
}

/** Adds the Change-Id to a commit message that lacks one. */
export function withChangeId(message: string, id: string): string {
  if (/^Change-Id: /m.test(message)) return message;
  return `${message.replace(/\s+$/, "")}\n\nChange-Id: ${id}\n`;
}

interface Request {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** The request each forge expects, so it can be asserted without a network. */
export function changeRequest(forge: Forge, change: ChangeRequest, token: string): Request | undefined {
  switch (forge.kind) {
    case "github":
      return {
        url: `${forge.apiBase ?? "https://api.github.com"}/repos/${change.owner}/${change.repo}/pulls`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
        body: { head: change.head, base: change.base, title: change.title, body: change.body },
      };

    case "gitlab":
      return {
        url: `${forge.webBase ?? forge.apiBase}/api/v4/projects/${encodeURIComponent(
          `${change.owner}/${change.repo}`,
        )}/merge_requests`,
        headers: { "content-type": "application/json", "private-token": token },
        body: {
          source_branch: change.head,
          target_branch: change.base,
          title: change.title,
          description: change.body,
        },
      };

    case "forgejo":
      return {
        url: `${forge.apiBase ?? forge.webBase}/api/v1/repos/${change.owner}/${change.repo}/pulls`,
        headers: { "content-type": "application/json", authorization: `token ${token}` },
        body: { head: change.head, base: change.base, title: change.title, body: change.body },
      };

    // Gerrit: no endpoint. The change is the push to `refs/for/<branch>`.
    case "gerrit":
    case "unknown":
      return undefined;
  }
}

/** Reads the URL a forge answers with, whatever it calls the field. */
export function urlFromResponse(forge: Forge, body: unknown): string | undefined {
  const record = body as Record<string, unknown> | undefined;
  if (!record) return undefined;
  const candidates = record.html_url ?? record.web_url ?? (record as { url?: unknown }).url;
  return typeof candidates === "string" ? candidates : undefined;
}

/**
 * Opens the change, or explains why it did not.
 *
 * A failure here never loses the work: the branch is already pushed, and the
 * caller keeps the compare URL.
 */
export async function openChange(
  forge: Forge,
  change: ChangeRequest,
  token: string,
): Promise<ChangeResult> {
  const request = changeRequest(forge, change, token);
  if (!request) {
    return {
      warnings: [
        forge.kind === "gerrit"
          ? "Gerrit has no pull request: the change is the commit pushed to refs/for/"
          : "this forge is not recognised: the branch is pushed, the change is yours to open",
      ],
    };
  }

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return { warnings: [`${forge.kind} refused the change: HTTP ${response.status} ${detail}`] };
  }

  const body: unknown = await response.json().catch(() => undefined);
  return { url: urlFromResponse(forge, body), warnings: [] };
}

/**
 * What to tell an agent when no token is configured but the harness may have a
 * tool that opens changes — on this machine the Forgejo MCP does.
 */
export function mcpHint(forge: Forge): string {
  switch (forge.kind) {
    case "github":
      return "If the harness has a GitHub tool for pull requests, it can open it with these values.";
    case "gitlab":
      return "If the harness has a GitLab tool for merge requests, it can open it with these values.";
    case "forgejo":
      return "If the harness has the forgejo MCP, `create_pull_request` takes owner, repo, head, base, title and body.";
    case "gerrit":
      return "For Gerrit, push the commit to refs/for/<branch> with a Change-Id trailer.";
    default:
      return "The branch is pushed; open the change from the repository's web UI.";
  }
}