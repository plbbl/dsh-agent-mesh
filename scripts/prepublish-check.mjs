import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const requiredFiles = [
  packageJson.main,
  packageJson.exports['.'].default,
  packageJson.exports['./client'].default,
  packageJson.exports['./cli'].default,
  packageJson.dsh.bundle.patch,
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
];

const missing = requiredFiles.filter((relativePath) => !existsSync(join(root, relativePath)));
if (missing.length) {
  console.error(`Missing release files:\n${missing.map((file) => `- ${file}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`dsh-agent-mesh ${packageJson.version}: release files present`);
}
