const fs = require('node:fs/promises');
const path = require('node:path');
const { withAppBuildGradle, withAndroidManifest, withDangerousMod, withGradleProperties, withProjectBuildGradle } = require('expo/config-plugins');

module.exports = function withRxd(config) {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults.manifest.application[0].$['android:extractNativeLibs'] = 'true';
    // Connections may point at a user-configured local HTTP model server.
    mod.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
    const permissions = mod.modResults.manifest['uses-permission'] ??= [];
    for (const name of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.WAKE_LOCK', 'android.permission.QUERY_ALL_PACKAGES']) {
      if (!permissions.some((entry) => entry.$['android:name'] === name)) permissions.push({ $: { 'android:name': name } });
    }
    const services = mod.modResults.manifest.application[0].service ??= [];
    const serviceName = 'expo.modules.arxdrxd.PreloadVerificationService';
    if (!services.some((entry) => entry.$['android:name'] === serviceName)) {
      services.push({ $: {
        'android:name': serviceName,
        'android:exported': 'true',
        'android:permission': 'android.permission.DUMP',
        'android:foregroundServiceType': 'dataSync',
      } });
    }
    return mod;
  });
  config = withGradleProperties(config, (mod) => {
    mod.modResults = mod.modResults.filter((item) => !['reactNativeArchitectures', 'android.minSdkVersion', 'android.ndkVersion'].includes(item.key));
    mod.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' });
    mod.modResults.push({ type: 'property', key: 'android.minSdkVersion', value: '26' });
    mod.modResults.push({ type: 'property', key: 'android.ndkVersion', value: '28.2.13676358' });
    return mod;
  });
  config = withProjectBuildGradle(config, (mod) => {
    const ndk = 'ext.ndkVersion = findProperty("android.ndkVersion")';
    if (!mod.modResults.contents.includes(ndk)) {
      const plugin = /apply plugin:\s*["']expo-root-project["']/;
      if (!plugin.test(mod.modResults.contents)) throw new Error('Expo root plugin location changed; review Arxd NDK configuration');
      mod.modResults.contents = mod.modResults.contents.replace(plugin, `${ndk}\n$&`);
    }
    // Maven Central is slow enough from this network that a debug build stalls for
    // minutes on react-android's debug AAR; the mirrors answer first and the
    // original repositories stay behind them as fallback.
    const mirror = '// Arxd: fast Maven mirrors first, upstream repositories kept as fallback.';
    if (!mod.modResults.contents.includes(mirror)) {
      const anchor = /allprojects \{\s*repositories \{/;
      if (!anchor.test(mod.modResults.contents)) throw new Error('Gradle repository block changed; review the Arxd mirror configuration');
      mod.modResults.contents = mod.modResults.contents.replace(anchor, (match) => `${match}\n    // Arxd: fast Maven mirrors first, upstream repositories kept as fallback.\n    maven { url 'https://maven.aliyun.com/repository/central' }\n    maven { url 'https://maven.aliyun.com/repository/google' }`);
    }
    const marker = '// Arxd: keep build artifacts under the repository target directory.';
    if (!mod.modResults.contents.includes(marker)) {
      // Third-party RN CMake files address their own build/generated directory.
      // Leave those ignored dependency intermediates at the upstream location.
      mod.modResults.contents += `\n${marker}\ndef localModules = new File(rootProject.projectDir.parentFile, "modules").canonicalPath + File.separator\nallprojects { project ->\n  if (project.projectDir.canonicalPath.startsWith(localModules)) {\n    project.layout.buildDirectory.set(new File(rootProject.projectDir, "../target/arxd/gradle/" + project.path.replace(':', '_')))\n  }\n}\n`;
    }
    return mod;
  });
  config = withAppBuildGradle(config, (mod) => {
    const setting = 'android.packaging.jniLibs.useLegacyPackaging = true';
    if (!mod.modResults.contents.includes(setting)) mod.modResults.contents += `\n${setting}\n`;
    const identity = "android.packaging.jniLibs.keepDebugSymbols.add('**/librxd.so')";
    if (!mod.modResults.contents.includes(identity)) mod.modResults.contents += `\n${identity}\n`;
    const preloadIdentity = "android.packaging.jniLibs.keepDebugSymbols.add('**/libarxdpreload.so')";
    if (!mod.modResults.contents.includes(preloadIdentity)) mod.modResults.contents += `\n${preloadIdentity}\n`;
    // Module build directories live under target/, inside the JS bundle task's
    // project input. Keep the JS bundle ordered after the relocated module
    // outputs so Gradle does not reject the release graph as overlapping.
    const bundleDependency = '// Arxd: declare relocated module outputs to the release bundle task.';
    if (!mod.modResults.contents.includes(bundleDependency)) {
      mod.modResults.contents += `\n${bundleDependency}\ntasks.matching { it.name == 'createBundleReleaseJsAndAssets' }.configureEach {\n  mustRunAfter(project(':arxd-rxd').tasks.matching { it.name.toLowerCase().contains('release') })\n}\n`;
    }
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    // RNGP and its CMake entry both use android/app/build by name. An alias
    // keeps those paths consistent while the actual App products live in target.
    const target = path.resolve(mod.modRequest.projectRoot, 'target/arxd/gradle/_app');
    const alias = path.join(mod.modRequest.platformProjectRoot, 'app/build');
    await fs.mkdir(target, { recursive: true });
    let existing;
    try { existing = await fs.lstat(alias); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.isSymbolicLink()) throw new Error('Generated App build directory is not an alias; rerun Expo prebuild --clean');
      if (path.resolve(path.dirname(alias), await fs.readlink(alias)) === target) return mod;
      await fs.unlink(alias);
    }
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return mod;
  }]);
};
