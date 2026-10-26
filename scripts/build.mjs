import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
await Promise.all(['style.css', 'app.js'].map(name => copyFile(`public/${name}`, `dist/${name}`)));
let html = await readFile('public/index.html', 'utf8');
html = html.replace('<script src="/app.js" defer>', '<script src="/cloud.js" defer></script><script src="/app.js" defer>')
  .replaceAll('LOCAL NETWORK', 'PRIVATE CIRCLE').replaceAll('LAN ONLY', 'ONLINE')
  .replace('A little meeting place for devices on your Wi-Fi.', 'A private meeting place for your devices, on any network.')
  .replace('Send a thought. Share a file. Keep it local.', 'Send a thought. Share a file. Stay connected.')
  .replace('Network join code', 'Private pairing code').replace('Code shown on the host laptop', 'Enter your shared pairing code')
  .replace('Open this address on a device on the same Wi-Fi, then enter the host’s join code.', 'Open this address on any device with internet access, then enter your private pairing code.')
  .replace('Files up to 1 GB · Available for 1 hour · Keep the host running', 'Files up to 1 GB · Available for 24 hours · Internet required')
  .replace('LOCAL FIRST. SIMPLY CONNECTED.', 'ANY NETWORK. SIMPLY CONNECTED.');
await writeFile('dist/index.html', html);
await build({ entryPoints: ['cloud/browser.js'], bundle: true, outfile: 'dist/cloud.js', format: 'iife', minify: true, platform: 'browser', target: 'es2022' });
console.log('Vercel frontend built in dist/. Local mode is unchanged.');
