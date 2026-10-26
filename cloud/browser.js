import { upload } from '@vercel/blob/client';

window.NearbyCloud = true;
window.NearbyUpload = async (file, target, onProgress) => {
  async function post(path, data) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
  }
  const intent = await post('/api/upload-intent', { name: file.name, size: file.size, target });
  await upload(intent.pathname, file, { access: 'private', handleUploadUrl: '/api/upload', clientPayload: JSON.stringify({ id: intent.id }), multipart: file.size > 5 * 1024 * 1024, contentType: 'application/octet-stream', onUploadProgress: onProgress });
  await post('/api/upload-complete', { id: intent.id });
};

// Short requests work across independent serverless invocations and survive cold starts.
window.NearbyEvents = class {
  listeners = new Map(); closed = false; snapshots = new Map();
  constructor() { this.timer = setTimeout(() => this.poll(), 0); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  async poll() {
    if (this.closed) return;
    try {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('Connection unavailable');
      const state = await response.json(); if (this.closed) return;
      this.onopen?.(); this.emit('heartbeat', {});
      for (const type of ['groups', 'peers', 'history']) {
        const serialized = JSON.stringify(state[type]);
        if (this.snapshots.get(type) !== serialized) { this.snapshots.set(type, serialized); this.emit(type, state[type]); }
      }
      this.timer = setTimeout(() => this.poll(), document.hidden ? 15000 : 3000);
    } catch { if (!this.closed) this.onerror?.(); }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
};
