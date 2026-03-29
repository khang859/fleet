import spaceship from './sprites-spaceship';
import robot from './sprites-robot';
import cat from './sprites-cat';

const SPRITE_SHEETS: Record<string, string> = { spaceship, robot, cat };

export function getSpriteSheet(id: string): string {
  return SPRITE_SHEETS[id] ?? SPRITE_SHEETS['spaceship'];
}
