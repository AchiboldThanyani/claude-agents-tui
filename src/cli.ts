#!/usr/bin/env node
import * as fs from 'fs';
import { isActive, SessionInfo, TranscriptStore } from './transcripts';
import { resolveRoot } from './root';
import { buildRows, compose, detailBox, emptyState, footer, footerButtons, header, Row, rule, selectRow, Style, unselectedRow } from './render';
import { Space } from './space';
import { isMouseInput, MOUSE_OFF, MOUSE_ON, parseMouse } from './input';

const HELP = `claude-agents — watch Claude Code sessions and their subagents

Usage: claude-agents [options]

  --since <dur>     only show activity newer than this (default 1h; e.g. 30m, 6h, 2d)
  --project <text>  only show sessions whose project folder contains <text>
  --root <dir>      transcript folder (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects;
                    in WSL, falls back to the Windows C:\\Users\\<you>\\.claude\\projects)
  --space           start in the space view (agents floating on a canvas)
  --once            print one snapshot and exit
  --no-color        disable colors (also honours NO_COLOR)
  --no-mouse        do not capture the mouse (keeps normal text selection)
  -h, --help        show this help

Keys: tab switch tree/space view · ↑/↓ (or arrows in space view) select
      enter show/hide details · q quit
Mouse: click to select, click again for details, click the footer keys,
       wheel to move through the tree
`;

interface Options {
  sinceMs: number;
  project?: string;
  root: string;
  once: boolean;
  color: boolean;
  space: boolean;
  mouse: boolean;
}

function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] ?? 'm') as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

function parseArgs(argv: string[]): Options {
  let root: string | undefined;
  const opts: Options = {
    sinceMs: parseDuration('1h'),
    root: '',
    once: false,
    color: !process.env.NO_COLOR,
    space: false,
    mouse: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--since') opts.sinceMs = parseDuration(value());
    else if (a === '--project') opts.project = value();
    else if (a === '--root') root = value();
    else if (a === '--once') opts.once = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--space') opts.space = true;
    else if (a === '--no-mouse') opts.mouse = false;
    else throw new Error(`unknown option: ${a}`);
  }
  opts.root = resolveRoot(root).root;
  return opts;
}

function scan(store: TranscriptStore, opts: Options): { now: number; sessions: SessionInfo[] } {
  const now = Date.now();
  return { now, sessions: store.scan(now - opts.sinceMs, opts.project, now) };
}

/** What to say when there is nothing to show. */
function emptyMessage(opts: Options): string {
  if (!fs.existsSync(opts.root)) return `Transcript folder not found: ${opts.root} (point at it with --root <dir>)`;
  return `No Claude Code activity in the last ${Math.round(opts.sinceMs / 60000)}m (widen it with --since, e.g. --since 1d).`;
}

function runOnce(opts: Options): void {
  const width = process.stdout.columns || Number(process.env.COLUMNS) || 120;
  const style: Style = { color: opts.color && !!process.stdout.isTTY };
  const { now, sessions } = scan(new TranscriptStore(opts.root), opts);
  const rows = buildRows(sessions, now, width, style);
  const lines = [header(sessions, opts.root, now, width, style), rule(width, style)];
  if (!rows.length) lines.push(emptyMessage(opts));
  else if (opts.space) {
    const height = Math.max(12, (process.stdout.rows || Number(process.env.LINES) || 24) - 3);
    const space = new Space();
    space.sync(sessions, width, height);
    space.settle();
    lines.push(...space.render(style));
  } else lines.push(...rows.map((r) => r.text));
  process.stdout.write(lines.join('\n') + '\n');
}

