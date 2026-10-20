const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// Arxd: release signing from ARXD_RELEASE_* properties.';
const SIGNING = `
${MARKER}
def arxdReleaseStoreFile = findProperty('ARXD_RELEASE_STORE_FILE') ?: System.getenv('ARXD_RELEASE_STORE_FILE')
def arxdReleaseStorePassword = findProperty('ARXD_RELEASE_STORE_PASSWORD') ?: System.getenv('ARXD_RELEASE_STORE_PASSWORD')
def arxdReleaseKeyAlias = findProperty('ARXD_RELEASE_KEY_ALIAS') ?: System.getenv('ARXD_RELEASE_KEY_ALIAS')
def arxdReleaseKeyPassword = findProperty('ARXD_RELEASE_KEY_PASSWORD') ?: System.getenv('ARXD_RELEASE_KEY_PASSWORD')
def arxdHasReleaseSigning = [arxdReleaseStoreFile, arxdReleaseStorePassword, arxdReleaseKeyAlias, arxdReleaseKeyPassword].every { it != null && !it.toString().trim().isEmpty() }
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') throw new Error('Release signing requires the Groovy app build file');
    let contents = mod.modResults.contents;
    if (!contents.includes(MARKER)) {
      const androidBlock = /^android \{/m;
      if (!androidBlock.test(contents)) throw new Error('App build file android block changed; review release signing');
      contents = contents.replace(androidBlock, `${SIGNING}\nandroid {`);

      const buildTypes = /^    buildTypes \{/m;
      if (!buildTypes.test(contents)) throw new Error('App build file buildTypes block changed; review release signing');
      contents = contents.replace(buildTypes, `    signingConfigs {
        if (arxdHasReleaseSigning) {
            release {
                storeFile file(arxdReleaseStoreFile)
                storePassword arxdReleaseStorePassword
                keyAlias arxdReleaseKeyAlias
                keyPassword arxdReleaseKeyPassword
            }
        }
    }
    buildTypes {`);

      const debugFallback = /\/\/ Caution! In production, you need to generate your own keystore file\.\n\s*\/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\n\s*signingConfig signingConfigs\.debug/;
      if (!debugFallback.test(contents)) throw new Error('Release signing fallback changed; review release signing');
      contents = contents.replace(debugFallback, `// Arxd: never fall back to the debug key for a release artifact.
            if (arxdHasReleaseSigning) {
                signingConfig signingConfigs.release
            }`);

      contents += `
// Arxd: refuse an unsigned release instead of silently producing one.
gradle.taskGraph.whenReady { graph ->
    if (!arxdHasReleaseSigning && graph.allTasks.any { it.name.toLowerCase().contains('release') }) {
        throw new GradleException('Release signing is not configured; set ARXD_RELEASE_STORE_FILE, ARXD_RELEASE_STORE_PASSWORD, ARXD_RELEASE_KEY_ALIAS and ARXD_RELEASE_KEY_PASSWORD')
    }
}
`;
    }
    mod.modResults.contents = contents;
    return mod;
  });
};
