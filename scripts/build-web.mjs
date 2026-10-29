// Builds the single-player Thulla page into one self-contained HTML file.
//   dist/index.html     full document: open it in a browser, or wrap it with Capacitor later
//   dist/artifact.html  the same page without <html>/<head>/<body>, for publishing as a Claude artifact
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = {
  bundle: true,
  write: false,
  platform: 'browser',
  target: ['es2019'],
  minify: true,
  legalComments: 'none',
  tsconfig: root + 'tsconfig.json',
  logLevel: 'warning',
};

const worker = await build({ ...common, entryPoints: [root + 'apps/web/src/botWorker.ts'], format: 'iife' });
const workerSource = worker.outputFiles[0].text;

const app = await build({
  ...common,
  entryPoints: [root + 'apps/web/src/main.ts'],
  format: 'iife',
  // The Nakama server key is public (every client sends it), but a server should not use the default.
  define: { BOT_WORKER_SOURCE: JSON.stringify(workerSource), NAKAMA_SERVER_KEY: JSON.stringify(process.env.NAKAMA_SERVER_KEY || 'defaultkey') },
});
// Keep "</script" sequences inside the bundle from closing the inline script tag.
const appSource = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const shell = readFileSync(root + 'apps/web/index.html', 'utf8');
const fragment = `${shell.trim()}\n<script>\n${appSource}</script>\n`;
const full =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  '</head>\n<body>\n' +
  fragment +
  '</body>\n</html>\n';

mkdirSync(root + 'dist', { recursive: true });
writeFileSync(root + 'dist/artifact.html', fragment);
writeFileSync(root + 'dist/index.html', full);
console.log(
  `Built dist/index.html (${(full.length / 1024).toFixed(0)} KB) and dist/artifact.html; bot worker ${(workerSource.length / 1024).toFixed(0)} KB`,
);
