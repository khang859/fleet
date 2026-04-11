# Syntax Highlighting Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand syntax highlighting to ~30 languages in the File Editor, add Shiki-based highlighting to the Telescope file preview, and unify the duplicated extension-to-language mappings into a shared registry.

**Architecture:** A shared `languages.ts` registry provides the canonical extension-to-language mapping consumed by three components: FileEditorPane (CodeMirror, lazy-loaded), TelescopeModal (Shiki, lazy-loaded singleton), and GitChangesModal (Shiki via @git-diff-view/shiki). Each consumer maps the registry's language ID to its own library's API.

**Tech Stack:** CodeMirror 6 (editor), Shiki 4.x (read-only preview), TypeScript, React

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/languages.ts` | Create | Shared extension-to-language registry |
| `src/shared/__tests__/languages.test.ts` | Create | Tests for the language registry |
| `src/renderer/src/components/FileEditorPane.tsx` | Modify | Consume shared registry, lazy-load expanded CodeMirror langs |
| `src/renderer/src/components/Telescope/ShikiPreview.tsx` | Create | Shiki-highlighted preview component |
| `src/renderer/src/components/Telescope/TelescopeModal.tsx` | Modify | Use ShikiPreview instead of plain `<pre>` |
| `src/renderer/src/components/GitChangesModal.tsx` | Modify | Replace local lang map with shared registry |
| `package.json` | Modify | Add new `@codemirror/lang-*` packages |

---

### Task 1: Install CodeMirror Language Packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install all new CodeMirror language packages**

```bash
npm install @codemirror/lang-rust @codemirror/lang-go @codemirror/lang-java @codemirror/lang-cpp @codemirror/lang-xml @codemirror/lang-sql @codemirror/lang-sass @codemirror/lang-php @codemirror/lang-vue @codemirror/lang-yaml @codemirror/legacy-modes
```

- [ ] **Step 2: Verify install succeeded**

Run: `npm ls @codemirror/lang-rust @codemirror/lang-yaml @codemirror/legacy-modes`
Expected: All three packages listed without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add codemirror language packages for syntax highlighting expansion"
```

---

### Task 2: Create Shared Language Registry

**Files:**
- Create: `src/shared/languages.ts`
- Create: `src/shared/__tests__/languages.test.ts`

- [ ] **Step 1: Write failing tests for the language registry**

Create `src/shared/__tests__/languages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getLanguageForPath } from '../languages';

describe('getLanguageForPath', () => {
  it('resolves common extensions', () => {
    expect(getLanguageForPath('app.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(getLanguageForPath('script.sh')).toEqual({ id: 'bash', label: 'Bash' });
    expect(getLanguageForPath('config.yaml')).toEqual({ id: 'yaml', label: 'YAML' });
    expect(getLanguageForPath('main.rs')).toEqual({ id: 'rust', label: 'Rust' });
    expect(getLanguageForPath('main.go')).toEqual({ id: 'go', label: 'Go' });
    expect(getLanguageForPath('style.css')).toEqual({ id: 'css', label: 'CSS' });
  });

  it('handles full file paths', () => {
    expect(getLanguageForPath('/home/user/project/src/index.tsx')).toEqual({ id: 'tsx', label: 'TSX' });
    expect(getLanguageForPath('C:\\Users\\dev\\file.py')).toEqual({ id: 'python', label: 'Python' });
  });

  it('handles case-insensitive extensions', () => {
    expect(getLanguageForPath('README.MD')).toEqual({ id: 'markdown', label: 'Markdown' });
    expect(getLanguageForPath('data.JSON')).toEqual({ id: 'json', label: 'JSON' });
  });

  it('matches special filenames without extensions', () => {
    expect(getLanguageForPath('/project/Dockerfile')).toEqual({ id: 'dockerfile', label: 'Dockerfile' });
    expect(getLanguageForPath('/project/Makefile')).toEqual({ id: 'makefile', label: 'Makefile' });
  });

  it('returns null for unknown extensions', () => {
    expect(getLanguageForPath('file.xyz')).toBeNull();
    expect(getLanguageForPath('noextension')).toBeNull();
  });

  it('handles yml and yaml both mapping to yaml', () => {
    expect(getLanguageForPath('ci.yml')).toEqual({ id: 'yaml', label: 'YAML' });
    expect(getLanguageForPath('config.yaml')).toEqual({ id: 'yaml', label: 'YAML' });
  });

  it('handles all JS/TS variants', () => {
    expect(getLanguageForPath('a.js')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.mjs')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.cjs')).toEqual({ id: 'javascript', label: 'JavaScript' });
    expect(getLanguageForPath('a.jsx')).toEqual({ id: 'jsx', label: 'JSX' });
    expect(getLanguageForPath('a.ts')).toEqual({ id: 'typescript', label: 'TypeScript' });
    expect(getLanguageForPath('a.tsx')).toEqual({ id: 'tsx', label: 'TSX' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/shared/__tests__/languages.test.ts`
