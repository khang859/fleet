export const USER_GROUP_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;

export type UserGroupColor = typeof USER_GROUP_COLORS[number];
