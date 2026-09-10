import Ajv from 'ajv';
import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import rawSchema from '../../../../resources/claude-code-settings.schema.json';
import { isRecord } from '../../../shared/is-record';

/**
 * Diagnostics for the raw settings editor.
 *
 * Two severities, and the difference matters. A parse error is an `error`:
 * Fleet cannot write text it cannot parse, so it blocks the save. Anything the
 * schema dislikes is a `warning`: the schema is a vendored snapshot and Claude
 * Code ships keys before SchemaStore lists them, so a warning must never stand
 * between the user and their own file.
 */

// `strict: false` because the schema is draft-07 but uses the newer `$defs`
// spelling for its definitions, which ajv's strict mode reports as unknown.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ajv ships a CJS default export
const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(rawSchema);

/** A JSON pointer for every property in the document, with its text range. */
function locateProperties(state: EditorState): Map<string, { from: number; to: number }> {
  const found = new Map<string, { from: number; to: number }>();
  const doc: Text = state.doc;

  const walk = (node: SyntaxNode, pointer: string): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'Property') {
        const nameNode = child.getChild('PropertyName');
        if (!nameNode) continue;
        const key = doc.sliceString(nameNode.from, nameNode.to).replace(/^"/, '').replace(/"$/, '');
        const childPointer = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        found.set(childPointer, { from: nameNode.from, to: child.to });
        walk(child, childPointer);
      } else {
        walk(child, pointer);
      }
    }
  };

  walk(syntaxTree(state).topNode, '');
  return found;
}

/** The unknown top-level keys in a parsed document, with their ranges. */
function unknownTopLevelKeys(
  value: Record<string, unknown>,
  known: (key: string) => boolean,
  locations: Map<string, { from: number; to: number }>
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (known(key)) continue;
    const where = locations.get(`/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    out.push({
      from: where?.from ?? 0,
      to: where?.to ?? 0,
      severity: 'warning',
      message: `"${key}" is not in Fleet's copy of the Claude Code settings schema. It may be newer than the snapshot, or a typo.`
    });
  }
  return out;
}

/**
 * Lint one settings document. Exported separately from the lint source so it
 * can be unit tested without a live editor view.
 */
export function claudeSettingsDiagnostics(
  state: EditorState,
  isKnownTopLevelKey: (key: string) => boolean
): Diagnostic[] {
  const text = state.doc.toString();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    const position = /position (\d+)/.exec(String(err));
    const at = position ? Math.min(Number(position[1]), state.doc.length) : 0;
    return [
      {
        from: at,
        to: Math.min(at + 1, state.doc.length),
        severity: 'error',
        message: `This file is not valid JSON, so Fleet cannot save it. ${String(err)}`
      }
    ];
  }

  if (!isRecord(parsed)) {
    return [
      {
        from: 0,
        to: state.doc.length,
        severity: 'error',
        message: 'A settings file must be a JSON object.'
      }
    ];
  }

  const locations = locateProperties(state);
  const out = unknownTopLevelKeys(parsed, isKnownTopLevelKey, locations);

  if (!validate(parsed) && validate.errors) {
    for (const error of validate.errors) {
      // Union branches produce one error per branch; the caller only needs to
      // know the value looks wrong, not which of five branches it failed.
      if (error.keyword === 'anyOf' || error.keyword === 'oneOf') continue;
      const where = locations.get(error.instancePath);
      out.push({
        from: where?.from ?? 0,
        to: where?.to ?? Math.min(1, state.doc.length),
        severity: 'warning',
        message: `${error.instancePath || 'this file'} ${error.message ?? 'does not match the schema'}.`
      });
    }
  }

  return out;
}

export function claudeSettingsLintSource(
  isKnownTopLevelKey: (key: string) => boolean,
  onDiagnostics: (diagnostics: Diagnostic[]) => void
) {
  return (view: EditorView): Diagnostic[] => {
    const diagnostics = claudeSettingsDiagnostics(view.state, isKnownTopLevelKey);
    onDiagnostics(diagnostics);
    return diagnostics;
  };
}
