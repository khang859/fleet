import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AnnotationStore } from '../annotation-store';

const TEST_DIR = join(tmpdir(), `fleet-annotation-store-test-${Date.now()}`);

describe('AnnotationStore', () => {
  let store: AnnotationStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new AnnotationStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts with empty list', () => {
    expect(store.list()).toEqual([]);
  });

  it('adds an annotation and lists it', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      viewport: { width: 1440, height: 900 },
      context: 'Fix button',
      elements: [
        {
          selector: '#btn',
          tag: 'button',
          id: 'btn',
          classes: ['primary'],
          text: 'Click',
          rect: { x: 0, y: 0, width: 100, height: 40 },
          attributes: {}
        }
      ]
    };
    const meta = store.add(result, []);
    expect(meta.url).toBe('https://example.com');
    expect(meta.elementCount).toBe(1);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(meta.id);
  });

  it('gets annotation detail', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    const detail = store.get(meta.id);
    expect(detail).not.toBeNull();
    expect(detail?.url).toBe('https://example.com');
  });

  it('deletes an annotation', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    store.delete(meta.id);
    expect(store.list()).toHaveLength(0);
    expect(store.get(meta.id)).toBeNull();
  });

  it('cleans up old annotations', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    const meta = store.add(result, []);
    // Manually backdate the timestamp
    const index = store.list();
    index[0].timestamp = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    store.saveIndex(index);

    store.cleanup(3); // 3 day retention
    expect(store.list()).toHaveLength(0);
  });

  it('preserves recent annotations during cleanup', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: []
    };
    store.add(result, []);
    store.cleanup(3);
    expect(store.list()).toHaveLength(1);
  });

  it('emits changed event on add', () => {
    let emitted = false;
    store.on('changed', () => {
      emitted = true;
    });
    store.add({ success: true, url: 'https://example.com', elements: [] }, []);
    expect(emitted).toBe(true);
  });

  it('emits changed event on delete', () => {
    const meta = store.add(
      { success: true, url: 'https://example.com', elements: [] },
      []
    );
    let emitted = false;
    store.on('changed', () => {
      emitted = true;
    });
    store.delete(meta.id);
    expect(emitted).toBe(true);
  });

  it('handles screenshots', () => {
    const result = {
      success: true as const,
      url: 'https://example.com',
      elements: [
        {
          selector: '#el',
          tag: 'div',
          id: 'el',
          classes: [],
          text: '',
          rect: { x: 0, y: 0, width: 100, height: 100 },
          attributes: {}
        }
      ]
    };
    const png = Buffer.from('fake-png-data');
    const meta = store.add(result, [{ index: 1, pngBuffer: png }]);
    const detail = store.get(meta.id);
    expect(detail?.screenshotPaths).toHaveLength(1);
  });
});
