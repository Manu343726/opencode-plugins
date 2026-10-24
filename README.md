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
| [`git-skills`](git-skills/README.md) | Uses git repositories as per-project sources of skills and agents: declares `<id>@<url>:<ref>` references, registers them at startup, and can adopt an entry into the project with its provenance so drift is detectable | in use |

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
