import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { FakeProjects, iso, reply, title, toolUse, userPrompt } from './fixtures';

const CLI = path.join(__dirname, '..', 'cli.js');

let fake: FakeProjects;

beforeEach(() => (fake = new FakeProjects()));
afterEach(() => fake.cleanup());

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '120', NO_COLOR: '' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli --once', () => {
  test('prints the session tree from --root', () => {
    const now = Date.now();
    fake.writeSession('proj', 's1', [
      userPrompt('build it', iso(now), 'C:\\code\\demo-app'),
      toolUse('toolu_A', 'Agent', { description: 'Find code' }, iso(now)),
      title('Demo session'),
    ]);
    fake.writeAgent('proj', 's1', 'a1', { agentType: 'Explore', description: 'Find code', toolUseId: 'toolu_A' }, [
      toolUse('t1', 'Grep', { pattern: 'authenticate' }, iso(now)),
    ]);

    const { code, stdout } = run('--once', '--no-color', '--root', fake.root);
    assert.equal(code, 0);
    assert.match(stdout, /✦ claude agents  1 sessions  ● 1 running/);
    assert.match(stdout, /Demo session \(1 agent\)/);
    assert.match(stdout, /└─  ● running +◎ Explore +Find code .*Grep authenticate/);
    assert.doesNotMatch(stdout, /\x1b\[/, 'no ANSI codes with --no-color');
  });

  test('--space prints the settled space view', () => {
    const now = Date.now();
    fake.writeSession('proj', 's1', [
      userPrompt('build it', iso(now), 'C:\\code\\demo-app'),
      toolUse('toolu_A', 'Agent', { description: 'Find code' }, iso(now)),
      title('Demo session'),
    ]);
    fake.writeAgent('proj', 's1', 'a1', { agentType: 'Explore', description: 'Find code', toolUseId: 'toolu_A' }, [
      toolUse('t1', 'Grep', { pattern: 'authenticate' }, iso(now)),
    ]);

    const { code, stdout } = run('--once', '--space', '--no-color', '--root', fake.root);
    assert.equal(code, 0);
    assert.match(stdout, /╭─────●─╮/, 'running card with its status mark');
    assert.match(stdout, /◎/);
    assert.match(stdout, /Demo session/);
    assert.doesNotMatch(stdout, /└─/, 'no tree connectors in the space view');
  });

  test('--project filters sessions', () => {
    const now = Date.now();
    fake.writeSession('a', 's1', [userPrompt('one', iso(now), 'C:\\work\\extension'), reply('ok', iso(now)), title('First')]);
    fake.writeSession('b', 's2', [userPrompt('two', iso(now), 'C:\\work\\budget'), reply('ok', iso(now)), title('Second')]);

    const { stdout } = run('--once', '--no-color', '--root', fake.root, '--project', 'budget');
    assert.match(stdout, /Second/);
    assert.doesNotMatch(stdout, /First/);
  });

  test('says so when there is no activity', () => {
    const { code, stdout } = run('--once', '--no-color', '--root', fake.root);
    assert.equal(code, 0);
    assert.match(stdout, /No Claude Code activity/);
  });

  test('a missing transcript folder is reported with a hint', () => {
    const missing = path.join(fake.root, 'does-not-exist');
    const { code, stdout } = run('--once', '--no-color', '--root', missing);
    assert.equal(code, 0);
    assert.match(stdout, /Transcript folder not found: .*does-not-exist \(point at it with --root <dir>\)/);
  });

  test('piped output falls back to a single snapshot without --once', () => {
    const { code, stdout } = run('--no-color', '--root', fake.root);
    assert.equal(code, 0);
    assert.match(stdout, /^ ✦ claude agents  0 sessions  ● 0 running/);
  });
});

describe('cli options', () => {
  test('--help prints usage', () => {
    const { code, stdout } = run('--help');
    assert.equal(code, 0);
    assert.match(stdout, /Usage: claude-agents/);
  });

  test('a bad duration exits with an error', () => {
    const { code, stderr } = run('--since', '2x');
    assert.equal(code, 1);
    assert.match(stderr, /bad duration: 2x/);
  });

  test('an unknown option exits with an error', () => {
    const { code, stderr } = run('--nope');
    assert.equal(code, 1);
    assert.match(stderr, /unknown option: --nope/);
  });

  test('an option missing its value exits with an error', () => {
    const { code, stderr } = run('--root');
    assert.equal(code, 1);
    assert.match(stderr, /--root needs a value/);
  });
});
