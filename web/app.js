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

const WEB_MESSAGE_TIMEOUT_MS = 30000;

function setMessageStatus(text) {
  const status = $('#message-status');
  if (status) status.textContent = text;
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

  if (message.role === 'assistant' && !options.pending && message.text) {
    const voiceBtn = document.createElement('button');
    voiceBtn.className = 'voice-button';
    voiceBtn.type = 'button';
    voiceBtn.title = 'Listen to ElevenLabs voice';
    voiceBtn.innerHTML = '🔊 <span>Listen</span>';
    voiceBtn.addEventListener('click', async () => {
      if (voiceBtn.dataset.playing === 'true') {
        if (window._currentAudio) {
          window._currentAudio.pause();
          window._currentAudio = null;
        }
        voiceBtn.dataset.playing = 'false';
        voiceBtn.innerHTML = '🔊 <span>Listen</span>';
        return;
      }
      voiceBtn.innerHTML = '⏳ <span>Synthesizing...</span>';
      try {
        let audioUrl = message.audio_url;
        if (!audioUrl) {
          const res = await api('/api/v1/web/speak', {
            method: 'POST',
            body: JSON.stringify({ text: message.text }),
          });
          audioUrl = res.audio_url;
          message.audio_url = audioUrl;
        }
        if (typeof Audio !== 'undefined') {
          if (window._currentAudio) {
            window._currentAudio.pause();
            window._currentAudio = null;
          }
          const audio = new Audio(audioUrl);
          window._currentAudio = audio;
          voiceBtn.dataset.playing = 'true';
          voiceBtn.innerHTML = '⏹ <span>Stop</span>';
          audio.onended = () => {
            voiceBtn.dataset.playing = 'false';
            voiceBtn.innerHTML = '🔊 <span>Listen</span>';
            window._currentAudio = null;
          };
          audio.onerror = () => {
            voiceBtn.dataset.playing = 'false';
            voiceBtn.innerHTML = '🔊 <span>Listen</span>';
            setMessageStatus('Voice playback error.');
            window._currentAudio = null;
          };
          await audio.play();
        }
      } catch (err) {
        voiceBtn.dataset.playing = 'false';
        voiceBtn.innerHTML = '🔊 <span>Listen</span>';
        setMessageStatus(`Voice error: ${err.message}`);
      }
    });
    body.appendChild(voiceBtn);
  }

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
  sendButton.setAttribute('aria-disabled', String(pending));
  input.disabled = pending;
  if (pending) {
    input.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    typingState.classList.remove('hidden');
    typingState.setAttribute('aria-live', 'assertive');
    typingState.textContent = 'Message accepted. CST is processing your request.';
  } else {
    input.removeAttribute('aria-busy');
    form.removeAttribute('aria-busy');
    typingState.classList.add('hidden');
  }
}

function setSession(session) {
  state.session = session;
  $('#tenant-name').textContent = session.tenant?.name || 'vFarm Global';
  $('#project-name').textContent = session.project?.name || 'Project';
  $('#user-name').textContent = session.user.name;
  $('#user-role').textContent = session.user.role;
  $('#user-initials').textContent = session.user.name.split(' ').map((part) => part[0]).join('').slice(0, 2);
  $('#scope-label').textContent = `${session.farm_count} farm${session.farm_count === 1 ? '' : 's'} in scope`;
  $('#welcome-name').textContent = session.user.name.toUpperCase();
  $('#farm-count').textContent = session.farm_count;
  $('#farm-count-badge').textContent = session.farm_count;
  $('#farm-list').replaceChildren(...(session.farms || []).map((farmId) => {
    const detail = (session.farm_details || []).find((f) => (f.farm_id === farmId || f.id === farmId));
    const title = detail?.farm_name ? detail.farm_name : farmId.replaceAll('_', ' ');
    const subtitle = detail?.farm_code ? `${detail.farm_code} · ${farmId.slice(0, 8)}...` : 'Verified resource scope';
    const item = document.createElement('div');
    item.className = 'farm-row';
    item.innerHTML = `<span class="farm-icon">⌁</span><span><strong>${title}</strong><small>${subtitle}</small></span><span class="farm-status">Active</span>`;
    return item;
  }));
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
}

