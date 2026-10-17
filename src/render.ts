import { AgentInfo, SessionInfo, Status } from './transcripts';

/** One selectable line in the tree. */
export interface Row {
  key: string;
  text: string;
  detail: { title: string; lines: string[] };
}

export interface Style {
  color: boolean;
}

const ICON: Record<Status, string> = { running: '●', idle: '○', done: '✓' };
const COLOR: Record<Status, string> = { running: '32', idle: '33', done: '90' };

export function paint(s: string, code: string, style: Style): string {
  return style.color ? `\x1b[${code}m${s}\x1b[0m` : s;
}

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

interface Columns {
  width: number;
}

function statusCell(status: Status, label: string, style: Style): string {
  return paint(`${ICON[status]} ${fit(label, 10)}`, COLOR[status], style);
}

function agentRows(agents: AgentInfo[], prefix: string, now: number, cols: Columns, style: Style, out: Row[]): void {
  agents.forEach((a, i) => {
    const last = i === agents.length - 1;
    const branch = prefix + (last ? '└─ ' : '├─ ');
    const st = a.state;
    const elapsed = (a.status === 'running' ? now : st.lastTime || st.mtime) - st.firstTime;
    const doing = a.status === 'done' ? `${st.toolCalls} tools · ${compact(st.outputTokens)} tok` : st.current ?? '';

    const fixedLeft = branch.length + 12; // tree + status cell
    const nameW = 16;
    const timeW = 8;
    const rest = Math.max(10, cols.width - fixedLeft - nameW - timeW - 3);
    const descW = Math.min(36, Math.floor(rest * 0.45));
    const doingW = rest - descW - 1;

    const text =
      paint(branch, '90', style) +
      statusCell(a.status, a.status, style) +
      fit(a.agentType, nameW) +
      ' ' +
      fit(a.description, descW) +
      ' ' +
      fit(duration(elapsed), timeW) +
      ' ' +
      paint(fit(doing, doingW), '2', style);

    out.push({
      key: 'agent:' + a.id,
      text,
      detail: {
        title: `${a.agentType} · ${a.description} · ${shortModel(st.model)} · ${a.status}`,
        lines: st.recent.map((r) => `${clock(r.time)}  ${r.text}`),
      },
    });
    agentRows(a.children, prefix + (last ? '   ' : '│  '), now, cols, style, out);
  });
}

export function buildRows(sessions: SessionInfo[], now: number, width: number, style: Style): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    const st = s.state;
    const label = s.status === 'done' ? 'your turn' : s.status;
    const title = st.title ?? st.firstPrompt ?? s.id.slice(0, 8);
    const model = shortModel(st.model);
    // Status (12) + title (min 10) + gaps; the project column gives way on narrow terminals.
    const projectW = Math.max(4, Math.min(18, width - 12 - 10 - 1 - 12 - model.length - 1));
    const right = `${fit(s.project, projectW)} ${fit(ago(now - st.mtime), 11)} ${model}`;
    const agents = s.agentCount ? ` (${s.agentCount} agent${s.agentCount === 1 ? '' : 's'})` : '';
    const titleW = Math.max(10, width - 12 - right.length - 1);

    rows.push({
      key: 'session:' + s.id,
      text: statusCell(s.status, label, style) + paint(fit(title + agents, titleW), '1', style) + ' ' + right,
      detail: {
        title: `${title} · ${s.project} · session ${s.id}`,
        lines: st.recent.map((r) => `${clock(r.time)}  ${r.text}`),
      },
    });
    agentRows(s.agents, '', now, { width }, style, rows);
  }
  return rows;
}

export function header(sessions: SessionInfo[], root: string, now: number, width: number, style: Style): string {
  const count = (pred: (st: Status) => boolean) => {
    let n = 0;
    const walk = (as: AgentInfo[]) =>
      as.forEach((a) => {
        if (pred(a.status)) n++;
        walk(a.children);
      });
    sessions.forEach((s) => walk(s.agents));
    return n;
  };
  const left = `Claude agents · ${sessions.length} sessions · ${count((s) => s === 'running')} agents running`;
  const time = clock(now);
  const rootW = width - left.length - time.length - 4;
  const right = (rootW >= 12 ? fit(root, rootW).trimEnd() + '  ' : '') + time;
  const gap = Math.max(1, width - left.length - right.length);
  return paint(left, '1', style) + ' '.repeat(gap) + paint(right, '90', style);
}
