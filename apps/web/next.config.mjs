/** @type {import('next').NextConfig} */
export default {
  // The workspace packages are TypeScript source, not built output.
  transpilePackages: ['@fo/core', '@fo/db', '@fo/rag'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  webpack(config) {
    // The packages use ESM-style ".js" specifiers that resolve to ".ts" sources.
    // tsx handles this natively; webpack needs to be told.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
