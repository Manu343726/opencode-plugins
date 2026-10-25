# git-skills

An [OpenCode](https://opencode.ai) V2 plugin that makes **git repositories the source of skills
and agents**, declared per project. It is one of the plugins in
[`opencode-plugins`](../README.md), and the configuration below is the shape it takes when loaded
through that bundle.

A project lists what it uses. The plugin resolves each reference, shallow-clones it into a cache,
finds the entry and registers it for the session. Nothing is copied into the project unless you
ask to *adopt* it, and an adopted entry records where it came from so drift can be detected.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "git+ssh://git@forgejo:2222/manu343726/opencode-plugins.git#main",
      "options": {
        "plugins": ["git-skills"],
        "git-skills": {
          "skills": ["homelable-docs@ssh://git@forgejo:2222/homelab/Homelab.git:main"],
          "agents": [
            "reviewer@ssh://git@forgejo:2222/manu343726/agent-skills.git:v1.2.0",
            "team/orchestrator@ssh://git@forgejo:2222/manu343726/agent-skills.git"
          ],
          "repos": ["ssh://git@forgejo:2222/manu343726/agent-skills.git"]
        }
      }
    }
  ]
}
```

## Reference syntax

```
<id>@<git-url>[:<ref>]
```

- `id` — for a skill, a single lowercase segment (`.agents/skills/<id>/`); for an agent,
  lowercase segments joined by `/` (`team/reviewer`, matching `.opencode/agents/team/reviewer.md`).
- `ref` — a branch **or a tag**, since both are resolved with `git clone --branch`; a commit sha
  works too. Defaults to `main`.
- The URL is anything git accepts: `https://`, `ssh://`, an scp-like `git@host:path`, or a local
  path.

An item is a plain reference string while it is **enabled** — the implicit `enabled: true` — and
an object once it is turned off, so the state lives with the item instead of in a second list that
could disagree with the first:

```jsonc
"skills": [
  "homelable-docs@ssh://git@forgejo:2222/homelab/Homelab.git:main",
  { "reference": "system-monitoring@ssh://git@forgejo:2222/homelab/Homelab.git:main", "enabled": false }
]
```

A disabled reference is listed and not loaded: it costs no clone, and turning it back on is one edit
— the string form is written back, so the file stays compact.

The split is unambiguous because a git ref cannot contain `:`. The id ends at the first `@`;
after the scheme, the first `:` that appears after a `/` starts the ref; a colon before any `/`
belongs to the host or to the scp-like form. So `reviewer@ssh://git@host:2222/x.git:main` splits
into url `ssh://git@host:2222/x.git` and ref `main`, while the same string without `:main` keeps
the default ref rather than treating `2222/x.git` as one.

## What happens at startup

1. Every reference is parsed; a malformed one is reported and the rest still load.
2. Each `url+ref` pair is cloned once into `~/.cache/opencode/git-skills/<hash(url)>/<hash(ref)>/`
   (override with `cacheDir`). A repository is cloned **only** if a reference needs it — `repos[]`
   is for browsing, not for eager fetching.
3. Inside the checkout, skills are any directory holding a `SKILL.md` and are named after it;
   agents are Markdown files under `agents/`, `.opencode/agents/`, `.claude/agents/` or
   `.agents/agents/`, named after their path below that root.
4. Entries the project already owns are **not** registered: an adopted copy or a hand-written file
   always wins, so an id has exactly one definition in a session.
5. A failed refresh is not fatal: the cached tree is used and a warning is logged, because losing
   the network must not leave a project without its skills.

A repository that follows neither convention can declare itself:

```json
{
  "skills": { "documentation": "packs/docs" },
  "agents": { "team/reviewer": "packs/reviewer.md" }
}
```

A declared section replaces the convention for that kind.

## Global plus project

What a project sees is the **sum** of two configurations: the machine's
(`~/.config/opencode/opencode.jsonc`) and the project's own. The global one says what every
project gets; the project's adds what is dedicated to it.

The plugin reads both from disk and merges them by reference, because a plugin instance only
receives the options of the entry that loaded it. The project's entries come last and therefore
win, which is the only way for one project to turn off something declared for all of them.

**Content is not inherited from parent directories.** OpenCode merges the configuration of every
ancestor, so on a machine whose `$HOME` is itself a repository — this one — a configuration at the
root would otherwise leak into every project under it. The plugin reads the project's own file and
the machine's, and nothing in between: a project declares what it uses.

```jsonc
// global
"agents": ["docs-writer@ssh://git@forgejo:2222/homelab/Homelab.git:main"]

// project: the same reference, off — nothing else needs saying
"agents": [{ "reference": "docs-writer@ssh://git@forgejo:2222/homelab/Homelab.git:main", "enabled": false }]
```

