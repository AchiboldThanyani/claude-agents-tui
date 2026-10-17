import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads Claude Code transcripts from disk. Layout (Claude Code 2.x):
 *
 *   <root>/<project>/<sessionId>.jsonl                         main conversation
 *   <root>/<project>/<sessionId>/subagents/agent-<id>.jsonl    one per subagent
 *   <root>/<project>/<sessionId>/subagents/agent-<id>.meta.json
 *
 * Files are append-only JSONL, so each one is read incrementally from the
 * last offset and folded into a small summary (TranscriptState).
 */

export type Status = 'running' | 'idle' | 'done';

/** No writes for this long and not finished → shown as idle instead of running. */
const RUNNING_WINDOW_MS = 30_000;
/** Final text is sometimes logged with stop_reason null; treat it as finished once quiet this long. */
const TEXT_END_GRACE_MS = 10_000;
const RECENT_LIMIT = 20;

export interface Activity {
  time: number;
  text: string;
}

export interface TranscriptState {
  offset: number;
  partial: Buffer;
  mtime: number;
  firstTime: number;
  lastTime: number;
  title?: string;
  firstPrompt?: string;
  cwd?: string;
  model?: string;
  /** Last assistant turn ended (end_turn) and nothing has happened since. */
  finished: boolean;
  /** Last entry is assistant text with no stop_reason and no tool call after it. */
  endedWithText: boolean;
  /** Short description of the latest action, e.g. `Grep "runAgent"`. */
  current?: string;
  toolCalls: number;
  outputTokens: number;
  /** ids of Agent/Task tool calls made from this transcript, used to nest subagents. */
  spawnedToolUseIds: Set<string>;
  recent: Activity[];
}

export interface AgentInfo {
  id: string;
  agentType: string;
  description: string;
  depth: number;
  toolUseId?: string;
  state: TranscriptState;
  status: Status;
  children: AgentInfo[];
}

export interface SessionInfo {
  id: string;
  project: string;
  state: TranscriptState;
  status: Status;
  agents: AgentInfo[];
  agentCount: number;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

function newState(): TranscriptState {
  return {
    offset: 0,
    partial: Buffer.alloc(0),
    mtime: 0,
    firstTime: 0,
    lastTime: 0,
    finished: false,
    endedWithText: false,
    toolCalls: 0,
    outputTokens: 0,
    spawnedToolUseIds: new Set(),
    recent: [],
  };
}

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const arg =
    i.description ?? i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? i.skill;
  if (typeof arg !== 'string' || !arg) return name;
  const shown = typeof i.file_path === 'string' && arg === i.file_path ? path.basename(arg) : arg;
  return `${name} ${oneLine(shown, 80)}`;
}

function pushRecent(st: TranscriptState, time: number, text: string): void {
  st.recent.push({ time, text });
  if (st.recent.length > RECENT_LIMIT) st.recent.shift();
}

function applyEntry(st: TranscriptState, o: any): void {
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string') {
    st.title = o.aiTitle;
    return;
  }
  if (typeof o.cwd === 'string') st.cwd = o.cwd;

  const time = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!isNaN(time)) {
    if (!st.firstTime) st.firstTime = time;
    st.lastTime = time;
  }
  const t = isNaN(time) ? st.lastTime : time;
  const msg = o.message;
  if (!msg) return;

  if (o.type === 'assistant') {
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) st.model = msg.model;
    const out = msg.usage?.output_tokens;
    if (typeof out === 'number') st.outputTokens += out;

    let lastBlock = '';
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      lastBlock = part.type;
      if (part.type === 'tool_use') {
        st.toolCalls++;
        st.current = describeTool(part.name, part.input);
        pushRecent(st, t, st.current);
        if (part.name === 'Agent' || part.name === 'Task') st.spawnedToolUseIds.add(part.id);
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        st.current = '“' + oneLine(part.text, 80) + '”';
        pushRecent(st, t, oneLine(part.text));
      }
    }
    st.finished = msg.stop_reason === 'end_turn';
    if (lastBlock === 'tool_use' || lastBlock === 'text') st.endedWithText = lastBlock === 'text' && msg.stop_reason == null;
  } else if (o.type === 'user' && !o.isMeta) {
    const content = msg.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
          : '';
    if (text.startsWith('[Request interrupted')) {
      st.finished = true;
      st.endedWithText = false;
      st.current = 'interrupted';
      pushRecent(st, t, 'interrupted by user');
      return;
    }
    st.finished = false;
    st.endedWithText = false;
    if (text && !text.startsWith('<')) {
      if (!st.firstPrompt) st.firstPrompt = oneLine(text, 80);
      pushRecent(st, t, 'prompt: ' + oneLine(text));
    }
  }
}

