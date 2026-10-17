import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptStore, SessionInfo, AgentInfo } from '../transcripts';
import { FakeProjects, age, append, iso, reply, title, toolResult, toolUse, userPrompt } from './fixtures';

const HOUR = 3_600_000;

let fake: FakeProjects;
let now: number;

beforeEach(() => {
  fake = new FakeProjects();
  now = Date.now();
});

afterEach(() => fake.cleanup());

function scan(store = new TranscriptStore(fake.root), opts: { since?: number; project?: string } = {}): SessionInfo[] {
  return store.scan(now - (opts.since ?? HOUR), opts.project, now);
}

function only<T>(items: T[]): T {
  assert.equal(items.length, 1, `expected exactly one item, got ${items.length}`);
  return items[0];
}

/** A session with one Explore subagent whose transcript is `entries`. */
function sessionWithAgent(entries: object[], agentAgeMs = 0): string {
  fake.writeSession('proj', 's1', [
    userPrompt('build it', iso(now)),
    toolUse('toolu_A', 'Agent', { description: 'Find code' }, iso(now)),
  ]);
  const file = fake.writeAgent('proj', 's1', 'a1', { agentType: 'Explore', description: 'Find code', toolUseId: 'toolu_A' }, entries);
  age(file, now, agentAgeMs);
  return file;
}

function onlyAgent(): AgentInfo {
  return only(only(scan()).agents);
}

