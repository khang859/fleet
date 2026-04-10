/**
 * Minimal path utilities for the renderer process.
 * Node's `path` module is not available in the browser context.
 */

export function dirname(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash === -1 ? '.' : filePath.slice(0, lastSlash);
}

export function resolve(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative;
  const parts = `${base}/${relative}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return '/' + resolved.join('/');
}
