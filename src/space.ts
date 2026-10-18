import { AgentInfo, SessionInfo, Status } from './transcripts';
import { agentLook, BOLD, C, Style, bg, fg, paint, tint } from './render';

/**
 * The "space" view: agents float on a canvas like the VS Code extension's
 * graph, laid out by the same force simulation (repulsion between all nodes,
 * springs along parent → child links, a gentle pull to the centre, damping).
 *
 * World units: x is one terminal column, y is half a row, so distances look
 * the same in both directions (cells are about twice as tall as wide).
 * Links are drawn with braille dots, 2×4 per cell, so diagonals stay smooth.
 */

// ── Graph ───────────────────────────────────────────────────────────────────

export interface SpaceNode {
  key: string;
  icon: string;
  color: string;
  status: Status;
  label: string;
  sublabel: string;
  isSession: boolean;
  parent?: string;
}

export interface Graph {
  nodes: SpaceNode[];
  edges: Array<[string, string]>;
  hidden: number;
}

function agentNode(a: AgentInfo, parent: string): SpaceNode {
  const look = agentLook(a.agentType);
  const short = a.agentType.replace(/^.*:/, ''); // feature-dev:code-reviewer → code-reviewer
  return { key: 'agent:' + a.id, icon: look.icon, color: look.color, status: a.status, label: short, sublabel: a.description, isSession: false, parent };
}

/** Flattens sessions into graph nodes, dropping finished work first when there are more than `cap`. */
export function buildGraph(sessions: SessionInfo[], cap: number): Graph {
  type Entry = { node: SpaceNode; lastTime: number; session: string; done: boolean };
  const entries: Entry[] = [];
  for (const s of sessions) {
    const key = 'session:' + s.id;
    entries.push({
      node: {
        key,
        icon: '❖',
        color: C.accent,
        status: s.status,
        label: s.state.title ?? s.state.firstPrompt ?? s.id.slice(0, 8),
        sublabel: s.project,
        isSession: true,
      },
      lastTime: s.state.mtime,
      session: key,
      done: false,
    });
    const walk = (agents: AgentInfo[], parent: string) =>
      agents.forEach((a) => {
        entries.push({ node: agentNode(a, parent), lastTime: a.state.mtime, session: key, done: a.status === 'done' });
        walk(a.children, 'agent:' + a.id);
      });
    walk(s.agents, key);
  }

  let kept = entries;
  // 1. Oldest finished agents go first.
  if (kept.length > cap) {
    const done = kept.filter((e) => e.done).sort((a, b) => a.lastTime - b.lastTime);
    const drop = new Set(done.slice(0, kept.length - cap).map((e) => e.node.key));
    kept = kept.filter((e) => !drop.has(e.node.key));
  }
  // 2. Then whole sessions that have nothing left but their hub, least recent first.
  if (kept.length > cap) {
    const lonely = kept
      .filter((e) => e.node.isSession && !kept.some((k) => !k.node.isSession && k.session === e.session))
      .sort((a, b) => a.lastTime - b.lastTime);
    const drop = new Set(lonely.slice(0, kept.length - cap).map((e) => e.node.key));
    kept = kept.filter((e) => !drop.has(e.node.key));
  }
  kept = kept.slice(0, Math.max(cap, 1));

  const present = new Set(kept.map((e) => e.node.key));
  const nodes = kept.map((e) => {
    // Re-attach to the session hub when the real parent was hidden.
    if (e.node.parent && !present.has(e.node.parent)) return { ...e.node, parent: present.has(e.session) ? e.session : undefined };
    return e.node;
  });
  const edges = nodes.filter((n) => n.parent).map((n) => [n.parent!, n.key] as [string, string]);
  return { nodes, edges, hidden: entries.length - kept.length };
}

// ── Physics ─────────────────────────────────────────────────────────────────

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const CARD_W = 9; // ╭───────╮
const CARD_H = 3; // rows
const LABEL_W = 16;
const REPEL = 40;
const SPRING = 0.03;
const REST = 20;
const DAMPING = 0.85;
const MAX_SPEED = 3;

