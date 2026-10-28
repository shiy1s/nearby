import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './handler.mjs';

class MemoryRedis {
  values = new Map();
  expirations = new Map();
  async get(k) { return structuredClone(this.values.get(k) ?? null); }
  async set(k, v, options) { this.values.set(k, structuredClone(v)); if (options?.ex) this.expirations.set(k, options.ex); return 'OK'; }
  async del(k) { return this.values.delete(k); }
  async hget(k, f) { return structuredClone(this.values.get(k)?.[f] ?? null); }
  async hgetall(k) { return structuredClone(this.values.get(k) ?? null); }
  async hset(k, obj) { this.values.set(k, { ...this.values.get(k), ...structuredClone(obj) }); }
  async mget(...keys) { return Promise.all(keys.map(k => this.get(k))); }
  async eval(script, keys) { const count = (this.values.get(keys[0]) || 0) + 1; this.values.set(keys[0], count); return count; }
  async zadd(k, entry) { const entries = this.values.get(k) || []; const previous = entries.find(e => e.member === entry.member); if (previous) previous.score = entry.score; else entries.push(structuredClone(entry)); entries.sort((a, b) => a.score - b.score); this.values.set(k, entries); }
  async zremrangebyrank(k, from, to) { const entries = this.values.get(k) || []; const end = to < 0 ? entries.length + to : to; if (end >= from) entries.splice(from, end - from + 1); }
  async zrange(k, from, to, options) { const entries = this.values.get(k) || []; return (options?.byScore ? entries.filter(e => e.score >= from && e.score <= to).slice(0, options.count) : entries.slice(from, to === -1 ? undefined : to + 1)).map(e => e.member); }
  async zrem(k, value) { this.values.set(k, (this.values.get(k) || []).filter(e => e.member !== value)); }
  multi() { const calls = []; const tx = { exec: async () => { for (const [method, args] of calls) await this[method](...args); } }; for (const method of ['hset', 'set', 'del', 'zadd', 'zrem', 'zremrangebyrank']) tx[method] = (...args) => { calls.push([method, args]); return tx; }; return tx; }
}

