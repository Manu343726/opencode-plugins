# subagent-monitor

Shows the agents working in the current session, as a widget in OpenCode's sidebar.

A background subagent is an ordinary child session — the `subagent` tool creates it with the
current session as its parent — so the panel reads the session tree the TUI already keeps live:
`data.session.family()` for the ids, `data.session.status()` for what each one is doing. Nothing
is polled from the server's agent list and nothing is asked of the model.

Running subagents are listed first, newest first, with the elapsed time since they started. A
finished one stays in the list marked `done`: "it ran and ended" is what a person looking for a
missing subagent needs to see.

## Using it

Nothing to open: it is part of the sidebar, next to the session, the way
[`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota) is. It claims
`sidebar.content`, so it is there while you work and there is nothing to close.

```
Subagents · 1 running · 1
● general  44s
○ explore  done
```

## How it is built

The plugin is plain TypeScript that calls OpenTUI's JSX runtime directly — `jsx(type, props)` from
`@opentui/solid/jsx-runtime`, which is exactly what the Solid compiler emits — and it pins
`@opentui/core` and `@opentui/solid` to **0.5.10**, the version OpenCode 2.0.31 itself runs.

That is not preference. Three things were measured, and each ruled out the obvious approach:

- A `.tsx` file in `.opencode/plugins/` is **not discovered**: the loader only picks up `.ts`/`.js`,
  and the file never appears in the log at any level.
- JSX inside a `.ts` file has no transform: Bun falls back to React and the plugin dies with
  `Cannot find package 'react'`.
- Importing `@opentui/solid` at 0.6.x loads a **second** `@opentui/core`, whose global registration
  collides with the host's: `Environment variable "OPENTUI_FORCE_UNICODE" is already registered with
  different configuration`. 0.6 renamed what that variable means; 0.5.10 is the version whose
  wording matches the host's.

`@slkiser/opencode-quota` is built the same way — its own `@opentui` at 0.5.10, its own `solid-js`,
and a compiled `dist/` — and it is the arrangement that loads.

## Verified

Driven in a real pty against OpenCode 2.0.31, in a project that declared the plugin and re-exported
its `tui.ts` from `.opencode/plugins/`:

```
Subagents · 0 running · 0 in this session
No subagents yet. An agent launched in the background appears here.
```

and, with a background subagent actually running:

```
Subagents · 1 running · 1 in this session
● general   Sleep 90 then report   44s
```

The elapsed time advances and a finished entry flips to `done`.

## Updating

When OpenCode ships a new OpenTUI, this pin has to move with it; the symptom of getting it wrong is
the plugin failing to load with the env-var message above, not a subtle rendering bug.