/** Small deterministic hash, so layouts are stable between runs and in tests. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export class Space {
  private bodies = new Map<string, Body>();
  graph: Graph = { nodes: [], edges: [], hidden: 0 };
  cols = 80;
  rows = 20;

  /** Most nodes that fit comfortably in a cols × rows area. */
  static capacity(cols: number, rows: number): number {
    // A card plus its labels needs roughly 18 × 6 cells, and layouts pack at about half density.
    return Math.max(4, Math.floor((cols * rows) / 220));
  }

  private get W() {
    return this.cols;
  }

  private get H() {
    return this.rows * 2;
  }

  sync(sessions: SessionInfo[], cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.graph = buildGraph(sessions, Space.capacity(cols, rows));
    const keys = new Set(this.graph.nodes.map((n) => n.key));
    for (const k of [...this.bodies.keys()]) if (!keys.has(k)) this.bodies.delete(k);
    const firstLayout = this.bodies.size === 0;

    for (const n of this.graph.nodes) {
      if (this.bodies.has(n.key)) continue;
      // New nodes appear next to their parent (or around the centre), like the extension.
      const anchor = (n.parent && this.bodies.get(n.parent)) || { x: this.W / 2, y: this.H / 2 };
      const a = hash(n.key) * Math.PI * 2;
      const r = n.parent ? REST * 0.6 : 4 + hash(n.key + '#r') * 10;
      this.bodies.set(n.key, { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r, vx: 0, vy: 0 });
    }
    // Open already arranged, so arrow keys work straight away; later arrivals float in.
    if (firstLayout && this.bodies.size) {
      this.energy = Infinity;
      this.settle();
    }
  }

  position(key: string): { x: number; y: number } | undefined {
    const b = this.bodies.get(key);
    return b && { x: b.x, y: b.y };
  }

  /** Total movement in the last step; near zero once the layout has settled. */
  energy = Infinity;

  step(times = 1): void {
    for (let t = 0; t < times; t++) this.tick();
  }

  settle(maxTicks = 800): void {
    for (let t = 0; t < maxTicks && this.energy > 0.01; t++) this.tick();
  }

  private tick(): void {
    const list = this.graph.nodes.map((n) => this.bodies.get(n.key)!);
    const W = this.W;
    const H = this.H;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (!dx && !dy) dx = 0.1 * (i - j);
        const d = Math.sqrt(dx * dx + dy * dy);
        const f = REPEL / (d * d);
        a.vx -= (dx / d) * f;
        a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;

        // Cards and their labels must not overlap: push apart along the shallower axis.
        const ox = LABEL_W + 2 - Math.abs(dx);
        const oy = (CARD_H + 2) * 2 + 2 - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox / (LABEL_W + 2) < oy / 12) {
            const s = Math.sign(dx) * ox * 0.1;
            a.vx -= s;
            b.vx += s;
          } else {
            const s = Math.sign(dy || 1) * oy * 0.1;
            a.vy -= s;
            b.vy += s;
          }
        }
      }
    }

    for (const [from, to] of this.graph.edges) {
      const a = this.bodies.get(from);
      const b = this.bodies.get(to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - REST) * SPRING;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }

    let energy = 0;
    for (const p of list) {
      // Centre pull; a little stronger vertically because terminals are wide and short.
      p.vx += (W / 2 - p.x) * 0.003;
      p.vy += (H / 2 - p.y) * 0.008;
      p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx * DAMPING));
      p.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vy * DAMPING));
      const x = p.x;
      const y = p.y;
      // Keep the card and its two label lines on screen; the bottom row stays free for the "hidden" note.
      p.x = Math.max(LABEL_W / 2, Math.min(W - LABEL_W / 2 - 1, p.x + p.vx));
      p.y = Math.max(2, Math.min(H - 10, p.y + p.vy));
      // A card pressed against an edge stops there instead of pushing forever.
      if (p.x !== x + p.vx) p.vx = 0;
      if (p.y !== y + p.vy) p.vy = 0;
      energy += Math.abs(p.x - x) + Math.abs(p.y - y);
    }
    this.energy = energy;
  }

  /** The node drawn at a canvas cell (its card or its two label lines), topmost first. */
  hit(col: number, row: number, selectedKey?: string): string | undefined {
    const ordered = [...this.graph.nodes].sort((a, b) => Number(b.key === selectedKey) - Number(a.key === selectedKey));
    for (const n of ordered) {
      const b = this.bodies.get(n.key)!;
      const left = Math.round(b.x) - Math.floor(CARD_W / 2);
      const top = Math.round(b.y / 2) - 1;
      if (col >= left && col < left + CARD_W && row >= top && row < top + CARD_H) return n.key;
      const label = clip(row === top + 3 ? n.label : row === top + 4 ? n.sublabel : '', LABEL_W);
      const start = Math.round(b.x - label.length / 2);
      if (label && col >= start && col < start + label.length) return n.key;
    }
    return undefined;
  }

  /** Node nearest to the selected one in a direction, for arrow-key navigation. */
  nearest(fromKey: string, dir: 'left' | 'right' | 'up' | 'down'): string | undefined {
    const from = this.bodies.get(fromKey);
    if (!from) return this.graph.nodes[0]?.key;
    const [ux, uy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    let best: { key: string; score: number } | undefined;
    for (const n of this.graph.nodes) {
      if (n.key === fromKey) continue;
      const b = this.bodies.get(n.key)!;
      const dx = b.x - from.x;
      const dy = b.y - from.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const cos = (dx * ux + dy * uy) / d;
      if (cos <= 0.2) continue;
      const score = d * (1 + 2 * (1 - cos));
      if (!best || score < best.score) best = { key: n.key, score };
    }
    return best?.key;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  render(style: Style, selectedKey?: string): string[] {
    const canvas = new Canvas(this.cols, this.rows);
    const sel = selectedKey;

    for (const [from, to] of this.graph.edges) {
      const a = this.bodies.get(from)!;
      const b = this.bodies.get(to)!;
      const hot = from === sel || to === sel;
      canvas.line(a.x * 2, a.y * 2, b.x * 2, b.y * 2, hot ? C.accent : C.subtle);
    }

    const ordered = [...this.graph.nodes].sort((a, b) => Number(a.key === sel) - Number(b.key === sel));
    for (const n of ordered) this.drawNode(canvas, n, n.key === sel, style);

    if (this.graph.hidden) {
      canvas.text(1, this.rows - 1, `+${this.graph.hidden} finished hidden · Tab for the tree`, C.muted);
    }
    return canvas.toLines(style);
  }

  private drawNode(canvas: Canvas, n: SpaceNode, selected: boolean, style: Style): void {
    const b = this.bodies.get(n.key)!;
    const left = Math.round(b.x) - Math.floor(CARD_W / 2);
    const top = Math.round(b.y / 2) - 1;
    const statusColor = STATUS_COLOR[n.status];
    const border = selected ? C.accent : statusColor;
    const fill = tint(selected ? C.accent : statusColor, selected ? 0.22 : 0.12);

    const inner = CARD_W - 2;
    canvas.text(left, top, '╭' + '─'.repeat(inner) + '╮', border, undefined, selected);
    canvas.text(left, top + 1, '│', border, undefined, selected);
    canvas.text(left + 1, top + 1, ' '.repeat(inner), C.text, fill);
    canvas.text(left + 1 + Math.floor(inner / 2), top + 1, n.icon, n.color, fill, true);
    canvas.text(left + CARD_W - 1, top + 1, '│', border, undefined, selected);
    canvas.text(left, top + 2, '╰' + '─'.repeat(inner) + '╯', border, undefined, selected);

    // Running: two counter-rotating arcs chase round the border, like the extension's rings.
    if (n.status === 'running' && style.frame !== undefined) {
      const ring = perimeter(left, top);
      const at = (i: number) => ring[((i % ring.length) + ring.length) % ring.length];
      for (let i = 0; i < 4; i++) canvas.recolor(...at(style.frame + i), C.accent);
      for (let i = 0; i < 3; i++) canvas.recolor(...at(-style.frame + ring.length / 2 + i), C.accent2);
    }

    // Status mark in the top-right corner, like the extension's status dot.
    const mark = n.status === 'running' && style.frame !== undefined ? SPINNER[style.frame % SPINNER.length] : STATUS_MARK[n.status];
    canvas.text(left + CARD_W - 3, top, mark, STATUS_COLOR[n.status], undefined, true);

    const label = clip(n.label, LABEL_W);
    const sub = clip(n.sublabel, LABEL_W);
    canvas.text(Math.round(b.x - label.length / 2), top + 3, label, n.isSession ? C.text : n.color, undefined, true);
    canvas.text(Math.round(b.x - sub.length / 2), top + 4, sub, n.isSession ? C.accent2 : C.muted);
  }
}

const STATUS_COLOR: Record<Status, string> = { running: C.running, idle: C.warn, done: C.ok };
const STATUS_MARK: Record<Status, string> = { running: '●', idle: '◌', done: '✓' };
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function clip(s: string, w: number): string {
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

/** Border cells of a card, clockwise from the top-left corner. */
function perimeter(left: number, top: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let x = 0; x < CARD_W; x++) cells.push([left + x, top]);
  for (let y = 1; y < CARD_H - 1; y++) cells.push([left + CARD_W - 1, top + y]);
  for (let x = CARD_W - 1; x >= 0; x--) cells.push([left + x, top + CARD_H - 1]);
  for (let y = CARD_H - 2; y >= 1; y--) cells.push([left, top + y]);
  return cells;
}

// ── Character canvas with a braille layer ──────────────────────────────────

const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class Canvas {
  private ch: Array<string | undefined>;
  private fgc: Array<string | undefined>;
  private bgc: Array<string | undefined>;
  private bold: boolean[];
  private dots: Uint8Array;
  private dotColor: Array<string | undefined>;

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.ch = new Array(n);
    this.fgc = new Array(n);
    this.bgc = new Array(n);
    this.bold = new Array(n).fill(false);
    this.dots = new Uint8Array(n);
    this.dotColor = new Array(n);
  }

  text(col: number, row: number, s: string, color?: string, back?: string, bold = false): void {
    if (row < 0 || row >= this.h) return;
    [...s].forEach((c, i) => {
      const x = col + i;
      if (x < 0 || x >= this.w) return;
      const k = row * this.w + x;
      this.ch[k] = c;
      this.fgc[k] = color;
      this.bgc[k] = back;
      this.bold[k] = bold;
    });
  }

  recolor(col: number, row: number, color: string): void {
    if (col < 0 || col >= this.w || row < 0 || row >= this.h) return;
    this.fgc[row * this.w + col] = color;
    this.bold[row * this.w + col] = true;
  }

  /** Sets one braille sub-pixel; (sx, sy) are in 2×4 dots-per-cell coordinates. */
  dot(sx: number, sy: number, color: string): void {
    const col = Math.floor(sx / 2);
    const row = Math.floor(sy / 4);
    if (col < 0 || col >= this.w || row < 0 || row >= this.h) return;
    const k = row * this.w + col;
    this.dots[k] |= BRAILLE[sy - row * 4][sx - col * 2];
    this.dotColor[k] = color;
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const tx = Math.round(x1);
    const ty = Math.round(y1);
    const dx = Math.abs(tx - x);
    const dy = -Math.abs(ty - y);
    const sx = x < tx ? 1 : -1;
    const sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.dot(x, y, color);
      if (x === tx && y === ty) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  toLines(style: Style): string[] {
    const lines: string[] = [];
    for (let row = 0; row < this.h; row++) {
      let out = '';
      let run = '';
      let runCode = '';
      const flush = () => {
        out += runCode ? paint(run, runCode, style) : run;
        run = '';
      };
      for (let col = 0; col < this.w; col++) {
        const k = row * this.w + col;
        let c = this.ch[k];
        let code = '';
        if (c !== undefined) {
          const parts = [this.bold[k] ? BOLD : '', this.fgc[k] ? fg(this.fgc[k]!) : '', this.bgc[k] ? bg(this.bgc[k]!) : ''];
          code = parts.filter(Boolean).join(';');
        } else if (this.dots[k]) {
          c = String.fromCharCode(0x2800 + this.dots[k]);
          code = fg(this.dotColor[k]!);
        } else {
          c = ' ';
        }
        if (code !== runCode) {
          flush();
          runCode = code;
        }
        run += c;
      }
      flush();
      lines.push(out);
    }
    return lines;
  }
}