function showView(view) {
  const views = { overview: $('#overview-view'), chat: $('#chat-view-panel'), activity: $('#activity-view') };
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== view));
  $('#page-title').textContent = view === 'overview' ? 'Project overview' : view === 'chat' ? 'How can we help?' : 'Recent activity';
  ['overview-nav', 'chat-nav', 'activity-nav'].forEach((id) => $(`#${id}`).classList.remove('active'));
  $(`#${view}-nav`).classList.add('active');
  $('.sidebar').classList.remove('open');
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
  const email = $('#email-input')?.value?.trim();
  const password = $('#password-input')?.value;
  const user = $('#user-select')?.value;
  const projectId = $('#project-select')?.value;

  try {
    const payload = {};
    if (email && password) {
      payload.email = email;
      payload.password = password;
    } else if (user) {
      payload.user = user;
    }
    if (projectId) payload.project_id = projectId;

    const adminToken = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
      ? localStorage.getItem('cst_admin_token')
      : null;
    const headers = adminToken ? { 'X-Admin-Token': adminToken } : {};

    setSession(await api('/api/v1/web/session', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }));
    await loadHistory();
    showView('overview');
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
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
  setMessageStatus('Message submitted.');
  input.value = '';
  list.scrollTop = list.scrollHeight;

  // 2. Lock the composer and show typing indicator.
  setComposerPending(true);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_MESSAGE_TIMEOUT_MS);

  try {
    const autoPlayVoice = $('#auto-play-voice')?.checked;
    const response = await api('/api/v1/web/message', {
      method: 'POST',
      body: JSON.stringify({ text, voice: autoPlayVoice }),
      signal: controller.signal,
    });
    setMessageStatus('CST is responding.');
    // Give the responding state a real paint before replacing it with delivered.
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve(undefined));
      else setTimeout(resolve, 0);
    });
    renderMessage({
      role: 'assistant',
      text: response.reply_text,
      media: response.media_url ? [response.media_url] : [],
      audio_url: response.audio_url,
      created_at: Date.now(),
    });
    if (autoPlayVoice && response.audio_url && typeof Audio !== 'undefined') {
      try {
        if (window._currentAudio) { window._currentAudio.pause(); window._currentAudio = null; }
        const autoAudio = new Audio(response.audio_url);
        window._currentAudio = autoAudio;
        autoAudio.play().catch(() => {});
      } catch {}
    }
    list.scrollTop = list.scrollHeight;
    setMessageStatus('Response delivered.');
  } catch (error) {
    // Show a clear failure message — do not silently swallow.
    const message = controller.signal.aborted ? 'The request timed out' : error.message;
    const errorArticle = renderMessage({
      role: 'assistant',
      text: `We couldn't complete that request. ${message}. Please try again.`,
      created_at: Date.now(),
    });
    errorArticle.classList.add('message-error');
    input.value = text;
    setMessageStatus(`Error: response could not be delivered. ${message}.`);
    list.scrollTop = list.scrollHeight;
  } finally {
    clearTimeout(timeoutId);
    // 3. Unlock the composer.
    setComposerPending(false);
    input.focus();
  }
}

async function init() {
  const adminToken = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
    ? localStorage.getItem('cst_admin_token')
    : null;
  const headers = adminToken ? { 'X-Admin-Token': adminToken } : {};
  try {
    setSession(await api('/api/v1/web/session', { headers }));
    await loadHistory();
    showView('overview');
  } catch {
    try {
      const projects = await api('/api/v1/web/projects');
      $('#project-select').replaceChildren(...projects.map((project) => new Option(project.name, project.project_id)));
    } catch {
      // Fallback if projects request fails
    }
  }
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

// Speech-to-text mic integration
const micButton = $('#mic-button');
if (micButton && typeof window !== 'undefined') {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    let recognizing = false;

    micButton.addEventListener('click', () => {
      if (recognizing) {
        recognition.stop();
        return;
      }
      try {
        recognition.start();
      } catch {}
    });

    recognition.onstart = () => {
      recognizing = true;
      micButton.classList.add('recording');
      micButton.title = 'Listening... Click to stop';
      setMessageStatus('Listening to your voice...');
    };
    recognition.onresult = (e) => {
      const transcript = e.results?.[0]?.[0]?.transcript;
      if (transcript) {
        input.value = transcript;
        setMessageStatus('Voice captured. Sending...');
        $('#message-form').requestSubmit();
      }
    };
    recognition.onerror = (e) => {
      recognizing = false;
      micButton.classList.remove('recording');
      setMessageStatus(`Mic error: ${e.error || 'speech recognition failed'}`);
    };
    recognition.onend = () => {
      recognizing = false;
      micButton.classList.remove('recording');
    };
  } else {
    micButton.style.display = 'none';
  }
}

init();