test('hosted pairing, offline groups, private uploads, expiry and cold starts', async () => {
  const redis = new MemoryRedis(), stored = new Map();
  const env = { JOIN_CODE: '123456', UPSTASH_REDIS_REST_URL: 'https://example.test', UPSTASH_REDIS_REST_TOKEN: 'test', BLOB_READ_WRITE_TOKEN: 'test', CRON_SECRET: 'cleanup-secret', NODE_ENV: 'production' };
  const blob = {
    head: async pathname => stored.get(pathname) || Promise.reject(Error('Missing blob')),
    del: async pathname => stored.delete(pathname),
    issueSignedToken: async options => { assert.deepEqual(options.operations, ['get']); assert(options.validUntil <= Date.now() + 300000); return options; },
    presignUrl: async (token, options) => { assert.equal(options.access, 'private'); assert.equal(token.pathname, options.pathname); return { presignedUrl: 'https://store.private.blob.vercel-storage.com/' + options.pathname + '?signed=1' }; },
    getDownloadUrl: url => url + '&download=1',
  };
  const handleUpload = async options => {
    if (options.body.type === 'callback') { await options.onUploadCompleted({ tokenPayload: JSON.stringify({ id: options.body.id }) }); return { ok: true }; }
    return options.onBeforeGenerateToken(options.body.pathname, JSON.stringify({ id: options.body.id }));
  };
  const dependencies = { getRedis: () => redis, blob, handleUpload, env };
  let handler = createHandler(dependencies);
  async function request(path, user, body, headers = {}) {
    const req = { url: path, method: body === undefined ? 'GET' : 'POST', headers: { host: 'nearby.example', ...(user ? { cookie: user.cookie } : {}), ...headers }, body };
    const result = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
    await handler(req, result); return result;
  }
  async function pair(name) { const r = await request('/api/join', null, { name, code: env.JOIN_CODE }); assert.equal(r.statusCode, 200); assert.match(r.headers['set-cookie'], /Secure/); return { ...r.body, cookie: r.headers['set-cookie'].split(';')[0] }; }
  const alice = await pair('Laptop'), bob = await pair('Phone'), outsider = await pair('Other');
  assert.equal((await request('/api/me')).statusCode, 401);
  assert.equal((await request('/api/message', alice, null)).statusCode, 400);
  assert.equal((await request('/api/message', alice, '{broken')).statusCode, 400);
  assert.equal((await request('/api/message', alice, [])).statusCode, 400);
  assert.equal((await request('/api/message', alice, { text: '🚀'.repeat(7000) })).statusCode, 413);
  assert.equal((await request('/api/me', alice, undefined, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await request('/api/me', null, undefined, { cookie: 'nearby=invalid' })).statusCode, 401);
  assert.equal([...redis.expirations.entries()].filter(([k, seconds]) => k.includes('session:') && seconds === 34560000).length, 3);
  const group = (await request('/api/groups', alice, { name: 'Family', members: [bob.device] })).body;
  assert.equal((await request('/api/message', outsider, { target: group.id, text: 'No access' })).statusCode, 403);
  assert.equal((await request('/api/message', alice, { target: group.id, text: 'Delivered while offline' })).statusCode, 200);
  handler = createHandler(dependencies);
  assert.equal((await request('/api/me', alice)).body.device, alice.device);
  const state = (await request('/api/state', bob)).body;
  assert.equal(state.groups[0].id, group.id); assert.equal(state.history[0].text, 'Delivered while offline');
  assert.deepEqual((await request('/api/state', outsider)).body.history, []);
  assert.deepEqual((await request('/api/state', outsider)).body.groups, []);
  assert.equal((await request('/api/message', alice, { target: 'all', text: 'forged' }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await request('/api/upload-intent', outsider, { target: group.id, name: 'secret.bin', size: 20 })).statusCode, 403);
  const intent = (await request('/api/upload-intent', alice, { target: group.id, name: 'secret.bin', size: 20 })).body;
  const auth = await request('/api/upload', alice, { id: intent.id, pathname: intent.pathname });
  assert.equal(auth.body.maximumSizeInBytes, 20); assert.equal(auth.body.allowOverwrite, false);
  assert.deepEqual(auth.body.allowedContentTypes, ['application/octet-stream']);
  assert.equal((await request('/api/upload', outsider, { id: intent.id, pathname: intent.pathname })).statusCode, 403);
  assert.equal((await request('/api/upload', alice, { id: intent.id, pathname: 'other/path' })).statusCode, 403);
  stored.set(intent.pathname, { pathname: intent.pathname, size: 19 });
  assert.equal((await request('/api/upload-complete', alice, { id: intent.id })).statusCode, 400);
  stored.set(intent.pathname, { pathname: intent.pathname, size: 20 });
  assert.equal((await request('/api/upload-complete', alice, { id: intent.id })).statusCode, 200);
  assert.equal((await request('/api/upload', null, { type: 'callback', id: intent.id })).statusCode, 200);
  assert.equal((await request('/api/state', bob)).body.history.filter(i => i.id === intent.id).length, 1);
  assert.equal((await request('/api/files/' + intent.id, outsider)).statusCode, 403);
  const download = await request('/api/files/' + intent.id, bob); assert.equal(download.statusCode, 302); assert.match(download.headers.location, /download=1/);
  const fileKey = 'nearby:v1:file:' + intent.id; const file = await redis.get(fileKey); file.expires = Date.now() - 1; await redis.set(fileKey, file);
  await redis.zadd('nearby:v1:expiry', { score: file.expires, member: intent.id });
  assert.equal((await request('/api/files/' + intent.id, bob)).statusCode, 404);
  assert.equal((await request('/api/cleanup')).statusCode, 401);
  assert.equal((await request('/api/cleanup', null, undefined, { authorization: 'Bearer ' + env.CRON_SECRET })).body.removed, 1);
  assert.equal(stored.has(intent.pathname), false);
  // Rewritten Vercel API requests reach the same endpoint.
  assert.equal((await request('/api/index?route=me', bob)).body.device, bob.device);
  const messageId = state.history[0].id;
  assert.equal((await request('/api/message/delete', outsider, { id: messageId, scope: 'everyone' })).statusCode, 404);
  assert.equal((await request('/api/message/delete', bob, { id: messageId, scope: 'everyone' })).statusCode, 403);
  assert.equal((await request('/api/message/delete', bob, { id: messageId, scope: 'me' })).statusCode, 200);
  assert(!(await request('/api/state', bob)).body.history.some(i => i.id === messageId));
  assert((await request('/api/state', alice)).body.history.some(i => i.id === messageId));
  assert.equal((await request('/api/message/delete', alice, { id: messageId, scope: 'everyone' })).statusCode, 200);
  handler = createHandler(dependencies);
  assert(!(await request('/api/state', alice)).body.history.some(i => i.id === messageId));
  assert.equal((await request('/api/message/delete', alice, { id: messageId, scope: 'bad' })).statusCode, 400);
  for (let n = 0; n < 10; n++) assert.equal((await request('/api/join', null, { name: 'Guess', code: 'wrong' }, { 'x-vercel-forwarded-for': 'test-attacker' })).statusCode, 401);
  const blocked = await request('/api/join', null, { name: 'Guess', code: env.JOIN_CODE }, { 'x-vercel-forwarded-for': 'test-attacker' });
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers['retry-after'], '60');
  // Simulate minute windows rolling over while preserving the hourly counter.
  for (let n = 0; n < 21; n++) {
    for (const k of redis.values.keys()) if (k.includes(':limit:join:')) redis.values.delete(k);
    const result = await request('/api/join', null, { name: 'Guess', code: 'wrong' }, { 'x-vercel-forwarded-for': 'test-attacker' });
    assert.equal(result.statusCode, n < 20 ? 401 : 429);
  }
});

test('hosted build fails closed when secrets are missing', async () => {
  const handler = createHandler({ env: {}, getRedis() { throw Error('Must not connect'); } });
  const res = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await handler({ headers: {} }, res);
  assert.equal(res.statusCode, 503); assert.match(res.body.error, /setup is incomplete/);
});
