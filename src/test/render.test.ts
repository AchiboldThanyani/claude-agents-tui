import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildRows, duration, fit, header } from '../render';
import { AgentInfo, SessionInfo, Status, TranscriptState } from '../transcripts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const plain = { color: false };

function state(patch: Partial<TranscriptState> = {}): TranscriptState {
  return {
    offset: 0,
    partial: Buffer.alloc(0),
    mtime: NOW,
    firstTime: NOW - 65_000,
    lastTime: NOW,
    finished: false,
    endedWithText: false,
    toolCalls: 0,
    outputTokens: 0,
    spawnedToolUseIds: new Set(),
    recent: [],
    ...patch,
  };
}

function agent(id: string, status: Status, patch: Partial<AgentInfo> = {}): AgentInfo {
  return { id, agentType: 'Explore', description: 'Find code', depth: 1, state: state(), status, children: [], ...patch };
}

function session(agents: AgentInfo[], status: Status = 'running'): SessionInfo {
  return {
    id: 'abcdef12-0000',
    project: 'demo-app',
    state: state({ title: 'Demo session', model: 'claude-opus-5-5' }),
    status,
    agents,
    agentCount: agents.length,
  };
}

describe('duration', () => {
  for (const [ms, want] of [
    [0, '0s'],
    [59_000, '59s'],
    [65_000, '1m05s'],
    [3_600_000 + 120_000, '1h02m'],
    [3 * 86_400_000, '3d'],
    [-5000, '0s'],
  ] as const) {
    test(`${ms}ms → ${want}`, () => assert.equal(duration(ms), want));
  }
});

describe('fit', () => {
  test('pads short text', () => assert.equal(fit('ab', 5), 'ab   '));
  test('truncates long text with an ellipsis', () => assert.equal(fit('abcdefgh', 5), 'abcd…'));
  test('zero width is empty', () => assert.equal(fit('abc', 0), ''));
});

describe('buildRows', () => {
  test('draws the session and a nested agent tree', () => {
    const child = agent('c', 'running', { agentType: 'Explore', state: state({ current: 'Grep auth' }) });
    const parent = agent('p', 'running', { agentType: 'Plan', description: 'Plan work', children: [child] });
    const rows = buildRows([session([parent])], NOW, 120, plain);

    assert.equal(rows.length, 3);
    assert.match(rows[0].text, /^● running +Demo session \(1 agent\)/);
    assert.match(rows[0].text, /demo-app/);
    assert.match(rows[0].text, /opus-5-5$/);
    assert.match(rows[1].text, /^└─ ● running +Plan +Plan work +1m05s/);
    assert.match(rows[2].text, /^   └─ ● running +Explore .*Grep auth/);
    assert.deepEqual(rows.map((r) => r.key), ['session:abcdef12-0000', 'agent:p', 'agent:c']);
  });

  test('siblings use ├─ and │ connectors', () => {
    const a = agent('a', 'running', { children: [agent('a1', 'running')] });
    const rows = buildRows([session([a, agent('b', 'done')])], NOW, 120, plain);
    assert.match(rows[1].text, /^├─ /);
    assert.match(rows[2].text, /^│  └─ /);
    assert.match(rows[3].text, /^└─ ✓ done/);
  });

  test('finished agents show tool and token totals instead of the last action', () => {
    const done = agent('d', 'done', { state: state({ toolCalls: 12, outputTokens: 15_400, current: 'Read x.ts' }) });
    const text = buildRows([session([done])], NOW, 140, plain)[1].text;
    assert.match(text, /12 tools · 15k tok/);
    assert.doesNotMatch(text, /Read x\.ts/);
  });

  test('a finished session reads as "your turn"', () => {
    assert.match(buildRows([session([], 'done')], NOW, 120, plain)[0].text, /^✓ your turn Demo session/);
  });

  test('rows never exceed the terminal width', () => {
    const long = 'x'.repeat(300);
    const a = agent('a', 'running', { description: long, state: state({ current: long }) });
    for (const width of [60, 100, 160]) {
      for (const row of buildRows([session([a])], NOW, width, plain)) {
        assert.ok(row.text.length <= width, `row is ${row.text.length} wide at width ${width}: ${row.text}`);
      }
    }
  });

  test('detail lines carry the recent activity with clock times', () => {
    const a = agent('a', 'running', { state: state({ recent: [{ time: NOW, text: 'Grep auth' }] }) });
    const detail = buildRows([session([a])], NOW, 120, plain)[1].detail;
    assert.match(detail.title, /^Explore · Find code/);
    assert.equal(detail.lines.length, 1);
    assert.match(detail.lines[0], /^\d\d:\d\d:\d\d  Grep auth$/);
  });

  test('color mode wraps statuses in ANSI codes', () => {
    assert.match(buildRows([session([])], NOW, 120, { color: true })[0].text, /\x1b\[32m● running/);
  });
});

describe('header', () => {
  test('counts running agents across nested trees', () => {
    const tree = agent('a', 'running', { children: [agent('b', 'running'), agent('c', 'done')] });
    assert.match(header([session([tree])], '/root', NOW, 120, plain), /1 sessions · 2 agents running/);
  });

  test('a long root path is shortened to fit the width', () => {
    const h = header([], 'C:/' + 'very-long-folder/'.repeat(10), NOW, 80, plain);
    assert.ok(h.length <= 80, `header is ${h.length} wide`);
    assert.match(h, /…/);
  });
});
