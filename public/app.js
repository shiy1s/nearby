const $ = s => document.querySelector(s);
let me, peers = [], target = 'all', items = [], events, uploading = false;
let groups = [];
let reconnectTimer, restoring = false, lastEvent = Date.now();
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(restoreConnection, 3000);
}
async function restoreConnection() {
  if (restoring) return;
  restoring = true;
  try {
    const response = await fetch('/api/me', { signal: AbortSignal.timeout(8000) });
    if (response.status === 401) {
      events?.close(); events = null; me = null;
      clearTimeout(reconnectTimer);
      $('#app-view').hidden = true; $('#join-view').hidden = false;
      $('#connection').textContent = 'Ready to pair';
      return;
    }
    if (!response.ok) throw Error('Host unavailable');
    enter(await response.json());
  } catch {
    $('#connection').textContent = 'Waiting for network…';
    scheduleReconnect();
  } finally { restoring = false; }
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 6000); }
async function api(path, data) { const r = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}); const result = await r.json(); if (!r.ok) throw Error(result.error); return result; }
function select(device) { target = device; renderPeers(); renderGroups(); renderFeed(); const group = groups.find(g => g.id === target); $('#target-title').textContent = group?.name || (target === 'all' ? 'Everyone' : peers.find(p => p.device === target)?.name || 'Offline device'); $('#target-subtitle').textContent = group ? `${group.members.length} members · Saved group` : target === 'all' ? 'Messages and files shared with the circle' : 'Only you and this device'; }
function renderGroups() {
  $('#groups').replaceChildren();
  for (const group of groups) {
    const button = document.createElement('button'); button.className = `peer${target === group.id ? ' selected' : ''}`;
    button.textContent = `◎ ${group.name}`; button.onclick = () => select(group.id); $('#groups').append(button);
  }
}
$('#create-group').onclick = () => {
  $('#group-form').hidden = false;
  $('#group-members').replaceChildren();
  const legend = document.createElement('legend'); legend.textContent = 'Include devices'; $('#group-members').append(legend);
  for (const peer of peers.filter(p => p.device !== me.device)) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = peer.device;
    label.append(input, document.createTextNode(peer.name + (peer.online ? '' : ' · offline'))); $('#group-members').append(label);
  }
  $('#group-name').focus();
};
$('#cancel-group').onclick = () => { $('#group-form').hidden = true; };
$('#group-form').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('[type=submit]'); button.disabled = true;
  try {
    const group = await api('/api/groups', { name: $('#group-name').value, members: [...document.querySelectorAll('#group-members input:checked')].map(i => i.value) });
    if (!groups.some(g => g.id === group.id)) groups.push(group);
    $('#group-form').reset(); $('#group-form').hidden = true; select(group.id); toast('Group saved. Members can find it in Saved groups.');
  } catch (err) { toast(err.message); } finally { button.disabled = false; }
};
function renderPeers() {
  $('#count').textContent = peers.length; $('#everyone').classList.toggle('selected', target === 'all'); $('#peers').replaceChildren();
  for (const p of peers.filter(p => p.device !== me.device)) {
    const b = document.createElement('button'); b.className = `peer${target === p.device ? ' selected' : ''}`;
    const icon = document.createElement('span'); icon.className = 'avatar'; icon.textContent = '▱';
    const label = document.createElement('span'); label.textContent = p.name;
    const sub = document.createElement('small'); sub.textContent = p.online ? 'Connected' : 'Paired · offline'; label.append(sub); b.append(icon, label); b.onclick = () => select(p.device); $('#peers').append(b);
  }
}
const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
function renderFeed() {
  const visible = items.filter(i => target === 'all' || target.startsWith('group-') ? i.target === target : !i.target.startsWith('group-') && i.target !== 'all' && (i.sender === target || i.target === target));
  $('#feed').replaceChildren();
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'empty'; const h = document.createElement('h3'); h.textContent = 'A small space to share.'; const p = document.createElement('p'); p.textContent = 'Send a message or use + to share files.'; empty.append(h,p); $('#feed').append(empty); }
  for (const i of visible) {
    const el = document.createElement('div'); el.className = `item${i.sender === me.device ? ' mine' : ''}`;
    const meta = document.createElement('small'); meta.textContent = `${i.sender === me.device ? 'You' : i.name} · ${new Date(i.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; el.append(meta);
    if (i.kind === 'message') { const p = document.createElement('p'); p.textContent = i.text; el.append(p); }
    else { const a = document.createElement('a'); a.href = `/api/files/${i.id}`; a.download = i.filename; a.textContent = `↓ ${i.filename} · ${size(i.size)}`; el.append(a); }
    $('#feed').append(el);
  }
  $('#feed').scrollTop = $('#feed').scrollHeight;
}
function enter(user) {
  clearTimeout(reconnectTimer);
  me = user; $('#join-view').hidden = true; $('#app-view').hidden = false; $('#my-name').textContent = `${me.name} · this device`;
  $('#address').textContent = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'Use the Wi-Fi address shown in the host terminal.' : location.origin;
  events?.close(); events = new (window.NearbyEvents || EventSource)('/api/events');
  lastEvent = Date.now();
  events.onopen = () => { lastEvent = Date.now(); $('#connection').textContent = window.NearbyCloud ? 'Live · connected online' : 'Live · connected locally'; };
  events.onerror = () => { events?.close(); $('#connection').textContent = 'Reconnecting…'; scheduleReconnect(); };
  events.addEventListener('heartbeat', () => { lastEvent = Date.now(); });
  events.addEventListener('groups', e => { groups = JSON.parse(e.data); renderGroups(); });
  events.addEventListener('peers', e => { peers = JSON.parse(e.data); renderPeers(); });
  events.addEventListener('history', e => { items = JSON.parse(e.data); renderFeed(); });
  events.addEventListener('item', e => { const item = JSON.parse(e.data); if (!items.some(i => i.id === item.id)) items.push(item); items = items.slice(-100); renderFeed(); if (item.sender !== me.device && item.target !== 'all' && target !== item.sender && target !== item.target) toast(`${item.name} sent you ${item.kind === 'file' ? 'a file' : 'a message'}. Open the matching device or group to view it.`); });
}
$('#join-form').onsubmit = async e => { e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; try { enter(await api('/api/join', { name: $('#name').value, code: $('#code').value.trim() })); } catch (err) { toast(err.message); } finally { button.disabled = false; } };
$('#everyone').onclick = () => select('all');
$('#send-form').onsubmit = async e => { e.preventDefault(); const text = $('#message').value; if (!text.trim()) return; $('#send').disabled = true; try { await api('/api/message', { target, text }); $('#message').value = ''; } catch (err) { toast(err.message); } finally { $('#send').disabled = false; } };
$('#message').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#send-form').requestSubmit(); } };
$('#file').onchange = async e => {
  if (uploading) return; const selected = [...e.target.files], destination = target; uploading = true; $('#file').disabled = true;
  try {
    for (const file of selected) if (file.size > 1024 ** 3) throw Error(`${file.name} exceeds the 1 GB limit.`);
    if (!selected.length) return;
    const loaded = selected.map(() => 0), total = selected.reduce((sum, f) => sum + f.size, 0), started = performance.now();
    let next = 0, completed = 0; const failures = [];
    const update = () => {
      const sent = loaded.reduce((sum, n) => sum + n, 0);
      const rate = sent / Math.max((performance.now() - started) / 1000, 0.1);
      $('#progress').value = total ? sent / total * 100 : completed / selected.length * 100;
      $('#transfer-label').textContent = `${completed}/${selected.length} files ready · ${size(sent)} / ${size(total)} · ${(rate / 1048576).toFixed(1)} MB/s${sent === total && completed < selected.length ? ' · Finishing…' : ''}`;
    };
    $('#transfer').hidden = false; update();
    async function worker() {
      while (next < selected.length) {
        const index = next++, file = selected[index];
        try {
          if (window.NearbyUpload) {
            await window.NearbyUpload(file, destination, event => { loaded[index] = event.loaded; update(); });
          } else {
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/upload?target=${encodeURIComponent(destination)}&name=${encodeURIComponent(file.name)}`);
            xhr.upload.onprogress = event => { if (event.lengthComputable) { loaded[index] = event.loaded; update(); } };
            xhr.onload = () => { if (xhr.status === 200) resolve(); else { let message = 'Upload failed.'; try { message = JSON.parse(xhr.responseText).error || message; } catch {} reject(Error(message)); } };
            xhr.onerror = () => reject(Error('Connection lost. Please retry this file.'));
            xhr.onabort = () => reject(Error('Upload cancelled.'));
            xhr.send(file);
          });
          }
          loaded[index] = file.size; completed++;
        } catch (err) { failures.push(`${file.name}: ${err.message}`); }
        update();
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, selected.length) }, () => worker()));
    toast(failures.length ? `${completed}/${selected.length} files shared. ${failures.join(' ')}` : 'Files shared. The recipient can now download them.');
  } catch (err) { toast(err.message); } finally { uploading = false; $('#file').disabled = false; $('#file').value = ''; $('#transfer').hidden = true; }
};
window.addEventListener('online', restoreConnection);
window.addEventListener('offline', () => { $('#connection').textContent = 'Waiting for network…'; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreConnection(); });
setInterval(() => { if (me && !document.hidden && Date.now() - lastEvent > 45000) restoreConnection(); }, 10000);
restoreConnection();

