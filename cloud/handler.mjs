import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const MAX_FILE = 1024 ** 3;
const LIFE = 24 * 60 * 60 * 1000;
const id = () => randomBytes(24).toString('hex');
const hash = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const key = suffix => `nearby:v1:${suffix}`;
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const cleanName = value => typeof value === 'string' ? value.trim().slice(0, 60) : '';

// Dependencies are injected so authorization and persistence can be tested without cloud credentials.
export function createHandler({ getRedis, blob, handleUpload, env = process.env }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try {
      if (!env.JOIN_CODE || env.JOIN_CODE.length < 16 || !(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL) || !(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN) || !env.BLOB_READ_WRITE_TOKEN) {
        return reply(503, { error: 'Hosting setup is incomplete. Configure the database, private Blob store, and a JOIN_CODE of at least 16 characters.' });
      }
      const redis = getRedis();
      const url = new URL(req.url, 'https://' + req.headers.host);
      const path = url.searchParams.has('route') ? '/api/' + url.searchParams.get('route') : url.pathname;
      if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}` && !(env.NODE_ENV !== 'production' && req.headers.origin === `http://${req.headers.host}`)) fail(403, 'Origin not allowed.');
      async function body() {
        if (req.body !== undefined) { const value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; if (JSON.stringify(value).length > 24000) fail(413, 'Request too large.'); return value; }
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 24000) fail(413, 'Request too large.'); }
        return JSON.parse(text);
      }
      async function limit(label, maximum, seconds) {
        const count = await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", [key('limit:' + label)], [seconds]);
        if (count > maximum) fail(429, 'Too many requests. Please try again later.');
      }
      const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('nearby='))?.slice(7);
      let session;
      async function authenticate() {
        if (session) return session;
        const device = cookie && await redis.get(key('session:' + hash(cookie)));
        session = device && await redis.hget(key('devices'), device);
        if (!session) fail(401, 'Pair this browser first.');
        res.setHeader('Set-Cookie', `nearby=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`);
        return session;
      }
      async function devices() { return Object.values(await redis.hgetall(key('devices')) || {}); }
      async function recipients(user, target) {
        if (target === 'all') return (await devices()).map(d => d.device);
        if (typeof target !== 'string') fail(400, 'Choose a recipient.');
        if (target.startsWith('group-')) {
          const group = await redis.hget(key('groups'), target);
          if (!group || !group.members.includes(user.device)) fail(403, 'You are not a member of this group.');
          return group.members;
        }
        if (!await redis.hget(key('devices'), target)) fail(404, 'Device not found.');
        return [...new Set([user.device, target])];
      }
      async function publish(item, allowed, transaction = redis.multi()) {
        for (const device of allowed) {
          transaction.zadd(key('history:' + device), { score: item.time, member: JSON.stringify(item) });
          transaction.zremrangebyrank(key('history:' + device), 0, -101);
        }
        await transaction.exec();
      }
      async function finishUpload(intentId) {
        const intent = await redis.get(key('file:' + intentId));
        if (!intent || intent.expires < Date.now()) fail(404, 'Upload expired.');
        if (intent.complete) return intent;
        const info = await blob.head(intent.pathname);
        if (info.pathname !== intent.pathname || info.size !== intent.size) fail(400, 'Uploaded file size does not match. Please retry.');
        intent.complete = true;
        const item = { id: intentId, kind: 'file', sender: intent.sender, name: intent.name, target: intent.target, filename: intent.filename, size: intent.size, time: intent.time, expires: intent.expires };
        // ZADD uses an identical serialized item on callback retries, so duplicate callbacks are harmless.
        await publish(item, intent.allowed, redis.multi().set(key('file:' + intentId), intent));
        return intent;
      }
      if (path === '/api/cleanup' && req.method === 'GET') {
        if (!env.CRON_SECRET || !same(req.headers.authorization || '', `Bearer ${env.CRON_SECRET}`)) fail(401, 'Unauthorized.');
        const expired = await redis.zrange(key('expiry'), 0, Date.now(), { byScore: true, offset: 0, count: 100 });
        for (const fileId of expired) {
          const file = await redis.get(key('file:' + fileId));
          if (file) await blob.del(file.pathname);
          await redis.multi().del(key('file:' + fileId)).zrem(key('expiry'), fileId).exec();
        }
        return reply(200, { removed: expired.length });
      }
      if (path === '/api/join' && req.method === 'POST') {
        const ip = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        await limit('join:' + hash(String(ip)), 10, 60);
        const data = await body();
        if (typeof data.code !== 'string' || !same(data.code, env.JOIN_CODE)) fail(401, 'That pairing code is incorrect.');
        const name = cleanName(data.name); if (!name) fail(400, 'Enter a device name.');
        const token = id(); const user = { device: id(), name };
        await redis.multi().hset(key('devices'), { [user.device]: user }).set(key('session:' + hash(token)), user.device).exec();
        res.setHeader('Set-Cookie', `nearby=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`);
        return reply(200, user);
      }
      if (path === '/api/upload' && req.method === 'POST') {
        const data = await body();
        const result = await handleUpload({ request: req, body: data,
          onBeforeGenerateToken: async (pathname, clientPayload) => {
            const user = await authenticate();
            const intentId = JSON.parse(clientPayload || '{}').id;
            const intent = await redis.get(key('file:' + intentId));
            if (!intent || intent.sender !== user.device || intent.pathname !== pathname || intent.complete || intent.expires < Date.now()) fail(403, 'Upload not authorized.');
            return { maximumSizeInBytes: intent.size, addRandomSuffix: false, allowOverwrite: false, validUntil: Date.now() + 3600000, tokenPayload: JSON.stringify({ id: intentId }) };
          },
          onUploadCompleted: async ({ tokenPayload }) => { await finishUpload(JSON.parse(tokenPayload).id); },
        });
        return reply(200, result);
      }
      const user = await authenticate();
      if (path === '/api/me' && req.method === 'GET') return reply(200, user);
      if (path === '/api/state' && req.method === 'GET') {
        await redis.set(key('presence:' + user.device), Date.now(), { ex: 40 });
        const [people, allGroups, history] = await Promise.all([devices(), redis.hgetall(key('groups')), redis.zrange(key('history:' + user.device), 0, -1)]);
        const presence = people.length ? await redis.mget(...people.map(p => key('presence:' + p.device))) : [];
        return reply(200, { peers: people.map((p, i) => ({ ...p, online: Boolean(presence[i]) })), groups: Object.values(allGroups || {}).filter(g => g.members.includes(user.device)), history: history.map(i => typeof i === 'string' ? JSON.parse(i) : i) });
      }
      if (path === '/api/groups' && req.method === 'POST') {
        await limit('groups:' + user.device, 10, 3600);
        const { name, members } = await body(); const title = cleanName(name);
        const known = new Set((await devices()).map(d => d.device));
        if (!title || !Array.isArray(members) || members.length > 100 || members.some(m => !known.has(m))) fail(400, 'Enter a name and select paired devices.');
        const group = { id: 'group-' + id(), name: title, owner: user.device, members: [...new Set([user.device, ...members])] };
        await redis.hset(key('groups'), { [group.id]: group }); return reply(201, group);
      }
      if (path === '/api/message' && req.method === 'POST') {
        await limit('message:' + user.device, 60, 60);
        const { target, text } = await body();
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) fail(400, 'Use a message between 1 and 4,000 characters.');
        const allowed = await recipients(user, target);
        await publish({ id: id(), kind: 'message', sender: user.device, name: user.name, target, text: text.trim(), time: Date.now() }, allowed);
        return reply(200, { ok: true });
      }
      if (path === '/api/upload-intent' && req.method === 'POST') {
        await limit('upload:' + user.device, 20, 3600);
        const data = await body();
        if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE || typeof data.name !== 'string') fail(400, 'Choose a nonempty file up to 1 GB.');
        const allowed = await recipients(user, data.target);
        const fileId = id(), filename = data.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'file';
        const file = { id: fileId, pathname: `nearby/${fileId}/${filename}`, filename, size: data.size, sender: user.device, name: user.name, target: data.target, allowed, time: Date.now(), expires: Date.now() + LIFE, complete: false };
        await redis.multi().set(key('file:' + fileId), file).zadd(key('expiry'), { score: file.expires, member: fileId }).exec();
        return reply(201, { id: fileId, pathname: file.pathname });
      }
      if (path === '/api/upload-complete' && req.method === 'POST') {
        const data = await body(); const file = await redis.get(key('file:' + data.id));
        if (!file || file.sender !== user.device) fail(403, 'Upload not authorized.');
        await finishUpload(data.id); return reply(200, { ok: true });
      }
      if (path.startsWith('/api/files/') && req.method === 'GET') {
        const file = await redis.get(key('file:' + path.slice('/api/files/'.length)));
        if (!file || !file.complete || file.expires < Date.now()) fail(404, 'This file is unavailable or expired. Ask the sender to share it again.');
        if (!file.allowed.includes(user.device)) fail(403, 'This file was shared with another device or group.');
        const validUntil = Math.min(file.expires, Date.now() + 3600000);
        const token = await blob.issueSignedToken({ pathname: file.pathname, operations: ['get'], validUntil });
        const { presignedUrl } = await blob.presignUrl(token, { operation: 'get', pathname: file.pathname, access: 'private', validUntil });
        res.statusCode = 302; res.setHeader('Location', blob.getDownloadUrl(presignedUrl)); res.end(); return;
      }
      return reply(404, { error: 'Not found.' });
    } catch (error) {
      if (!error.status) console.error('Nearby request failed', { code: error.code || error.name });
      return reply(error.status || 500, { error: error.status ? error.message : 'The cloud service could not complete this request. Please retry.' });
    }
  };
}
