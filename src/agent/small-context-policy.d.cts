export function arxdSmallContextPolicy<T extends { reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>(policy: T, contextWindow: number): T;
