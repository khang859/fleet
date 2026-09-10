import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { jsonCaretContext } from './claude-json-path';
import { keysAtPath, enumAtPath, descriptionAtPath } from '../../../shared/claude-settings-schema';

/**
 * Schema-driven completion for the raw settings editor.
 *
 * Keys at an object position, enum values at a value position. Both come from
 * the vendored schema, so the same snapshot that describes the form describes
 * the editor, and neither can drift from the other.
 */
export function claudeSettingsCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/"?[\w.$-]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  const caret = jsonCaretContext(context.state, context.pos);
  const quoted = context.state.doc.sliceString(word.from, word.from + 1) === '"';

  if (caret.at === 'key') {
    const keys = keysAtPath(caret.path);
    if (keys.length === 0) return null;
    return {
      from: word.from,
      options: keys.map((key) => ({
        label: quoted ? `"${key}"` : key,
        type: 'property',
        detail: descriptionAtPath([...caret.path, key])?.split('\n')[0]
      }))
    };
  }

  const values = enumAtPath(caret.path);
  if (values.length === 0) return null;
  return {
    from: word.from,
    options: values.map((value) => ({ label: `"${value}"`, type: 'enum' }))
  };
}