## Options

| Option | Meaning |
|---|---|
| `skills` | References to register as skills |
| `agents` | References to register as agents |
| `repos` | Repositories to browse in the TUI without registering anything |
| `cacheDir` | Cache root (default `~/.cache/opencode/git-skills`) |
| `ttlMinutes` | How long a cached checkout is trusted before a refresh (default `5`) |
| `offline` | Never touch the network; use whatever is cached |
| `globalConfigDir` | Where global definitions live, so they win over remote ones (default `~/.config/opencode`) |

## Adopting

*Adopt* copies an entry into the project as if it had been written by hand:

| Kind | Destination |
|---|---|
| skill | `.agents/skills/<id>/` (all its files: `references/`, `scripts/`, …) |
| agent | `.opencode/agents/<id>.md` |

The copy is the project's file from then on — commit it, edit it, review it in a PR — and the
plugin stops registering the remote version of that id.

The frontmatter carries its provenance:

```yaml
metadata:
  opencode-git-skills:
    id: reviewer@https://git.example/homelab/skills.git:main
    commit: 9f3c1a2b8d4e5f60718293a4b5c6d7e8f9012345
    digest: sha256:4b1c…
```

`digest` is computed over the entry **without** the provenance block, with the frontmatter
re-serialised with sorted keys and the body newline-normalised. That makes it insensitive to
formatting — rewriting the block or moving a YAML key does not count as drift — and sensitive to
content: editing the body, a frontmatter value, a neighbouring file, or adding a file all change
it.

## State

| State | Meaning |
|---|---|
| `✓ in sync` | the local digest matches the recorded one and the entry at the ref is the same |
| `↑ update available` | the entry's files at the ref differ from the adopted ones |
| `✎ local changes` | the digest differs from the recorded one |
| `⚠ local changes + update` | both |
| `✗ gone from the repo` | the entry no longer exists at that id |

The comparison is by content, not by commit: an unrelated commit upstream does not mark an entry
as updatable. That was measured — on a repository where one skill changed, comparing commits
flagged two unrelated entries, and comparing digests did not.

Updating an entry with local changes asks first, because it overwrites them.

## Browsing

`/git-skills` (or **Browse git skills and agents** in the palette) opens one modal with two views.
`ctrl+t` moves between them, `esc` closes it, and each view has its own search box.

| Tab | Shows | Keys |
|---|---|---|
| **Catalog** | every entry in the known repositories, marked as enabled, disabled or absent | `enter` enable · `ctrl+a` adopt · `ctrl+t` project |
| **Project** | the references the project declares and the copies it owns, each with its state | `ctrl+u` update · `ctrl+d` enable/disable · `ctrl+x` delete · `ctrl+t` catalog |

*Disable* keeps the reference and flips `enabled` to `false` on the item; *enable* flips it back and
writes the compact string. *Delete* removes the item from the configuration entirely. On an adopted
copy there is no reference to keep, so `ctrl+d` deletes the copy and `ctrl+u` refreshes it from the
repository.

Adopting refuses when the id already exists in the project as a hand-written file — that file is the
project's, and replacing it with a copy of the repository's version would be a surprise, not a
feature.

## Refreshing from an agent session

A session loads these definitions when it starts, so a commit that lands afterwards changes nothing
by itself — and until now only the browser could pull it. `git_skills({ action: "refresh" })` is the
tool counterpart of the browser's refresh, and it calls the same code: `resolve()`, and through it
`git.ts:ensureCheckout`, which is the only thing in this plugin that clones or fetches. `scanTargets`
— the scan the modal runs — lives in `src/refresh.ts` so both halves use one implementation.

It fetches every reference the configuration names with the cache TTL bypassed, then reloads the two
registries and reports:

| Part | What it answers |
|---|---|
| references | each url+ref with its old and new sha, and whether it moved |
| changed / added / removed | the entries whose text differs, the fields that differ, and the files they came from |
| not in effect until a new session | an agent's `mode` and `permissions`, which the session resolved when it started |
| verified | whether the rebuilt registry actually holds the new text, read back after the reload |

Nothing changed upstream means "no change": the checkout is reused (no clone), and the registries are
not reloaded at all. A refresh that ran but was overridden does not read as success — it says which
entry the session still holds the old text of, because reporting `ok` over an inert reload is the
failure this tool exists to prevent.

## Proposing a change back

An adopted copy can be edited like any file, and those edits can go back to the repository they came
from. **`ctrl+p`** on a row of the Project tab asks for a pull request title and then:

