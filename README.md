# claude-agents-tui

[![Tests](https://github.com/AchiboldThanyani/claude-agents-tui/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/AchiboldThanyani/claude-agents-tui/actions/workflows/test.yml)

A plain terminal view of your running Claude Code sessions and their subagents.

It is read-only: it reads the transcript files Claude Code already writes to
`~/.claude/projects` and never starts, stops or talks to an agent. It has no
runtime dependencies.

```
Claude agents · 1 sessions · 2 agents running            ~/.claude/projects  21:46:07

  ● running   Demo session (2 agents)                     demo-app   now   opus-5-5
  └─ ● running   Plan      Plan the work       2s   Agent Find auth code
›    └─ ● running   Explore   Find auth code     2s   Grep authenticate

── Explore · Find auth code · haiku-4-5 · running ─────────────────────────────
21:46:06  prompt: search
21:46:06  Grep authenticate

↑/↓ select · enter activity · q quit
```

## Install

```sh
npm install
npm run build
npm link          # optional: puts `claude-agents` on your PATH
```

## Use

```sh
claude-agents                    # live view, refreshes every second
claude-agents --since 6h         # widen the time window (default 1h)
claude-agents --project extension
claude-agents --once             # print one snapshot and exit (also used when piped)
```

Keys: `↑/↓` or `j/k` select, `enter` shows the selected row's recent activity,
`q` quits.

## Statuses

| Icon | Agent     | Session    | Meaning                                              |
|------|-----------|------------|------------------------------------------------------|
| ●    | running   | running    | transcript written in the last 30s and not finished  |
| ○    | idle      | idle       | not finished, but quiet (waiting on a permission prompt, rate-limited, or killed) |
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
