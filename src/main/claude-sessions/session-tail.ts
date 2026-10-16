import { StringDecoder } from 'string_decoder';
import { readGrowth } from './read-growth';
import { listSubagentTranscripts } from './transcript-path';

/**
 * Follows a `.jsonl` file as it grows, handing each line to the caller once.
 *
 * Only the bytes added since the last read are read, so a transcript that
 * runs to hundreds of megabytes costs no more to follow than a short one.
 * An unfinished last line waits for the rest.
 */
export class JsonlTail {
  private offset = 0;
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';

  /**
   * Hand `onLine` every line the file gained since the last read. False when
   * the file got shorter, so it was replaced and this tail is spent. A file
   * that does not exist yet has gained nothing.
   */
  async read(path: string, onLine: (line: string) => void): Promise<boolean> {
    let shrank = false;
    await readGrowth(
      path,
      (size) => {
        shrank = size < this.offset;
        return shrank ? size : this.offset;
      },
      (bytes) => {
        this.offset += bytes.length;
        // The decoder holds back a character split across two reads.
        const lines = (this.partial + this.decoder.write(bytes)).split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      }
    );
    return !shrank;
  }
}

type OnSessionLine = (line: string, fromSubagent: boolean) => void;

/**
 * A session's transcript and its subagents' transcripts, followed together.
 * Subagent files that appear later are picked up on the next read.
 */
export class SessionTail {
  private readonly tails = new Map<string, JsonlTail>();

  constructor(private readonly transcriptPath: string) {}

  /**
   * Hand `onLine` every line the session's files gained since the last read,
   * the transcript's first. When a file got shorter it was replaced: `onReset`
   * is called so the caller drops what it counted, and every file is read
   * again from the start.
   */
  async read(onLine: OnSessionLine, onReset: () => void): Promise<void> {
    if (await this.readAll(onLine)) return;
    this.tails.clear();
    onReset();
    await this.readAll(onLine);
  }

  private async readAll(onLine: OnSessionLine): Promise<boolean> {
    const paths = [this.transcriptPath, ...(await listSubagentTranscripts(this.transcriptPath))];
    for (const path of paths) {
      let tail = this.tails.get(path);
      if (!tail) {
        tail = new JsonlTail();
        this.tails.set(path, tail);
      }
      const fromSubagent = path !== this.transcriptPath;
      if (!(await tail.read(path, (line) => onLine(line, fromSubagent)))) return false;
    }
    return true;
  }
}