Expected: FAIL — `getLanguageForPath` is not exported / does not exist.

- [ ] **Step 3: Implement the shared language registry**

Create `src/shared/languages.ts`:

```ts
export interface LanguageInfo {
  id: string;
  label: string;
}

const extensionMap: Record<string, LanguageInfo> = {
  sh: { id: 'bash', label: 'Bash' },
  bash: { id: 'bash', label: 'Bash' },
  zsh: { id: 'bash', label: 'Bash' },
  c: { id: 'c', label: 'C' },
  h: { id: 'c', label: 'C' },
  cpp: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  cxx: { id: 'cpp', label: 'C++' },
  css: { id: 'css', label: 'CSS' },
  go: { id: 'go', label: 'Go' },
  html: { id: 'html', label: 'HTML' },
  htm: { id: 'html', label: 'HTML' },
  java: { id: 'java', label: 'Java' },
  js: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  jsx: { id: 'jsx', label: 'JSX' },
  json: { id: 'json', label: 'JSON' },
  kt: { id: 'kotlin', label: 'Kotlin' },
  kts: { id: 'kotlin', label: 'Kotlin' },
  less: { id: 'less', label: 'Less' },
  lua: { id: 'lua', label: 'Lua' },
  mk: { id: 'makefile', label: 'Makefile' },
  md: { id: 'markdown', label: 'Markdown' },
  markdown: { id: 'markdown', label: 'Markdown' },
  php: { id: 'php', label: 'PHP' },
  py: { id: 'python', label: 'Python' },
  rb: { id: 'ruby', label: 'Ruby' },
  rs: { id: 'rust', label: 'Rust' },
  scss: { id: 'scss', label: 'SCSS' },
  sql: { id: 'sql', label: 'SQL' },
  swift: { id: 'swift', label: 'Swift' },
  svelte: { id: 'svelte', label: 'Svelte' },
  toml: { id: 'toml', label: 'TOML' },
  ts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'tsx', label: 'TSX' },
  vue: { id: 'vue', label: 'Vue' },
  xml: { id: 'xml', label: 'XML' },
  svg: { id: 'xml', label: 'XML' },
  plist: { id: 'xml', label: 'XML' },
  yaml: { id: 'yaml', label: 'YAML' },
  yml: { id: 'yaml', label: 'YAML' },
  zig: { id: 'zig', label: 'Zig' },
};

/** Filenames (no extension) that map to a language */
const filenameMap: Record<string, LanguageInfo> = {
  Dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  Makefile: { id: 'makefile', label: 'Makefile' },
};

export function getLanguageForPath(filePath: string): LanguageInfo | null {
  // Extract the filename from the path
  const filename = filePath.split(/[/\\]/).pop() ?? '';

  // Check special filenames first (Dockerfile, Makefile)
  const byName = filenameMap[filename];
  if (byName) return byName;

  // Check by extension
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() ?? '' : '';
  return extensionMap[ext] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/shared/__tests__/languages.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/languages.ts src/shared/__tests__/languages.test.ts
git commit -m "feat: add shared language registry for syntax highlighting"
```

---

### Task 3: Expand FileEditorPane Language Support

**Files:**
- Modify: `src/renderer/src/components/FileEditorPane.tsx:1-93` (imports and language functions)

- [ ] **Step 1: Replace the inline language functions with shared registry + lazy loader**

In `src/renderer/src/components/FileEditorPane.tsx`, replace the entire top section (lines 1-59) with the following. This replaces `getLanguageExtension()` with an async `loadCodeMirrorLanguage()` that lazy-loads language packs, and replaces `getLanguageName()` with the shared registry.

Remove these static imports (lines 16-21):
```ts
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
```

