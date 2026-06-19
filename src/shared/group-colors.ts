export const USER_GROUP_COLORS = [
  'blue',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple'
] as const;

export type UserGroupColor = (typeof USER_GROUP_COLORS)[number];

export const COLOR_MAP: Record<UserGroupColor, string> = {
  blue: 'bg-blue-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  pink: 'bg-pink-500',
  purple: 'bg-purple-500'
};
