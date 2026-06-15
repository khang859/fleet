// src/main/learnings/vec-extension.ts
import type Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';

/**
 * Load the sqlite-vec loadable extension into a better-sqlite3 connection.
 *
 * sqlite-vec resolves its native `vec0` library relative to its own package, which
 * in a packaged build points inside `app.asar`. `loadExtension` calls dlopen, which
 * cannot read a file inside the asar archive — so we redirect to the unpacked copy
 * (the binary is listed in electron-builder.yml `asarUnpack`). See
 * docs/learnings/2026-06-15-sqlite-vec-onnx-packaging.md.
 */
export function loadVecExtension(db: Database.Database): void {
  let path = getLoadablePath();
  if (path.includes('app.asar') && !path.includes('app.asar.unpacked')) {
    path = path.replace('app.asar', 'app.asar.unpacked');
  }
  db.loadExtension(path);
}
