/**
 * Mouse input. With SGR mouse reporting on (`ESC[?1000h ESC[?1006h`), the
 * terminal sends `ESC[<button;col;row M` on press and `…m` on release, with
 * 1-based coordinates. Only presses matter here.
 */

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

export type MouseEvent =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'wheel'; dir: 'up' | 'down'; x: number; y: number };

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Mouse events in a chunk of input (0-based x/y). Empty when the chunk is not mouse input. */
export function parseMouse(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const m of data.matchAll(SGR)) {
    const button = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    if (m[4] !== 'M') continue; // release
    if (button & 32) continue; // drag / motion
    if (button & 64) events.push({ kind: 'wheel', dir: (button & 1) === 0 ? 'up' : 'down', x, y });
    else if ((button & 3) === 0) events.push({ kind: 'click', x, y });
  }
  return events;
}

export function isMouseInput(data: string): boolean {
  return data.startsWith('\x1b[<');
}