Add this import near the top:
```ts
import { getLanguageForPath } from '../../../shared/languages';
```

Replace the `getLanguageExtension` function (lines 29-59) with:
```ts
async function loadCodeMirrorLanguage(langId: string): Promise<LanguageSupport | null> {
  switch (langId) {
    case 'javascript':
      return import('@codemirror/lang-javascript').then((m) => m.javascript());
    case 'jsx':
      return import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true }));
    case 'typescript':
      return import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true }));
    case 'tsx':
      return import('@codemirror/lang-javascript').then((m) =>
        m.javascript({ typescript: true, jsx: true })
      );
    case 'html':
      return import('@codemirror/lang-html').then((m) => m.html());
    case 'css':
      return import('@codemirror/lang-css').then((m) => m.css());
    case 'less':
    case 'scss':
      return import('@codemirror/lang-sass').then((m) => m.sass());
    case 'json':
      return import('@codemirror/lang-json').then((m) => m.json());
    case 'markdown':
      return import('@codemirror/lang-markdown').then((m) => m.markdown());
    case 'python':
      return import('@codemirror/lang-python').then((m) => m.python());
    case 'rust':
      return import('@codemirror/lang-rust').then((m) => m.rust());
    case 'go':
      return import('@codemirror/lang-go').then((m) => m.go());
    case 'java':
    case 'kotlin':
      return import('@codemirror/lang-java').then((m) => m.java());
    case 'c':
    case 'cpp':
      return import('@codemirror/lang-cpp').then((m) => m.cpp());
    case 'xml':
      return import('@codemirror/lang-xml').then((m) => m.xml());
    case 'sql':
      return import('@codemirror/lang-sql').then((m) => m.sql());
    case 'php':
      return import('@codemirror/lang-php').then((m) => m.php());
    case 'vue':
      return import('@codemirror/lang-vue').then((m) => m.vue());
    case 'yaml':
      return import('@codemirror/lang-yaml').then((m) => m.yaml());
    case 'bash': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return new LanguageSupport(StreamLanguage.define(shell));
    }
    case 'dockerfile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
      return new LanguageSupport(StreamLanguage.define(dockerFile));
    }
    case 'toml': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { toml } = await import('@codemirror/legacy-modes/mode/toml');
      return new LanguageSupport(StreamLanguage.define(toml));
    }
    case 'ruby': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
      return new LanguageSupport(StreamLanguage.define(ruby));
    }
    case 'lua': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { lua } = await import('@codemirror/legacy-modes/mode/lua');
      return new LanguageSupport(StreamLanguage.define(lua));
    }
    case 'swift': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { swift } = await import('@codemirror/legacy-modes/mode/swift');
      return new LanguageSupport(StreamLanguage.define(swift));
    }
    case 'makefile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { cmake } = await import('@codemirror/legacy-modes/mode/cmake');
      return new LanguageSupport(StreamLanguage.define(cmake));
    }
    case 'svelte':
      // Svelte uses HTML as base — closest available
      return import('@codemirror/lang-html').then((m) => m.html());
    case 'zig':
      // No dedicated CodeMirror mode — fall through to C-like
      return import('@codemirror/lang-cpp').then((m) => m.cpp());
    default:
      return null;
  }
}
```

Replace the `getLanguageName` function (lines 61-93) with:
```ts
function getLanguageName(filePath: string): string {
  return getLanguageForPath(filePath)?.label ?? 'Plain Text';
}
```

- [ ] **Step 2: Update the editor creation effect to handle async language loading**

In the `useEffect` that creates the editor (line 165), replace the synchronous language resolution with an async approach. Change lines 172-225 (the `const langExt = getLanguageExtension(filePath)` through end of EditorView creation):

Replace the synchronous `const langExt = getLanguageExtension(filePath);` (line 172) with:

```ts
    const langInfo = getLanguageForPath(filePath);
```

In the extensions array, remove `...(langExt ? [langExt] : [])` (line 225) — language will be added dynamically after creation.

After `viewRef.current = view;` (line 231), add:

```ts
    // Lazy-load and apply syntax highlighting
    if (langInfo) {
      void loadCodeMirrorLanguage(langInfo.id).then((langExt) => {
        if (langExt && viewRef.current === view) {
          view.dispatch({
            effects: StateEffect.appendConfig.of(langExt)
          });
        }
      });
    }
```

