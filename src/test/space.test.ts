import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildGraph, Canvas, Space } from '../space';
import { C, fg, visibleLength } from '../render';
import { AgentInfo, SessionInfo, Status, TranscriptState } from '../transcripts';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const plain = { color: false };
const color = { color: true };

function state(patch: Partial<TranscriptState> = {}): TranscriptState {
  return {
    offset: 0,
    partial: Buffer.alloc(0),
    mtime: NOW,
    firstTime: NOW - 60_000,
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
  return { id, agentType: 'Explore', description: 'Find ' + id, depth: 1, state: state(), status, children: [], file: `agent-${id}.jsonl`, ...patch };
}

function session(id: string, agents: AgentInfo[], status: Status = 'running', mtime = NOW): SessionInfo {
  return { id, project: 'demo-app', state: state({ title: 'Session ' + id, mtime }), status, agents, agentCount: agents.length, file: id + '.jsonl' };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A session with a planner that spawned two explorers, plus a reviewer. */
function team(): SessionInfo[] {
  const plan = agent('plan', 'running', {
    agentType: 'Plan',
    children: [agent('e1', 'running'), agent('e2', 'done')],
  });
  return [session('s1', [plan, agent('rev', 'idle', { agentType: 'feature-dev:code-reviewer' })])];
}

describe('buildGraph', () => {
  test('makes a node per session and agent, linked parent → child', () => {
    const g = buildGraph(team(), 50);
    assert.deepEqual(g.nodes.map((n) => n.key), ['session:s1', 'agent:plan', 'agent:e1', 'agent:e2', 'agent:rev']);
    assert.deepEqual(g.edges, [
      ['session:s1', 'agent:plan'],
      ['agent:plan', 'agent:e1'],
      ['agent:plan', 'agent:e2'],
      ['session:s1', 'agent:rev'],
    ]);
    assert.equal(g.hidden, 0);
  });

  test('uses the agent icon and drops plugin prefixes from labels', () => {
    const rev = buildGraph(team(), 50).nodes.find((n) => n.key === 'agent:rev')!;
    assert.equal(rev.label, 'code-reviewer');
    assert.equal(rev.icon, '◇');
    assert.equal(rev.sublabel, 'Find rev');
  });

  test('over capacity, the oldest finished agents are hidden first', () => {
    const agents = [
      agent('old', 'done', { state: state({ mtime: NOW - 3000 }) }),
      agent('newer', 'done', { state: state({ mtime: NOW - 1000 }) }),
      agent('busy', 'running'),
    ];
    const g = buildGraph([session('s', agents)], 3);
    assert.deepEqual(g.nodes.map((n) => n.key), ['session:s', 'agent:newer', 'agent:busy']);
    assert.equal(g.hidden, 1);
  });

  test('children of a hidden agent are re-attached to the session', () => {
    const parent = agent('p', 'done', { state: state({ mtime: NOW - 5000 }), children: [agent('kid', 'running')] });
    const g = buildGraph([session('s', [parent, agent('x', 'running')])], 3);
    assert.ok(!g.nodes.some((n) => n.key === 'agent:p'));
    assert.deepEqual(g.edges.find(([, to]) => to === 'agent:kid'), ['session:s', 'agent:kid']);
  });

  test('then sessions with nothing left are hidden, least recent first', () => {
    const sessions = [
      session('busy', [agent('a', 'running')]),
      session('stale', [], 'done', NOW - 60_000),
      session('recent', [], 'done', NOW - 1000),
    ];
    const g = buildGraph(sessions, 3);
    assert.deepEqual(g.nodes.map((n) => n.key), ['session:busy', 'agent:a', 'session:recent']);
  });
});

describe('Space layout', () => {
  test('is deterministic', () => {
    const a = new Space();
    const b = new Space();
    for (const s of [a, b]) {
      s.sync(team(), 100, 24);
      s.settle();
    }
    for (const n of a.graph.nodes) assert.deepEqual(a.position(n.key), b.position(n.key));
  });

  test('settles with cards apart and on screen', () => {
    const many = [
      session('s1', [agent('a', 'running', { children: [agent('a1', 'running'), agent('a2', 'running')] }), agent('b', 'idle')]),
      session('s2', [agent('c', 'running'), agent('d', 'done')]),
    ];
    const cols = 118;
    const rows = 26;
    const space = new Space();
    space.sync(many, cols, rows);
    space.settle();
    assert.ok(space.energy < 0.05, `still moving: ${space.energy}`);

    const pos = space.graph.nodes.map((n) => ({ key: n.key, ...space.position(n.key)! }));
    assert.equal(pos.length, 8);
    for (const p of pos) {
      assert.ok(p.x - 4 >= 0 && p.x + 4 < cols, `${p.key} off screen horizontally at ${p.x}`);
      assert.ok(p.y / 2 - 1 >= 0 && p.y / 2 + 3 < rows, `${p.key} off screen vertically at ${p.y}`);
    }
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const overlapX = Math.abs(pos[i].x - pos[j].x) < 9;
        const overlapY = Math.abs(pos[i].y - pos[j].y) / 2 < 3;
        assert.ok(!(overlapX && overlapY), `${pos[i].key} overlaps ${pos[j].key}`);
      }
    }
  });

  test('the first layout is already settled, so navigation works immediately', () => {
    const space = new Space();
    space.sync(team(), 100, 24);
    assert.ok(space.energy < 0.05, `still moving: ${space.energy}`);
    assert.ok(space.nearest('session:s1', 'right') || space.nearest('session:s1', 'left'));
  });

  test('keeps existing positions when the graph changes', () => {
    const space = new Space();
    space.sync(team(), 100, 24);
    space.settle();
    const before = space.position('agent:plan');
    const grown = team();
    grown[0].agents.push(agent('new', 'running'));
    space.sync(grown, 100, 24);
    assert.deepEqual(space.position('agent:plan'), before);
    assert.ok(space.position('agent:new'));
  });

  test('arrow navigation picks the nearest node in that direction', () => {
    const space = new Space();
    space.sync(team(), 100, 24);
    space.settle();
    const keys = space.graph.nodes.map((n) => n.key);
    const leftmost = keys.reduce((a, b) => (space.position(a)!.x <= space.position(b)!.x ? a : b));
    const next = space.nearest(leftmost, 'right');
    assert.ok(next && space.position(next)!.x > space.position(leftmost)!.x);
    assert.equal(space.nearest(leftmost, 'left'), undefined);
  });
});

