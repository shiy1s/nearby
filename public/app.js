const $ = selector => document.querySelector(selector);
let me, peers = [], target = 'all', items = [], events, uploading = false, groups = [];
let createAfterJoin = false, activeFilter = 'all';
const unread = new Map();
let knownItems = new Set(), historyLoaded = false;
let reconnectTimer, restoring = false, lastEvent = Date.now();

const initials = value => String(value || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
const formatTime = time => {
  if (!time) return '';
  const date = new Date(time);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const appShell = () => $('.app-shell');

$('#header-create').onclick = () => {
  if (me) openGroupForm();
  else { createAfterJoin = true; $('#name').focus(); toast('Join your circle first. You can create a group right after pairing.'); }
};
$('#create-group').onclick = openGroupForm;
$('#cancel-group').onclick = () => { $('#group-form').hidden = true; };

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
async function api(path, data) {
  const response = await fetch(path, data ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  } : {});
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw Error(result.error || 'Something went wrong. Please try again.');
  return result;
}
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
      appShell()?.classList.remove('chat-open');
      $('#app-view').hidden = true;
      $('#join-view').hidden = false;
      $('#connection').textContent = 'Ready to pair';
      return;
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw Error(result.error || 'Service unavailable. Retrying…');
    }
    enter(await response.json());
  } catch (error) {
    $('#connection').textContent = 'Reconnecting…';
    if (error.message && !/fetch|timeout|abort/i.test(error.message)) toast(error.message);
    scheduleReconnect();
  } finally { restoring = false; }
}

