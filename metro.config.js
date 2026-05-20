const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// supabase-js does an optional `import("@opentelemetry/api")` at runtime that
// Metro tries to statically resolve and fails on. Stub it with an empty module
// since we don't use OTEL on the client.
const EMPTY_MODULE = path.resolve(__dirname, 'src/lib/empty.js');

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@opentelemetry/api') {
    return { type: 'sourceFile', filePath: EMPTY_MODULE };
  }
  if (typeof originalResolveRequest === 'function') {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