describe('agent status', () => {
  test('pending tool call written just now is running, with the tool as current action', () => {
    sessionWithAgent([userPrompt('search', iso(now)), toolUse('t1', 'Grep', { pattern: 'authenticate' }, iso(now))]);
    const a = onlyAgent();
    assert.equal(a.status, 'running');
    assert.equal(a.state.current, 'Grep authenticate');
  });

  test('end_turn reply is done', () => {
    sessionWithAgent([userPrompt('search', iso(now, 5000)), reply('Found it.', iso(now))]);
    assert.equal(onlyAgent().status, 'done');
  });

  test('unfinished agent quiet for over 30s is idle', () => {
    sessionWithAgent(
      [userPrompt('search', iso(now, 60_000)), toolUse('t1', 'Bash', { command: 'npm test' }, iso(now, 60_000))],
      60_000,
    );
    assert.equal(onlyAgent().status, 'idle');
  });

  test('final text logged with stop_reason null counts as done once quiet for 10s', () => {
    sessionWithAgent([userPrompt('search', iso(now, 15_000)), reply('All done.', iso(now, 15_000), null)], 15_000);
    assert.equal(onlyAgent().status, 'done');
  });

  test('text with stop_reason null written just now is still running', () => {
    sessionWithAgent([userPrompt('search', iso(now)), reply('Let me look…', iso(now), null)]);
    assert.equal(onlyAgent().status, 'running');
  });

  test('tool result after a reply means the agent is working again', () => {
    sessionWithAgent([
      reply('Checking.', iso(now, 2000), null),
      toolUse('t1', 'Read', { file_path: 'C:\\code\\src\\index.ts' }, iso(now, 1000)),
      toolResult('t1', iso(now)),
    ]);
    const a = onlyAgent();
    assert.equal(a.status, 'running');
    assert.equal(a.state.current, 'Read index.ts', 'file paths are shown as the basename');
  });

  test('user interrupt marks the agent finished', () => {
    sessionWithAgent([
      toolUse('t1', 'Bash', { command: 'sleep 100' }, iso(now, 1000)),
      { type: 'user', timestamp: iso(now), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]);
    const a = onlyAgent();
    assert.equal(a.status, 'done');
    assert.equal(a.state.current, 'interrupted');
  });

  test('counts tool calls and output tokens', () => {
    sessionWithAgent([
      toolUse('t1', 'Grep', { pattern: 'x' }, iso(now)),
      toolUse('t2', 'Read', { file_path: 'a.ts' }, iso(now)),
      reply('Done.', iso(now)),
    ]);
    const a = onlyAgent();
    assert.equal(a.state.toolCalls, 2);
    assert.equal(a.state.outputTokens, 120);
  });
});

describe('sessions', () => {
  test('uses the AI title, project folder from cwd and model', () => {
    fake.writeSession('C--code-demo-app', 's1', [
      userPrompt('build the thing', iso(now)),
      reply('Sure.', iso(now)),
      title('Demo session'),
    ]);
    const s = only(scan());
    assert.equal(s.state.title, 'Demo session');
    assert.equal(s.project, 'demo-app');
    assert.equal(s.state.model, 'claude-sonnet-5-5');
    assert.equal(s.status, 'done');
  });

  test('falls back to the first prompt when there is no title', () => {
    fake.writeSession('proj', 's1', [userPrompt('fix the login bug', iso(now))]);
    assert.equal(only(scan()).state.firstPrompt, 'fix the login bug');
  });

  test('ignores system-style prompts wrapped in tags when picking the first prompt', () => {
    fake.writeSession('proj', 's1', [
      userPrompt('<command-name>/clear</command-name>', iso(now)),
      userPrompt('real question', iso(now)),
    ]);
    assert.equal(only(scan()).state.firstPrompt, 'real question');
  });

  test('sessions older than the window are hidden', () => {
    const file = fake.writeSession('proj', 'old', [userPrompt('hi', iso(now, 3 * HOUR))]);
    age(file, now, 3 * HOUR);
    assert.equal(scan().length, 0);
    assert.equal(scan(undefined, { since: 4 * HOUR }).length, 1);
  });

  test('project filter is a case-insensitive substring match', () => {
    fake.writeSession('a', 's1', [userPrompt('one', iso(now), 'C:\\work\\Extension')]);
    fake.writeSession('b', 's2', [userPrompt('two', iso(now), 'C:\\work\\budget-app')]);
    assert.deepEqual(scan(undefined, { project: 'exten' }).map((s) => s.project), ['Extension']);
  });

  test('sessions with running work are listed first', () => {
    const idle = fake.writeSession('proj', 'idle', [userPrompt('a', iso(now, 600_000)), reply('ok', iso(now, 600_000))]);
    age(idle, now, 60_000);
    const busy = fake.writeSession('proj', 'busy', [userPrompt('b', iso(now, 600_000)), toolUse('t', 'Bash', { command: 'ls' }, iso(now, 600_000))]);
    age(busy, now, 120_000);
    fake.writeAgent('proj', 'busy', 'x', { agentType: 'Explore', toolUseId: 'nope' }, [toolUse('t2', 'Grep', { pattern: 'p' }, iso(now))]);
    assert.deepEqual(scan().map((s) => s.id), ['busy', 'idle']);
  });

  test('a missing projects folder gives an empty list instead of throwing', () => {
    assert.deepEqual(new TranscriptStore(fake.root + '-missing').scan(0), []);
  });
});

describe('subagent nesting', () => {
  test('agents are nested under the transcript that spawned them', () => {
    fake.writeSession('proj', 's1', [toolUse('toolu_A', 'Agent', { description: 'Plan' }, iso(now))]);
    fake.writeAgent('proj', 's1', 'plan', { agentType: 'Plan', description: 'Plan', toolUseId: 'toolu_A', spawnDepth: 1 }, [
      toolUse('toolu_B', 'Agent', { description: 'Search' }, iso(now)),
    ]);
    fake.writeAgent('proj', 's1', 'explore', { agentType: 'Explore', description: 'Search', toolUseId: 'toolu_B', spawnDepth: 2 }, [
      toolUse('t1', 'Grep', { pattern: 'auth' }, iso(now)),
    ]);

    const s = only(scan());
    assert.equal(s.agentCount, 2);
    const plan = only(s.agents);
    assert.equal(plan.agentType, 'Plan');
    assert.equal(only(plan.children).agentType, 'Explore');
  });

  test('agents whose parent is not visible fall back to the session', () => {
    fake.writeSession('proj', 's1', [userPrompt('hi', iso(now))]);
    fake.writeAgent('proj', 's1', 'orphan', { agentType: 'Explore', toolUseId: 'unknown' }, [toolUse('t1', 'Grep', { pattern: 'x' }, iso(now))]);
    assert.equal(only(only(scan()).agents).id, 'orphan');
  });

  test('missing meta file uses defaults and the first prompt as description', () => {
    fake.writeSession('proj', 's1', [userPrompt('hi', iso(now))]);
    const file = fake.agentFile('proj', 's1', 'nometa');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(userPrompt('look for bugs', iso(now))) + '\n');
    const a = onlyAgent();
    assert.equal(a.agentType, 'agent');
    assert.equal(a.description, 'look for bugs');
  });

  test('old finished agents are hidden but old unfinished ones are kept', () => {
    fake.writeSession('proj', 's1', [userPrompt('hi', iso(now))]);
    const done = fake.writeAgent('proj', 's1', 'done', { agentType: 'A' }, [reply('ok', iso(now, 2 * HOUR))]);
    age(done, now, 2 * HOUR);
    fake.writeAgent('proj', 's1', 'fresh', { agentType: 'B' }, [toolUse('t', 'Grep', { pattern: 'x' }, iso(now))]);
    assert.deepEqual(only(scan()).agents.map((a) => a.id), ['fresh']);
  });
});

