import { createInterface } from 'node:readline/promises';
import assert from 'node:assert/strict';
import { put } from '@vercel/blob/client';

const base = process.argv[2];
if (!base || !base.startsWith('https://')) throw Error('Pass the hosted HTTPS origin.');
let code = process.env.NEARBY_SMOKE_CODE;
if (!code) {
  const input = createInterface({ input: process.stdin });
  console.log('Waiting for pairing code on stdin.');
  code = await input.question(''); input.close();
}
async function api(path, cookie, body) {
  const res = await fetch(base + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const value = await res.json();
  if (!res.ok) throw Error(`${path}: ${res.status} ${value.error}`);
  return { value, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const sender = await api('/api/join', null, { name: 'Verification sender', code });
const receiver = await api('/api/join', null, { name: 'Verification receiver', code });
const group = (await api('/api/groups', sender.cookie, { name: 'Verification group', members: [receiver.value.device] })).value;
await api('/api/message', sender.cookie, { target: group.id, text: 'Hosted messaging verification passed.' });
const bytes = Buffer.from('Nearby hosted file verification.\n');
const intent = (await api('/api/upload-intent', sender.cookie, { target: group.id, name: 'verification.txt', size: bytes.length })).value;
const token = (await api('/api/upload', sender.cookie, { type: 'blob.generate-client-token', payload: { pathname: intent.pathname, multipart: false, clientPayload: JSON.stringify({ id: intent.id }) } })).value;
await put(intent.pathname, bytes, { token: token.clientToken, access: 'private', contentType: 'application/octet-stream' });
await api('/api/upload-complete', sender.cookie, { id: intent.id });
const state = (await api('/api/state', receiver.cookie)).value;
assert(state.history.some(i => i.id === intent.id));
assert(state.history.some(i => i.text === 'Hosted messaging verification passed.'));
const download = await fetch(base + '/api/files/' + intent.id, { headers: { Cookie: receiver.cookie }, redirect: 'manual' });
assert.equal(download.status, 302);
const file = await fetch(download.headers.get('location')); assert.equal(file.status, 200);
assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
console.log('PASS: pairing, group message, private Blob upload, signed download, and exact file integrity.');
