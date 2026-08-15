import { mkdir } from 'node:fs/promises';

import { build } from 'esbuild';

const pluginId = 'dsh-agent-mesh';

await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/dsh-plugin.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'lib/index.js',
  legalComments: 'none',
});
await build({
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'lib/client.js',
  external: ['react'],
  legalComments: 'none',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});
