# opencode-plugins

Personal [OpenCode](https://opencode.ai) plugins, one directory per plugin, loaded through a single
entrypoint.

Each plugin is self-contained: its own source, its own tests, its own README. The root `index.ts`
exists because OpenCode resolves a plugin package as `<package>/index.ts` — measured on 2.0.31, and
not through `package.json` `exports` or `main` — so a repository of plugins needs one entry that
reaches the others.

## Plugins

| Plugin | What it does | Status |
|---|---|---|
| [`git-skills`](git-skills/README.md) | Uses git repositories as per-project sources of skills and agents: declares `<id>@<url>:<ref>` references, registers them at startup, pulls them again on demand with the `git_skills` tool's `refresh` action, and can adopt an entry into the project with its provenance so drift is detectable | in use |
| [`subagent-monitor`](subagent-monitor/README.md) | Shows the agents working in the current session in the sidebar: running first, with elapsed time, finished ones marked done and gone five minutes later (`finishedTtlMinutes`) | new |

## Panels and the terminal half

Nothing extra to do: declaring the package is enough for both halves. OpenCode loads the server
entrypoint from `<package>/index.ts` and the terminal one from `exports["./tui"]` in the package's
`package.json`, so `/git-skills` and the sidebar appear as soon as a project lists the plugin.

```jsonc
"exports": { ".": "./index.ts", "./tui": "./tui.ts" }
```

That map is the contract: an earlier version of this README told projects to re-export the bundle
from `.opencode/plugins/` because a measurement had been taken before the package shipped `tui.ts`.
It is not needed, and the section that said so was wrong.

## Consuming a plugin

One package, one entry, and the plugin's own options nested under its name:

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
          "agents": ["homelab-reviewer@ssh://git@forgejo:2222/homelab/Homelab.git:main"]
        }
      }
    }
  ]
}
```

- `plugins` is optional. Absent, every plugin in this repository is activated.
- Each plugin reads only its own object, so two plugins can never collide on a key.
- Pin a tag instead of `:main` for a project that should not follow the branch.
- The URL must be one git can reach. These repositories are private and their HTTPS URL redirects
  to a login page, so `git clone` fails with `unable to update url base from redirect`; SSH works
  through this machine's `forgejo` alias.

A plugin can also be loaded on its own, from a checkout, while developing it:

```jsonc
{ "package": "/home/me/Projects/opencode-plugins/git-skills", "options": { "skills": [] } }
```

That path form is what the tests use; the bundle is what projects use.

## Layout

```
index.ts              the entrypoint: activates the plugins named in the configuration
tui.ts                the same for the terminal half, loaded from a project's plugins dir
package.json          one install, with the dependencies every plugin needs
git-skills/
  README.md           what the plugin does and how it is configured
  index.ts            the package entry for that plugin when loaded standalone
  src/                the implementation, free of OpenCode APIs where it can be
  test/               node --test, against real git repositories
```

Dependencies live at the root because a git-installed package installs only the root
`dependencies` — a plugin's own `package.json` is for standalone development, not for what the
loader installs.

## Development

```sh
npm install
npm test          # every plugin's tests
npm run typecheck
```

Adding a plugin is a directory, a README, and one line in `index.ts` and in the table above.

## License

MIT.
