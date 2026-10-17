import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Works out which folder holds Claude Code's transcripts.
 *
 * Inside WSL, people often run the Windows build of Claude Code, which writes
 * to C:\Users\<name>\.claude rather than the Linux home folder. When the Linux
 * folder is missing we look for the Windows one under /mnt/<drive>/Users.
 */

export interface RootEnv {
  env: NodeJS.ProcessEnv;
  homedir: string;
  platform: NodeJS.Platform;
  release: string;
  /** Where Windows drives are mounted in WSL. Overridable for tests. */
  mountRoot?: string;
}

export type RootSource = 'option' | 'config-dir' | 'home' | 'wsl-windows';

export interface ResolvedRoot {
  root: string;
  source: RootSource;
}

export function currentEnv(): RootEnv {
  return { env: process.env, homedir: os.homedir(), platform: process.platform, release: os.release() };
}

export function isWsl(e: RootEnv): boolean {
  return e.platform === 'linux' && (!!e.env.WSL_DISTRO_NAME || /microsoft/i.test(e.release));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function list(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** Every /mnt/<drive>/Users/<user>/.claude/projects folder, most recently changed first. */
export function findWindowsRoots(mountRoot = '/mnt'): string[] {
  const found: Array<{ dir: string; mtime: number }> = [];
  for (const drive of list(mountRoot)) {
    if (!/^[a-z]$/i.test(drive)) continue; // skip /mnt/wsl, /mnt/wslg, …
    const users = path.join(mountRoot, drive, 'Users');
    for (const user of list(users)) {
      const dir = path.join(users, user, '.claude', 'projects');
      if (!isDir(dir)) continue;
      found.push({ dir, mtime: newestChild(dir) });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.dir);
}

/** Newest mtime among a folder's entries, so the account used most recently wins. */
function newestChild(dir: string): number {
  let newest = 0;
  for (const name of [...list(dir), '.']) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // vanished while scanning
    }
  }
  return newest;
}

export function resolveRoot(option: string | undefined, e: RootEnv = currentEnv()): ResolvedRoot {
  if (option) return { root: option, source: 'option' };
  if (e.env.CLAUDE_CONFIG_DIR) return { root: path.join(e.env.CLAUDE_CONFIG_DIR, 'projects'), source: 'config-dir' };

  const home = path.join(e.homedir, '.claude', 'projects');
  if (!isDir(home) && isWsl(e)) {
    const [windows] = findWindowsRoots(e.mountRoot);
    if (windows) return { root: windows, source: 'wsl-windows' };
  }
  return { root: home, source: 'home' };
}
