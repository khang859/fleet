import xtermHeadless from '@xterm/headless';

// A CommonJS package whose named exports Node's ESM loader cannot see.
const { Terminal } = xtermHeadless;

/**
 * A headless copy of a pane's terminal, fed the pane's output, so the main
 * process can read what the pane shows without the renderer: a crew pane
 * waiting at a login or trust screen, say. It keeps the screen only.
 */
export class PaneScreen {
  private readonly term: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number) {
    // xterm counts reading the buffer as proposed API.
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** The screen as text once all output so far is parsed, without trailing blank space. */
  async text(): Promise<string> {
    await new Promise<void>((resolve) => this.term.write('', resolve));
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    }
    return lines.join('\n').trimEnd();
  }

  dispose(): void {
    this.term.dispose();
  }
}
