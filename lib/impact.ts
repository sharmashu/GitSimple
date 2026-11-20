export const IMPACT_LEVELS = ['Breaking', 'Feature', 'Refactor', 'Security', 'Performance', 'Fix'] as const;
export type ImpactLevel = typeof IMPACT_LEVELS[number];
