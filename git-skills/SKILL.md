---
name: Git skills and agents
description: How this project gets skills and agents from git repositories — the reference syntax, the git_skills tool, the global-plus-project merge, adopting a copy with provenance, and what to do when something is missing
---

# Git skills and agents

This project loads **skills and agents from git repositories**, declared in its configuration. They
are not copied here unless someone adopts them. The plugin `git-skills` resolves them at startup and
registers them for the session.

## What is loaded, and from where

A reference is `<id>@<git-url>[:<ref>]`:

- `id` — a skill id is one lowercase segment; an agent id may nest (`team/reviewer`).
- `ref` — a branch or a tag, `main` by default.
- The url is anything git accepts. On this machine the repositories are private and reachable over
  `ssh://git@forgejo:2222/…`; the HTTPS url redirects to a login page and the clone fails.

What a project sees is the **sum** of two configurations: the machine's
(`~/.config/opencode/opencode.jsonc`) and the project's own (`opencode.jsonc` or
`.opencode/opencode.jsonc` in the project's directory). The project's entries come last and win, so
a project can turn off something the machine enables by writing only the override.

Content is **not** inherited from parent directories: a configuration in a directory above the
project is ignored. On this machine `$HOME` is itself a repository, and a configuration at its root
would otherwise appear in every project under it.

An item is a plain string while it is enabled, and an object once it is not:

```jsonc
"skills": [
  "homelable-docs@ssh://git@forgejo:2222/homelab/Homelab.git:main",
  { "reference": "system-monitoring@ssh://git@forgejo:2222/homelab/Homelab.git:main", "enabled": false }
]
```

A disabled reference stays in the configuration and is not loaded.

## The tool

`git_skills({ action })` answers three questions:

| action | answer |
|---|---|
| `status` | what is loaded right now, the commit each entry came from, and everything skipped and why |
| `references` | what the configuration declares, and which file it was read from |
| `adopted` | the copies the project owns, and whether each drifted from its repository |
| `propose` | pushes the local changes of every drifted copy to a branch of its repository, and opens a pull request for each |

Use `status` before claiming a skill or agent is available: the session's own list is the truth, and
an entry can be skipped because the project already defines it by hand, or because it is disabled.

## Reading the state of an adopted copy

Adopting copies an entry into the project as if it had been written here — a skill into
`.agents/skills/<id>/`, an agent into `.opencode/agents/<id>.md` — with its provenance in the
frontmatter:

```yaml
metadata:
  opencode-git-skills:
    id: reviewer@ssh://git@forgejo:2222/homelab/Homelab.git:main
    commit: 9f3c1a2b…
    digest: sha256:4b1c…
```

| State | Meaning |
|---|---|
| `✓ in sync` | the copy matches its repository |
| `↑ update available` | the entry at the branch differs; a tag never moves |
| `✎ local changes` | someone edited the copy |
| `⚠ local changes + update` | both |
| `✗ gone from the repo` | the entry no longer exists at that id |

The comparison is by content, not by commit: an unrelated commit upstream does not mark a copy as
outdated.

## Patterns

- **A skill is missing from the session.** Ask `git_skills status` first. The usual reasons, in
  order: the reference is not in the configuration, it is disabled, the project has its own file
  for that id (the local file wins), or the id does not exist in the repository — the status names
  which.
- **Adding a shared skill or agent.** Edit the project's configuration; do not copy files. The
  reference is the whole record.
- **Changing something for this project only.** Adopt it and edit the copy: adopting is what makes
  it the project's own, and the provenance keeps the drift visible.
- **Turning something off without losing it.** Set `enabled: false` on the item. Deleting the
  reference is a different intent.
- **Never edit `.agents/skills/<id>` by hand when it has provenance** without checking the state
  afterwards: the next `git_skills adopted` will report it as modified, which is correct but
  noisy if it was accidental.

## Configuration keys

| Key | Meaning |
|---|---|
| `skills` | references to register as skills |
| `agents` | references to register as agents |
| `repos` | repositories to browse without registering anything |
| `cacheDir` | where checkouts live (default `~/.cache/opencode/git-skills`) |
| `ttlMinutes` | how long a cached checkout is trusted before a refresh (default 5) |
| `offline` | never touch the network; use whatever is cached |

The terminal side adds `/git-skills`: one modal with a **Catalog** of everything the known
repositories hold and a **Project** view of what this project uses, each row carrying its state.
`enter` enables, `ctrl+a` adopts, `ctrl+u` updates a copy, `ctrl+d` enables or disables an item,
`ctrl+x` deletes it from the configuration, `ctrl+t` switches view.
