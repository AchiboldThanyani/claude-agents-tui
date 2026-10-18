import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  agentLook,
  buildRows,
  C,
  detailBox,
  duration,
  emptyState,
  fg,
  fit,
  footer,
  header,
  selectRow,
  visibleLength,
} from '../render';
import { AgentInfo, SessionInfo, Status, TranscriptState } from '../transcripts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const plain = { color: false };
const color = { color: true };

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

describe('agentLook', () => {
  for (const [type, icon] of [
    ['Explore', '◎'],
    ['feature-dev:code-explorer', '◎'],
    ['Plan', '◈'],
    ['feature-dev:code-architect', '◈'],
    ['code-review', '◇'],
    ['feature-dev:code-reviewer', '◇'],
    ['test-writer', '▲'],
    ['bug-finder', '✱'],
    ['claude-code-guide', '≡'],
    ['general-purpose', '✦'],
    ['something-else', '•'],
  ] as const) {
    test(`${type} → ${icon}`, () => assert.equal(agentLook(type).icon, icon));
  }
});

describe('buildRows', () => {
  test('draws the session and a nested agent tree', () => {
    const child = agent('c', 'running', { agentType: 'Explore', state: state({ current: 'Grep auth' }) });
    const parent = agent('p', 'running', { agentType: 'Plan', description: 'Plan work', children: [child] });
    const rows = buildRows([session([parent])], NOW, 120, plain);

    assert.equal(rows.length, 3);
    assert.match(rows[0].text, /^ ● running +❖ Demo session \(1 agent\)/);
    assert.match(rows[0].text, /demo-app/);
    assert.match(rows[0].text, /opus-5-5$/);
    assert.match(rows[1].text, /^└─  ● running +◈ Plan +Plan work +1m05s/);
    assert.match(rows[2].text, /^   └─  ● running +◎ Explore .*Grep auth/);
    assert.deepEqual(rows.map((r) => r.key), ['session:abcdef12-0000', 'agent:p', 'agent:c']);
  });

  test('siblings use ├─ and │ connectors', () => {
    const a = agent('a', 'running', { children: [agent('a1', 'running')] });
    const rows = buildRows([session([a, agent('b', 'done')])], NOW, 120, plain);
    assert.match(rows[1].text, /^├─ /);
    assert.match(rows[2].text, /^│  └─ /);
    assert.match(rows[3].text, /^└─  ✓ done/);
  });

  test('description and time columns line up across tree depths', () => {
    const deep = agent('c', 'running', { description: 'Low task' });
    const mid = agent('b', 'running', { description: 'Mid task', children: [deep] });
    const top = agent('a', 'running', { description: 'Top task', children: [mid] });
    const rows = buildRows([session([top])], NOW, 120, plain).slice(1);
    const cols = rows.map((r) => [r.text.indexOf(' task') - 3, r.text.indexOf('1m05s')]);
    assert.deepEqual(cols[1], cols[0]);
    assert.deepEqual(cols[2], cols[0]);
  });

  test('finished agents show tool and token totals instead of the last action', () => {
    const done = agent('d', 'done', { state: state({ toolCalls: 12, outputTokens: 15_400, current: 'Read x.ts' }) });
    const text = buildRows([session([done])], NOW, 140, plain)[1].text;
    assert.match(text, /12 tools · 15k tok/);
    assert.doesNotMatch(text, /Read x\.ts/);
  });

  test('a finished session reads as "your turn"', () => {
    assert.match(buildRows([session([], 'done')], NOW, 120, plain)[0].text, /^ ✓ your turn +❖ Demo session/);
  });

  test('an idle agent gets the idle pill', () => {
    assert.match(buildRows([session([agent('i', 'idle')])], NOW, 120, plain)[1].text, /^└─  ◌ idle /);
  });

  test('rows never exceed the terminal width, with or without colour', () => {
    const long = 'x'.repeat(300);
    const a = agent('a', 'running', { description: long, state: state({ current: long }) });
    for (const style of [plain, color]) {
      for (const width of [60, 100, 160]) {
        for (const row of buildRows([session([a])], NOW, width, style)) {
          const len = visibleLength(row.text);
          assert.ok(len <= width, `row is ${len} wide at width ${width}: ${row.text}`);
        }
      }
    }
  });

  test('colour and plain rows have the same visible text', () => {
    const tree = [session([agent('a', 'running', { state: state({ current: 'Grep auth' }) }), agent('b', 'done')])];
    const p = buildRows(tree, NOW, 120, plain).map((r) => r.text);
    const c = buildRows(tree, NOW, 120, color).map((r) => r.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    assert.deepEqual(c, p);
  });

  test('detail carries the recent activity with clock times', () => {
    const a = agent('a', 'running', { state: state({ model: 'claude-haiku-4-5', recent: [{ time: NOW, text: 'Grep auth' }] }) });
    const detail = buildRows([session([a])], NOW, 120, plain)[1].detail;
    assert.equal(detail.title, 'Explore · Find code');
    assert.equal(detail.meta, 'haiku-4-5 · running');
    assert.equal(detail.icon, '◎');
    assert.equal(detail.lines.length, 1);
    assert.match(detail.lines[0].time, /^\d\d:\d\d:\d\d$/);
    assert.equal(detail.lines[0].text, 'Grep auth');
  });

  test('colour mode uses the extension palette in 24-bit colour', () => {
    const text = buildRows([session([])], NOW, 120, color)[0].text;
    assert.ok(text.includes(fg(C.running)), 'running pill uses the extension running blue');
    assert.ok(text.includes(fg(C.accent)), 'session icon uses the accent purple');
  });

  test('running agents spin when an animation frame is given', () => {
    const tree = [session([agent('a', 'running')])];
    const f0 = buildRows(tree, NOW, 120, { color: true, frame: 0 })[1].text;
    const f1 = buildRows(tree, NOW, 120, { color: true, frame: 1 })[1].text;
    assert.ok(f0.includes('⠋') && f1.includes('⠙'), 'spinner advances with the frame');
    assert.ok(!f0.includes('●'));
  });
});

describe('header', () => {
  test('counts agents by status across nested trees', () => {
    const tree = agent('a', 'running', { children: [agent('b', 'running'), agent('c', 'done'), agent('d', 'idle')] });
    const h = header([session([tree])], '/root', NOW, 140, plain);
    assert.match(h, /^ ✦ claude agents  1 sessions  ● 2 running  ◌ 1 idle  ✓ 1 done/);
  });

  test('a long root path is shortened to fit the width', () => {
    for (const style of [plain, color]) {
      const h = header([], 'C:/' + 'very-long-folder/'.repeat(10), NOW, 80, style);
      assert.ok(visibleLength(h) <= 80, `header is ${visibleLength(h)} wide`);
      assert.match(h, /…/);
    }
  });
});

describe('chrome', () => {
  test('selected rows fill the width with the accent bar', () => {
    const s = selectRow('hello', 40, color);
    assert.equal(visibleLength(s), 40);
    assert.ok(s.startsWith(`\x1b[${fg(C.accent)}m▌`));
  });

  test('plain selection uses a › marker', () => {
    assert.equal(selectRow('hello', 40, plain), '› hello');
  });

  test('detail box is exactly the requested size', () => {
    const d = {
      icon: '◎',
      color: C.accent2,
      title: 'Explore · Find code',
      meta: 'haiku-4-5 · running',
      lines: [
        { time: '12:00:00', text: 'prompt: search' },
        { time: '12:00:01', text: 'Grep authenticate' },
        { time: '12:00:02', text: '“Found it in auth.ts”' },
      ],
    };
    for (const style of [plain, color]) {
      const box = detailBox(d, 70, 6, style);
      assert.equal(box.length, 6);
      for (const line of box) assert.equal(visibleLength(line), 70, line);
    }
    const plainBox = detailBox(d, 70, 6, plain);
    assert.match(plainBox[0], /^╭─ ◎ Explore · Find code ─+ haiku-4-5 · running ─╮$/);
    assert.match(plainBox[2], /│ 12:00:01  Grep authenticate +│/);
    assert.match(plainBox[5], /^╰─+╯$/);
  });

  test('empty detail box says so', () => {
    const box = detailBox({ icon: '❖', color: C.accent, title: 't', meta: '', lines: [] }, 40, 4, plain);
    assert.match(box[1], /no activity yet/);
  });

  test('empty state is centred and includes the reason', () => {
    const lines = emptyState('Transcript folder not found', 80, 20, plain);
    assert.ok(lines.some((l) => l.trim() === 'No agents yet'));
    assert.ok(lines.some((l) => l.trim() === 'Transcript folder not found'));
    const title = lines.find((l) => l.trim() === 'No agents yet')!;
    assert.equal(title.indexOf('N'), Math.floor((80 - 'No agents yet'.length) / 2));
  });

  test('footer lists the keys', () => {
    assert.equal(footer(plain), '↑/↓ select · enter details · tab space view · q quit');
    assert.equal(footer(plain, 'space'), 'arrows move · enter details · tab tree view · q quit');
    assert.match(footer(color).replace(/\x1b\[[0-9;]*m/g, ''), /↑↓ +select +⏎ +details +⇥ +space view +q +quit/);
    assert.match(footer(color, 'space').replace(/\x1b\[[0-9;]*m/g, ''), /←↑↓→ +move .*⇥ +tree view/);
  });
});
