/** Shared small-model policy for runtime reporting and the pinned Pi adapter. */
function arxdSmallContextPolicy(policy, contextWindow) {
  if (contextWindow <= 0 || contextWindow >= 65536) return policy;
  return { ...policy,
    reserveTokens: Math.min(policy.reserveTokens, Math.max(1024, Math.floor(contextWindow / 4))),
    keepRecentTokens: Math.min(policy.keepRecentTokens, Math.max(512, Math.floor(contextWindow / 8))),
    backgroundTokens: Math.min(policy.backgroundTokens, Math.max(512, Math.floor(contextWindow / 8))),
  };
}
exports.arxdSmallContextPolicy = arxdSmallContextPolicy;