describe('incremental reading', () => {
  test('picks up lines appended after the first scan', () => {
    const store = new TranscriptStore(fake.root);
    const file = sessionWithAgent([toolUse('t1', 'Grep', { pattern: 'x' }, iso(now))]);
    assert.equal(only(only(scan(store)).agents).status, 'running');

    append(file, [reply('Found it.', iso(now))]);
    const a = only(only(scan(store)).agents);
    assert.equal(a.status, 'done');
    assert.equal(a.state.toolCalls, 1, 'earlier lines are not counted twice');
  });

  test('a half-written last line is held back until it is completed', () => {
    const store = new TranscriptStore(fake.root);
    const file = sessionWithAgent([toolUse('t1', 'Grep', { pattern: 'x' }, iso(now))]);
    const line = JSON.stringify(reply('Found it.', iso(now))) + '\n';
    const cut = Math.floor(line.length / 2);

    fs.appendFileSync(file, line.slice(0, cut));
    assert.equal(only(only(scan(store)).agents).status, 'running');

    fs.appendFileSync(file, line.slice(cut));
    assert.equal(only(only(scan(store)).agents).status, 'done');
  });

  test('multi-byte characters split across reads survive', () => {
    const store = new TranscriptStore(fake.root);
    const file = sessionWithAgent([toolUse('t1', 'Grep', { pattern: 'x' }, iso(now))]);
    const bytes = Buffer.from(JSON.stringify(reply('café ✓ done', iso(now))) + '\n');
    const cut = bytes.indexOf(Buffer.from('✓')) + 1; // inside the 3-byte character

    fs.appendFileSync(file, bytes.subarray(0, cut));
    scan(store);
    fs.appendFileSync(file, bytes.subarray(cut));
    assert.equal(only(only(scan(store)).agents).state.current, '“café ✓ done”');
  });

  test('malformed lines are skipped', () => {
    const file = sessionWithAgent([toolUse('t1', 'Grep', { pattern: 'x' }, iso(now))]);
    fs.appendFileSync(file, '{"type":"assistant", broken\n');
    append(file, [reply('Still parsed.', iso(now))]);
    assert.equal(onlyAgent().status, 'done');
  });

  test('a rewritten (shorter) file is re-read from the start', () => {
    const store = new TranscriptStore(fake.root);
    const file = sessionWithAgent([
      toolUse('t1', 'Grep', { pattern: 'x' }, iso(now)),
      toolUse('t2', 'Grep', { pattern: 'y' }, iso(now)),
      toolUse('t3', 'Grep', { pattern: 'z' }, iso(now)),
    ]);
    assert.equal(only(only(scan(store)).agents).state.toolCalls, 3);

    fs.writeFileSync(file, JSON.stringify(reply('Short.', iso(now))) + '\n');
    const a = only(only(scan(store)).agents);
    assert.equal(a.state.toolCalls, 0);
    assert.equal(a.status, 'done');
  });
});
