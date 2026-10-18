import * as fs from 'fs';

/**
 * Reads a whole transcript as a conversation for the transcript viewer:
 * prompts, Claude's replies, tool calls and their results, in order.
 */

export type EntryKind = 'prompt' | 'reply' | 'tool' | 'result' | 'error' | 'interrupt';

export interface Entry {
  kind: EntryKind;
  time: number;
  /** Tool name for 'tool' entries. */
  tool?: string;
  text: string;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : ''))
    .filter(Boolean)
    .join('\n');
}

/** One-line-per-field view of a tool's input, e.g. `pattern: "auth"`. */
export function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

export function parseConversation(jsonl: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o.message;
    if (!msg || o.isMeta) continue;
    const time = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const t = isNaN(time) ? entries[entries.length - 1]?.time ?? 0 : time;

    if (o.type === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          entries.push({ kind: 'reply', time: t, text: part.text.trim() });
        } else if (part.type === 'tool_use') {
          entries.push({ kind: 'tool', time: t, tool: part.name, text: describeInput(part.input) });
        }
      }
    } else if (o.type === 'user') {
      if (typeof msg.content === 'string') {
        pushPrompt(entries, t, msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            entries.push({ kind: part.is_error ? 'error' : 'result', time: t, text: resultText(part.content).trim() });
          } else if (part.type === 'text' && typeof part.text === 'string') {
            pushPrompt(entries, t, part.text);
          }
        }
      }
    }
  }
  return entries;
}

function pushPrompt(entries: Entry[], time: number, text: string): void {
  const s = text.trim();
  if (!s || s.startsWith('<')) return; // command wrappers and system reminders
  if (s.startsWith('[Request interrupted')) entries.push({ kind: 'interrupt', time, text: 'Interrupted by user' });
  else entries.push({ kind: 'prompt', time, text: s });
}

/** Re-reads a transcript only when it has grown or changed. */
export class ConversationFile {
  private size = -1;
  private mtime = -1;
  entries: Entry[] = [];

  constructor(readonly file: string) {}

  /** Returns true when the entries changed. */
  refresh(): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (st.size === this.size && st.mtimeMs === this.mtime) return false;
    this.size = st.size;
    this.mtime = st.mtimeMs;
    this.entries = parseConversation(fs.readFileSync(this.file, 'utf8'));
    return true;
  }
}