function runLive(opts: Options): void {
  const out = process.stdout;
  const store = new TranscriptStore(opts.root);
  let snap = scan(store, opts);
  let rows: Row[] = [];
  let selected = 0;
  let selectedKey = '';
  let showDetail = false;
  let scroll = 0;
  let frame = 0;
  let mode: 'tree' | 'space' = opts.space ? 'space' : 'tree';
  const space = new Space();
  // Where things were drawn last frame, for mouse hit-testing.
  let layout = { listTop: 2, listH: 0, footerRow: 0, style: { color: opts.color } as Style };

  const draw = () => {
    const width = out.columns || 100;
    const height = out.rows || 30;
    const style: Style = { color: opts.color, frame };
    // Rebuilt on every frame so the spinner turns and elapsed times tick.
    rows = buildRows(snap.sessions, Date.now(), width - 2, style);
    const idx = rows.findIndex((r) => r.key === selectedKey);
    selected = idx >= 0 ? idx : Math.min(selected, Math.max(0, rows.length - 1));
    selectedKey = rows[selected]?.key ?? '';

    const lines: string[] = [header(snap.sessions, opts.root, Date.now(), width, style), rule(width, style)];
    const detailH = showDetail && rows[selected] ? Math.min(12, Math.floor(height / 2)) : 0;
    const listH = Math.max(1, height - lines.length - 2 - detailH);

    if (!rows.length) lines.push(...emptyState(emptyMessage(opts), width, listH, style));
    else if (mode === 'space') {
      space.sync(snap.sessions, width, listH);
      // The selection may be a finished agent the space view had no room for.
      if (!space.position(selectedKey)) selectedKey = space.graph.nodes[0]?.key ?? selectedKey;
      lines.push(...space.render(style, selectedKey));
    } else {
      if (selected < scroll) scroll = selected;
      if (selected >= scroll + listH) scroll = selected - listH + 1;
      rows.slice(scroll, scroll + listH).forEach((r, i) => {
        lines.push(scroll + i === selected ? selectRow(r.text, width, style) : unselectedRow(r.text));
      });
    }
    while (lines.length < height - 1 - detailH) lines.push('');
    const detail = rows.find((r) => r.key === selectedKey)?.detail;
    if (detailH && detail) lines.push(...detailBox(detail, width, detailH, style));

    lines.length = Math.min(lines.length, height - 1);
    lines.push(footer(style, mode));
    layout = { listTop: 2, listH, footerRow: lines.length - 1, style };
    // Synchronized update (ignored by terminals that do not support it) avoids tearing.
    out.write('\x1b[?2026h' + compose(lines, height, style) + '\x1b[?2026l');
  };

  const refresh = () => {
    snap = scan(store, opts);
    draw();
  };

  const anythingRunning = () => snap.sessions.some((s) => s.status === 'running' || s.agents.some(isActive));

  const restore = () => out.write((opts.mouse ? MOUSE_OFF : '') + '\x1b[?25h\x1b[?1049l');

  const quit = () => {
    restore();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };

  /** Click on a row or card selects it; clicking the selection again toggles details. */
  const click = (x: number, y: number) => {
    if (y === layout.footerRow) {
      const button = footerButtons(layout.style, mode).find((b) => x >= b.from && x < b.to);
      if (button?.action === 'quit') return quit();
      if (button?.action === 'details') showDetail = !showDetail;
      if (button?.action === 'toggle-view') mode = mode === 'tree' ? 'space' : 'tree';
      return;
    }
    if (y < layout.listTop || y >= layout.listTop + layout.listH || !rows.length) return;
    const key = mode === 'space' ? space.hit(x, y - layout.listTop, selectedKey) : rows[scroll + y - layout.listTop]?.key;
    if (!key) return;
    if (key === selectedKey) showDetail = !showDetail;
    else selectedKey = key;
  };

  out.write('\x1b[?1049h\x1b[?25l' + (opts.mouse ? MOUSE_ON : ''));
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('exit', restore);
  out.on('resize', draw);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString();
    if (isMouseInput(k)) {
      for (const e of parseMouse(k)) {
        if (e.kind === 'click') click(e.x, e.y);
        else if (mode === 'tree') {
          const i = e.dir === 'up' ? Math.max(0, selected - 1) : Math.min(rows.length - 1, selected + 1);
          selectedKey = rows[i]?.key ?? selectedKey;
          selected = i;
        }
      }
      return draw();
    }
    if (k === 'q' || k === '\x03') return quit();
    const arrow = ({ '\x1b[A': 'up', k: 'up', '\x1b[B': 'down', j: 'down', '\x1b[D': 'left', h: 'left', '\x1b[C': 'right', l: 'right' } as const)[
      k as 'k'
    ];
    if (k === '\t') mode = mode === 'tree' ? 'space' : 'tree';
    else if (k === '\r' || k === '\n') showDetail = !showDetail;
    else if (k === '\x1b') showDetail = false;
    else if (arrow && mode === 'space') selectedKey = space.nearest(selectedKey, arrow) ?? selectedKey;
    else if (arrow === 'up') selectedKey = rows[Math.max(0, selected - 1)]?.key ?? selectedKey;
    else if (arrow === 'down') selectedKey = rows[Math.min(rows.length - 1, selected + 1)]?.key ?? selectedKey;
    draw();
  });

  draw();
  setInterval(refresh, 1000);
  // ~10 fps for the spinner and the floating layout; idle when nothing moves.
  setInterval(() => {
    frame++;
    let moving = false;
    if (mode === 'space') {
      space.step(2);
      moving = space.energy > 0.05;
    }
    if (moving || (opts.color && anythingRunning())) draw();
  }, 100);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.once || !process.stdout.isTTY || !process.stdin.isTTY) runOnce(opts);
  else runLive(opts);
} catch (err) {
  process.stderr.write(`claude-agents: ${(err as Error).message}\n`);
  process.exit(1);
}
