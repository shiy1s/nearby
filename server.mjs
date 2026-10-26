import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const code = process.env.JOIN_CODE || String(randomInt(100000, 1000000));
const storage = await mkdtemp(join(tmpdir(), 'nearby-'));
const sessions = new Map(), files = new Map(), attempts = new Map();
const dataDir = process.env.DATA_DIR || join(root, '.nearby-data');
await mkdir(dataDir, { recursive: true });
const pairingPath = join(dataDir, 'devices.json');
try {
  for (const { token, device, name } of JSON.parse(await readFile(pairingPath, 'utf8'))) {
    sessions.set(token, { device, name, streams: new Set(), history: [], seen: Date.now() });
  }
} catch (err) { if (err.code !== 'ENOENT') throw err; }
let saveQueue = Promise.resolve();
function savePairings() {
  const snapshot = JSON.stringify([...sessions].map(([token, { device, name }]) => ({ token, device, name })));
  const write = saveQueue.catch(() => {}).then(async () => {
    await writeFile(pairingPath + '.tmp', snapshot, { mode: 0o600 });
    await rename(pairingPath + '.tmp', pairingPath);
  });
  saveQueue = write;
  return write;
}
const remember = (res, token) => res.setHeader('Set-Cookie', `nearby=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`);
const groups = new Map();
const groupPath = join(dataDir, 'groups.json');
try { for (const group of JSON.parse(await readFile(groupPath, 'utf8'))) groups.set(group.id, group); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
let groupQueue = Promise.resolve();
function saveGroups() {
  const snapshot = JSON.stringify([...groups.values()]);
  const result = groupQueue.catch(() => {}).then(async () => {
    await writeFile(groupPath + '.tmp', snapshot, { mode: 0o600 });
    await rename(groupPath + '.tmp', groupPath);
  });
  groupQueue = result; return result;
}
const myGroups = session => [...groups.values()].filter(g => g.members.includes(session.device));
function recipients(sender, target) {
  const group = groups.get(target);
  return group ? [...sessions.values()].filter(s => group.members.includes(s.device)) : target === 'all' ? online() : [sender, ...online().filter(s => s.device === target)];
}
const MAX = 1024 * 1024 * 1024, QUOTA = 5 * MAX;
let reserved = 0;
const id = () => randomBytes(24).toString('hex');
const online = () => [...sessions.values()].filter(s => s.streams.size);
const emit = (s, type, data) => { for (const stream of s.streams) stream.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
const presence = () => { const people = [...sessions.values()].map(({ device, name, streams }) => ({ device, name, online: streams.size > 0 })); for (const s of online()) emit(s, 'peers', people); };
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
async function json(req) {
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error('Request too large'); }
  return JSON.parse(body);
}
function deliver(sender, target, item) {
  for (const s of new Set(recipients(sender, target))) { s.history.push(item); s.history = s.history.slice(-100); emit(s, 'item', item); }
}
function targetExists(target) { return groups.has(target) || target === 'all' || online().some(s => s.device === target); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      return res.end(await readFile(join(root, 'public', name)));
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const address = req.socket.remoteAddress;
      const attempt = attempts.get(address) || { count: 0, start: Date.now() };
      if (Date.now() - attempt.start > 60000) { attempt.count = 0; attempt.start = Date.now(); }
      attempts.set(address, attempt);
      if (++attempt.count > 15) return send(res, 429, { error: 'Too many attempts. Wait one minute.' });
      const data = await json(req);
      if (data.code !== code) return send(res, 401, { error: 'That join code is incorrect.' });
      if (typeof data.name !== 'string' || !data.name.trim()) return send(res, 400, { error: 'Enter a device name.' });
      const token = id(), device = id();
      sessions.set(token, { device, name: data.name.trim().slice(0, 40), streams: new Set(), history: [], seen: Date.now() });
      try { await savePairings(); } catch (err) { sessions.delete(token); throw err; }
      remember(res, token);
      return send(res, 200, { device, name: sessions.get(token).name });
    }
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('nearby='))?.slice(7);
    const session = sessions.get(token);
    if (!session) return send(res, 401, { error: 'Join this network first.' });
    session.seen = Date.now();
    remember(res, token);
    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { device: session.device, name: session.name });
    if (req.method === 'GET' && url.pathname === '/api/groups') return send(res, 200, myGroups(session));
    if (req.method === 'POST' && url.pathname === '/api/groups') {
      const { name, members } = await json(req);
      const known = new Set([...sessions.values()].map(s => s.device));
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || !Array.isArray(members) || members.length > 100 || members.some(m => !known.has(m))) return send(res, 400, { error: 'Enter a group name and select paired devices.' });
      const group = { id: 'group-' + id(), name: name.trim(), members: [...new Set([session.device, ...members])], owner: session.device };
      groups.set(group.id, group);
      try { await saveGroups(); } catch (err) { groups.delete(group.id); throw err; }
      for (const s of online()) emit(s, 'groups', myGroups(s));
      return send(res, 201, group);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': connected\n\n'); session.streams.add(res);
      emit(session, 'groups', myGroups(session)); emit(session, 'history', session.history); presence();
      req.on('close', () => { session.streams.delete(res); session.seen = Date.now(); presence(); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/message') {
      const { target, text } = await json(req);
      if (groups.has(target) && !groups.get(target).members.includes(session.device)) return send(res, 403, { error: 'You are not a member of this group.' });
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) return send(res, 400, { error: 'Use a message between 1 and 4,000 characters.' });
      if (!targetExists(target)) return send(res, 409, { error: 'This device is offline.' });
      const item = { id: id(), kind: 'message', sender: session.device, name: session.name, target, text: text.trim(), time: Date.now() };
      deliver(session, target, item); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const target = url.searchParams.get('target'), name = (url.searchParams.get('name') || 'file').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180);
      if (groups.has(target) && !groups.get(target).members.includes(session.device)) return send(res, 403, { error: 'You are not a member of this group.' });
      const size = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX) return send(res, 413, { error: 'Maximum file size is 1 GB.' });
      if (reserved + size > QUOTA) return send(res, 507, { error: 'Host storage limit reached. Files expire after one hour.' });
      if (!targetExists(target)) return send(res, 409, { error: 'This device is offline.' });
      const fileId = id(), path = join(storage, fileId);
      const allowed = new Set(recipients(session, target).map(s => s.device));
      reserved += size;
      try {
        let received = 0;
        await pipeline(req, new Transform({ highWaterMark: 1024 * 1024, transform(chunk, enc, cb) { received += chunk.length; cb(received > size ? new Error('Upload exceeds declared size') : null, chunk); } }), createWriteStream(path, { flags: 'wx', highWaterMark: 1024 * 1024 }));
        if ((await stat(path)).size !== size) throw new Error('Incomplete upload');
      } catch (err) { reserved -= size; await rm(path, { force: true }); throw err; }
      files.set(fileId, { path, name, size, allowed, expires: Date.now() + 3600000 });
      deliver(session, target, { id: fileId, kind: 'file', sender: session.device, name: session.name, target, filename: name, size, time: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
      const file = files.get(url.pathname.slice('/api/files/'.length));
      if (!file || file.expires < Date.now()) return send(res, 404, { error: 'This file has expired.' });
      if (!file.allowed.has(session.device)) return send(res, 403, { error: 'This file was shared with another device.' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
      await pipeline(createReadStream(file.path, { highWaterMark: 1024 * 1024 }), res); return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) { if (!res.headersSent && !res.destroyed) send(res, 400, { error: 'Request failed. Please try again.' }); else res.destroy(); }
});
const timer = setInterval(async () => {
  for (const s of online()) emit(s, 'heartbeat', { time: Date.now() });
  for (const [key, file] of files) if (file.expires < Date.now()) { files.delete(key); reserved -= file.size; await rm(file.path, { force: true }).catch(() => {}); }
  for (const [key, a] of attempts) if (Date.now() - a.start > 60000) attempts.delete(key);
}, 20000);
server.requestTimeout = 0;
server.listen(port, '0.0.0.0', () => {
  console.log(`\nNearby is running. Join code: ${code}\nThis laptop: http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) for (const a of addresses || []) if (a.family === 'IPv4' && !a.internal) console.log(`Other devices: http://${a.address}:${port}`);
  console.log('Keep this window open. Press Ctrl+C to stop.\n');
});
async function stop() { clearInterval(timer); server.closeAllConnections(); server.close(); await rm(storage, { recursive: true, force: true }); process.exit(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
