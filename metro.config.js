const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.transformer.babelTransformerPath = require.resolve('./src/compat/babel-transformer.cjs');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = context.resolveRequest(context, moduleName, platform);
  if (platform === 'android' && result.type === 'sourceFile' &&
      result.filePath.replaceAll('\\', '/').endsWith('/@earendil-works/pi-ai/dist/auth/context.js')) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/compat/provider-auth-context.ts') };
  }
  if (platform === 'android' && result.type === 'sourceFile' &&
      result.filePath.replaceAll('\\', '/').endsWith('/@earendil-works/pi-ai/dist/env-api-keys.js')) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/compat/provider-env-keys.ts') };
  }
  return result;
};

module.exports = config;
