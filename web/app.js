const $ = (selector) => document.querySelector(selector);
const state = { session: null, pending: false };
const loginView = $('#login-view');
const chatView = $('#chat-view');
const list = $('#message-list');
const input = $('#message-input');

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.message || data?.error || 'Request failed');
  return data;
}

function renderMessage(message, options = {}) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  if (options.pending) article.classList.add('message-pending');
  if (options.id) article.id = options.id;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = message.role === 'user' ? ($('#user-initials').textContent || 'ME') : 'CST';
  const body = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.text;
  body.appendChild(bubble);
  (message.media || []).filter(Boolean).forEach((url) => { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Open attached media'; link.className = 'media-link'; body.appendChild(link); });
  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date(message.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  body.appendChild(time);
  article.append(avatar, body);
  list.appendChild(article);
  return article;
}

/** Set the composer to pending (disabled) or idle (enabled). */
function setComposerPending(pending) {
  state.pending = pending;
  const sendButton = $('#send-button');
  const typingState = $('#typing-state');
  const form = $('#message-form');
  sendButton.disabled = pending;
  input.disabled = pending;
  if (pending) {
    input.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    typingState.classList.remove('hidden');
    typingState.setAttribute('aria-live', 'assertive');
  } else {
    input.removeAttribute('aria-busy');
    form.removeAttribute('aria-busy');
    typingState.classList.add('hidden');
  }
}

function setSession(session) {
  state.session = session;
  $('#tenant-name').textContent = session.tenant.name;
  $('#project-name').textContent = session.project.name;
  $('#user-name').textContent = session.user.name;
  $('#user-role').textContent = session.user.role;
  $('#user-initials').textContent = session.user.name.split(' ').map((part) => part[0]).join('').slice(0, 2);
  $('#scope-label').textContent = `${session.farm_count} farm${session.farm_count === 1 ? '' : 's'} in scope`;
  $('#welcome-name').textContent = session.user.name.toUpperCase();
  $('#farm-count').textContent = session.farm_count;
  $('#farm-count-badge').textContent = session.farm_count;
  $('#farm-list').replaceChildren(...(session.farms || []).map((farmId) => { const item = document.createElement('div'); item.className = 'farm-row'; item.innerHTML = `<span class="farm-icon">⌁</span><span><strong>${farmId.replaceAll('_', ' ')}</strong><small>Verified resource scope</small></span><span class="farm-status">Active</span>`; return item; }));
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
}

function showView(view) {
  const views = { overview: $('#overview-view'), chat: $('#chat-view-panel'), activity: $('#activity-view') };
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== view));
  $('#page-title').textContent = view === 'overview' ? 'Project overview' : view === 'chat' ? 'How can we help?' : 'Recent activity';
  ['overview-nav', 'chat-nav', 'activity-nav'].forEach((id) => $(`#${id}`).classList.remove('active'));
  $(`#${view}-nav`).classList.add('active');
  if (view === 'activity') renderActivity();
}

function renderActivity() {
  const activity = $('#activity-list');
  activity.replaceChildren();
  Array.from(list.querySelectorAll('.message.user')).slice(-6).reverse().forEach((message) => {
    const row = document.createElement('div'); row.className = 'activity-row';
    row.innerHTML = `<span class="activity-dot"></span><span><strong>${message.querySelector('.message-bubble').textContent}</strong><small>${message.querySelector('.message-time').textContent} · Web chat</small></span>`;
    activity.appendChild(row);
  });
  if (!activity.children.length) activity.innerHTML = '<p class="muted">No requests yet. Start a conversation with CST.</p>';
}

async function openWorkspace(event) {
  event.preventDefault();
  $('#login-error').textContent = '';
  try { setSession(await api('/api/v1/web/session', { method: 'POST', body: JSON.stringify({ user: $('#user-select').value, project_id: $('#project-select').value }) })); await loadHistory(); } catch (error) { $('#login-error').textContent = error.message; }
  try { showView('overview'); } catch (error) { $('#login-error').textContent = error.message; }
}

async function loadHistory() {
  const history = await api('/api/v1/web/history');
  list.replaceChildren();
  history.messages.forEach((m) => renderMessage(m));
  if (!history.messages.length) renderMessage({ role: 'assistant', text: 'Welcome back. Ask me about the farms in your project scope.', created_at: Date.now() });
  list.scrollTop = list.scrollHeight;
}

async function sendMessage(event) {
  event.preventDefault();
  // Prevent duplicate submissions while a request is pending.
  if (state.pending) return;
  const text = input.value.trim();
  if (!text) return;

  // 1. Show user message IMMEDIATELY — before the API call.
  renderMessage({ role: 'user', text, created_at: Date.now() });
  input.value = '';
  list.scrollTop = list.scrollHeight;

  // 2. Lock the composer and show typing indicator.
  setComposerPending(true);

  try {
    const response = await api('/api/v1/web/message', { method: 'POST', body: JSON.stringify({ text }) });
    renderMessage({
      role: 'assistant',
      text: response.reply_text,
      media: response.media_url ? [response.media_url] : [],
      created_at: Date.now(),
    });
    list.scrollTop = list.scrollHeight;
  } catch (error) {
    // Show a clear failure message — do not silently swallow.
    const errorArticle = renderMessage({
      role: 'assistant',
      text: `We couldn't complete that request. ${error.message}. Please try again.`,
      created_at: Date.now(),
    });
    errorArticle.classList.add('message-error');
    list.scrollTop = list.scrollHeight;
  } finally {
    // 3. Unlock the composer.
    setComposerPending(false);
    input.focus();
  }
}

async function init() {
  try { setSession(await api('/api/v1/web/session')); await loadHistory(); showView('overview'); } catch { const projects = await api('/api/v1/web/projects'); $('#project-select').replaceChildren(...projects.map((project) => new Option(project.name, project.project_id))); }
}

$('#login-form').addEventListener('submit', openWorkspace);
$('#message-form').addEventListener('submit', sendMessage);
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#message-form').requestSubmit(); } });
$('#logout-button').addEventListener('click', async () => { await api('/api/v1/web/logout', { method: 'POST' }); window.location.reload(); });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#overview-nav').addEventListener('click', () => showView('overview'));
$('#chat-nav').addEventListener('click', () => showView('chat'));
$('#activity-nav').addEventListener('click', () => showView('activity'));
$('#overview-chat-button').addEventListener('click', () => showView('chat'));
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { input.value = button.dataset.prompt; showView('chat'); input.focus(); }));
init();