describe('Space hit-testing', () => {
  function settled() {
    const space = new Space();
    space.sync(team(), 100, 24);
    return space;
  }

  /** Canvas cell of a node's icon (its card centre). */
  function centre(space: Space, key: string) {
    const p = space.position(key)!;
    return { col: Math.round(p.x), row: Math.round(p.y / 2) };
  }

  test('a click on a card finds that node', () => {
    const space = settled();
    for (const n of space.graph.nodes) {
      const { col, row } = centre(space, n.key);
      assert.equal(space.hit(col, row), n.key);
      assert.equal(space.hit(col - 4, row - 1), n.key, 'top-left corner');
      assert.equal(space.hit(col + 4, row + 1), n.key, 'bottom-right corner');
    }
  });

  test('a click on a label finds its node', () => {
    const space = settled();
    const { col, row } = centre(space, 'agent:plan');
    assert.equal(space.hit(col, row + 2), 'agent:plan'); // "Plan" under the card
  });

  test('empty space finds nothing', () => {
    const space = settled();
    const lines = space.render(plain);
    for (let row = 0; row < lines.length; row++) {
      const col = [...lines[row]].findIndex((c) => c === ' ');
      if (col >= 0 && lines.every((l) => l[col] === ' ')) {
        assert.equal(space.hit(col, row), undefined);
        return;
      }
    }
  });

  test('the hit matches what is drawn', () => {
    const space = settled();
    const lines = space.render(plain);
    for (const n of space.graph.nodes) {
      const { col, row } = centre(space, n.key);
      assert.equal([...lines[row]][col], n.icon, `${n.key} icon is where hit() looks`);
    }
  });
});

describe('Space rendering', () => {
  function rendered(style: { color: boolean; frame?: number }, selected?: string, cols = 100, rows = 24) {
    const space = new Space();
    space.sync(team(), cols, rows);
    space.settle();
    return space.render(style, selected);
  }

  test('fills exactly the requested area', () => {
    for (const style of [plain, color]) {
      const lines = rendered(style, 'agent:plan');
      assert.equal(lines.length, 24);
      for (const l of lines) assert.equal(visibleLength(l), 100);
    }
  });

  test('draws a card with an icon and label for every node', () => {
    const text = rendered(plain).join('\n');
    for (const s of ['◈', '◎', '◇', '❖', 'Plan', 'Explore', 'code-reviewer', 'Session s1']) assert.ok(text.includes(s), `missing ${s}`);
    assert.equal(text.match(/╭─────────╮/g)?.length, 5);
    for (const t of ['● Plan', '● Explore', '◌ code-reviewer', '● Session s1']) assert.ok(text.includes(t), `missing title ${t}`);
  });

  test('links are drawn with braille dots', () => {
    assert.match(rendered(plain).join('\n'), /[⠁-⣿]/);
  });

  test('the selected card and its links use the accent colour', () => {
    const lines = rendered(color, 'agent:plan');
    const joined = lines.join('\n');
    assert.ok(joined.includes(`${fg(C.accent)}m╭`) || joined.includes(`1;${fg(C.accent)}m╭`));
    assert.match(joined, new RegExp(`${fg(C.accent).replace(/;/g, ';')}m[⠁-⣿]`));
  });

  test('running cards animate, still frames do not', () => {
    const a = rendered({ color: true, frame: 0 }).join('');
    const b = rendered({ color: true, frame: 3 }).join('');
    assert.notEqual(a, b);
    assert.equal(rendered(color).join(''), rendered(color).join(''));
  });

  test('plain mode has no escape codes', () => {
    assert.doesNotMatch(rendered(plain).join(''), /\x1b/);
  });

  test('says how many finished agents were hidden', () => {
    const lots = [session('s', Array.from({ length: 30 }, (_, i) => agent('d' + i, 'done')))];
    const space = new Space();
    space.sync(lots, 60, 16);
    space.settle();
    assert.match(strip(space.render(plain).join('\n')), /\+\d+ finished hidden · Tab for the tree/);
  });
});

describe('Canvas', () => {
  test('braille lines set the right dots', () => {
    const c = new Canvas(2, 1);
    c.line(0, 0, 3, 0, '#ffffff'); // top dot row across both cells
    assert.deepEqual(c.toLines(plain), ['⠉⠉']);
  });

  test('text overwrites dots', () => {
    const c = new Canvas(3, 1);
    c.line(0, 0, 5, 3, '#ffffff');
    c.text(1, 0, 'X');
    assert.equal(c.toLines(plain)[0][1], 'X');
  });
});
