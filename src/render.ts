import * as os from 'os';
import { AgentInfo, SessionInfo, Status } from './transcripts';

/**
 * Drawing. Colours and per-type icons follow the Claude Subagents VS Code
 * extension (Catppuccin Mocha + purple/teal accents), as 24-bit ANSI colour.
 * With colour off everything degrades to plain text in the same layout.
 */

export interface Activity {
  time: string;
  text: string;
}

/** One selectable line in the tree. */
export interface Row {
  key: string;
  text: string;
  detail: { icon: string; color: string; title: string; meta: string; lines: Activity[] };
}

export interface Style {
  color: boolean;
  /** Animation frame for the running spinner; static icon when undefined. */
  frame?: number;
}

// ── Theme ───────────────────────────────────────────────────────────────────

export const C = {
  bg: '#0d0e14',
  surface: '#13141c',
  border: '#1e2030',
  accent: '#7c6af7',
  accent2: '#5eead4',
  text: '#cdd6f4',
  // Lighter than the extension's greys, which assume its near-black background.
  muted: '#8087a2',
  subtle: '#5d6283',
  ok: '#a6e3a1',
  err: '#f38ba8',
  warn: '#f9e2af',
  running: '#89b4fa',
};

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export const fg = (hex: string) => `38;2;${rgb(hex).join(';')}`;
export const bg = (hex: string) => `48;2;${rgb(hex).join(';')}`;
export const BOLD = '1';
const ITALIC = '3';

