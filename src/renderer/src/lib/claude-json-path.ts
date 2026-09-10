import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/**
 * Where a caret sits inside a JSON document, expressed as the object key path
 * that leads to it.
 *
 * Completion needs this: the schema can only say which keys or which enum
 * values belong at a position once it knows the path to that position. The
 * answer is read off the syntax tree rather than by re-parsing the text,
 * because the document is usually mid-edit and will not parse.
 */
export type JsonCaretContext = {
  /** Object keys from the document root to the caret's container. */
  path: string[];
  /** Whether a property name or a value belongs at the caret. */
  at: 'key' | 'value';
};

function unquote(raw: string): string {
  return raw.replace(/^"/, '').replace(/"$/, '');
}

function propertyName(property: SyntaxNode, doc: Text): string {
  const name = property.getChild('PropertyName');
  return name ? unquote(doc.sliceString(name.from, name.to)) : '';
}

/** Every enclosing property name, outermost first, including `node` itself. */
function pathFrom(node: SyntaxNode | null, doc: Text): string[] {
  const out: string[] = [];
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === 'Property') out.unshift(propertyName(cur, doc));
  }
  return out;
}

export function jsonCaretContext(state: EditorState, pos: number): JsonCaretContext {
  const doc = state.doc;
  const node = syntaxTree(state).resolveInner(pos, -1);

  if (node.name === 'PropertyName') {
    // The path of the object that holds this key, not of the key itself.
    return { path: pathFrom(node.parent?.parent ?? null, doc), at: 'key' };
  }

  // A half-typed key is still a bare string in its object; the parser has not
  // seen the colon that would make it a property.
  if (node.name === 'String' && node.parent?.name === 'Object') {
    return { path: pathFrom(node.parent, doc), at: 'key' };
  }

  if (node.name === 'Object') return { path: pathFrom(node, doc), at: 'key' };

  // A caret in the gap of a property, after the name but before the value.
  if (node.name === 'Property') return { path: pathFrom(node, doc), at: 'value' };

  return { path: pathFrom(node, doc), at: 'value' };
}
