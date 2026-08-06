/**
 * Reading a server-sent event stream, one line at a time.
 *
 * Both things Fleet streams from OpenRouter - a completion and an image - send
 * SSE, and the part worth getting right is the same for each: a chunk can split
 * a line anywhere, so the tail of one read is held back until the next read
 * completes it. What the lines mean is the caller's business.
 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      yield* lines;
    }
    // A body that ends without a final newline still ends with a line.
    if (buffer !== '') yield buffer;
  } finally {
    // Whoever stops reading early - a `break` on the done marker, a thrown
    // error - releases the lock rather than leaving the response half-read.
    reader.releaseLock();
  }
}

/**
 * The JSON of one `data:` line, or `null` for everything else.
 *
 * OpenRouter interleaves `: comment` keep-alives with the data, and a payload
 * that does not parse is skipped rather than failing the stream - what follows
 * it is still likely to arrive.
 */
export function sseData(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice('data:'.length).trim();
  if (data === '' || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
