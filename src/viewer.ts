import { ConversationFile, Entry } from './conversation';
import { BOLD, C, Style, fg, fit, paint } from './render';

/**
 * Full-screen, scrollable view of one transcript: prompts, replies, tool
 * calls and their results. Follows new activity while scrolled to the end.
 */

const TOOL_INPUT_LINES = 6;
const RESULT_LINES = 8;

/** Removes terminal control sequences from transcript text so it cannot repaint the screen. */
export function sanitize(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Wraps text to `width`, breaking at spaces where possible. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  for (const raw of sanitize(text).split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (!line) {
      out.push('');
      continue;
    }
    while (line.length > w) {
      const cut = line.lastIndexOf(' ', w);
      const at = cut > w * 0.5 ? cut : w;
      out.push(line.slice(0, at));
      line = line.slice(at).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

function clock(t: number): string {
  return t ? new Date(t).toTimeString().slice(0, 8) : '';
}

/** Lays a conversation out as styled lines for a given width. */
export function layout(entries: Entry[], width: number, style: Style): string[] {
  const lines: string[] = [];
  const inner = Math.max(10, width - 4);
  const head = (icon: string, label: string, color: string, time: number) =>
    paint(`${icon} ${label}`, `${BOLD};${fg(color)}`, style) + '  ' + paint(clock(time), fg(C.muted), style);
  const body = (text: string, color: string, prefix = '  ', max = Infinity) => {
    const wrapped = wrap(text, inner);
    const shown = wrapped.slice(0, max);
    for (const l of shown) lines.push(paint(prefix, fg(C.subtle), style) + paint(l, fg(color), style));
    if (wrapped.length > shown.length) {
      lines.push(paint(prefix, fg(C.subtle), style) + paint(`… ${wrapped.length - shown.length} more lines`, fg(C.muted), style));
    }
  };

  for (const e of entries) {
    switch (e.kind) {
      case 'prompt':
        if (lines.length) lines.push('');
        lines.push(head('▸', 'Prompt', C.accent, e.time));
        body(e.text, C.text);
        break;
      case 'reply':
        if (lines.length) lines.push('');
        lines.push(head('◆', 'Claude', C.accent2, e.time));
        body(e.text, C.text);
        break;
      case 'tool':
        if (lines.length) lines.push('');
        lines.push(head('⚙', e.tool ?? 'tool', C.running, e.time));
        if (e.text) body(e.text, C.muted, '  ', TOOL_INPUT_LINES);
        break;
      case 'result':
        if (e.text) body(e.text, C.muted, '  │ ', RESULT_LINES);
        else lines.push(paint('  │ ', fg(C.subtle), style) + paint('(no output)', fg(C.muted), style));
        break;
      case 'error':
        lines.push(paint('  ✗ failed', `${BOLD};${fg(C.err)}`, style));
        body(e.text || '(no message)', C.err, '  │ ', RESULT_LINES);
        break;
      case 'interrupt':
        if (lines.length) lines.push('');
        lines.push(paint('⏹ Interrupted by user', `${BOLD};${fg(C.warn)}`, style) + '  ' + paint(clock(e.time), fg(C.muted), style));
        break;
    }
  }
  return lines;
}

export class Viewer {
  scroll = 0;
  /** Stick to the end while new activity arrives, until the user scrolls up. */
  follow = true;
  private cache = { count: -1, width: -1, color: false, lines: [] as string[] };

  constructor(
    readonly conversation: ConversationFile,
    readonly title: string,
    readonly icon: string,
    readonly color: string,
  ) {
    conversation.refresh();
  }

  private lines(width: number, style: Style): string[] {
    const n = this.conversation.entries.length;
    if (this.cache.count !== n || this.cache.width !== width || this.cache.color !== style.color) {
      this.cache = { count: n, width, color: style.color, lines: layout(this.conversation.entries, width, style) };
    }
    return this.cache.lines;
  }

  /** `height` rows: a title line, then the visible part of the conversation. */
  render(width: number, height: number, style: Style): string[] {
    const all = this.lines(width, style);
    const view = Math.max(1, height - 1);
    const max = Math.max(0, all.length - view);
    if (this.follow) this.scroll = max;
    this.scroll = Math.max(0, Math.min(this.scroll, max));

    const where = all.length <= view ? 'all' : this.scroll >= max ? 'end' : `${Math.round((this.scroll / max) * 100)}%`;
    const right = ` ${all.length} lines · ${where} `;
    const left = ` ${this.icon} ${this.title} `;
    const titleLine =
      paint(fit(left, Math.max(0, width - right.length)), `${BOLD};${fg(this.color)}`, style) + paint(right, fg(C.muted), style);

    const out = [titleLine, ...all.slice(this.scroll, this.scroll + view).map((l) => ' ' + l)];
    if (!all.length) out.push(paint('  (nothing in this transcript yet)', fg(C.muted), style));
    return out;
  }

  scrollBy(delta: number, height: number, width: number, style: Style): void {
    const total = this.lines(width, style).length;
    const max = Math.max(0, total - Math.max(1, height - 1));
    this.scroll = Math.max(0, Math.min(max, (this.follow ? max : this.scroll) + delta));
    this.follow = this.scroll >= max;
  }

  toTop(): void {
    this.scroll = 0;
    this.follow = false;
  }

  toEnd(): void {
    this.follow = true;
  }
}
