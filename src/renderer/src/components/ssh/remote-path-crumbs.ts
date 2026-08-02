export type Crumb = { label: string; path: string };

/**
 * Split an absolute POSIX path into cumulative crumbs, starting at `/`.
 * Note this describes *where the directory sits in the tree*, not how the user
 * got there - per NN/g, a breadcrumb is a location indicator, not a back trail.
 * (Back/forward buttons cover the history axis.)
 */
export function toCrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const segment of path.split('/')) {
    if (segment === '') continue;
    acc += `/${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}
