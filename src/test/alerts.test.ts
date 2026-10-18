import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AlertTracker, banner, summarize } from '../alerts';
import { notifyCommand } from '../notify';
import { visibleLength } from '../render';
import { AgentInfo, SessionInfo, Status, TranscriptState } from '../transcripts';

function state(patch: Partial<TranscriptState> = {}): TranscriptState {
  return {
    offset: 0,
    partial: Buffer.alloc(0),
    mtime: 1,
    firstTime: 0,
    lastTime: 1,
    finished: false,
    endedWithText: false,
    toolCalls: 0,
    outputTokens: 0,
    spawnedToolUseIds: new Set(),
    recent: [],
    ...patch,
  };
}

function world(sessionStatus: Status, agents: Array<[string, Status, string?]>): SessionInfo[] {
  const list: AgentInfo[] = agents.map(([id, status, type]) => ({
    id,
    agentType: type ?? 'Explore',
    description: 'Find ' + id,
    depth: 1,
    state: state(),
    status,
    children: [],
    file: id + '.jsonl',
  }));
  return [{ id: 's1', project: 'extension', state: state({ title: 'Review code' }), status: sessionStatus, agents: list, agentCount: list.length, file: 's1.jsonl' }];
}

describe('AlertTracker', () => {
  test('the first scan never alerts, even for idle or finished work', () => {
    const t = new AlertTracker();
    assert.deepEqual(t.update(world('done', [['a', 'idle'], ['b', 'done']])), []);
  });

  test('a running agent going quiet asks for attention', () => {
    const t = new AlertTracker();
    t.update(world('running', [['a', 'running']]));
    const [alert, ...rest] = t.update(world('running', [['a', 'idle', 'feature-dev:code-reviewer']]));
    assert.equal(rest.length, 0);
    assert.equal(alert.level, 'attention');
    assert.equal(alert.title, 'code-reviewer is waiting · extension');
    assert.match(alert.body, /Find a .*permission/);
  });

  test('an agent finishing is information only', () => {
    const t = new AlertTracker();
    t.update(world('running', [['a', 'running']]));
    assert.deepEqual(
      t.update(world('running', [['a', 'done']])).map((a) => [a.level, a.title]),
      [['info', 'Explore finished · extension']],
    );
  });

  test('the session finishing its turn asks for attention, listed first', () => {
    const t = new AlertTracker();
    t.update(world('running', [['a', 'running']]));
    const alerts = t.update(world('done', [['a', 'done']]));
    assert.deepEqual(alerts.map((a) => [a.level, a.title]), [
      ['attention', 'Your turn · extension'],
      ['info', 'Explore finished · extension'],
    ]);
  });

  test('each change alerts once', () => {
    const t = new AlertTracker();
    t.update(world('running', [['a', 'running']]));
    assert.equal(t.update(world('running', [['a', 'idle']])).length, 1);
    assert.equal(t.update(world('running', [['a', 'idle']])).length, 0);
  });

  test('an agent that appears already finished does not alert', () => {
    const t = new AlertTracker();
    t.update(world('running', []));
    assert.deepEqual(t.update(world('running', [['quick', 'done']])), []);
  });

  test('idle → done still reports the finish', () => {
    const t = new AlertTracker();
    t.update(world('running', [['a', 'idle']]));
    assert.deepEqual(t.update(world('running', [['a', 'done']])).map((a) => a.level), ['info']);
  });
});

describe('alert text', () => {
  const alerts = [
    { level: 'attention' as const, icon: '◌', title: 'Explore is waiting · extension', body: 'Find a' },
    { level: 'info' as const, icon: '✓', title: 'Plan finished · extension', body: 'Plan b' },
  ];

  test('summary leads with the first alert and lists the rest', () => {
    assert.deepEqual(summarize(alerts), {
      title: '◌ Explore is waiting · extension',
      body: 'Find a\n+1 more: Plan finished · extension',
    });
  });

  test('banner fills the width exactly, even when the title is long', () => {
    for (const width of [30, 80, 140]) {
      for (const style of [{ color: false }, { color: true }]) {
        const b = banner(alerts, width, style);
        assert.equal(visibleLength(b), width, b);
      }
    }
    assert.match(banner(alerts, 80, { color: false }), /^── ◌ Explore is waiting · extension ─+ \+1 more $/);
  });
});

describe('notifyCommand', () => {
  const title = 'Your turn · "x"; $(rm -rf /)';
  const body = "it's `done`";

  test('Windows uses a PowerShell toast with the text only in environment variables', () => {
    const c = notifyCommand(title, body, 'win32', false)!;
    assert.equal(c.cmd, 'powershell.exe');
    assert.ok(!c.args.join(' ').includes('rm -rf'), 'text never appears in the command');
    assert.deepEqual([c.env.CLAUDE_AGENTS_TITLE, c.env.CLAUDE_AGENTS_BODY], [title, body]);
    assert.equal(c.env.WSLENV, undefined);
  });

  test('WSL also uses the Windows toast and forwards the variables', () => {
    const c = notifyCommand(title, body, 'linux', true, 'WT_SESSION:WT_PROFILE_ID:')!;
    assert.equal(c.cmd, 'powershell.exe');
    assert.equal(c.env.WSLENV, 'WT_SESSION:WT_PROFILE_ID:CLAUDE_AGENTS_TITLE/u:CLAUDE_AGENTS_BODY/u');
  });

  test('macOS uses osascript reading the variables', () => {
    const c = notifyCommand(title, body, 'darwin', false)!;
    assert.equal(c.cmd, 'osascript');
    assert.ok(!c.args.join(' ').includes('rm -rf'));
  });

  test('Linux uses notify-send with the text as separate arguments', () => {
    const c = notifyCommand(title, body, 'linux', false)!;
    assert.deepEqual([c.cmd, ...c.args], ['notify-send', '--app-name=claude-agents', title, body]);
  });
});
