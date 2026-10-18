# claude-agents-tui

[![Tests](https://github.com/AchiboldThanyani/claude-agents-tui/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/AchiboldThanyani/claude-agents-tui/actions/workflows/test.yml)

A live terminal view of your running Claude Code sessions and their subagents.

![claude-agents showing a session with nested Explore, reviewer and test-writer subagents](https://raw.githubusercontent.com/AchiboldThanyani/claude-agents-tui/master/docs/screenshot.png)

It is read-only: it reads the transcript files Claude Code already writes to
`~/.claude/projects` and never starts, stops or talks to an agent. It has no
runtime dependencies.

The look follows the [Claude Subagents](https://github.com/AchiboldThanyani/claude-subagents)
VS Code extension: its Catppuccin colours, a coloured icon per agent type
(◎ Explore, ◈ Plan, ◇ review, ▲ tests, ✱ bugs, ✦ general purpose…) and a
spinner on running agents, drawn as plain outlined text over your terminal's
own background. It is designed for dark themes and needs 24-bit colour
(Windows Terminal, iTerm2, most Linux terminals). `--no-color` or piping the
output gives plain text.

## Install

```sh
npm install -g claude-agents-tui
claude-agents
```

Or run it once without installing: `npx claude-agents-tui`.

From source:

```sh
npm install
npm run build
npm link          # optional: puts `claude-agents` on your PATH
```

## Use

```sh
claude-agents                    # live view, refreshes every second
claude-agents --space            # start in the space view
claude-agents --since 6h         # widen the time window (default 1h)
claude-agents --project extension
claude-agents --once             # print one snapshot and exit (also used when piped)
```

| Key | Tree view | Space view |
|---|---|---|
| `Tab` | switch to space view | switch to tree view |
| `↑/↓` or `j/k` | select row | move to the nearest agent above/below |
| `←/→` or `h/l` | | move to the nearest agent left/right |
| `Enter` | show/hide the selected agent's recent activity | same |
| `q` | quit | quit |

**Mouse:** click a row or card to select it, click it again to show its
details, click the footer keys (`⏎ details`, `⇥ space view`, `q quit`), and
use the wheel to move through the tree. While the mouse is captured, hold
`Shift` to select text, or start with `--no-mouse`.

Clicks work in terminals on Linux, macOS and WSL. On native Windows (running
`claude-agents` from PowerShell or cmd), Node's console input currently passes
keys through but not mouse events, so use the keyboard there, or run it from
WSL.

### Space view

![The space view: agents float as cards linked to the agent that spawned them](https://raw.githubusercontent.com/AchiboldThanyani/claude-agents-tui/master/docs/space.png)

Agents float on a canvas like the extension's graph, laid out by the same
force simulation: cards push each other apart, links pull each agent towards
the one that spawned it, and everything drifts to a stop. Each card shows the
status and name above (`⠙ Explore`) and the description below. Running agents
spin and have two arcs chasing round their border; the selected card and its
links turn purple.

A terminal only has room for so many cards, so when there are too many the
oldest finished agents are hidden first (the count is shown bottom-left).
Switch to the tree view with `Tab` to see everything.

### Which folder it reads

1. `--root <dir>` if given
2. `$CLAUDE_CONFIG_DIR/projects` if that variable is set
3. `~/.claude/projects` if it exists
4. **WSL:** if there is no Linux `~/.claude/projects`, the Windows one at
   `/mnt/<drive>/Users/<you>/.claude/projects` (the most recently used, if
   there are several). This covers running the Windows build of Claude Code
   and watching it from an Ubuntu shell.

The folder in use is shown in the top-right corner.

## Statuses

| Icon | Agent     | Session    | Meaning                                              |
|------|-----------|------------|------------------------------------------------------|
| ⠋ ●  | running   | running    | transcript written in the last 30s and not finished (spins in the live view) |
| ◌    | idle      | idle       | not finished, but quiet (waiting on a permission prompt, rate-limited, or killed) |
| ✓    | done      | your turn  | last turn ended; for a session it is waiting for you |

Subagents are nested under the agent that spawned them, using the `toolUseId`
in each `agent-<id>.meta.json`.

## How it works

```
~/.claude/projects/<project>/<session>.jsonl                       main conversation
~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl  each subagent
~/.claude/projects/<project>/<session>/subagents/agent-<id>.meta.json
```

- `src/transcripts.ts` tails each JSONL file from its last offset and folds new
  lines into a small summary (status, current tool, tool count, tokens).
- `src/render.ts` turns the summaries into tree rows.
- `src/space.ts` lays out the space view (force simulation) and draws it on a
  character canvas, with links in braille dots.
- `src/cli.ts` handles options, keys and redraws using plain ANSI codes.

## Tests

```sh
npm test
```

Uses Node's built-in test runner (Node 21+), no extra dependencies. The tests
build fake transcript folders in a temp directory and check status detection,
subagent nesting, incremental reading (appended, half-written and rewritten
files), filtering, rendering widths and the CLI end to end.

These files are an internal Claude Code format, not a public API, so a future
Claude Code release may need small parser updates.

This is an independent project and is not affiliated with or endorsed by
Anthropic.
