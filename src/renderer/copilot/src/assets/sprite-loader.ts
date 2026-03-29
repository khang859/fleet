import officer from './sprites-officer';
import robot from './sprites-robot';
import cat from './sprites-cat';
import bear from './sprites-bear';

const SPRITE_SHEETS: Record<string, string> = { officer, robot, cat, bear };

export function getSpriteSheet(id: string): string {
  return SPRITE_SHEETS[id] ?? SPRITE_SHEETS['officer'];
}