Add to the imports at top:
```ts
import { StateEffect } from '@codemirror/state';
```

Note: `StateEffect` is from `@codemirror/state` which is already imported — just add `StateEffect` to the existing `import { EditorState } from '@codemirror/state'` line.

- [ ] **Step 3: Verify it builds**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/FileEditorPane.tsx
git commit -m "feat: expand file editor to support ~30 languages with lazy loading"
```

---

### Task 4: Create Shiki Preview Component for Telescope

**Files:**
- Create: `src/renderer/src/components/Telescope/ShikiPreview.tsx`

- [ ] **Step 1: Create the ShikiPreview component**

Create `src/renderer/src/components/Telescope/ShikiPreview.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { getLanguageForPath } from '../../../../shared/languages';

type HighlighterInstance = Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>;

let highlighterPromise: Promise<HighlighterInstance> | null = null;

/** Core languages to pre-load with the highlighter */
const PRELOAD_LANGS = [
  'typescript', 'javascript', 'json', 'html', 'css', 'python', 'bash',
  'yaml', 'markdown', 'tsx', 'jsx', 'rust', 'go',
] as const;

function getHighlighter(): Promise<HighlighterInstance> {
  highlighterPromise ??= import('shiki').then((mod) =>
    mod.createHighlighter({
      themes: ['one-dark-pro'],
      langs: [...PRELOAD_LANGS],
    })
  );
  return highlighterPromise;
}

type Props = {
  content: string;
  filePath: string;
};

