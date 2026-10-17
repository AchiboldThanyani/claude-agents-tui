import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Builds a fake ~/.claude/projects folder in a temp dir, laid out the way
 * Claude Code writes it, so tests can drive TranscriptStore and the CLI.
 */
export class FakeProjects {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-test-'));

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  sessionFile(project: string, session: string): string {
    return path.join(this.root, project, `${session}.jsonl`);
  }

  agentFile(project: string, session: string, agentId: string): string {
    return path.join(this.root, project, session, 'subagents', `agent-${agentId}.jsonl`);
  }

  writeSession(project: string, session: string, entries: object[]): string {
    return write(this.sessionFile(project, session), entries);
  }

  writeAgent(project: string, session: string, agentId: string, meta: object, entries: object[]): string {
    const file = this.agentFile(project, session, agentId);
    write(file, entries);
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
    return file;
  }
}

function write(file: string, entries: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  return file;
}

export function append(file: string, entries: object[]): void {
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

/** Sets a file's mtime to `msAgo` before `now`. */
export function age(file: string, now: number, msAgo: number): void {
  const t = new Date(now - msAgo);
  fs.utimesSync(file, t, t);
}

export function iso(now: number, msAgo = 0): string {
  return new Date(now - msAgo).toISOString();
}

// ── Transcript entry builders ───────────────────────────────────────────────

export function userPrompt(text: string, timestamp: string, cwd = 'C:\\code\\demo-app'): object {
  return { type: 'user', cwd, timestamp, message: { role: 'user', content: text } };
}

export function toolUse(
  id: string,
  name: string,
  input: object,
  timestamp: string,
  model = 'claude-sonnet-5-5',
): object {
  return {
    type: 'assistant',
    timestamp,
    message: {
      model,
      stop_reason: 'tool_use',
      usage: { output_tokens: 10 },
      content: [{ type: 'tool_use', id, name, input }],
    },
  };
}

export function toolResult(id: string, timestamp: string): object {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  };
}

export function reply(text: string, timestamp: string, stopReason: string | null = 'end_turn'): object {
  return {
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-sonnet-5-5',
      stop_reason: stopReason,
      usage: { output_tokens: 100 },
      content: [{ type: 'text', text }],
    },
  };
}

export function title(text: string): object {
  return { type: 'ai-title', aiTitle: text };
}
