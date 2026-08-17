/**
 * Splitting the model list by where its models live.
 *
 * A picker holding several hundred OpenRouter models and two on loopback is
 * unreadable as one flat list: the two the user set up themselves are the ones
 * they are looking for, and they would be a rounding error in it. Headers give
 * them a place that is theirs.
 *
 * Only while nothing has been typed, though. A search result is one ranked list
 * - the best match belongs at the top whichever server it is on - and headers
 * over a filtered list would push the answer down under a heading to make room
 * for a distinction the user has stopped caring about.
 */

export type PickerGroup<T> = {
  key: string;
  /** `null` draws no heading, for a list that is one list. */
  header: string | null;
  models: T[];
};

type Sourced = { local?: { label: string } };

/**
 * The list, grouped by source, or left exactly as it is.
 *
 * Endpoints keep the order they arrive in - which is the order they were added
 * in, since main puts local models ahead of cloud ones and walks the configured
 * list in order. Two endpoints the user named the same thing share a heading,
 * which is the honest reading of having named them the same thing.
 */
export function groupBySource<T extends Sourced>(
  models: T[],
  grouped: boolean
): Array<PickerGroup<T>> {
  if (!grouped) return models.length === 0 ? [] : [{ key: 'all', header: null, models }];

  const groups: Array<PickerGroup<T>> = [];
  const byHeader = new Map<string, PickerGroup<T>>();

  for (const model of models) {
    const header = model.local?.label ?? 'OpenRouter';
    let group = byHeader.get(header);
    if (group === undefined) {
      group = { key: header, header, models: [] };
      byHeader.set(header, group);
      groups.push(group);
    }
    group.models.push(model);
  }

  // A single group is not a grouping. Heading a list "OpenRouter" when there is
  // nothing it could be contrasted with is furniture, not information.
  if (groups.length === 1) return [{ ...groups[0], header: null }];
  return groups;
}
