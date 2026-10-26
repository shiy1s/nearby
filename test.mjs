import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

test('LAN messaging, presence, file integrity and access controls', async () => {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), 'nearby-test-'));
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dataDir, PORT: '31987', JOIN_CODE: '123456' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = 'http://127.0.0.1:31987';
  const controllers = [];
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(Error('Startup timeout')), 5000).unref())]);
    async function join(name) { const r = await fetch(base + '/api/join', { method: 'POST', body: JSON.stringify({ name, code: '123456' }) }); assert.equal(r.status, 200); return { ...await r.json(), cookie: r.headers.get('set-cookie').split(';')[0] }; }
    async function request(user, path, data) { return fetch(base + path, { headers: { Cookie: user.cookie }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) }); }
    async function listen(user) {
      const controller = new AbortController(); controllers.push(controller);
      const r = await fetch(base + '/api/events', { headers: { Cookie: user.cookie }, signal: controller.signal });
      const received = []; let text = '';
      (async () => { try { for await (const chunk of r.body) { text += new TextDecoder().decode(chunk); let index; while ((index = text.indexOf('\n\n')) !== -1) { const event = text.slice(0, index); text = text.slice(index + 2); const data = event.split('\n').find(line => line.startsWith('data: ')); if (data) received.push(JSON.parse(data.slice(6))); } } } catch {} })();
      return received;
    }
    const a = await join('Laptop'), b = await join('Phone'), c = await join('Other laptop');
    const ae = await listen(a), be = await listen(b), ce = await listen(c);
    assert.equal((await fetch(base + '/api/me')).status, 401);
    assert.equal((await fetch(base + '/api/join', { method: 'POST', body: JSON.stringify({ name: 'Wrong', code: '000000' }) })).status, 401);
    assert.equal((await request(a, '/api/message', { target: b.device, text: 'hello phone' })).status, 200);
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const upload = await fetch(base + `/api/upload?target=${b.device}&name=test.bin`, { method: 'POST', headers: { Cookie: a.cookie }, body: bytes });
    assert.equal(upload.status, 200);
    assert.equal((await request(a, '/api/message', { target: 'all', text: 'hello everyone' })).status, 200);
    for (let i = 0; i < 100 && !be.some(e => e.kind === 'file'); i++) await new Promise(r => setTimeout(r, 20));
    assert(be.some(e => e.text === 'hello phone')); assert(ae.some(e => e.text === 'hello phone')); assert(!ce.some(e => e.text === 'hello phone'));
    const file = be.find(e => e.kind === 'file'); assert(file);
    const download = await request(b, '/api/files/' + file.id); assert.equal(download.status, 200); assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await request(c, '/api/files/' + file.id)).status, 403);
    assert.equal((await request(a, '/api/message', { target: 'missing', text: 'test' })).status, 409);
    assert.equal((await fetch(base + '/api/message', { method: 'POST', headers: { Cookie: a.cookie, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
    for (let i = 0; i < 100 && !ce.some(e => e.text === 'hello everyone'); i++) await new Promise(r => setTimeout(r, 20));
    assert(ce.some(e => e.text === 'hello everyone'));
    const created = await request(a, '/api/groups', { name: 'Family', members: [b.device] });
    assert.equal(created.status, 201); const group = await created.json();
    assert.equal((await (await request(b, '/api/groups')).json())[0].id, group.id);
    assert.deepEqual(await (await request(c, '/api/groups')).json(), []);
    assert.equal((await request(c, '/api/message', { target: group.id, text: 'intrusion' })).status, 403);
    assert.equal((await request(a, '/api/message', { target: group.id, text: 'family only' })).status, 200);
    assert.equal((await fetch(base + `/api/upload?target=${group.id}&name=group.bin`, { method: 'POST', headers: { Cookie: c.cookie }, body: bytes })).status, 403);
    assert.equal((await fetch(base + `/api/upload?target=${group.id}&name=group.bin`, { method: 'POST', headers: { Cookie: a.cookie }, body: bytes })).status, 200);
    for (let i = 0; i < 100 && !be.some(e => e.filename === 'group.bin'); i++) await new Promise(r => setTimeout(r, 20));
    assert(be.some(e => e.text === 'family only')); assert(!ce.some(e => e.text === 'family only'));
    const groupFile = be.find(e => e.filename === 'group.bin'); assert(groupFile);
    assert.equal((await request(c, '/api/files/' + groupFile.id)).status, 403);
    assert.equal((await request(b, '/api/files/' + groupFile.id)).status, 200);
    const large = Buffer.alloc(4 * 1024 * 1024, 173);
    await Promise.all([0, 1, 2].map(async index => {
      const result = await fetch(base + `/api/upload?target=${b.device}&name=parallel-${index}.bin`, { method: 'POST', headers: { Cookie: a.cookie }, body: large });
      assert.equal(result.status, 200);
    }));
    for (let i = 0; i < 100 && be.filter(e => e.filename?.startsWith('parallel-')).length < 3; i++) await new Promise(r => setTimeout(r, 20));
    const parallelFiles = be.filter(e => e.filename?.startsWith('parallel-'));
    assert.equal(parallelFiles.length, 3);
    await Promise.all(parallelFiles.map(async file => {
      const result = await request(b, '/api/files/' + file.id);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), large);
    }));
    assert.equal((await fetch(base)).status, 200);
  } finally { controllers.forEach(c => c.abort()); child.kill(); await once(child, 'exit'); await rm(dataDir, { recursive: true, force: true }); }
});

test('pairing survives host restart with the same identity and renewed cookie', async () => {
  const dataDir = await mkdtemp(pathJoin(tmpdir(), 'nearby-pairing-test-'));
  let child;
  async function start(code) {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dataDir, PORT: '31988', JOIN_CODE: code }, stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(Error('Startup timeout')), 5000).unref())]);
  }
  async function stop() { const exited = once(child, 'exit'); child.kill(); await exited; child = null; }
  try {
    await start('111111');
    const r = await fetch('http://127.0.0.1:31988/api/join', { method: 'POST', body: JSON.stringify({ name: 'Remembered phone', code: '111111' }) });
    assert.equal(r.status, 200);
    const user = await r.json(), cookie = r.headers.get('set-cookie').split(';')[0];
    assert.match(r.headers.get('set-cookie'), /Max-Age=34560000/);
    const groupResponse = await fetch('http://127.0.0.1:31988/api/groups', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ name: 'Permanent group', members: [] }) });
    assert.equal(groupResponse.status, 201); const savedGroup = await groupResponse.json();
    await stop(); await start('222222');
    const restoredGroups = await fetch('http://127.0.0.1:31988/api/groups', { headers: { Cookie: cookie } });
    assert.deepEqual(await restoredGroups.json(), [savedGroup]);
    const restored = await fetch('http://127.0.0.1:31988/api/me', { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), user);
    assert.match(restored.headers.get('set-cookie'), /Max-Age=34560000/);
    const controller = new AbortController();
    const events = await fetch('http://127.0.0.1:31988/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(events.status, 200); controller.abort();
    assert.equal((await fetch('http://127.0.0.1:31988/api/me', { headers: { Cookie: 'nearby=invalid' } })).status, 401);
  } finally { if (child) await stop(); await rm(dataDir, { recursive: true, force: true }); }
});
