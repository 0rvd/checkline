// Minimal zero-dependency static server for Checkline.
// Usage: node scripts/serve.mjs [port]   (default 5173)
//
// Reads SUPABASE_URL / SUPABASE_ANON_KEY (and optional SUPABASE_JS_URL) from the environment or a
// local .env file and serves them to the browser as /config.js. Only public values are served;
// a secret / service-role key is refused. Dotfiles (.env, .git, ...) are never served.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig } from './public-config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = join(root, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const { config, warning } = publicConfig(process.env);
if (warning) console.warn(`\n[checkline] ${warning}\n`);
const configJs = `window.CHECKLINE_CONFIG = ${JSON.stringify(config)};\n`;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    if (path === '/config.js') {
      res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
      res.end(configJs);
      return;
    }
    // Never serve dotfiles or dependencies (protects .env and .git).
    if (path.split('/').some((seg) => seg.startsWith('.')) || path.startsWith('/node_modules/')) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => {
  console.log(`Checkline running at http://localhost:${port}`);
  console.log(config.supabaseUrl ? `Online play: Supabase project ${config.supabaseUrl}` : 'Online play: not configured (local and computer play only)');
});
