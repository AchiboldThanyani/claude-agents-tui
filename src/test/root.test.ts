import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findWindowsRoots, isWsl, resolveRoot, RootEnv } from '../root';

let tmp: string;
let home: string;
let mnt: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-root-'));
  home = path.join(tmp, 'home', 'me');
  mnt = path.join(tmp, 'mnt');
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function wsl(env: NodeJS.ProcessEnv = {}): RootEnv {
  return { env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', ...env }, homedir: home, platform: 'linux', release: '6.6.87.2-microsoft-standard-WSL2', mountRoot: mnt };
}

function linux(): RootEnv {
  return { env: {}, homedir: home, platform: 'linux', release: '6.8.0-45-generic', mountRoot: mnt };
}

/** Creates /mnt/<drive>/Users/<user>/.claude/projects with an mtime `minutesAgo`. */
function windowsUser(user: string, minutesAgo = 0, drive = 'c'): string {
  const dir = path.join(mnt, drive, 'Users', user, '.claude', 'projects');
  fs.mkdirSync(path.join(dir, 'some-project'), { recursive: true });
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(path.join(dir, 'some-project'), t, t);
  fs.utimesSync(dir, t, t);
  return dir;
}

function linuxProjects(): string {
  const dir = path.join(home, '.claude', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('isWsl', () => {
  test('detects WSL from WSL_DISTRO_NAME', () => {
    assert.equal(isWsl({ ...linux(), env: { WSL_DISTRO_NAME: 'Ubuntu' } }), true);
  });

  test('detects WSL from the kernel release', () => {
    assert.equal(isWsl({ ...linux(), release: '5.15.153.1-microsoft-standard-WSL2' }), true);
  });

  test('plain Linux is not WSL', () => {
    assert.equal(isWsl(linux()), false);
  });

  test('Windows is not WSL even with WSL variables around', () => {
    assert.equal(isWsl({ ...linux(), platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), false);
  });
});

describe('resolveRoot', () => {
  test('--root always wins', () => {
    windowsUser('Achibold');
    assert.deepEqual(resolveRoot('/custom', wsl({ CLAUDE_CONFIG_DIR: '/cfg' })), { root: '/custom', source: 'option' });
  });

  test('CLAUDE_CONFIG_DIR beats the home folder and WSL detection', () => {
    windowsUser('Achibold');
    assert.deepEqual(resolveRoot(undefined, wsl({ CLAUDE_CONFIG_DIR: '/cfg' })), {
      root: path.join('/cfg', 'projects'),
      source: 'config-dir',
    });
  });

  test('in WSL with no Linux transcripts, uses the Windows folder', () => {
    const windows = windowsUser('Achibold');
    assert.deepEqual(resolveRoot(undefined, wsl()), { root: windows, source: 'wsl-windows' });
  });

  test('in WSL, Linux transcripts are preferred when they exist', () => {
    windowsUser('Achibold');
    const own = linuxProjects();
    assert.deepEqual(resolveRoot(undefined, wsl()), { root: own, source: 'home' });
  });

  test('plain Linux never looks at /mnt', () => {
    windowsUser('Achibold');
    assert.deepEqual(resolveRoot(undefined, linux()), { root: path.join(home, '.claude', 'projects'), source: 'home' });
  });

  test('in WSL with nothing anywhere, falls back to the home folder', () => {
    assert.deepEqual(resolveRoot(undefined, wsl()), { root: path.join(home, '.claude', 'projects'), source: 'home' });
  });
});

describe('findWindowsRoots', () => {
  test('lists every Windows user with Claude Code, most recently used first', () => {
    const old = windowsUser('Old', 120);
    const recent = windowsUser('Achibold', 1);
    windowsUser('Other', 60, 'd');
    assert.deepEqual(findWindowsRoots(mnt), [recent, path.join(mnt, 'd', 'Users', 'Other', '.claude', 'projects'), old]);
  });

  test('ignores non-drive folders like /mnt/wsl and users without Claude Code', () => {
    fs.mkdirSync(path.join(mnt, 'wsl', 'Users', 'x', '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(mnt, 'c', 'Users', 'Public'), { recursive: true });
    assert.deepEqual(findWindowsRoots(mnt), []);
  });

  test('a missing mount folder gives an empty list', () => {
    assert.deepEqual(findWindowsRoots(path.join(tmp, 'nope')), []);
  });
});
