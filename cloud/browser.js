import { upload } from '@vercel/blob/client';

window.NearbyCloud = true;
window.NearbyUpload = async (file, target, onProgress) => {
  async function post(path, data) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
    const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
  }
  const intent = await post('/api/upload-intent', { name: file.name, size: file.size, target });
  await upload(intent.pathname, file, { access: 'private', handleUploadUrl: '/api/upload', clientPayload: JSON.stringify({ id: intent.id }), multipart: file.size > 5 * 1024 * 1024, contentType: 'application/octet-stream', onUploadProgress: onProgress });
  // Completion is idempotent: retry a lost response without uploading the file again.
  for (let attempt = 0; ; attempt++) {
    try { await post('/api/upload-complete', { id: intent.id }); break; }
    catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
  }
};

// Short requests work across independent serverless invocations and survive cold starts.
window.NearbyEvents = class {
  listeners = new Map(); closed = false; snapshots = new Map();
  busy = false; refreshPending = false;
  constructor() { this.timer = setTimeout(() => this.poll(), 0); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  async poll() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('Connection unavailable');
      const state = await response.json(); if (this.closed) return;
      this.onopen?.(); this.emit('heartbeat', {});
      for (const type of ['groups', 'peers', 'history']) {
        const serialized = JSON.stringify(state[type]);
        if (this.snapshots.get(type) !== serialized) { this.snapshots.set(type, serialized); this.emit(type, state[type]); }
      }
      this.timer = setTimeout(() => this.poll(), this.refreshPending ? 0 : document.hidden ? 15000 : 3000);
      this.refreshPending = false;
    } catch { if (!this.closed) this.onerror?.(); }
    finally { this.busy = false; }
  }
  refresh() { if (this.closed) return; clearTimeout(this.timer); if (this.busy) this.refreshPending = true; else this.poll(); }
  close() { this.closed = true; clearTimeout(this.timer); }
};
