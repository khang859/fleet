import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGallery } from '../gallery';

const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-8888-4777-8666-555555555555';

let root: string;

/** One image on disk, stamped so the ordering under test is the one asked for. */
function put(sessionId: string, name: string, seconds: number): string {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, 'bytes');
  utimesSync(path, seconds, seconds);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-gallery-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listGallery', () => {
  it('says the store is empty rather than failing when it does not exist yet', async () => {
    expect(await listGallery(null, 10, join(root, 'nothing-here'))).toEqual({
      images: [],
      next: null
    });
  });

  it('gathers every conversation into one list, newest first', async () => {
    const old = put(A, 'a.png', 1000);
    const recent = put(B, 'b.png', 3000);
    const middle = put(A, 'c.png', 2000);

    const page = await listGallery(null, 10, root);
    expect(page.images.map((i) => i.path)).toEqual([recent, middle, old]);
    expect(page.images[0].sessionId).toBe(B);
    // Nothing left, so the grid is told to stop asking.
    expect(page.next).toBeNull();
  });

  it('leaves out what is not an image, and what is not a conversation', async () => {
    const image = put(A, 'a.png', 1000);
    put(A, 'notes.txt', 1000);
    put('not-a-uuid', 'b.png', 2000);

    const page = await listGallery(null, 10, root);
    expect(page.images.map((i) => i.path)).toEqual([image]);
  });

  it('pages by position, so a picture arriving mid-scroll cannot hide another', async () => {
    const paths = [3000, 2000, 1000].map((at, i) => put(A, `${i}.png`, at));

    const first = await listGallery(null, 2, root);
    expect(first.images.map((i) => i.path)).toEqual([paths[0], paths[1]]);
    expect(first.next).toEqual({ modifiedAt: first.images[1].modifiedAt, path: paths[1] });

    // A newer picture lands between the two reads. An offset would now skip
    // the third image; a cursor still returns exactly what follows the second.
    put(A, 'newest.png', 4000);

    const second = await listGallery(first.next, 2, root);
    expect(second.images.map((i) => i.path)).toEqual([paths[2]]);
    expect(second.next).toBeNull();
  });

  it('breaks a tie by path, so two images written in the same moment both appear', async () => {
    const first = put(A, 'a.png', 1000);
    const second = put(A, 'b.png', 1000);

    const page = await listGallery(null, 1, root);
    expect(page.images.map((i) => i.path)).toEqual([first]);

    const rest = await listGallery(page.next, 1, root);
    expect(rest.images.map((i) => i.path)).toEqual([second]);
  });
});
