import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../GitChangesModal';

const MULTI_FILE_DIFF = `diff --git a/src/main/index.ts b/src/main/index.ts
index abc1234..def5678 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -10,6 +10,7 @@ import { app } from 'electron';
 import { foo } from './foo';
+import { bar } from './bar';

 const x = 1;
@@ -30,3 +31,4 @@ function init() {
   setup();
+  teardown();
 }
diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx
index 1111111..2222222 100644
--- a/src/renderer/App.tsx
+++ b/src/renderer/App.tsx
@@ -1,4 +1,5 @@
 import React from 'react';
+import { NewComponent } from './NewComponent';

 export function App() {`;

describe('parseUnifiedDiff', () => {
  it('splits a multi-file diff into per-file entries', () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(result).toHaveLength(2);
  });

  it('extracts correct file names', () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(result[0].fileName).toBe('src/main/index.ts');
    expect(result[1].fileName).toBe('src/renderer/App.tsx');
  });

  it('strips header lines from hunks (diff --git, index, ---, +++)', () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    for (const file of result) {
      for (const hunk of file.hunks) {
        expect(hunk).not.toMatch(/^diff --git/m);
        expect(hunk).not.toMatch(/^index /m);
        expect(hunk).not.toMatch(/^--- /m);
        expect(hunk).not.toMatch(/^\+\+\+ /m);
      }
    }
  });

  it('produces hunks that each start with @@', () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    for (const file of result) {
      expect(file.hunks.length).toBeGreaterThan(0);
      for (const hunk of file.hunks) {
        expect(hunk.startsWith('@@')).toBe(true);
      }
    }
  });

  it('correctly splits multiple hunks within a single file', () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    // First file has two @@ hunks
    expect(result[0].hunks).toHaveLength(2);
    // Second file has one @@ hunk
    expect(result[1].hunks).toHaveLength(1);
  });

  it('returns empty array for empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseUnifiedDiff('  \n\n  ')).toEqual([]);
  });

  it('handles new file mode headers', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe('new.ts');
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].startsWith('@@')).toBe(true);
    expect(result[0].hunks[0]).not.toContain('new file mode');
  });

  it('binary file diffs produce empty hunks array', () => {
    const diff = `diff --git a/image.png b/image.png
index abc1234..def5678 100644
Binary files a/image.png and b/image.png differ`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe('image.png');
    expect(result[0].hunks).toEqual([]);
  });

  it('handles renamed file diffs correctly', () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe('new-name.ts');
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].startsWith('@@')).toBe(true);
    expect(result[0].hunks[0]).not.toContain('rename from');
    expect(result[0].hunks[0]).not.toContain('similarity index');
  });
});
