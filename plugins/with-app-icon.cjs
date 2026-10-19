const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const resources = {
  'drawable/ic_launcher_background_light.xml': `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="#f4f0e8" />
</shape>
`,
  'drawable/ic_launcher_foreground_light.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
  android:width="108dp" android:height="108dp"
  android:viewportWidth="256" android:viewportHeight="256">
  <group android:pivotX="128" android:pivotY="128" android:scaleX="0.55" android:scaleY="0.55">
    <path android:fillColor="#101114" android:pathData="M40 66 113 128 87 149 40 111Z" />
    <path android:fillColor="#101114" android:pathData="M216 66 143 128 169 149 216 111Z" />
    <path android:fillColor="#101114" android:pathData="M40 148C66 169 96 184 128 184s62-15 88-36c-11 47-47 76-88 76s-77-29-88-76Z" />
  </group>
</vector>
`,
  'mipmap-anydpi-v26/ic_launcher_light.xml': `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@drawable/ic_launcher_background_light" />
  <foreground android:drawable="@drawable/ic_launcher_foreground_light" />
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`,
};
resources['mipmap-anydpi-v26/ic_launcher_round_light.xml'] = resources['mipmap-anydpi-v26/ic_launcher_light.xml'];

function launcherFilter(filter) {
  const actions = (filter.action || []).map((entry) => entry.$?.['android:name']);
  const categories = (filter.category || []).map((entry) => entry.$?.['android:name']);
  return actions.includes('android.intent.action.MAIN') && categories.includes('android.intent.category.LAUNCHER');
}

function launcherAlias(name, icon, roundIcon, enabled) {
  return { $: {
    'android:name': name,
    'android:targetActivity': '.MainActivity',
    'android:enabled': String(enabled),
    'android:exported': 'true',
    'android:icon': icon,
    'android:roundIcon': roundIcon,
    'android:label': '@string/app_name',
    'android:theme': '@style/Theme.App.SplashScreen',
  }, 'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }], category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }] }] };
}

module.exports = function withAppIcon(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application[0];
    const main = (application.activity || []).find((entry) => entry.$?.['android:name'] === '.MainActivity');
    if (main) main['intent-filter'] = (main['intent-filter'] || []).filter((filter) => !launcherFilter(filter));
    const aliases = application['activity-alias'] ??= [];
    const dark = launcherAlias('.MainActivityDark', '@mipmap/ic_launcher', '@mipmap/ic_launcher_round', false);
    const light = launcherAlias('.MainActivityLight', '@mipmap/ic_launcher_light', '@mipmap/ic_launcher_round_light', true);
    for (const alias of [dark, light]) {
      const index = aliases.findIndex((entry) => entry.$?.['android:name'] === alias.$['android:name']);
      if (index === -1) aliases.push(alias); else aliases[index] = alias;
    }
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const root = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res');
    for (const [relative, content] of Object.entries(resources)) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    return mod;
  }]);
};
