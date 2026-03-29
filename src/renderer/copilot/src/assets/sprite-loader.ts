import { MASCOT_REGISTRY } from '../../../../shared/mascots';

const validIds = new Set(MASCOT_REGISTRY.map((m) => m.id));

export function getSpriteSheet(id: string): string {
  const mascotId = validIds.has(id) ? id : 'officer';
  return `fleet-asset://mascots/${mascotId}.webp`;
}
