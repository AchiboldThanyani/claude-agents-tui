#!/usr/bin/env node
import * as fs from 'fs';
import { AgentInfo, isActive, SessionInfo, TranscriptStore } from './transcripts';
import { currentEnv, isWsl, resolveRoot } from './root';
import {
  buildRows,
  compose,
  detailBox,
  emptyState,
  footer,
  footerButtons,
  FooterAction,
  header,
  Row,
  rule,
  selectRow,
  Style,
  unselectedRow,
} from './render';
import { Space } from './space';
import { isMouseInput, MOUSE_OFF, MOUSE_ON, parseMouse } from './input';
import { Alert, AlertTracker, banner, summarize } from './alerts';
import { notify } from './notify';
import { ConversationFile } from './conversation';
import { Viewer } from './viewer';

const HELP = `claude-agents — watch Claude Code sessions and their subagents

Usage: claude-agents [options]

  --since <dur>     only show activity newer than this (default 1h; e.g. 30m, 6h, 2d)
  --project <text>  only show sessions whose project folder contains <text>
  --root <dir>      transcript folder (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects;
                    in WSL, falls back to the Windows C:\\Users\\<you>\\.claude\\projects)
  --space           start in the space view (agents floating on a canvas)
  --notify          also send desktop notifications when an agent or session needs you
  --quiet           no terminal bell for alerts
  --once            print one snapshot and exit
  --no-color        disable colors (also honours NO_COLOR)
  --no-mouse        do not capture the mouse (keeps normal text selection)
  -h, --help        show this help

Keys: tab switch tree/space view · ↑/↓ (or arrows in space view) select
      enter show/hide details · v full transcript · q quit
Transcript: ↑/↓ scroll · PgUp/PgDn page · g/G top/end · Esc close
Mouse: click to select, click again for details, click the footer keys,
       wheel to move through the tree or scroll the transcript
`;

