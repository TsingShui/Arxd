// pi-ai 1.3 native host: API keys are supplied by the connection's encrypted
// store. Node environment/ADC discovery is unavailable in Android JavaScript.
export const ANTHROPIC_AUTH_TOKEN_ENV = 'ANTHROPIC_AUTH_TOKEN';
export const ANTHROPIC_OAUTH_TOKEN_ENV = 'ANTHROPIC_OAUTH_TOKEN';
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const ANTHROPIC_FEDERATION_RULE_ID_ENV = 'ANTHROPIC_FEDERATION_RULE_ID';
export const ANTHROPIC_ORGANIZATION_ID_ENV = 'ANTHROPIC_ORGANIZATION_ID';
export const ANTHROPIC_SERVICE_ACCOUNT_ID_ENV = 'ANTHROPIC_SERVICE_ACCOUNT_ID';
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = 'ANTHROPIC_IDENTITY_TOKEN_FILE';
export const ANTHROPIC_WORKSPACE_ID_ENV = 'ANTHROPIC_WORKSPACE_ID';
export function findEnvKeys() { return undefined; }
export function getEnvApiKey() { return undefined; }
