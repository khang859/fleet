import type { MascotDefinition, SpriteAnimations } from './types';

export const DEFAULT_ANIMATIONS: SpriteAnimations = {
  idle: { frames: [0, 1], fps: 2 },
  processing: { frames: [2, 3, 4], fps: 4 },
  permission: { frames: [5, 6], fps: 3 },
  complete: { frames: [7, 8], fps: 2 },
};

export const MASCOT_REGISTRY: MascotDefinition[] = [
  { id: 'officer', name: 'Officer', description: 'The classic Fleet officer', thumbnailFrame: 0 },
  { id: 'robot', name: 'Robot', description: 'A friendly automaton', thumbnailFrame: 0 },
  { id: 'cat', name: 'Cat', description: 'A curious space cat', thumbnailFrame: 0 },
  { id: 'bear', name: 'Bear', description: 'An armored polar bear warrior', thumbnailFrame: 0 },
  { id: 'kraken', name: 'Kraken', description: 'An astral space kraken', thumbnailFrame: 0 },
  {
    id: 'dragon', name: 'Dragon', description: 'An armored cybernetic dragon', thumbnailFrame: 0,
    animations: {
      idle: { frames: [0, 1, 2, 3], fps: 3 },
      processing: { frames: [4, 5, 6, 7, 8, 9], fps: 8 },
      permission: { frames: [10, 11], fps: 3 },
      complete: { frames: [12, 13, 14, 15], fps: 4 },
    },
  },
];
