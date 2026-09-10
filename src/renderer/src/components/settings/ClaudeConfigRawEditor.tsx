import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { linter, lintGutter } from '@codemirror/lint';
import { autocompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Diagnostic } from '@codemirror/lint';
import { useClaudeConfigStore } from '../../store/claude-config-store';
import { isKnownTopLevelKey } from '../../../../shared/claude-settings-schema';
import { claudeSettingsLintSource } from '../../lib/claude-settings-lint';
import { claudeSettingsCompletions } from '../../lib/claude-settings-completion';
import type { ClaudeFileKind } from '../../../../shared/claude-config';

/**
 * The raw text view of whichever file the page is on.
 *
 * The document lives in the store, not in this component, so an unsaved edit
 * survives the unmount that navigating to another settings page causes. The
 * editor is only re-seeded when the store's text and the editor's text differ,
 * which happens on a load or a reload but never on the user's own typing.
 *
 * The whole editor is rebuilt for each file rather than re-seeded, because
 * `history()` would otherwise carry its entries across the switch: an undo in
 * one file would write the previous file's text into it, and a save would then
 * copy private user values into a shared project file.
 */

const READONLY_HINT = 'Hooks are managed on the Copilot page and are not written from here.';

export function ClaudeConfigRawEditor({
  path,
  kind
}: {
  path: string;
  kind: ClaudeFileKind;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const edit = useClaudeConfigStore((s) => s.edit);
  const text = useClaudeConfigStore((s) => s.documents[path]?.text ?? '');
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  // Read at creation time only, so the editor opens on the current draft
  // instead of on an empty document it then has to undo its way out of.
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: textRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          language.current.of([]),
          oneDark,
          EditorView.theme({ '&': { fontSize: '12px' }, '.cm-scroller': { maxHeight: '420px' } }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            edit(path, update.state.doc.toString());
          })
        ]
      })
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
  }, [edit, path]);

  // The language, the linter and completion all depend on which file is open,
  // so they are swapped together rather than rebuilt with the whole editor.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const extensions =
      kind === 'settings'
        ? [
            json(),
            lintGutter(),
            linter(claudeSettingsLintSource(isKnownTopLevelKey, setDiagnostics)),
            autocompletion({ override: [claudeSettingsCompletions] })
          ]
        : [markdown()];
    instance.dispatch({ effects: language.current.reconfigure(extensions) });
    if (kind !== 'settings') setDiagnostics([]);
  }, [kind]);

  // Adopt the store's text whenever it diverges from what is on screen: a load,
  // a reload, or a switch to another file. Typing never reaches this branch,
  // because the update listener has already put that text in the store.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (instance.state.doc.toString() === text) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: text },
      // A load or a reload is not something the user did, so undo must not walk
      // back into the text it replaced.
      annotations: Transaction.addToHistory.of(false)
    });
  }, [text, path]);

  const problems = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning');
  // A parse error is the one thing that blocks a save, so the hint gives way to it.
  const blocked = problems.some((d) => d.severity === 'error');

  return (
    <div className="space-y-2">
      <div
        ref={host}
        data-testid="claude-config-raw-editor"
        className="overflow-hidden rounded border border-fleet-border-strong"
      />
      {kind === 'settings' ? (
        <div className="space-y-1">
          {problems.slice(0, 5).map((problem, i) => (
            <div
              key={`${problem.from}-${i}`}
              className={`text-[11px] ${
                problem.severity === 'error' ? 'text-red-400' : 'text-amber-400'
              }`}
            >
              {problem.message}
            </div>
          ))}
          {blocked ? null : (
            <div className="text-[11px] text-fleet-text-subtle">{READONLY_HINT}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