/** `color` laid over `base` at `alpha` opacity, like the extension's rgba() tints. */
export function tint(color: string, alpha: number, base = C.bg): string {
  const a = rgb(color);
  const b = rgb(base);
  return '#' + a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

export function paint(s: string, code: string, style: Style): string {
  return style.color && s ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

// ── Text helpers ────────────────────────────────────────────────────────────

export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s.padEnd(width);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d`;
}

function ago(ms: number): string {
  return ms < 5000 ? 'now' : duration(ms) + ' ago';
}

function clock(t: number): string {
  return new Date(t).toTimeString().slice(0, 8);
}

function shortModel(m?: string): string {
  return m ? m.replace(/^claude-/, '') : '';
}

function compact(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'k' : String(n);
}

function tildify(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// ── Status pills and agent icons ────────────────────────────────────────────

const STATUS: Record<Status, { icon: string; color: string }> = {
  running: { icon: '●', color: C.running },
  idle: { icon: '◌', color: C.warn },
  done: { icon: '✓', color: C.ok },
};

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const PILL_W = 14; // ' ✓ your turn ' (13) plus at least one space

function statusIcon(status: Status, style: Style): string {
  if (status === 'running' && style.color && style.frame !== undefined) return SPINNER[style.frame % SPINNER.length];
  return STATUS[status].icon;
}

/** Status icon and word in the status colour, padded to a fixed column. */
function pill(status: Status, label: string, style: Style): string {
  const body = ` ${statusIcon(status, style)} ${label} `;
  return paint(body, fg(STATUS[status].color), style) + ' '.repeat(Math.max(1, PILL_W - body.length));
}

/** Matches Claude Code agent types to the extension's icon/colour families. */
const TYPES: Array<{ match: RegExp; icon: string; color: string }> = [
  { match: /explor|search|research/i, icon: '◎', color: '#5eead4' },
  { match: /plan|architect/i, icon: '◈', color: '#7c6af7' },
  { match: /review/i, icon: '◇', color: '#89b4fa' },
  { match: /test/i, icon: '▲', color: '#94e2d5' },
  { match: /bug|debug|fix/i, icon: '✱', color: '#f38ba8' },
  { match: /doc|guide|writ/i, icon: '≡', color: '#b4befe' },
  { match: /refactor|simplif/i, icon: '↻', color: '#fab387' },
  { match: /commit|git|pr\b/i, icon: '⊙', color: '#f9e2af' },
  { match: /summar/i, icon: '≈', color: '#cba6f7' },
  { match: /code|dev|build/i, icon: '❯', color: '#a6e3a1' },
  { match: /general/i, icon: '✦', color: '#cba6f7' },
];

export function agentLook(agentType: string): { icon: string; color: string } {
  return TYPES.find((t) => t.match.test(agentType)) ?? { icon: '•', color: C.text };
}

/** "Grep authenticate" → tool name in teal, argument muted; quoted text in italics. */
function action(text: string, width: number, style: Style): string {
  const s = fit(text, width);
  if (text.startsWith('“')) return paint(s, `${ITALIC};${fg(C.muted)}`, style);
  const m = /^([A-Z][A-Za-z_]*)(.*)$/s.exec(s);
  if (!m) return paint(s, fg(C.muted), style);
  return paint(m[1], fg(C.accent2), style) + paint(m[2], fg(C.muted), style);
}

// ── Rows ────────────────────────────────────────────────────────────────────

function activity(recent: Array<{ time: number; text: string }>): Activity[] {
  return recent.map((r) => ({ time: clock(r.time), text: r.text }));
}

function agentRows(agents: AgentInfo[], prefix: string, now: number, width: number, style: Style, out: Row[]): void {
  agents.forEach((a, i) => {
    const last = i === agents.length - 1;
    const branch = prefix + (last ? '└─ ' : '├─ ');
    const st = a.state;
    const look = agentLook(a.agentType);
    const elapsed = (a.status === 'running' ? now : st.lastTime || st.mtime) - st.firstTime;

    // Narrower name column as the tree deepens, so description and time columns line up.
    const nameW = Math.max(8, 19 - branch.length);
    const timeW = 7;
    const fixedLeft = branch.length + PILL_W + 2; // tree + pill + icon
    const rest = Math.max(10, width - fixedLeft - nameW - timeW - 3);
    const descW = Math.min(36, Math.floor(rest * 0.45));
    const doingW = rest - descW - 1;

    const doing =
      a.status === 'done'
        ? paint(fit(`${st.toolCalls} tool${st.toolCalls === 1 ? '' : 's'} · ${compact(st.outputTokens)} tok`, doingW), fg(C.muted), style)
        : action(st.current ?? '', doingW, style);

    const text =
      paint(branch, fg(C.subtle), style) +
      pill(a.status, a.status, style) +
      paint(look.icon + ' ', fg(look.color), style) +
      paint(fit(a.agentType, nameW), `${BOLD};${fg(look.color)}`, style) +
      ' ' +
      paint(fit(a.description, descW), fg(C.text), style) +
      ' ' +
      paint(fit(duration(elapsed), timeW), fg(C.muted), style) +
      ' ' +
      doing;

    out.push({
      key: 'agent:' + a.id,
      text,
      detail: {
        icon: look.icon,
        color: look.color,
        title: `${a.agentType} · ${a.description}`,
        meta: [shortModel(st.model), a.status].filter(Boolean).join(' · '),
        lines: activity(st.recent),
      },
    });
    agentRows(a.children, prefix + (last ? '   ' : '│  '), now, width, style, out);
  });
}

export function buildRows(sessions: SessionInfo[], now: number, width: number, style: Style): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    const st = s.state;
    const label = s.status === 'done' ? 'your turn' : s.status;
    const title = st.title ?? st.firstPrompt ?? s.id.slice(0, 8);
    const model = shortModel(st.model);
    const when = fit(ago(now - st.mtime), 11);
    // Pill + icon + title (min 10) + gaps; the project column gives way on narrow terminals.
    const projectW = Math.max(4, Math.min(18, width - PILL_W - 2 - 10 - 1 - 12 - model.length - 1));
    const rightLen = projectW + 1 + when.length + 1 + model.length;
    const titleW = Math.max(10, width - PILL_W - 2 - rightLen - 1);

    const count = s.agentCount ? ` (${s.agentCount} agent${s.agentCount === 1 ? '' : 's'})` : '';
    const fitted = fit(title + count, titleW);
    const titlePart = fitted.slice(0, Math.min(fitted.length, title.length));

    rows.push({
      key: 'session:' + s.id,
      text:
        pill(s.status, label, style) +
        paint('❖ ', fg(C.accent), style) +
        paint(titlePart, `${BOLD};${fg(C.text)}`, style) +
        paint(fitted.slice(titlePart.length), fg(C.muted), style) +
        ' ' +
        paint(fit(s.project, projectW), fg(C.accent2), style) +
        ' ' +
        paint(when, fg(C.muted), style) +
        ' ' +
        paint(model, fg(C.muted), style),
      detail: {
        icon: '❖',
        color: C.accent,
        title: `${title} · ${s.project}`,
        meta: `session ${s.id.slice(0, 8)}`,
        lines: activity(st.recent),
      },
    });
    agentRows(s.agents, '', now, width, style, rows);
  }
  return rows;
}

// ── Chrome: header, selection, detail box, footer, empty state ─────────────

function countAgents(sessions: SessionInfo[]): Record<Status, number> {
  const n: Record<Status, number> = { running: 0, idle: 0, done: 0 };
  const walk = (as: AgentInfo[]) =>
    as.forEach((a) => {
      n[a.status]++;
      walk(a.children);
    });
  sessions.forEach((s) => walk(s.agents));
  return n;
}

export function header(sessions: SessionInfo[], root: string, now: number, width: number, style: Style): string {
  const n = countAgents(sessions);
  const brand = ' ✦ claude agents ';
  const chips: Array<[string, string]> = [[`${sessions.length} sessions`, C.text]];
  chips.push([`${n.running ? statusIcon('running', style) : '●'} ${n.running} running`, C.running]);
  if (n.idle) chips.push([`◌ ${n.idle} idle`, C.warn]);
  if (n.done) chips.push([`✓ ${n.done} done`, C.ok]);

  const sep = '  ';
  const leftLen = brand.length + 1 + chips.reduce((len, [t]) => len + t.length + sep.length, 0);
  const time = clock(now);
  const rootW = width - leftLen - time.length - 4; // " · " plus at least one space of gap
  const right = (rootW >= 12 ? fit(tildify(root), rootW).trimEnd() + ' · ' : '') + time;
  const gap = Math.max(1, width - leftLen - right.length);

  return (
    paint(brand, `${BOLD};${fg(C.accent)}`, style) +
    ' ' +
    chips.map(([t, c]) => paint(t, fg(c), style) + sep).join('') +
    ' '.repeat(gap) +
    paint(right, fg(C.muted), style)
  );
}

export function rule(width: number, style: Style): string {
  return style.color ? paint('─'.repeat(width), fg(C.subtle), style) : '';
}

/** Marks the selected row with an accent bar (no background, so it suits any terminal theme). */
export function selectRow(text: string, _width: number, style: Style): string {
  if (!style.color) return '› ' + text;
  return paint('▌', `${BOLD};${fg(C.accent)}`, style) + ' ' + text;
}

export function unselectedRow(text: string): string {
  return '  ' + text;
}

/** Rounded panel with the selected row's recent activity. */
export function detailBox(d: Row['detail'], width: number, height: number, style: Style): string[] {
  const inner = Math.max(10, width - 4);
  const border = (s: string) => paint(s, fg(C.muted), style);
  const titleText = fit(` ${d.icon} ${d.title} `, Math.max(4, inner - d.meta.length - 4)).trimEnd() + ' ';
  const metaText = d.meta ? ` ${d.meta} ` : '';
  const fill = Math.max(1, width - 3 - titleText.length - metaText.length - 1);

  const lines = [
    border('╭─') +
      paint(titleText, `${BOLD};${fg(d.color)}`, style) +
      border('─'.repeat(fill)) +
      paint(metaText, fg(C.muted), style) +
      border('─╮'),
  ];
  const body = d.lines.slice(-(height - 2));
  for (let i = 0; i < height - 2; i++) {
    const a = body[i];
    let content = fit('', inner);
    if (a) {
      const textW = inner - a.time.length - 2;
      const text = a.text.startsWith('prompt:')
        ? paint(fit(a.text, textW), fg(C.accent), style)
        : action(a.text, textW, style);
      content = paint(a.time, fg(C.muted), style) + '  ' + text;
    } else if (i === 0) {
      content = paint(fit('no activity yet', inner), fg(C.muted), style);
    }
    lines.push(border('│ ') + content + border(' │'));
  }
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines;
}

export type FooterAction = 'details' | 'toggle-view' | 'quit';

interface FooterPart {
  key: string;
  plainKey: string;
  label: string;
  action?: FooterAction;
}

function footerParts(mode: 'tree' | 'space'): FooterPart[] {
  return [
    { key: 'Tab', plainKey: 'tab', label: mode === 'tree' ? 'space view' : 'tree view', action: 'toggle-view' },
    mode === 'tree' ? { key: '↑↓', plainKey: '↑/↓', label: 'select' } : { key: '←↑↓→', plainKey: 'arrows', label: 'select' },
    { key: '⏎', plainKey: 'enter', label: 'details', action: 'details' },
    { key: 'q', plainKey: 'q', label: 'quit', action: 'quit' },
  ];
}

const FOOTER_SEP = { color: '    ', plain: ' · ' };

function footerPieces(style: Style, mode: 'tree' | 'space'): Array<{ text: string; width: number; action?: FooterAction }> {
  return footerParts(mode).map((p) =>
    style.color
      ? {
          text: ' ' + paint(p.key, `${BOLD};${fg(C.accent)}`, style) + paint(` ${p.label}`, fg(C.text), style),
          width: 1 + p.key.length + 1 + p.label.length,
          action: p.action,
        }
      : { text: `${p.plainKey} ${p.label}`, width: p.plainKey.length + 1 + p.label.length, action: p.action },
  );
}

export function footer(style: Style, mode: 'tree' | 'space' = 'tree'): string {
  return footerPieces(style, mode)
    .map((p) => p.text)
    .join(style.color ? FOOTER_SEP.color : FOOTER_SEP.plain);
}

/** Column ranges [from, to) of the clickable footer buttons. */
export function footerButtons(style: Style, mode: 'tree' | 'space' = 'tree'): Array<{ from: number; to: number; action: FooterAction }> {
  const sep = (style.color ? FOOTER_SEP.color : FOOTER_SEP.plain).length;
  const buttons: Array<{ from: number; to: number; action: FooterAction }> = [];
  let x = 0;
  for (const p of footerPieces(style, mode)) {
    if (p.action) buttons.push({ from: x, to: x + p.width, action: p.action });
    x += p.width + sep;
  }
  return buttons;
}

/**
 * Turns screen lines into one terminal write. Each line is placed with an
 * explicit cursor move and cleared *before* it is written: clearing after a
 * full-width line would erase its last character, because the cursor is then
 * parked on the last column. The terminal's own background shows through.
 */
export function compose(lines: string[], height: number): string {
  let out = '';
  for (let row = 0; row < height; row++) out += `\x1b[${row + 1};1H\x1b[2K${lines[row] ?? ''}`;
  return out;
}

/** Centred placeholder, like the extension's empty canvas hint. */
export function emptyState(message: string, width: number, height: number, style: Style): string[] {
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const lines: string[] = Array(Math.max(0, Math.floor(height / 2) - 3)).fill('');
  lines.push(paint(center('✦'), fg(C.accent), style));
  lines.push('');
  lines.push(paint(center('No agents yet'), `${BOLD};${fg(C.text)}`, style));
  lines.push(paint(center(message), fg(C.muted), style));
  lines.push(paint(center('Start claude in another terminal and they will appear here.'), fg(C.muted), style));
  return lines;
}
