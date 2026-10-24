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
● general              44s
  Sleep 90 then report
○ explore              done
  Summarise the changelog
```

The list has two presentations, chosen by the `view` option:

- **`work`** (default) — the work itself. A subagent that launched another hangs under it, indented,
  because an agent may delegate again and the tree is how that reads.
- **`agents`** — every agent the session can use, with its description and how busy it is (`idle`, or
  how many tasks are running with it), and each agent's tasks listed under it.

An agent is busy when a child session of this one is executing with it, so the count and the tasks
never disagree.

Each entry names the agent — in the colour its own definition gives it, the one OpenCode uses in
its banner — and the task’s title under it. The marker carries the outcome: **blue** while running,
**green** when it succeeded, **red** when it failed, **orange** when it was interrupted, and the
default colour when the widget mounted after it had already finished and there is no outcome to
report.

```jsonc
"subagent-monitor": { "view": "agents" }
```

A finished subagent disappears **five minutes** after it ended — long enough to notice it
finished, short enough that the list does not become a history of the session. The delay is the
plugin's `finishedTtlMinutes` option; `0` keeps them listed forever.

```jsonc
"subagent-monitor": { "finishedTtlMinutes": 2 }
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

Driven in a real pty against OpenCode 2.0.31, in a project that only declared the plugin:

```
Subagents · 2 running · 3 total
● orchestrator  12s
  Cut the work into workstreams
  ● verifier  3s
    Measure the build
  ○ docs-writer  ok
    Write the changelog
○ reviewer  ok
  Review the pull request
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