1. clones — or refreshes — the source repository at the ref the copy was adopted from;
2. creates a branch `propose/<kind>-<id>-<timestamp>` from that commit;
3. copies the adopted files over the entry, commits with the title and a body carrying the diff,
   the file list and the provenance;
4. pushes the branch through the checkout's own remote, so it uses whatever credentials the machine
   already uses to reach that repository;
5. opens the change on the forge when a token is configured — otherwise it returns the compare URL
   and says what to do with it, including which harness tool can open it.

## Forges

The forge is read from the clone url, and each one is called with its own shape:

| Forge | Detected by | Endpoint | Header |
|---|---|---|---|
| **GitHub** | `github.com` | `api.github.com/repos/{o}/{r}/pulls` | `Authorization: Bearer` |
| **GitLab** | host containing `gitlab` | `/api/v4/projects/{o%2Fr}/merge_requests` | `PRIVATE-TOKEN` |
| **Forgejo / Gitea** | anything else, or an explicit `apiBase` | `/api/v1/repos/{o}/{r}/pulls` | `Authorization: token` |
| **Gerrit** | host containing `gerrit`, or the SSH port `29418` | none — a change is a push to `refs/for/<branch>` | — |

Gerrit is not a pull-request forge: the change **is** the commit pushed to `refs/for/`, and it needs
a `Change-Id` trailer. The plugin adds one when the message lacks it and pushes there, instead of
creating a branch nobody reviews.

When there is no token, the branch is pushed and the result says what to do: for a Forgejo host, that
the harness's `forgejo` MCP can open the pull request with `create_pull_request` and the head, base,
title and body this plugin already composed.

The body is composed from the change itself, never from a template that could describe something
else: `## What changed` carries `git diff --stat`, then the files, then an optional `## Details`, and
`## Where it came from` names the reference the copy was adopted from.

| Option | Meaning |
|---|---|
| `apiBase` | Web root of the forge, e.g. `https://git.example.com`. Needed for the compare URL and the pull request API; derivable from an `https://` clone URL, not from an SSH one. |
| `token` | Forge API token. Also read from `GIT_SKILLS_TOKEN`, then `FORGEJO_TOKEN`. Without it the branch is pushed and no pull request is opened. |

The agent side has the same power through the tool: `git_skills({ action: "propose" })` proposes every
adopted copy with local changes, one pull request each.

The adopted copy is never rewritten by proposing: the project keeps its version, and the provenance
keeps recording the commit it was taken from.

### The terminal half

Declaring the plugin is enough: OpenCode loads `exports["./tui"]` from the package alongside the
server entrypoint, so `/git-skills` is available without any extra file.

## Measured constraints

These came out of testing against OpenCode 2.0.31, and each one shapes the code:

- **A plugin package's entrypoint is `<package>/index.ts`.** It is not read from `package.json`
  `exports` or `main`: a package whose only entrypoint was `exports["."]` was skipped silently,
  with no log line at any level. The root `index.ts` and `tui.ts` here exist for that reason.
- **`AgentEditor` has no `add`.** `editor.update(id, …)` on a missing id creates the agent; that is
  measured, not documented, so it lives in `registerAgent` alone — one function and one test fail
  if a release stops doing it, instead of the feature vanishing quietly.
- **Agents are discovered only from `.opencode/agents/` and `~/.config/opencode/agents/`.**
  `.agents/agents/` is not a source (`Unknown agent`), while `.agents/skills/` *is* — which is why
  adopting a skill and adopting an agent land in different trees.
- **Agent frontmatter tolerates unknown keys**, including the `metadata` block used for provenance.
- **`/api/agent` and `/api/skill` do not list file-based definitions**, so the TUI reads the disk
  rather than asking the server.

### A project that uses the standard tree

`.agents/skills/` is discovered natively, `.agents/agents/` is not. The arrangement that keeps the
standard layout as the real home and still lets OpenCode find the agents is a symlink:

```
.agents/skills/<id>/SKILL.md              discovered as-is
.agents/agents/<id>.md                    the real file
.opencode/agents -> ../.agents/agents     the only path OpenCode reads for agents
```

Both were measured: the skill under `.agents/skills` appears in a fresh session, and the agent
behind the symlink answers when a subagent is launched. This plugin reads `.agents/agents` first
and deduplicates roots by real path, so the agent is listed once and its origin names the standard
tree.

## Not in scope

No server, no database, no publishing flow. The repository is the source and git is the transport.

## Development

```sh
node --test test/     # no build step; the sources are TypeScript run directly
npx tsc --noEmit
```

The core (reference parsing, cache, discovery, provenance, adoption, state) is free of OpenCode
APIs and is tested against real git repositories created in a temporary directory.

## License

MIT.
