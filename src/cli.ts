#!/usr/bin/env node
import * as fs from 'fs';
import { TranscriptStore } from './transcripts';
import { resolveRoot } from './root';
import { buildRows, fit, header, paint, Row, Style } from './render';

const HELP = `claude-agents — watch Claude Code sessions and their subagents

Usage: claude-agents [options]

  --since <dur>     only show activity newer than this (default 1h; e.g. 30m, 6h, 2d)
  --project <text>  only show sessions whose project folder contains <text>
  --root <dir>      transcript folder (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects;
                    in WSL, falls back to the Windows C:Users<you>.claudeprojects)
  --once            print one snapshot and exit
  --no-color        disable colors (also honours NO_COLOR)
  -h, --help        show this help

Keys: ↑/↓ or j/k select · enter show/hide activity · q quit
`;

interface Options {
  sinceMs: number;
  project?: string;
  root: string;
  once: boolean;
  color: boolean;
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
    else throw new Error(`unknown option: ${a}`);
  }
  opts.root = resolveRoot(root).root;
  return opts;
}

function snapshot(store: TranscriptStore, opts: Options, width: number, style: Style) {
  const now = Date.now();
  const sessions = store.scan(now - opts.sinceMs, opts.project, now);
  return { now, sessions, rows: buildRows(sessions, now, width, style) };
}

/** What to say when there is nothing to show. */
function emptyMessage(opts: Options): string {
  if (!fs.existsSync(opts.root)) return `Transcript folder not found: ${opts.root} (point at it with --root <dir>)`;
  return `No Claude Code activity in the last ${Math.round(opts.sinceMs / 60000)}m (widen it with --since, e.g. --since 1d).`;
}

function runOnce(opts: Options): void {
  const store = new TranscriptStore(opts.root);
  const width = process.stdout.columns || Number(process.env.COLUMNS) || 120;
  const style = { color: opts.color && !!process.stdout.isTTY };
  const { now, sessions, rows } = snapshot(store, opts, width, style);
  const lines = [header(sessions, opts.root, now, width, style), ''];
  if (!rows.length) lines.push(emptyMessage(opts));
  lines.push(...rows.map((r) => r.text));
  process.stdout.write(lines.join('\n') + '\n');
}

function runLive(opts: Options): void {
  const out = process.stdout;
  const style = { color: opts.color };
  const store = new TranscriptStore(opts.root);
  let rows: Row[] = [];
  let selected = 0;
  let selectedKey = '';
  let showDetail = false;
  let scroll = 0;
  let lastFrame = { now: 0, sessions: [] as ReturnType<typeof snapshot>['sessions'] };

  const refresh = () => {
    const snap = snapshot(store, opts, out.columns || 100, style);
    rows = snap.rows;
    lastFrame = snap;
    // Keep the same row selected as the tree changes underneath it.
    const idx = rows.findIndex((r) => r.key === selectedKey);
    selected = idx >= 0 ? idx : Math.min(selected, Math.max(0, rows.length - 1));
    draw();
  };

  const draw = () => {
    const width = out.columns || 100;
    const height = out.rows || 30;
    const lines: string[] = [header(lastFrame.sessions, opts.root, lastFrame.now, width, style), ''];
    const detailH = showDetail && rows[selected] ? Math.min(12, Math.floor(height / 2)) : 0;
    const listH = Math.max(1, height - lines.length - 2 - detailH);

    if (!rows.length) {
      lines.push(emptyMessage(opts) + ' Waiting…');
    }
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + listH) scroll = selected - listH + 1;
    rows.slice(scroll, scroll + listH).forEach((r, i) => {
      const isSel = scroll + i === selected;
      lines.push((isSel ? paint('›', '36', style) : ' ') + ' ' + r.text);
    });
    while (lines.length < height - 1 - detailH) lines.push('');

    if (detailH) {
      const d = rows[selected].detail;
      lines.push(paint(fit('── ' + d.title + ' ', width).replace(/ +$/, (m) => '─'.repeat(m.length)), '36', style));
      const body = d.lines.slice(-(detailH - 1));
      for (let i = 0; i < detailH - 1; i++) lines.push(fit(body[i] ?? '', width));
    }

    const footer = '↑/↓ select · enter activity · q quit';
    lines.length = Math.min(lines.length, height - 1);
    lines.push(paint(footer, '90', style));
    out.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  };

  const quit = () => {
    out.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };

  out.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('exit', () => out.write('\x1b[?25h\x1b[?1049l'));
  out.on('resize', draw);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const k = buf.toString();
    if (k === 'q' || k === '\x03') return quit();
    if (k === '\x1b[A' || k === 'k') selected = Math.max(0, selected - 1);
    else if (k === '\x1b[B' || k === 'j') selected = Math.min(rows.length - 1, selected + 1);
    else if (k === '\r' || k === '\n') showDetail = !showDetail;
    else if (k === '\x1b') showDetail = false;
    selectedKey = rows[selected]?.key ?? '';
    draw();
  });

  refresh();
  setInterval(refresh, 1000);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.once || !process.stdout.isTTY || !process.stdin.isTTY) runOnce(opts);
  else runLive(opts);
} catch (err) {
  process.stderr.write(`claude-agents: ${(err as Error).message}\n`);
  process.exit(1);
}
