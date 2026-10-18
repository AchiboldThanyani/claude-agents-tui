/**
 * A tiny terminal emulator for tests: enough of xterm to replay what the UI
 * writes and read back the visible text. Models the "pending wrap" state: after
 * a character lands in the last column the cursor stays there, so an erase
 * sent next clears that character, the quirk that cut off line ends.
 */
export class VirtualTerminal {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private pendingWrap = false;

  constructor(readonly width: number, readonly height: number) {
    this.grid = Array.from({ length: height }, () => Array(width).fill(' '));
  }

  write(data: string): void {
    const re = /\x1b\[([?0-9;]*)([A-Za-z])|\r|\n|[^\x1b\r\n]/gu;
    for (const m of data.matchAll(re)) {
      const t = m[0];
      if (m[2]) this.csi(m[1], m[2]);
      else if (t === '\r') this.carriageReturn();
      else if (t === '\n') this.lineFeed();
      else this.put(t);
    }
  }

  /** Visible text, one string per row, trailing spaces trimmed. */
  text(): string[] {
    return this.grid.map((r) => r.join('').replace(/ +$/, ''));
  }

  private put(ch: string): void {
    if (this.pendingWrap) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    if (this.col === this.width - 1) this.pendingWrap = true;
    else this.col++;
  }

  private carriageReturn(): void {
    this.col = 0;
    this.pendingWrap = false;
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    this.col = 0; // the tty's ONLCR turns \n into \r\n
    if (this.row < this.height - 1) this.row++;
    else {
      this.grid.shift();
      this.grid.push(Array(this.width).fill(' '));
    }
  }

  private csi(params: string, cmd: string): void {
    if (params.startsWith('?') || cmd === 'm') return; // modes and colours: no effect on text
    const n = params.split(';').map((p) => (p === '' ? undefined : Number(p)));
    this.pendingWrap = false;
    if (cmd === 'H') {
      this.row = Math.min(this.height - 1, (n[0] ?? 1) - 1);
      this.col = Math.min(this.width - 1, (n[1] ?? 1) - 1);
    } else if (cmd === 'K') {
      const mode = n[0] ?? 0;
      const from = mode === 0 ? this.col : 0;
      const to = mode === 1 ? this.col + 1 : this.width;
      for (let c = from; c < to; c++) this.grid[this.row][c] = ' ';
    } else if (cmd === 'J') {
      for (let c = this.col; c < this.width; c++) this.grid[this.row][c] = ' ';
      for (let r = this.row + 1; r < this.height; r++) this.grid[r].fill(' ');
    }
  }
}
