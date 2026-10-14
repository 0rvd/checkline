// For static hosting: writes config.js (public Supabase settings) next to index.html.
// Usage: node scripts/write-config.mjs   (reads .env or the environment). config.js is git-ignored.
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig } from './public-config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = join(root, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
const { config, warning } = publicConfig(process.env);
if (warning) console.warn(warning);
writeFileSync(join(root, 'config.js'), `window.CHECKLINE_CONFIG = ${JSON.stringify(config)};\n`);
console.log('Wrote config.js');