/** Reads whatever was appended to `file` since the last call and folds it into `st`. */
function readNew(file: string, st: TranscriptState, size: number, mtime: number): TranscriptState {
  if (size < st.offset) st = newState(); // file was rewritten
  st.mtime = mtime;
  if (size === st.offset) return st;

  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - st.offset);
    const n = fs.readSync(fd, buf, 0, buf.length, st.offset);
    st.offset += n;
    let data = Buffer.concat([st.partial, buf.subarray(0, n)]);
    let start = 0;
    for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
      const line = data.toString('utf8', start, nl).trim();
      start = nl + 1;
      if (!line) continue;
      try {
        applyEntry(st, JSON.parse(line));
      } catch {
        // half-written or unknown line: skip
      }
    }
    st.partial = Buffer.from(data.subarray(start));
  } finally {
    fs.closeSync(fd);
  }
  return st;
}

function statusOf(st: TranscriptState, now: number): Status {
  const quiet = now - Math.max(st.mtime, st.lastTime);
  if (st.finished || (st.endedWithText && quiet >= TEXT_END_GRACE_MS)) return 'done';
  return quiet < RUNNING_WINDOW_MS ? 'running' : 'idle';
}

function safeStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

export class TranscriptStore {
  private states = new Map<string, TranscriptState>();
  private metas = new Map<string, AgentMeta>();

  constructor(private root: string) {}

  private load(file: string, stat: fs.Stats): TranscriptState {
    const prev = this.states.get(file) ?? newState();
    const next = readNew(file, prev, stat.size, stat.mtimeMs);
    this.states.set(file, next);
    return next;
  }

  private meta(file: string): AgentMeta {
    let m = this.metas.get(file);
    if (!m) {
      try {
        m = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentMeta;
      } catch {
        m = {};
      }
      this.metas.set(file, m);
    }
    return m;
  }

  /** Sessions with activity since `cutoff` (ms epoch), newest first. */
  scan(cutoff: number, projectFilter?: string, now = Date.now()): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    for (const projDir of safeReaddir(this.root)) {
      const projPath = path.join(this.root, projDir);
      for (const name of safeReaddir(projPath)) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        const file = path.join(projPath, name);
        const subDir = path.join(projPath, id, 'subagents');
        const stat = safeStat(file);
        if (!stat) continue;
        const subStat = safeStat(subDir);
        if (Math.max(stat.mtimeMs, subStat?.mtimeMs ?? 0) < cutoff && !this.states.has(file)) continue;

        const state = this.load(file, stat);
        const project = state.cwd ? path.basename(state.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : projDir;
        if (projectFilter && !project.toLowerCase().includes(projectFilter.toLowerCase())) continue;

        const agents = subStat ? this.loadAgents(subDir, cutoff, now) : [];
        const lastActivity = Math.max(state.mtime, ...agents.map((a) => a.state.mtime));
        if (lastActivity < cutoff) continue;

        sessions.push({
          id,
          project,
          state,
          status: statusOf(state, now),
          agents: nest(agents, state),
          agentCount: agents.length,
        });
      }
    }

    const rank = (s: SessionInfo) => (s.status === 'running' || s.agents.some(isActive) ? 1 : 0);
    return sessions.sort((a, b) => rank(b) - rank(a) || b.state.mtime - a.state.mtime);
  }

  private loadAgents(subDir: string, cutoff: number, now: number): AgentInfo[] {
    const agents: AgentInfo[] = [];
    for (const name of safeReaddir(subDir)) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const file = path.join(subDir, name);
      const stat = safeStat(file);
      if (!stat) continue;
      const known = this.states.get(file);
      // Skip old finished agents without reading them; keep anything we already track.
      if (stat.mtimeMs < cutoff && !known) continue;

      const state = this.load(file, stat);
      const status = statusOf(state, now);
      if (status === 'done' && state.mtime < cutoff) continue;

      const meta = this.meta(path.join(subDir, `agent-${m[1]}.meta.json`));
      agents.push({
        id: m[1],
        agentType: meta.agentType ?? 'agent',
        description: meta.description ?? state.firstPrompt ?? '',
        depth: meta.spawnDepth ?? 1,
        toolUseId: meta.toolUseId,
        state,
        status,
        children: [],
      });
    }
    return agents.sort((a, b) => a.state.firstTime - b.state.firstTime);
  }
}

export function isActive(a: AgentInfo): boolean {
  return a.status !== 'done' || a.children.some(isActive);
}

/** Puts each agent under the agent whose transcript spawned it; the rest go under the session. */
function nest(agents: AgentInfo[], session: TranscriptState): AgentInfo[] {
  const top: AgentInfo[] = [];
  for (const a of agents) {
    const parent =
      a.toolUseId && !session.spawnedToolUseIds.has(a.toolUseId)
        ? agents.find((p) => p !== a && p.state.spawnedToolUseIds.has(a.toolUseId!))
        : undefined;
    (parent ? parent.children : top).push(a);
  }
  return top;
}
