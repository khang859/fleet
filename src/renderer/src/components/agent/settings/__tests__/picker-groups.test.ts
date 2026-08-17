import { describe, expect, it } from 'vitest';
import { groupBySource } from '../picker-groups';

/**
 * Where a model picker draws its headings.
 *
 * The stakes are the two models a person set up themselves sitting in a list of
 * several hundred they did not, and finding them again afterwards.
 */

type Model = { id: string; name: string; local?: { label: string } };

const cloud = (id: string): Model => ({ id, name: id });
const local = (id: string, label: string): Model => ({ id, name: id, local: { label } });

describe('grouping', () => {
  it('puts each endpoint under its own heading, cloud under OpenRouter', () => {
    const groups = groupBySource(
      [local('a', 'llama :11437'), local('b', 'llama :11438'), cloud('anthropic/x')],
      true
    );
    expect(groups.map((g) => g.header)).toEqual(['llama :11437', 'llama :11438', 'OpenRouter']);
    expect(groups[0].models.map((m) => m.id)).toEqual(['a']);
    expect(groups[2].models.map((m) => m.id)).toEqual(['anthropic/x']);
  });

  it('keeps the order the models arrived in, within a group and between them', () => {
    const groups = groupBySource(
      [local('a', 'A'), cloud('c1'), local('b', 'A'), cloud('c2')],
      true
    );
    // 'A' is claimed by the first model that named it, so it stays ahead of
    // OpenRouter even though a cloud model was seen before its second member.
    expect(groups.map((g) => g.header)).toEqual(['A', 'OpenRouter']);
    expect(groups[0].models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(groups[1].models.map((m) => m.id)).toEqual(['c1', 'c2']);
  });

  it('does not head a list that has nothing to be contrasted with', () => {
    // One heading over the whole list is furniture, not information.
    const groups = groupBySource([cloud('c1'), cloud('c2')], true);
    expect(groups).toHaveLength(1);
    expect(groups[0].header).toBeNull();
    expect(groups[0].models.map((m) => m.id)).toEqual(['c1', 'c2']);
  });

  it('leaves a single local endpoint unheaded too', () => {
    const groups = groupBySource([local('a', 'llama :11437')], true);
    expect(groups[0].header).toBeNull();
  });

  it('drops headings entirely while a search is running', () => {
    // A search result is one ranked list: the best match belongs at the top
    // whichever server it is on, not pushed down under a heading.
    const groups = groupBySource([local('a', 'llama :11437'), cloud('anthropic/x')], false);
    expect(groups).toHaveLength(1);
    expect(groups[0].header).toBeNull();
    expect(groups[0].models.map((m) => m.id)).toEqual(['a', 'anthropic/x']);
  });

  it('returns nothing for an empty list, grouped or not', () => {
    expect(groupBySource([], true)).toEqual([]);
    expect(groupBySource([], false)).toEqual([]);
  });

  it('gives every group a distinct key', () => {
    const groups = groupBySource(
      [local('a', 'llama :11437'), local('b', 'llama :11438'), cloud('anthropic/x')],
      true
    );
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it('does not mutate the list it was handed', () => {
    const models = [local('a', 'A'), cloud('c1')];
    const before = [...models];
    groupBySource(models, true);
    expect(models).toEqual(before);
  });
});