export function ShikiPreview({ content, filePath }: Props): React.JSX.Element {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setHighlightedHtml(null);

    const langInfo = getLanguageForPath(filePath);
    if (!langInfo) return;

    void (async () => {
      try {
        const highlighter = await getHighlighter();

        // Load the language grammar if not already loaded
        const loadedLangs = highlighter.getLoadedLanguages();
        if (!loadedLangs.includes(langInfo.id)) {
          try {
            await highlighter.loadLanguage(langInfo.id as Parameters<HighlighterInstance['loadLanguage']>[0]);
          } catch {
            // Language not available in Shiki — fall back to plain text
            return;
          }
        }

        if (generation !== generationRef.current) return; // stale

        const html = highlighter.codeToHtml(content, {
          lang: langInfo.id,
          theme: 'one-dark-pro',
        });

        if (generation === generationRef.current) {
          setHighlightedHtml(html);
        }
      } catch {
        // Shiki failed — leave highlightedHtml null to show fallback
      }
    })();
  }, [content, filePath]);

  if (highlightedHtml) {
    return (
      <div
        className="shiki-preview text-[11px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!text-[11px] [&_code]:!leading-relaxed"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  // Fallback: plain text (shown immediately, or when language is unknown)
  return (
    <pre className="text-[11px] text-neutral-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
      {content}
    </pre>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/ShikiPreview.tsx
git commit -m "feat: add ShikiPreview component for telescope file preview"
```

---

### Task 5: Integrate ShikiPreview into TelescopeModal

**Files:**
- Modify: `src/renderer/src/components/Telescope/TelescopeModal.tsx:121-226,330-356`

This task changes two things in TelescopeModal:
1. Store raw content + filePath separately from the display string (so ShikiPreview can receive unhighlighted content)
2. Use `ShikiPreview` in the preview panel

- [ ] **Step 1: Add new state and import**

At the top of `TelescopeModal.tsx`, add the import:
```ts
import { ShikiPreview } from './ShikiPreview';
```

Near the existing `previewContent` state (line 48), add a new state variable:
```ts
const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
```

- [ ] **Step 2: Update the preview effect to store the file path and raw content**

In the preview effect (lines 121-226), in the file-reading branch (lines 193-216), after reading the file content, store both the raw content and the file path. Replace lines 193-216:

```ts
      if (filePath !== null) {
        setPreviewLoading(true);
        setPreviewImage(null);
        void window.fleet.file
          .read(filePath)
          .then((result) => {
            if (result.success) {
              const lines = result.data.content.split('\n').slice(0, 200);
              setPreviewContent(lines.join('\n'));
              setPreviewFilePath(filePath);
            } else {
              setPreviewContent('Could not read file');
              setPreviewFilePath(null);
            }
          })
          .finally(() => setPreviewLoading(false));
        return;
      }
```

Note: We removed the line-number prefixing — Shiki needs raw content. Line numbers come from Shiki's output or CSS.

Also update the reset points to clear `previewFilePath`:
- At lines 124-125 (the early return when no results), add `setPreviewFilePath(null);`
- At line 146 (pane preview), add `setPreviewFilePath(null);` after `setPreviewImage(null);`
- At line 155 (directory preview), add `setPreviewFilePath(null);` after `setPreviewImage(null);`
- At line 178 (image preview), add `setPreviewFilePath(null);` after `setPreviewContent(null);`
- At line 219 (no preview), add `setPreviewFilePath(null);` after `setPreviewImage(null);`

- [ ] **Step 3: Update renderPreviewPanel to use ShikiPreview**

Replace the plain `<pre>` fallback in `renderPreviewPanel()` (lines 351-355):

```ts
  const renderPreviewPanel = (): React.JSX.Element => {
    if (previewLoading) {
      return <div className="text-xs text-neutral-500 p-3">Loading preview...</div>;
    }

    if (previewImage) {
      return (
        <div className="flex items-center justify-center h-full">
          <img
            src={`data:${previewImage.mimeType};base64,${previewImage.base64}`}
            className="max-w-full max-h-full object-contain"
            alt="Preview"
          />
        </div>
      );
    }

    if (!previewContent) {
      return <div className="text-xs text-neutral-600 p-3 italic">Select an item to preview</div>;
    }

    if (previewFilePath) {
      return <ShikiPreview content={previewContent} filePath={previewFilePath} />;
    }

    return (
      <pre className="text-[11px] text-neutral-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
        {previewContent}
      </pre>
    );
  };
```

The plain `<pre>` remains for non-file previews (pane info, directory listings) where `previewFilePath` is null.

- [ ] **Step 4: Verify it builds**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Telescope/TelescopeModal.tsx
git commit -m "feat: integrate shiki syntax highlighting into telescope preview"
```

---

### Task 6: Consolidate GitChangesModal Language Mapping

**Files:**
- Modify: `src/renderer/src/components/GitChangesModal.tsx:486-515`

- [ ] **Step 1: Add the shared registry import**

At the top of `GitChangesModal.tsx`, add:
```ts
import { getLanguageForPath } from '../../../shared/languages';
```

- [ ] **Step 2: Replace the local getLanguageFromFilename function**

Replace the `getLanguageFromFilename` function (lines 486-515) with:

```ts
function getLanguageFromFilename(filename: string): string | undefined {
  return getLanguageForPath(filename)?.id;
}
```

This preserves the existing function signature so callers (line 524) don't need to change. The shared registry now provides the mappings.

- [ ] **Step 3: Verify it builds**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 4: Run existing diff tests**

Run: `npm test -- src/renderer/src/components/__tests__/parseUnifiedDiff.test.ts`
Expected: All tests PASS (this test covers the diff parsing logic, which is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/GitChangesModal.tsx
git commit -m "refactor: consolidate git diff language mapping to shared registry"
```

---

### Task 7: Manual Verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No lint errors (fix any that appear).

- [ ] **Step 4: Start dev server and test File Editor**

Run: `npm run dev`

Open a file tab for each of these file types and verify syntax highlighting appears:
- `.ts` / `.tsx` — TypeScript/TSX (was working, verify no regression)
- `.sh` — Bash (new)
- `.yaml` — YAML (new)
- `.rs` — Rust (new)
- `.go` — Go (new)
- `.py` — Python (was working, verify no regression)

- [ ] **Step 5: Test Telescope preview**

Open Telescope (`Cmd+P` or equivalent), browse to files of different types:
- A `.ts` file — should show highlighted TypeScript
- A `.sh` file — should show highlighted Bash
- A `.json` file — should show highlighted JSON
- A directory — should show plain file listing (no highlighting)
- Rapidly arrow through files — should not lag or show stale highlighting

- [ ] **Step 6: Test Git Changes diff**

Make a change to a `.yaml` or `.rs` file, then open the Git Changes modal. Verify the diff shows syntax-highlighted content.

- [ ] **Step 7: Commit any fixes**

If any issues were found and fixed during manual testing:
```bash
git add -A
git commit -m "fix: address issues found during syntax highlighting manual testing"
```