function conversation(item) {
  if (item.target === 'all' || item.target.startsWith('group-')) return item.target;
  return item.sender === me.device ? item.target : item.sender;
}
function receive(item) {
  if (knownItems.has(item.id)) return;
  knownItems.add(item.id);
  const channel = conversation(item);
  if (item.sender !== me.device && channel !== target) {
    unread.set(channel, (unread.get(channel) || 0) + 1);
    toast(`${item.name} sent ${item.kind === 'file' ? 'a file' : 'a message'}.`);
  }
}
function itemsFor(channel) {
  if (channel === 'all' || channel.startsWith('group-')) return items.filter(item => item.target === channel);
  return items.filter(item =>
    !item.target.startsWith('group-') && item.target !== 'all' &&
    ((item.sender === me.device && item.target === channel) ||
     (item.sender === channel && item.target === me.device))
  );
}
function latestFor(channel) {
  return itemsFor(channel).reduce((latest, item) => !latest || item.time > latest.time ? item : latest, null);
}
function previewFor(item) {
  if (!item) return 'Start a conversation';
  const sender = item.sender === me.device ? 'You: ' : '';
  return item.kind === 'file' ? `${sender}📎 ${item.filename}` : sender + item.text.replace(/\s+/g, ' ');
}
function makeAvatar(label, kind = '') {
  const avatar = document.createElement('span');
  avatar.className = `conversation-avatar ${kind}`;
  avatar.textContent = kind === 'everyone' ? '◎' : kind === 'group' ? '♧' : initials(label);
  if (kind === 'person') {
    const peer = peers.find(person => person.name === label);
    if (peer?.online) {
      const dot = document.createElement('i');
      dot.className = 'online-dot';
      dot.setAttribute('aria-label', 'Online');
      avatar.append(dot);
    }
  }
  return avatar;
}
function makeSection(label) {
  const section = document.createElement('div');
  section.className = 'conversation-section';
  section.textContent = label;
  $('#conversation-list').append(section);
}
function makeConversationRow(entry) {
  const row = document.createElement('div');
  row.className = `conversation-row${target === entry.id ? ' selected' : ''}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'conversation-open';
  open.setAttribute('aria-pressed', String(target === entry.id));
  open.setAttribute('aria-label', `Open ${entry.name}`);
  open.onclick = () => select(entry.id);
  open.append(makeAvatar(entry.name, entry.kind));

  const copy = document.createElement('span');
  copy.className = 'conversation-copy';
  const top = document.createElement('span');
  top.className = 'conversation-topline';
  const name = document.createElement('strong');
  name.textContent = entry.name;
  const time = document.createElement('time');
  time.className = 'conversation-time';
  time.textContent = entry.last ? formatTime(entry.last.time) : '';
  top.append(name, time);

  const bottom = document.createElement('span');
  bottom.className = 'conversation-bottomline';
  const preview = document.createElement('span');
  preview.className = 'conversation-preview';
  preview.textContent = entry.preview;
  bottom.append(preview);
  if (entry.unread) {
    const badge = document.createElement('span');
    badge.className = 'unread-count';
    badge.textContent = entry.unread > 99 ? '99+' : String(entry.unread);
    bottom.append(badge);
  }
  copy.append(top, bottom);
  open.append(copy);
  row.append(open);
  if (entry.kind === 'person') {
    const actions = document.createElement('div');
    actions.className = 'device-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'device-menu-toggle';
    toggle.textContent = '⋮';
    toggle.setAttribute('aria-label', `More options for ${entry.name}`);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = event => {
      event.stopPropagation();
      const menu = actions.querySelector('.device-menu');
      const opening = menu.hidden;
      document.querySelectorAll('.device-menu').forEach(item => { item.hidden = true; });
      document.querySelectorAll('.device-menu-toggle').forEach(item => item.setAttribute('aria-expanded', 'false'));
      menu.hidden = !opening;
      toggle.setAttribute('aria-expanded', String(opening));
    };
    const menu = document.createElement('div');
    menu.className = 'device-menu';
    menu.hidden = true;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'device-delete';
    remove.textContent = me?.isAdmin ? 'Delete device' : 'Delete device · Admin only';
    remove.disabled = !me?.isAdmin;
    remove.title = me?.isAdmin ? 'Remove this paired device' : 'Only the administrator can remove devices';
    remove.onclick = async event => {
      event.stopPropagation();
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (!me?.isAdmin) return;
      if (!confirm(`Remove “${entry.name}” from your Nearby circle? Their pairing will stop working and their direct-chat history will be removed.`)) return;
      remove.disabled = true;
      try {
        await api('/api/devices/delete', { device: entry.id });
        peers = peers.filter(person => person.device !== entry.id);
        unread.delete(entry.id);
        if (target === entry.id) select('all');
        renderConversations();
        events?.refresh?.();
        toast(`${entry.name} was removed from your circle.`);
      } catch (error) {
        toast(error.message);
        remove.disabled = false;
      }
    };
    menu.append(remove);
    actions.append(toggle, menu);
    row.append(actions);
  }
  $('#conversation-list').append(row);
}
function renderConversations() {
  const list = $('#conversation-list');
  list.replaceChildren();
  const people = peers.filter(person => person.device !== me.device);
  const entries = [
    { id: 'all', name: 'Everyone', kind: 'everyone', last: latestFor('all'), unread: unread.get('all') || 0 }
  ];
  for (const person of people) {
    const last = latestFor(person.device);
    entries.push({ id: person.device, name: person.name, kind: 'person', last, unread: unread.get(person.device) || 0, online: person.online });
  }
  for (const group of groups) {
    const last = latestFor(group.id);
    entries.push({ id: group.id, name: group.name, kind: 'group', last, unread: unread.get(group.id) || 0, members: group.members.length });
  }
  for (const entry of entries) entry.preview = previewFor(entry.last);

  const query = $('#chat-search').value.trim().toLocaleLowerCase();
  let filtered = entries.filter(entry => {
    if (activeFilter === 'unread' && !entry.unread) return false;
    if (activeFilter === 'groups' && entry.kind !== 'group') return false;
    return !query || entry.name.toLocaleLowerCase().includes(query) || entry.preview.toLocaleLowerCase().includes(query);
  });
  const pinned = filtered.filter(entry => entry.kind === 'everyone');
  const direct = filtered.filter(entry => entry.kind === 'person').sort((a, b) => (b.last?.time || 0) - (a.last?.time || 0) || a.name.localeCompare(b.name));
  const savedGroups = filtered.filter(entry => entry.kind === 'group').sort((a, b) => (b.last?.time || 0) - (a.last?.time || 0) || a.name.localeCompare(b.name));
  if (pinned.length) {
    makeSection('Circle');
    pinned.forEach(makeConversationRow);
  }
  if (direct.length) {
    makeSection('People');
    direct.forEach(makeConversationRow);
  }
  if (savedGroups.length) {
    makeSection('Groups');
    savedGroups.forEach(makeConversationRow);
  }
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = query ? 'No conversations match your search.' : activeFilter === 'unread' ? 'You’re all caught up.' : 'No conversations here yet.';
    list.append(empty);
  }
}
function select(device) {
  target = device;
  unread.delete(device);
  const group = groups.find(item => item.id === target);
  const person = peers.find(item => item.device === target);
  const title = group?.name || (target === 'all' ? 'Everyone' : person?.name || 'Device');
  $('#target-title').textContent = title;
  $('#target-subtitle').textContent = group
    ? `${group.members.length} members · Group conversation`
    : target === 'all'
      ? `${peers.filter(person => person.device !== me.device).length} paired devices in your circle`
      : person?.online ? 'Online · Direct conversation' : 'Paired device · Currently offline';
  $('#chat-avatar').textContent = target === 'all' ? '◎' : group ? '♧' : initials(title);
  $('#chat-security-label').textContent = group ? 'PRIVATE GROUP' : 'PRIVATE CHAT';
  renderConversations();
  renderFeed(true);
  appShell()?.classList.add('chat-open');
  // Keep mobile keyboards closed until the user taps the composer.
}

function openGroupForm() {
  $('#group-form').hidden = false;
  $('#group-members').replaceChildren();
  const legend = document.createElement('legend');
  legend.textContent = 'Add people';
  $('#group-members').append(legend);
  const available = peers.filter(person => person.device !== me.device);
  if (!available.length) {
    const note = document.createElement('small');
    note.textContent = 'Pair another device before creating a group.';
    $('#group-members').append(note);
  }
  for (const person of available) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = person.device;
    const name = document.createTextNode(person.name + (person.online ? '' : ' · offline'));
    label.append(input, name);
    $('#group-members').append(label);
  }
  $('#group-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#group-name').focus();
}
$('#group-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.target.querySelector('[type=submit]');
  button.disabled = true;
  try {
    const group = await api('/api/groups', {
      name: $('#group-name').value,
      members: [...document.querySelectorAll('#group-members input:checked')].map(input => input.value)
    });
    if (!groups.some(existing => existing.id === group.id)) groups.push(group);
    $('#group-form').reset();
    $('#group-form').hidden = true;
    renderConversations();
    select(group.id);
    toast('Group created. Your members can find it in Chats.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('#chat-search').addEventListener('input', renderConversations);
$('#chat-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  $('#chat-filters').querySelectorAll('[data-filter]').forEach(chip => {
    const active = chip === button;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  renderConversations();
});
$('#back-to-chats').onclick = () => appShell()?.classList.remove('chat-open');

function appendMessageText(container, text) {
  const value = String(text ?? '');
  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  let cursor = 0;

  for (const match of value.matchAll(urlPattern)) {
    let urlText = match[0].replace(/[.,!?;:]+$/, '');
    while (urlText.endsWith(')') && (urlText.match(/\)/g) || []).length > (urlText.match(/\(/g) || []).length) {
      urlText = urlText.slice(0, -1);
    }
    if (!urlText) continue;

    const start = match.index;
    if (start > cursor) container.append(document.createTextNode(value.slice(cursor, start)));

    const href = /^www\./i.test(urlText) ? `https://${urlText}` : urlText;
    let parsed;
    try { parsed = new URL(href); } catch {}
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.includes('.')) {
      const link = document.createElement('a');
      link.className = 'message-link';
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = urlText;
      link.setAttribute('aria-label', `Open link: ${urlText}`);
      container.append(link);
    } else {
      container.append(document.createTextNode(urlText));
    }
    cursor = start + urlText.length;
  }

  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

