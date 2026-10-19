const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withServices(config) {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = manifest['uses-permission'] ??= [];
    for (const name of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK']) {
      if (!permissions.some((entry) => entry.$['android:name'] === name)) permissions.push({ $: { 'android:name': name } });
    }
    const application = manifest.application[0];
    const metadata = application['meta-data'] ??= [];
    const verificationKey = 'art.tsingshui.arxd.ENABLE_VERIFICATION';
    const enabled = config.extra?.arxdVerificationEnabled === true;
    if (enabled && !/^art\.tsingshui\.arxd\.[a-z][a-z0-9_]*$/.test(config.android?.package ?? '')) throw new Error('Verification cannot be enabled in a production package');
    const previousFlag = metadata.find((entry) => entry.$['android:name'] === verificationKey);
    if (previousFlag) previousFlag.$['android:value'] = String(enabled);
    else metadata.push({ $: { 'android:name': verificationKey, 'android:value': String(enabled) } });
    // Preserve the deployed with-rxd network policy; remove only our old override.
    if (application.$['android:networkSecurityConfig'] === '@xml/arxd_network_security') {
      delete application.$['android:networkSecurityConfig'];
    }
    const services = application.service ??= [];
    const name = 'expo.modules.arxdrxd.ManagedProcessService';
    if (!services.some((entry) => entry.$['android:name'] === name)) services.push({
      $: { 'android:name': name, 'android:exported': 'false', 'android:foregroundServiceType': 'specialUse', 'android:stopWithTask': 'false' },
      property: [{ $: { 'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE', 'android:value': 'User-started local analysis services and MCP subprocesses, with a persistent notification and explicit stop controls.' } }],
    });
    return mod;
  });
  return config;
};
