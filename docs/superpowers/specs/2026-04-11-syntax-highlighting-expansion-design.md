# Syntax Highlighting Expansion

## Overview

Expand syntax highlighting coverage across Fleet: add ~20 new languages to the File Editor (CodeMirror), add Shiki-based highlighting to the Telescope file preview, and consolidate the duplicated extension-to-language mappings into a single shared registry.

## Motivation

- The File Editor only highlights 7 languages (JS/TS, HTML, CSS, JSON, Markdown, Python). Common languages like Bash, YAML, Rust, Go, and many others render as plain text.
- The Telescope file preview has no syntax highlighting at all — files display as raw monospace text in a `<pre>` tag.
- Extension-to-language mappings are duplicated between `FileEditorPane.tsx` and `GitChangesModal.tsx`, meaning new languages must be added in multiple places.

## Design

### 1. Shared Language Registry

**File:** `src/shared/languages.ts`

A single module that maps file extensions to language metadata:

```ts
interface LanguageInfo {
  id: string       // canonical language ID (e.g. "typescript", "bash")
  label: string    // display label (e.g. "TypeScript", "Bash")
}
```

Exports a function `getLanguageForPath(filePath: string): LanguageInfo | null` that resolves a file path (or filename) to its language info by matching the extension.

**Supported languages (initial set):**

| Language | Extensions |
|----------|-----------|
| Bash/Shell | .sh, .bash, .zsh |
| C | .c, .h |
| C++ | .cpp, .hpp, .cc, .cxx |
| CSS | .css |
| Dockerfile | Dockerfile |
| Go | .go |
| HTML | .html, .htm |
| Java | .java |
| JavaScript | .js, .mjs, .cjs |
| JSX | .jsx |
| JSON | .json |
| Kotlin | .kt, .kts |
| Less | .less |
| Lua | .lua |
| Makefile | Makefile, .mk |
| Markdown | .md, .markdown |
| PHP | .php |
| Python | .py |
| Ruby | .rb |
| Rust | .rs |
| SCSS | .scss |
| SQL | .sql |
| Swift | .swift |
| TOML | .toml |
| TypeScript | .ts |
| TSX | .tsx |
| Vue | .vue |
| Svelte | .svelte |
| XML | .xml, .svg, .plist |
| YAML | .yml, .yaml |
| Zig | .zig |

Fallback: returns `null` for unrecognized extensions (consumers render as plain text).

Special cases: `Dockerfile` and `Makefile` match by filename (no extension), not by extension.

### 2. FileEditorPane Language Expansion

**File:** `src/renderer/src/components/FileEditorPane.tsx`

Replace the existing inline `getLanguageExtension()` with a new function that:

1. Calls `getLanguageForPath()` from the shared registry to get the language ID
2. Maps the language ID to a lazy-loaded CodeMirror `LanguageSupport` via dynamic `import()`

**New CodeMirror packages to install:**

- `@codemirror/lang-rust`
- `@codemirror/lang-go`
- `@codemirror/lang-java`
- `@codemirror/lang-cpp`
- `@codemirror/lang-xml`
- `@codemirror/lang-sql`
- `@codemirror/lang-sass` (for SCSS/Less)
- `@codemirror/lang-php`
- `@codemirror/lang-vue`
- `@codemirror/lang-yaml`
- `@codemirror/lang-angular` (skip if not needed — low priority)
- `@codemirror/legacy-modes` (for languages without dedicated packages: bash/shell, toml, dockerfile, ruby, lua, kotlin, swift, zig, makefile). These modes are wrapped with `StreamLanguage.define()` from `@codemirror/language` (already installed) to produce a `LanguageSupport` instance.

**Lazy loading pattern:**

```ts
async function loadLanguage(id: string): Promise<LanguageSupport | null> {
  switch (id) {
    case 'typescript':
    case 'tsx':
      return import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: id === 'tsx' }))
    case 'bash': {
      const { StreamLanguage } = await import('@codemirror/language')
      const { shell } = await import('@codemirror/legacy-modes/mode/shell')
      return new LanguageSupport(StreamLanguage.define(shell))
    }
    // etc.
  }
}
```

Each language is only loaded when a file of that type is opened. The footer language label uses the `label` field from the shared registry.

### 3. Telescope Shiki Preview

**File:** `src/renderer/src/components/Telescope/TelescopeModal.tsx` (or extracted into a `ShikiPreview.tsx` component)

Replace the plain `<pre>` file preview with Shiki-highlighted HTML.

**Shiki highlighter singleton:**

- Create/load the Shiki highlighter on first Telescope open using `createHighlighter()` from the `shiki` package (already installed)
- Store the instance in a module-level variable for reuse
- Load with a dark theme that matches the app aesthetic (e.g. `one-dark-pro` or `vitesse-dark`)
- Pre-load a core set of common grammars; lazy-load others on demand

**Highlighting flow:**

1. User navigates to a file in Telescope
2. Resolve file extension via `getLanguageForPath()` from the shared registry
3. If a language is recognized, call `highlighter.codeToHtml(content, { lang, theme })`
4. Render the resulting HTML via `dangerouslySetInnerHTML`
5. If no language is recognized, fall back to the existing plain `<pre>` rendering

**Performance considerations:**

- Show raw text immediately; swap in highlighted HTML once Shiki finishes (avoids blocking the UI while highlighting)
- Cancel in-flight highlighting when the selected file changes (user arrowing through files rapidly). Use an AbortController pattern or a generation counter to discard stale results.
- Limit highlighting to the first ~200 lines (the preview already caps at 200 lines)

**Fallback:** If Shiki hasn't loaded yet or an error occurs, render plain text. No degradation from current behavior.

### 4. GitChangesModal Consolidation

**File:** `src/renderer/src/components/GitChangesModal.tsx`

Replace the local `getLangFromFilename()` mapping (lines ~486-515) with a call to `getLanguageForPath()` from the shared registry. Map the returned language ID to the Shiki language name for `@git-diff-view/shiki`.

This ensures any language added to the shared registry automatically works in diff views.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/languages.ts` | New — shared language registry |
| `src/renderer/src/components/FileEditorPane.tsx` | Expand language support, consume shared registry |
| `src/renderer/src/components/Telescope/TelescopeModal.tsx` | Add Shiki preview (or extract `ShikiPreview.tsx`) |
| `src/renderer/src/components/GitChangesModal.tsx` | Replace local lang map with shared registry |
| `package.json` | Add ~10 new `@codemirror/lang-*` packages |

## Out of Scope

- Syntax highlighting in terminal panes (xterm.js handles its own ANSI rendering)
- User-configurable theme selection for syntax highlighting
- Language auto-detection by content (we rely on file extension only)
- LSP integration or intelligent code completion
