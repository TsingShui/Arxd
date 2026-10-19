const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Builds the CodeMode sidecar from source and adds its generated asset directory
 * to Android. The sidecar is not checked in: host.mjs and quickjs.wasm are
 * produced by scripts/build-codemode.mjs under target/ before packaging.
 */
module.exports = function withCodemode(config) {
  config = withAppBuildGradle(config, (mod) => {
    const marker = '// Arxd: Pi CodeMode Termux Node sidecar assets.';
    if (!mod.modResults.contents.includes(marker)) {
      mod.modResults.contents += `\n${marker}\ndef arxdCodemodeAssets = new File(rootProject.projectDir, "../../../target/arxd/codemode-assets")\nandroid {\n  sourceSets {\n    main {\n      assets.srcDirs += arxdCodemodeAssets\n    }\n  }\n}\ntasks.register("arxdBuildCodemode", Exec) {\n  workingDir new File(rootProject.projectDir, "..")\n  commandLine "node", "scripts/build-codemode.mjs"\n}\npreBuild.dependsOn("arxdBuildCodemode")\n`;
    }
    return mod;
  });
  return config;
};