interface Options {
  sinceMs: number;
  project?: string;
  root: string;
  once: boolean;
  color: boolean;
  space: boolean;
  mouse: boolean;
  notify: boolean;
  bell: boolean;
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
    notify: false,
    bell: true,
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
    else if (a === '--notify') opts.notify = true;
    else if (a === '--quiet') opts.bell = false;
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

/** The transcript file behind a row key ("session:<id>" or "agent:<id>"). */
function fileFor(sessions: SessionInfo[], key: string): string | undefined {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  for (const s of sessions) {
    if (kind === 'session' && s.id === id) return s.file;
    const find = (agents: AgentInfo[]): AgentInfo | undefined => {
      for (const a of agents) {
        if (a.id === id) return a;
        const hit = find(a.children);
        if (hit) return hit;
      }
    };
    const a = kind === 'agent' ? find(s.agents) : undefined;
    if (a) return a.file;
  }
  return undefined;
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
  let viewer: Viewer | undefined;

  const tracker = new AlertTracker();
  tracker.update(snap.sessions); // starting state: nothing alerts for work that was already done
  let alerts: Alert[] = [];
  let alertsUntil = 0;
  const wsl = isWsl(currentEnv());

  // Where things were drawn last frame, for mouse hit-testing.
  let layout = { listTop: 2, listH: 0, footerRow: 0, viewerH: 0, style: { color: opts.color } as Style };

  const size = () => ({ width: out.columns || 100, height: out.rows || 30 });

  const draw = () => {
    const { width, height } = size();
    const style: Style = { color: opts.color, frame };
    // Rebuilt on every frame so the spinner turns and elapsed times tick.
    rows = buildRows(snap.sessions, Date.now(), width - 2, style);
    const idx = rows.findIndex((r) => r.key === selectedKey);
    selected = idx >= 0 ? idx : Math.min(selected, Math.max(0, rows.length - 1));
    selectedKey = rows[selected]?.key ?? '';

    const underHeader = Date.now() < alertsUntil && alerts.length ? banner(alerts, width, style) : rule(width, style);
    const lines: string[] = [header(snap.sessions, opts.root, Date.now(), width, style), underHeader];
    const bodyH = Math.max(1, height - 4);

    if (viewer) {
      lines.push(...viewer.render(width, bodyH, style));
      layout = { ...layout, viewerH: bodyH };
    } else {
      const detailH = showDetail && rows[selected] ? Math.min(12, Math.floor(height / 2)) : 0;
      const listH = Math.max(1, bodyH - detailH);
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
      while (lines.length < height - 2 - detailH) lines.push('');
      const detail = rows.find((r) => r.key === selectedKey)?.detail;
      if (detailH && detail) lines.push(...detailBox(detail, width, detailH, style));
      layout = { ...layout, listH };
    }

    while (lines.length < height - 2) lines.push('');
    lines.length = Math.min(lines.length, height - 2);
    lines.push(rule(width, style), footer(style, viewer ? 'viewer' : mode));
    layout = { ...layout, listTop: 2, footerRow: lines.length - 1, style };
    // Synchronized update (ignored by terminals that do not support it) avoids tearing.
    out.write('\x1b[?2026h' + compose(lines, height) + '\x1b[?2026l');
  };

  const raise = (fresh: Alert[]) => {
    if (!fresh.length) return;
    alerts = fresh;
    alertsUntil = Date.now() + 8000;
    const needsYou = fresh.filter((a) => a.level === 'attention');
    if (needsYou.length && opts.bell) out.write('\x07');
    if (needsYou.length && opts.notify) {
      const { title, body } = summarize(needsYou);
      notify(title, body, process.platform, wsl);
    }
  };

  const refresh = () => {
    snap = scan(store, opts);
    raise(tracker.update(snap.sessions));
    viewer?.conversation.refresh();
    draw();
  };

  const anythingRunning = () => snap.sessions.some((s) => s.status === 'running' || s.agents.some(isActive));

  const openViewer = () => {
    const file = fileFor(snap.sessions, selectedKey);
    const d = rows.find((r) => r.key === selectedKey)?.detail;
    if (file && d) viewer = new Viewer(new ConversationFile(file), d.title, d.icon, d.color);
  };

  const restore = () => out.write((opts.mouse ? MOUSE_OFF : '') + '\x1b[?25h\x1b[?1049l');

  const quit = () => {
    restore();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };

  const act = (action: FooterAction | undefined) => {
    if (action === 'quit') return quit();
    if (action === 'details') showDetail = !showDetail;
    if (action === 'toggle-view') mode = mode === 'tree' ? 'space' : 'tree';
    if (action === 'transcript') openViewer();
    if (action === 'close') viewer = undefined;
    if (action === 'top') viewer?.toTop();
    if (action === 'end') viewer?.toEnd();
  };

  /** Click on a row or card selects it; clicking the selection again toggles details. */
  const click = (x: number, y: number) => {
    if (y === layout.footerRow) {
      return act(footerButtons(layout.style, viewer ? 'viewer' : mode).find((b) => x >= b.from && x < b.to)?.action);
    }
    if (viewer || y < layout.listTop || y >= layout.listTop + layout.listH || !rows.length) return;
    const key = mode === 'space' ? space.hit(x, y - layout.listTop, selectedKey) : rows[scroll + y - layout.listTop]?.key;
    if (!key) return;
    if (key === selectedKey) showDetail = !showDetail;
    else selectedKey = key;
  };

  const viewerKey = (k: string) => {
    const { width } = size();
    const h = layout.viewerH;
    const by = (n: number) => viewer!.scrollBy(n, h, width, { color: opts.color });
    if (k === '\x1b' || k === 'q' || k === 'v') viewer = undefined;
    else if (k === '\x1b[A' || k === 'k') by(-1);
    else if (k === '\x1b[B' || k === 'j') by(1);
    else if (k === '\x1b[5~' || k === '\x1b[D') by(-(h - 2));
    else if (k === '\x1b[6~' || k === '\x1b[C' || k === ' ') by(h - 2);
    else if (k === 'g' || k === '\x1b[H' || k === '\x1b[1~') viewer!.toTop();
    else if (k === 'G' || k === '\x1b[F' || k === '\x1b[4~') viewer!.toEnd();
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
    if (k === '\x03') return quit();
    if (isMouseInput(k)) {
      for (const e of parseMouse(k)) {
        if (e.kind === 'click') click(e.x, e.y);
        else if (viewer) viewer.scrollBy(e.dir === 'up' ? -3 : 3, layout.viewerH, size().width, { color: opts.color });
        else if (mode === 'tree') {
          const i = e.dir === 'up' ? Math.max(0, selected - 1) : Math.min(rows.length - 1, selected + 1);
          selectedKey = rows[i]?.key ?? selectedKey;
          selected = i;
        }
      }
      return draw();
    }
    if (viewer) {
      viewerKey(k);
      return draw();
    }
    if (k === 'q') return quit();
    const arrow = ({ '\x1b[A': 'up', k: 'up', '\x1b[B': 'down', j: 'down', '\x1b[D': 'left', h: 'left', '\x1b[C': 'right', l: 'right' } as const)[
      k as 'k'
    ];
    if (k === '\t') mode = mode === 'tree' ? 'space' : 'tree';
    else if (k === 'v') openViewer();
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
    if (mode === 'space' && !viewer) {
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