function renderFeed(forceBottom = false) {
  const feed = $('#feed');
  const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  const visible = itemsFor(target).sort((a, b) => a.time - b.time);
  feed.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.textContent = '✳';
    const heading = document.createElement('h3');
    heading.textContent = 'Your conversation starts here';
    const message = document.createElement('p');
    message.textContent = 'Send a message or attach a file to get things moving.';
    empty.append(icon, heading, message);
    feed.append(empty);
  }
  for (const item of visible) {
    const bubble = document.createElement('article');
    bubble.className = `item${item.sender === me.device ? ' mine' : ''}`;
    const meta = document.createElement('small');
    meta.textContent = `${item.sender === me.device ? 'You' : item.name} · ${formatTime(item.time)}`;
    bubble.append(meta);
    if (item.kind === 'message') {
      const message = document.createElement('p');
      appendMessageText(message, item.text);
      bubble.append(message);

      const menu = document.createElement('div');
      menu.className = 'message-menu';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'menu-toggle';
      toggle.setAttribute('aria-label', 'Message options');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = '⋮';
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      actions.hidden = true;
      toggle.onclick = click => {
        click.stopPropagation();
        document.querySelectorAll('.message-actions').forEach(other => { if (other !== actions) other.hidden = true; });
        actions.hidden = !actions.hidden;
        toggle.setAttribute('aria-expanded', String(!actions.hidden));
      };
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy message';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(item.text); toast('Message copied.'); actions.hidden = true; }
        catch { toast('Could not copy this message.'); }
      };
      actions.append(copy);
      for (const scope of item.sender === me.device ? ['me', 'everyone'] : ['me']) {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = scope === 'me' ? 'Delete for me' : 'Delete for everyone';
        action.onclick = async () => {
          const prompt = scope === 'me' ? 'Remove this message from your conversation?' : 'Delete this message for everyone? This cannot be undone.';
          if (!confirm(prompt)) return;
          action.disabled = true;
          try {
            await api('/api/message/delete', { id: item.id, scope });
            items = items.filter(existing => existing.id !== item.id);
            renderConversations();
            renderFeed();
            events?.refresh?.();
            toast(scope === 'me' ? 'Message deleted for you.' : 'Message deleted for everyone.');
          } catch (error) { toast(error.message); action.disabled = false; }
        };
        actions.append(action);
      }
      menu.append(toggle, actions);
      bubble.append(menu);
    } else {
      const expired = item.expires && item.expires <= Date.now();
      const link = document.createElement(expired ? 'span' : 'a');
      if (!expired) {
        link.href = `/api/files/${encodeURIComponent(item.id)}`;
        link.download = item.filename;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      link.textContent = `${expired ? 'Expired · ' : '↓ Download · '}${item.filename} · ${size(item.size)}`;
      bubble.append(link);
    }
    feed.append(bubble);
  }
  if (forceBottom || wasNearBottom) feed.scrollTop = feed.scrollHeight;
}
document.addEventListener('click', () => {
  document.querySelectorAll('.device-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.device-menu-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('.message-actions').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.menu-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
});

function enter(user) {
  clearTimeout(reconnectTimer);
  me = user;
  historyLoaded = false;
  knownItems = new Set();
  unread.clear();
  $('#join-view').hidden = true;
  $('#app-view').hidden = false;
  $('#my-name').textContent = `${me.name} · this device`;
  $('#my-avatar').textContent = initials(me.name);
  $('#connection').textContent = 'Connecting…';
  target = 'all';
  $('#target-title').textContent = 'Everyone';
  $('#target-subtitle').textContent = 'Messages shared with your circle';
  $('#chat-avatar').textContent = '◎';
  $('#chat-search').value = '';
  activeFilter = 'all';
  $('#chat-filters').querySelectorAll('[data-filter]').forEach(chip => {
    const active = chip.dataset.filter === 'all';
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  appShell()?.classList.remove('chat-open');
  events?.close();
  events = new (window.NearbyEvents || EventSource)('/api/events');
  lastEvent = Date.now();
  events.onopen = () => {
    lastEvent = Date.now();
    $('#connection').textContent = window.NearbyCloud ? 'Connected online' : 'Connected locally';
  };
  events.onerror = () => {
    events?.close();
    $('#connection').textContent = 'Reconnecting…';
    scheduleReconnect();
  };
  events.addEventListener('heartbeat', () => { lastEvent = Date.now(); });
  events.addEventListener('groups', event => {
    groups = JSON.parse(event.data);
    renderConversations();
    if (createAfterJoin) { createAfterJoin = false; openGroupForm(); }
  });
  events.addEventListener('peers', event => {
    peers = JSON.parse(event.data);
    renderConversations();
  });
  events.addEventListener('history', event => {
    items = JSON.parse(event.data);
    if (historyLoaded) items.forEach(receive);
    else { knownItems = new Set(items.map(item => item.id)); historyLoaded = true; }
    renderConversations();
    renderFeed();
  });
  events.addEventListener('item', event => {
    const item = JSON.parse(event.data);
    receive(item);
    if (!items.some(existing => existing.id === item.id)) items.push(item);
    items = items.slice(-100);
    renderConversations();
    renderFeed();
  });
}
$('#join-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.target.querySelector('[type=submit]');
  button.disabled = true;
  try {
    enter(await api('/api/join', { name: $('#name').value, code: $('#code').value.trim() }));
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('#send-form').onsubmit = async event => {
  event.preventDefault();
  if ($('#send').disabled) return;
  const text = $('#message').value;
  const destination = target;
  if (!text.trim()) return;
  $('#send').disabled = true;
  try {
    await api('/api/message', { target: destination, text });
    if ($('#message').value === text && target === destination) $('#message').value = '';
    events?.refresh?.();
  } catch (error) { toast(error.message); }
  finally { $('#send').disabled = false; $('#message').focus(); }
};
$('#message').addEventListener('input', () => {
  const field = $('#message');
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 130)}px`;
});
$('#message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#send-form').requestSubmit();
  }
};

$('#file').onchange = async event => {
  if (uploading) return;
  const selected = [...event.target.files];
  const destination = target;
  uploading = true;
  $('#file').disabled = true;
  $('#transfer-result').hidden = true;
  try {
    for (const file of selected) if (file.size > 1024 ** 3) throw Error(`${file.name} exceeds the 1 GB limit.`);
    if (!selected.length) return;
    const loaded = selected.map(() => 0);
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    const started = performance.now();
    let next = 0, completed = 0;
    const failures = [];
    const update = () => {
      const sent = loaded.reduce((sum, value) => sum + value, 0);
      const rate = sent / Math.max((performance.now() - started) / 1000, .1);
      $('#progress').value = total ? sent / total * 100 : completed / selected.length * 100;
      $('#transfer-label').textContent = `${completed}/${selected.length} files ready · ${size(sent)} / ${size(total)} · ${(rate / 1048576).toFixed(1)} MB/s${sent === total && completed < selected.length ? ' · Finishing…' : ''}`;
    };
    $('#transfer').hidden = false;
    update();
    async function worker() {
      while (next < selected.length) {
        const index = next++;
        const file = selected[index];
        try {
          if (window.NearbyUpload) {
            await window.NearbyUpload(file, destination, progress => { loaded[index] = progress.loaded; update(); });
          } else {
            await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', `/api/upload?target=${encodeURIComponent(destination)}&name=${encodeURIComponent(file.name)}`);
              xhr.upload.onprogress = progress => { if (progress.lengthComputable) { loaded[index] = progress.loaded; update(); } };
              xhr.onload = () => {
                if (xhr.status === 200) resolve();
                else {
                  let message = 'Upload failed.';
                  try { message = JSON.parse(xhr.responseText).error || message; } catch {}
                  reject(Error(message));
                }
              };
              xhr.onerror = () => reject(Error('Connection lost. Please retry this file.'));
              xhr.onabort = () => reject(Error('Upload cancelled.'));
              xhr.send(file);
            });
          }
          loaded[index] = file.size;
          completed++;
        } catch (error) { failures.push(`${file.name}: ${error.message}`); }
        update();
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, selected.length) }, () => worker()));
    const summary = failures.length
      ? `${completed}/${selected.length} files shared. Retry failed files: ${failures.join(' ')}`
      : 'Files shared. Open this conversation on the receiving device to download them.';
    $('#transfer-result').textContent = summary;
    $('#transfer-result').hidden = false;
    toast(summary);
    events?.refresh?.();
  } catch (error) { toast(error.message); }
  finally {
    uploading = false;
    $('#file').disabled = false;
    $('#file').value = '';
    $('#transfer').hidden = true;
  }
};

document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && me) {
    event.preventDefault();
    $('#chat-search').focus();
  }
});
window.addEventListener('online', restoreConnection);
window.addEventListener('offline', () => { $('#connection').textContent = 'Waiting for network…'; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreConnection(); });
setInterval(() => {
  if (me && !document.hidden && Date.now() - lastEvent > 45000) restoreConnection();
}, 10000);
window.addEventListener('beforeunload', event => {
  if (uploading) { event.preventDefault(); event.returnValue = ''; }
});
restoreConnection();
