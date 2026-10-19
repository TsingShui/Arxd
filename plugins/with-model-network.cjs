const { withMainApplication } = require('expo/config-plugins');

// Expo 58 fetch uses RN 0.88's OkHttpClientProvider. The model adapter marks
// requests; an application interceptor makes their buffered body one-shot BEFORE
// OkHttp's RetryAndFollowUpInterceptor and bounds native wall-clock lifetime.
// This prevents implicit POST replay for
// reset connections and 503 Retry-After:0. Other App requests are unchanged.
module.exports = function withModelNetwork(config) {
  return withMainApplication(config, (mod) => {
    const marker = '// Arxd: model replay and native wall deadline policy v2.';
    if (mod.modResults.contents.includes(marker)) return mod;
    if (mod.modResults.language !== 'kt') throw new Error('Review model network policy for a non-Kotlin MainApplication');
    // Replace the previous generated policy when prebuilding an existing project.
    mod.modResults.contents = mod.modResults.contents.replace(/\n    \/\/ Arxd: model POST replay belongs exclusively to Pi durable requests\.\n    com\.facebook\.react\.modules\.network\.OkHttpClientProvider\.setOkHttpClientFactory \{[\s\S]*?\n    \}\n/, '\n');
    const anchor = 'super.onCreate()';
    if (mod.modResults.contents.split(anchor).length !== 2) throw new Error('MainApplication lifecycle changed; review model network initialization');
    const code = `
    ${marker}
    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory {
      expo.modules.arxdrxd.ModelRequestPolicy.apply(
        com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder(this)
      ).build()
    }
`;
    mod.modResults.contents = mod.modResults.contents.replace(anchor, anchor + code);
    return mod;
  });
};
