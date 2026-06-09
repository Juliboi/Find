const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js ships an ESM build (dist/index.mjs) that does an optional
// `import(OTEL_PKG)` (OpenTelemetry) with a *dynamic* specifier. Hermes cannot
// compile a dynamic import() with a non-static argument, so production builds fail
// with "Invalid expression encountered".
//
// Expo SDK 54 enables Metro "package exports", so the `import` condition wins and
// the broken .mjs gets bundled. Force this one package (and its subpaths) to
// resolve via its CommonJS build (dist/index.cjs) — which uses a Hermes-safe
// require() — by turning package exports off just for it. Its main field already
// points at the CJS build.
const EMPTY_MODULE = path.resolve(__dirname, 'src/lib/empty.js');

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === '@supabase/supabase-js' ||
    moduleName.startsWith('@supabase/supabase-js/')
  ) {
    return context.resolveRequest(
      { ...context, unstable_enablePackageExports: false },
      moduleName,
      platform
    );
  }
  // Belt-and-suspenders: if anything statically pulls in OTEL, stub it out.
  if (moduleName === '@opentelemetry/api') {
    return { type: 'sourceFile', filePath: EMPTY_MODULE };
  }
  if (typeof originalResolveRequest === 'function') {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
