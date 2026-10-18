import type { Root } from 'mdast';

/**
 * A file's YAML front matter, as `remark-frontmatter` parses it, shown as a
 * `yaml` code block. Without this the `---` fences read as rules and the keys
 * run together into one paragraph.
 */
export function remarkFrontmatterAsCode() {
  return (tree: Root): void => {
    const first = tree.children.at(0);
    if (first?.type === 'yaml') {
      tree.children[0] = { type: 'code', lang: 'yaml', meta: null, value: first.value };
    }
  };
}
