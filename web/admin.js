// CST Platform Admin Console - Reactive Logic

// ── Auth Guard ───────────────────────────────────────────────────────────────
(function checkAuth() {
  const token = localStorage.getItem('cst_admin_token');
  if (!token) {
    window.location.replace('/admin/login');
    return;
  }
  // Validate token with server
  fetch('/api/v1/auth/me', { headers: { 'X-Admin-Token': token } })
    .then(r => {
      if (!r.ok) {
        localStorage.removeItem('cst_admin_token');
        window.location.replace('/admin/login');
      } else {
        return r.json();
      }
    })
    .then(data => {
      if (data) {
        // Show user info in header
        const nameEl = document.getElementById('admin-user-name');
        const emailEl = document.getElementById('admin-user-email');
        if (nameEl) nameEl.textContent = data.name || localStorage.getItem('cst_admin_name') || 'Admin';
        if (emailEl) emailEl.textContent = data.email || localStorage.getItem('cst_admin_email') || '';
      }
    })
    .catch(() => {});
})();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  tenants: [],
  projects: [],
  speakers: [],
  candidateNumbers: [],
  bindings: [],
  auditLogs: { security_events: [], alert_audits: [] },
  health: null,
  vfarmCustomers: [],
  vfarmCustomersLoaded: false,
};

// ── Toasts & Alerts ──────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span><button style="border:0;background:transparent;cursor:pointer;font-size:16px;color:currentColor;">&times;</button>`;

  toast.querySelector('button').addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    window.setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function showError(message) {
  const box = $('#admin-error');
  if (box) {
    box.textContent = message;
    box.classList.remove('hidden');
    window.setTimeout(() => box.classList.add('hidden'), 7000);
  }
  showToast(message, 'error');
}

async function api(path, options = {}) {
  const token = localStorage.getItem('cst_admin_token') || '';
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  // Session expired – redirect to login.
  //
  // Only do this when the 401 genuinely means "this CST admin session is
  // invalid". A 401 can also arrive from a *proxied upstream* (vFarm), and
  // treating that as a CST session expiry logs the operator out of the panel
  // whenever an upstream credential expires. The backend now maps upstream auth
  // failures to 502 (VFARM_AUTH_FAILED), but the response body is checked here
  // too so any remaining proxy route cannot end an admin session.
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  const isCstAuthFailure =
    response.status === 401 &&
    body?.error !== 'VFARM_AUTH_FAILED' &&
    body?.error !== 'PROXY_ERROR';
  if (isCstAuthFailure) {
    localStorage.removeItem('cst_admin_token');
    window.location.replace('/admin/login');
    throw new Error('Session expired. Redirecting to login...');
  }
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Request failed (${response.status})`);
  }
  return body;
}

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    showError(err.message);
  }
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="empty-row">${text}</td></tr>`;
}

function escapeAdminHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ── Tabs Navigation ──────────────────────────────────────────────────────────

function activateTab(tab) {
  $$('.admin-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.admin-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-${tab}`));

  // Tab-specific lazy refreshes
  if (tab === 'speakers') guarded(loadSpeakersTab);
  if (tab === 'audit') loadAuditLogs();
  if (tab === 'sms-consent') {
    loadConsentWordings();
    loadAllConsentRecords();
  }
  if (tab === 'overview') {
    loadHealth();
    loadVfarmPanel();
  }
  if (tab === 'vfarm-live') loadVfarmLiveTab();
  if (tab === 'turn-stream') guarded(loadTurnStream);
}

$('#admin-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.admin-tab');
  if (button) activateTab(button.dataset.tab);
});

// ── Shared Dropdown Option Fillers ───────────────────────────────────────────

function fillTenantSelects() {
  const selects = [
    '#project-sync-tenant',
    '#project-filter-tenant',
    '#number-sync-tenant',
    '#speaker-sync-tenant',
    '#invalidate-tenant',
    '#speaker-filter-tenant',
    '#add-user-tenant',
    '#turn-stream-filter-tenant',
    '#consent-tenant-select',
  ];

  selects.forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    const keepFirst = ['#project-filter-tenant', '#number-sync-tenant', '#speaker-filter-tenant', '#turn-stream-filter-tenant'].includes(selector);
    const current = select.value;

    select.replaceChildren(
      ...(keepFirst && select.options[0] ? [select.options[0]] : []),
      ...state.tenants.map((t) => new Option(`${t.name} (${t.tenant_id})`, t.tenant_id))
    );

    if (current && [...select.options].some((opt) => opt.value === current)) {
      select.value = current;
    }
  });

  $('#badge-tenants-count').textContent = state.tenants.length;
}

function fillProjectSelects() {
  const tenantFilter = $('#project-filter-tenant') ? $('#project-filter-tenant').value : '';
  const scoped = tenantFilter ? state.projects.filter((p) => p.tenant_id === tenantFilter) : state.projects;

  const projectSelects = [
    '#project-config-select',
    '#bind-project-select',
    '#speaker-sync-project',
    '#edit-user-project',
    '#add-user-project',
    '#speaker-filter-project',
    '#invalidate-project',
  ];

  projectSelects.forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    const keepFirst = selector === '#speaker-filter-project' || selector === '#invalidate-project';
    const current = select.value;

    select.replaceChildren(
      ...(keepFirst ? [new Option('All projects', '')] : []),
      ...state.projects.map((p) => new Option(`${p.name} (${p.project_id})`, p.project_id))
    );

    if (current && [...select.options].some((opt) => opt.value === current)) {
      select.value = current;
    }
  });

  // The invalidate form scopes its project list to the selected tenant (the
  // backend treats an empty project as "every project in the tenant"), so it
  // rebuilds its own options instead of keeping the flat fill above.
  invalidateProjectOptions();

  renderProjectTable(scoped);
  if (state.projects.length && $('#project-config-select')) {
    onProjectConfigSelectChange();
  }
}

// ── 1. Overview & Health & Architecture ──────────────────────────────────────

async function loadHealth() {
  const health = await api('/api/v1/admin/health/verification');
  state.health = health;

  const totalUsers = state.speakers.length;
  $('#health-summary').innerHTML = `
    <article class="metric-card blue-card">
      <span class="metric-label">TENANTS REGISTERED</span>
      <strong>${health.tenants.length}</strong>
      <small>Top isolation boundary</small>
    </article>
    <article class="metric-card mint-card">
      <span class="metric-label">BOUND SERVICE NUMBERS</span>
      <strong>${health.service_numbers.total_bound}</strong>
      <small>of ${health.service_numbers.total_candidate} candidate DIDs</small>
    </article>
    <article class="metric-card purple-card">
      <span class="metric-label">USERS &amp; SPEAKERS</span>
      <strong>${totalUsers}</strong>
      <small>Synced identity &amp; scope cache</small>
    </article>
    <article class="metric-card coral-card">
      <span class="metric-label">OUTBOUND QUEUE</span>
      <strong>${health.transport.pending_outbound_count}</strong>
      <small>Transport status: ${health.transport.status}</small>
    </article>`;

  // Render Section 2 Architecture Tree
  renderArchTree(health.tenants);

  // Render Verification Readiness Table
  const rows = health.tenants.map((tenant) => `
    <tr>
      <td><strong>${tenant.name}</strong><br><small class="muted">${tenant.tenant_id}</small></td>
      <td><span class="pill ${tenant.status === 'active' ? 'active' : 'warn'}">${tenant.status}</span></td>
      <td>${tenant.projects_count} project(s)</td>
      <td>
        ${tenant.projects.map((p) => `
          <div style="margin-bottom:4px;">
            <strong>${p.name}:</strong>
            <span class="pill ${p.capabilities.sms ? 'active' : 'off'}">sms ${p.capabilities.sms ? 'on' : 'off'}</span>
            <span class="pill ${p.capabilities.web ? 'active' : 'off'}">web ${p.capabilities.web ? 'on' : 'off'}</span>
            <span class="pill ${p.capabilities.voice ? 'active' : 'off'}">voice ${p.capabilities.voice ? 'on' : 'off'}</span>
          </div>`).join('') || '<span class="muted">No projects pulled</span>'}
      </td>
      <td>
        <span class="pill ${tenant.adapter_health?.status === 'healthy' ? 'active' : 'warn'}">
          ${tenant.adapter_health?.status || 'healthy'}
        </span>
      </td>
    </tr>`).join('');

  $('#health-tenants').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Tenant</th><th>Status</th><th>Projects</th><th>Channels / Capabilities</th><th>Adapter</th></tr>
      </thead>
      <tbody>${rows || emptyRow(5, 'No tenants registered yet.')}</tbody>
    </table>`;
}

function renderArchTree(tenants) {
  const container = $('#arch-tree-tenants');
  if (!container) return;

  if (!tenants.length) {
    container.innerHTML = `<div class="arch-tree-tenant"><p class="muted">No tenants registered.</p></div>`;
    return;
  }

  container.innerHTML = tenants.map((t) => `
    <div class="arch-tree-tenant">
      <span class="arch-tag">TENANT (ISOLATION BOUNDARY)</span>
      <h5>${t.name} <small class="muted">(${t.tenant_id})</small></h5>
      <div class="arch-projects-wrap">
        ${t.projects.map((p) => `
          <div class="arch-project-chip">
            <strong>${p.name}</strong>
            <small>ID: ${p.project_id} · Policy: ${p.speaker_policy}</small>
            <div style="margin-top:4px;">
              ${Object.entries(p.capabilities).filter(([_, enabled]) => enabled).map(([cap]) => `<span class="tag-chip">${cap}</span>`).join('')}
            </div>
          </div>`).join('') || '<small class="muted">No projects mapped</small>'}
      </div>
    </div>`).join('');
}

// ── 2. Users & Speakers Directory (Core User Request) ────────────────────────

async function loadSpeakers() {
  const tenant = $('#speaker-filter-tenant') ? $('#speaker-filter-tenant').value : '';
  const project = $('#speaker-filter-project') ? $('#speaker-filter-project').value : '';
  const role = $('#speaker-filter-role') ? $('#speaker-filter-role').value : '';
  const search = $('#speaker-search-input') ? $('#speaker-search-input').value.trim() : '';

  const queryParams = new URLSearchParams();
  if (tenant) queryParams.set('tenant_id', tenant);
  if (project) queryParams.set('project_id', project);
  if (role) queryParams.set('role', role);
  if (search) queryParams.set('search', search);

  const { speakers } = await api(`/api/v1/admin/speakers?${queryParams.toString()}`);
  state.speakers = speakers;

  $('#badge-users-count').textContent = speakers.length;
  renderSpeakersTable(speakers);
}

function renderSpeakersTable(speakers) {
  const container = $('#speakers-table-container');
  if (!container) return;

  const cacheFilter = $('#speaker-filter-cache') ? $('#speaker-filter-cache').value : '';
  const filtered = cacheFilter
    ? speakers.filter((s) => (cacheFilter === 'active' ? s.is_cache_active : !s.is_cache_active))
    : speakers;

  const vfarmByUserId = new Map(
    (state.vfarmCustomers || []).map((c) => [c.user_id, c])
  );

  const rows = filtered.map((speaker) => {
    const avatarLetter = (speaker.customer_ref || speaker.phone_e164).slice(0, 2).toUpperCase();
    const farmChips = (speaker.farm_ids && speaker.farm_ids.length > 0)
      ? speaker.farm_ids.map((farm) => `<span class="tag-chip">${farm}</span>`).join(' ')
      : '<span class="tag-chip-empty">Zero farm grants (Onboarding only)</span>';

    const cachePill = speaker.is_cache_active
      ? `<span class="cache-pill active"><span class="pulse-dot"></span> Active TTL</span>`
      : `<span class="cache-pill expired"><span class="pulse-dot"></span> Expired (Live resolve)</span>`;

    // Provenance badge: vFarm owns identity/role; CST owns the phone→user mapping.
    let sourceBadge;
    if (!state.vfarmCustomersLoaded) {
      sourceBadge = '<span class="pill off">CST record</span>';
    } else {
      const upstream = vfarmByUserId.get(speaker.customer_ref);
      if (upstream) {
        sourceBadge = `<span class="pill active" title="Verified against vFarm org members">vFarm · ${escapeAdminHtml(upstream.vfarm_role)}</span>`;
      } else {
        sourceBadge = '<span class="pill warn" title="No matching vFarm org member — revoked upstream or CST-only record">Not in vFarm org</span>';
      }
    }

    return `
      <tr>
        <td>
          <div class="user-identity-cell">
            <div class="user-avatar">${avatarLetter}</div>
            <div class="user-identity-text">
              <strong>${escapeAdminHtml(speaker.customer_ref || 'Unknown Person')}</strong>
              <small>${escapeAdminHtml(speaker.phone_e164)}</small>
              <small>${sourceBadge}</small>
            </div>
          </div>
        </td>
        <td>
          <strong>${escapeAdminHtml(speaker.project_id || '—')}</strong><br>
          <small class="muted">${escapeAdminHtml(speaker.tenant_id)}</small>
        </td>
        <td>
          <span class="role-badge ${escapeAdminHtml(speaker.role)}">${escapeAdminHtml(speaker.role)}</span>
        </td>
        <td>
          <div style="max-width:320px;">${farmChips}</div>
        </td>
        <td>
          ${cachePill}<br>
          <small class="muted">${speaker.speaker_cache_expires_at ? new Date(speaker.speaker_cache_expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</small>
        </td>
        <td>
          <div class="table-actions">
            <button class="table-btn" data-edit-speaker="${escapeAdminHtml(speaker.phone_e164)}" data-tenant="${escapeAdminHtml(speaker.tenant_id)}" data-project="${escapeAdminHtml(speaker.project_id || '')}">Edit</button>
            <button class="table-btn" data-invalidate-speaker="${escapeAdminHtml(speaker.phone_e164)}" data-tenant="${escapeAdminHtml(speaker.tenant_id)}" data-project="${escapeAdminHtml(speaker.project_id || '')}" title="Force fresh resolve on next message">Invalidate</button>
            <button class="table-btn danger" data-delete-speaker="${escapeAdminHtml(speaker.phone_e164)}" data-tenant="${escapeAdminHtml(speaker.tenant_id)}" data-project="${escapeAdminHtml(speaker.project_id || '')}" title="Revoke CST access only — vFarm membership is untouched">Revoke</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>User / Speaker Identity</th>
          <th>Project &amp; Tenant</th>
          <th>Role</th>
          <th>Resource Scope (Farm Grants)</th>
          <th>Cache Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows || emptyRow(6, 'No users match the search/filter criteria. Click "+ Onboard User" above to add one.')}</tbody>
    </table>`;

  // Attach action listeners
  $$('[data-edit-speaker]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const phone = btn.dataset.editSpeaker;
      const speaker = state.speakers.find((s) => s.phone_e164 === phone);
      if (speaker) openEditUserModal(speaker);
    });
  });

  $$('[data-invalidate-speaker]').forEach((btn) => {
    btn.addEventListener('click', () => guarded(async () => {
      const phone = btn.dataset.invalidateSpeaker;
      const tenant_id = btn.dataset.tenant;
      const project_id = btn.dataset.project || undefined;
      await api('/api/v1/admin/speakers/invalidate', {
        method: 'POST',
        body: JSON.stringify({ tenant_id, project_id, phone_e164: phone }),
      });
      showToast(`Invalidated cache for ${phone}. Next SMS re-resolves live.`, 'warn');
      await loadSpeakersTab();
    }));
  });

  $$('[data-delete-speaker]').forEach((btn) => {
    btn.addEventListener('click', () => guarded(async () => {
      const phone = btn.dataset.deleteSpeaker;
      const tenant_id = btn.dataset.tenant;
      const project_id = btn.dataset.project || undefined;
      if (!confirm(`Are you sure you want to revoke speaker ${phone}?`)) return;
      await api(`/api/v1/admin/speakers/${encodeURIComponent(phone)}`, {
        method: 'DELETE',
        body: JSON.stringify({ tenant_id, project_id }),
      });
      showToast(`Revoked speaker ${phone}.`, 'info');
      await loadSpeakersTab();
      await loadHealth();
    }));
  });
}

// User Search & Filters Events
$('#speaker-search-input')?.addEventListener('input', debounce(loadSpeakers, 300));
$('#speaker-filter-tenant')?.addEventListener('change', loadSpeakers);
$('#speaker-filter-project')?.addEventListener('change', loadSpeakers);
$('#speaker-filter-role')?.addEventListener('change', loadSpeakers);
$('#speaker-filter-cache')?.addEventListener('change', loadSpeakers);

// ── 2b. vFarm Org Members (live source of truth) ─────────────────────────────
// Reads the existing GET /api/v1/admin/vfarm/customers route. This is the same
// vFarm integration the runtime adapter uses (adapters/vfarm → httpClient
// GET /api/v1/organizations/{org_id}/users), so the panel shows what the engine
// would resolve — not a parallel list.

function fillVfarmOrgSelect() {
  const select = $('#vfarm-users-org');
  if (!select) return;

  const orgs = [];
  const seen = new Set();
  for (const project of state.projects) {
    if (!project?.tenant_org_id || seen.has(project.tenant_org_id)) continue;
    seen.add(project.tenant_org_id);
    orgs.push({ org_id: project.tenant_org_id, project_id: project.project_id });
  }

  const current = select.value;
  select.replaceChildren(
    new Option('Select a vFarm organization…', ''),
    ...orgs.map((o) => new Option(`${o.org_id} (${o.project_id})`, o.org_id))
  );
  if (current && seen.has(current)) select.value = current;
  else if (orgs.length === 1) select.value = orgs[0].org_id;

  return orgs;
}

// Real vFarm org ids are UUIDs. A project's tenant_org_id that is not a UUID is
// a CST-side placeholder and vFarm will reject it (422) — worth showing rather
// than letting an operator pick it and see nothing.
function looksLikeVfarmOrgId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

async function refreshVfarmOrgOptions() {
  const select = $('#vfarm-users-org');
  if (!select) return;

  const current = select.value;
  const projectOrgs = fillVfarmOrgSelect() || [];

  let discovered = [];
  try {
    const data = await api('/api/v1/admin/vfarm/organizations');
    discovered = Array.isArray(data?.organizations) ? data.organizations : [];
  } catch (err) {
    // vFarm not configured / not reachable — keep the project-derived options
    // and say so; the panel must not invent organizations.
    const status = $('#vfarm-users-status');
    if (status && !select.value) status.textContent = 'org discovery unavailable';
    return;
  }

  const existing = new Set(Array.from(select.options).map((o) => o.value).filter(Boolean));
  for (const org of discovered) {
    if (!org?.id || existing.has(org.id)) continue;
    existing.add(org.id);
    select.appendChild(new Option(
      `${org.name || 'org'} · ${org.slug || org.id.slice(0, 8)} · ${org.member_count ?? '?'} member(s) · ${org.id}`,
      org.id
    ));
  }

  // Mark placeholder project org ids so the operator knows why they return nothing.
  for (const option of Array.from(select.options)) {
    if (!option.value || looksLikeVfarmOrgId(option.value)) continue;
    option.textContent = `${option.textContent} ⚠ not a live vFarm id (placeholder)`;
  }

  void projectOrgs;
  if (current && existing.has(current)) select.value = current;
}

function renderVfarmUsersMessage(title, detail) {
  const list = $('#vfarm-users-list');
  const summary = $('#vfarm-users-summary');
  if (summary) summary.innerHTML = '';
  if (list) {
    list.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>${escapeAdminHtml(title)}</th></tr></thead>
        <tbody>${emptyRow(1, escapeAdminHtml(detail))}</tbody>
      </table>`;
  }
}

async function loadVfarmUsers() {
  const list = $('#vfarm-users-list');
  if (!list) return;

  const orgId = $('#vfarm-users-org')?.value || '';
  const status = $('#vfarm-users-status');
  if (!orgId) {
    state.vfarmCustomers = [];
    state.vfarmCustomersLoaded = false;
    if (status) status.textContent = 'no organization selected';
    renderVfarmUsersMessage('vFarm Users', 'Select a vFarm organization to load its members. No vFarm credentials are ever sent from the browser.');
    renderSpeakersTable(state.speakers);
    return;
  }

  if (status) status.textContent = 'loading…';

  let data;
  try {
    data = await api(`/api/v1/admin/vfarm/customers?org_id=${encodeURIComponent(orgId)}`);
  } catch (err) {
    // vFarm not configured / org has no mapping — report honestly, never fabricate.
    state.vfarmCustomers = [];
    state.vfarmCustomersLoaded = false;
    if (status) status.textContent = 'unavailable';
    renderVfarmUsersMessage('vFarm Users', `Live vFarm user data is not available right now: ${err.message}`);
    renderSpeakersTable(state.speakers);
    return;
  }

  // The endpoint distinguishes "vFarm says this org has no users" from
  // "the vFarm fetch failed". Only the former may be presented as truth;
  // otherwise the panel says so and leaves the CST badges unasserted.
  if (data?.vfarm_source === 'unavailable') {
    state.vfarmCustomers = [];
    state.vfarmCustomersLoaded = false;
    const reason = data?.source_error || 'vFarm did not return a usable response';
    if (status) status.textContent = 'source unavailable';
    $('#vfarm-users-summary').innerHTML = `
      <div class="metric-card">
        <span class="metric-label">vFarm Source</span>
        <strong class="metric-value">Unavailable</strong>
        <small class="muted">${escapeAdminHtml(reason)}</small>
      </div>`;
    list.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>vFarm organization members</th></tr></thead>
        <tbody>${emptyRow(1, `Live vFarm user data is not available right now, so the list below cannot be verified against the vFarm source of truth: ${escapeAdminHtml(reason)}. The CST speaker records above remain valid on their own.`)}</tbody>
      </table>`;
    renderSpeakersTable(state.speakers);
    return;
  }

  state.vfarmCustomers = data?.customers || [];
  state.vfarmCustomersLoaded = true;
  if (status) status.textContent = `${state.vfarmCustomers.length} member(s) · live`;

  const mapped = state.vfarmCustomers.filter((c) => c.cst_registered);
  const unmapped = state.vfarmCustomers.filter((c) => !c.cst_registered);
  const cstOnly = (state.speakers || []).filter(
    (s) => !state.vfarmCustomers.some((c) => c.user_id === s.customer_ref)
  );

  $('#vfarm-users-summary').innerHTML = `
    <div class="metric-card">
      <span class="metric-label">vFarm Members</span>
      <strong class="metric-value">${state.vfarmCustomers.length}</strong>
      <small class="muted">Live from ${escapeAdminHtml(orgId)}</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">Mapped to CST</span>
      <strong class="metric-value">${mapped.length}</strong>
      <small class="muted">Has a phone → speaker record</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">vFarm only</span>
      <strong class="metric-value">${unmapped.length}</strong>
      <small class="muted">No phone mapped in CST yet</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">CST only</span>
      <strong class="metric-value">${cstOnly.length}</strong>
      <small class="muted">No matching vFarm org member</small>
    </div>`;

  const rows = state.vfarmCustomers.map((c) => `
    <tr>
      <td><code>${escapeAdminHtml(c.user_id)}</code></td>
      <td><strong>${escapeAdminHtml(c.name || '—')}</strong><br><small class="muted">${escapeAdminHtml(c.email || '—')}</small></td>
      <td><span class="role-badge ${escapeAdminHtml(c.vfarm_role)}">${escapeAdminHtml(c.vfarm_role)}</span></td>
      <td>${c.cst_registered
        ? `<strong>${escapeAdminHtml(c.cst_phone_e164)}</strong><br><small class="muted">${escapeAdminHtml(c.cst_project_id || '—')} · CST role ${escapeAdminHtml(c.cst_role || '—')}</small>`
        : '<span class="tag-chip-empty">Not mapped — vFarm exposes no phone number</span>'}</td>
      <td>${(c.cst_farm_ids && c.cst_farm_ids.length)
        ? c.cst_farm_ids.map((f) => `<span class="tag-chip">${escapeAdminHtml(f)}</span>`).join(' ')
        : '<span class="muted">—</span>'}</td>
      <td>${c.cst_registered
        ? '<span class="pill active">mapped</span>'
        : '<span class="pill warn">vFarm only</span>'}</td>
    </tr>`).join('');

  list.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>vFarm user_id</th><th>Name / Email</th><th>vFarm Role</th><th>CST Speaker Mapping</th><th>Farm Scope</th><th>Status</th></tr>
      </thead>
      <tbody>${rows || emptyRow(6, 'vFarm returned no members for this organization.')}</tbody>
    </table>`;

  // Re-render the CST table so its provenance badges reflect live vFarm state.
  renderSpeakersTable(state.speakers);
}

$('#vfarm-users-org')?.addEventListener('change', () => guarded(loadVfarmUsers));
$('#btn-vfarm-users-refresh')?.addEventListener('click', () => guarded(loadVfarmUsers));

// Tab 2 entry point: CST projection first, then the live vFarm org view.
async function loadSpeakersTab() {
  await loadSpeakers();
  await refreshVfarmOrgOptions();
  await loadVfarmUsers();
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Modals: Edit User & Add User ─────────────────────────────────────────────

function openEditUserModal(speaker) {
  $('#edit-user-phone').value = speaker.phone_e164;
  $('#edit-user-ref').value = speaker.customer_ref || '';
  $('#edit-user-tenant').value = speaker.tenant_id;
  $('#edit-user-project').value = speaker.project_id;
  $('#edit-user-role').value = speaker.role || 'manager';
  $('#edit-user-ttl').value = '24';
  $('#edit-user-farms').value = speaker.farm_ids ? JSON.stringify(speaker.farm_ids) : '[]';
  $('#modal-edit-user').classList.remove('hidden');
}

$('#btn-close-edit-user')?.addEventListener('click', () => $('#modal-edit-user').classList.add('hidden'));
$('#btn-cancel-edit-user')?.addEventListener('click', () => $('#modal-edit-user').classList.add('hidden'));

$('#form-edit-user')?.addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const phone = $('#edit-user-phone').value;
    const tenant_id = $('#edit-user-tenant').value;
    const project_id = $('#edit-user-project').value;
    const customer_ref = $('#edit-user-ref').value.trim();
    const role = $('#edit-user-role').value;
    const ttl_hours = Number($('#edit-user-ttl').value) || 24;

    let farm_ids = [];
    const rawFarms = $('#edit-user-farms').value.trim();
    if (rawFarms) {
      if (rawFarms.startsWith('[')) {
        try { farm_ids = JSON.parse(rawFarms); } catch { throw new Error('Farm IDs JSON is invalid.'); }
      } else {
        farm_ids = rawFarms.split(',').map((f) => f.trim()).filter(Boolean);
      }
    }

    await api(`/api/v1/admin/speakers/${encodeURIComponent(phone)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tenant_id, project_id, customer_ref, role, farm_ids, ttl_hours }),
    });

    $('#modal-edit-user').classList.add('hidden');
    showToast(`Saved configuration for ${customer_ref || phone}.`, 'success');
    await loadSpeakersTab();
    await loadHealth();
  });
});

function openAddUserModal() {
  $('#modal-add-user').classList.remove('hidden');
}

$('#btn-open-add-user')?.addEventListener('click', openAddUserModal);
$('#btn-quick-onboard')?.addEventListener('click', openAddUserModal);
$('#btn-close-add-user')?.addEventListener('click', () => $('#modal-add-user').classList.add('hidden'));
$('#btn-cancel-add-user')?.addEventListener('click', () => $('#modal-add-user').classList.add('hidden'));

$('#form-add-user')?.addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const phone_e164 = $('#add-user-phone').value.trim();
    const customer_ref = $('#add-user-ref').value.trim();
    const tenant_id = $('#add-user-tenant').value;
    const project_id = $('#add-user-project').value;
    const role = $('#add-user-role').value;
    const ttl_hours = Number($('#add-user-ttl').value) || 24;

    let farm_ids = [];
    const rawFarms = $('#add-user-farms').value.trim();
    if (rawFarms) {
      if (rawFarms.startsWith('[')) {
        try { farm_ids = JSON.parse(rawFarms); } catch { throw new Error('Farm IDs JSON is invalid.'); }
      } else {
        farm_ids = rawFarms.split(',').map((f) => f.trim()).filter(Boolean);
      }
    }

    await api('/api/v1/admin/speakers', {
      method: 'POST',
      body: JSON.stringify({ phone_e164, customer_ref, tenant_id, project_id, role, farm_ids, ttl_hours }),
    });

    $('#form-add-user').reset();
    $('#modal-add-user').classList.add('hidden');
    showToast(`Onboarded user ${customer_ref} (${phone_e164}).`, 'success');
    await loadSpeakersTab();
    await loadHealth();
  });
});

// Sync speakers form in speakers tab
$('#speaker-sync-tenant')?.addEventListener('change', () => {
  const tenantId = $('#speaker-sync-tenant').value;
  const options = state.projects.filter((p) => p.tenant_id === tenantId);
  $('#speaker-sync-project').replaceChildren(...options.map((p) => new Option(`${p.name} — ${p.project_id}`, p.project_id)));
});

$('#speaker-sync-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const tenant_id = $('#speaker-sync-tenant').value;
    const project_id = $('#speaker-sync-project').value;
    const result = await api('/api/v1/admin/speakers/sync', {
      method: 'POST',
      body: JSON.stringify({ tenant_id, project_id }),
    });
    const rows = result.speakers.map((s) => `<tr><td>${s.person_id}</td><td>${s.phone_e164}</td><td><span class="role-badge ${s.role}">${s.role}</span></td><td>${s.farm_count} farm(s)</td></tr>`).join('');
    $('#speaker-sync-result').innerHTML = `<table class="admin-table"><thead><tr><th>Person</th><th>Phone</th><th>Role</th><th>Farm Grants</th></tr></thead><tbody>${rows || emptyRow(4, 'No speakers returned.')}</tbody></table>`;
    showToast(`Synced ${result.count} speaker(s) from tenant adapter.`, 'success');
    await loadSpeakersTab();
    await loadHealth();
  });
});

$('#btn-quick-sync-speakers')?.addEventListener('click', () => {
  const firstTenant = state.tenants[0]?.tenant_id;
  const firstProject = state.projects.find((p) => p.tenant_id === firstTenant)?.project_id;
  if (firstTenant && firstProject) {
    guarded(async () => {
      const result = await api('/api/v1/admin/speakers/sync', {
        method: 'POST',
        body: JSON.stringify({ tenant_id: firstTenant, project_id: firstProject }),
      });
      showToast(`Synced ${result.count} speaker(s) for ${firstProject}.`, 'success');
      await loadSpeakersTab();
    });
  }
});

// ── 2c. Instant Cache Invalidation form (R-NUM-P5) ──────────────────────────
// Mirrors the per-row "Invalidate" button (same endpoint, same body shape) so an
// operator can expire one speaker's cache entry without first loading the table.
//
// POST /api/v1/admin/speakers/invalidate
//   body: { tenant_id, project_id?, phone_e164 }
//   200:  { status: 'invalidated', tenant_id, project_id, phone_e164 }
//   400:  { error: 'BAD_REQUEST', message }   — missing tenant_id or phone_e164
//   500:  { error: 'INVALIDATION_FAILED', message }
// project_id is optional by contract (engine/src/admin/routes.ts:487 treats a
// NULL project as "every project in the tenant"), so the select may stay on
// "— any project —".

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

function invalidateProjectOptions() {
  const tenantId = $('#invalidate-tenant')?.value || '';
  const select = $('#invalidate-project');
  if (!select) return;
  const options = state.projects.filter((p) => p.tenant_id === tenantId);
  select.replaceChildren(
    new Option('— any project —', ''),
    ...options.map((p) => new Option(`${p.name} — ${p.project_id}`, p.project_id)),
  );
}

$('#invalidate-tenant')?.addEventListener('change', invalidateProjectOptions);

$('#speaker-invalidate-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    const tenant_id = $('#invalidate-tenant')?.value || '';
    const project_id = $('#invalidate-project')?.value || '';
    const phone_e164 = ($('#invalidate-phone')?.value || '').trim();

    if (!tenant_id) throw new Error('Select the tenant that owns this speaker.');
    if (!phone_e164) throw new Error('Enter the speaker phone number in E.164 format.');
    if (!E164_PATTERN.test(phone_e164)) {
      throw new Error(`"${phone_e164}" is not E.164 — expected a leading +, a non-zero country digit, then 1-14 digits (e.g. +15551234567).`);
    }

    const result = await api('/api/v1/admin/speakers/invalidate', {
      method: 'POST',
      body: JSON.stringify({ tenant_id, project_id: project_id || undefined, phone_e164 }),
    });

    const scope = project_id || 'all projects';
    const status = result?.status === 'invalidated' ? 'active' : 'warn';
    const rows = `
      <tr>
        <td><code>${escapeAdminHtml(phone_e164)}</code></td>
        <td><code>${escapeAdminHtml(tenant_id)}</code></td>
        <td>${escapeAdminHtml(scope)}</td>
        <td><span class="pill ${status}">${escapeAdminHtml(result?.status || 'unknown')}</span></td>
      </tr>`;
    const box = $('#speaker-invalidate-result');
    if (box) {
      box.innerHTML = `
        <table class="admin-table">
          <thead><tr><th>Phone</th><th>Tenant</th><th>Project Scope</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
    $('#invalidate-phone').value = '';

    showToast(`Invalidated cache for ${phone_e164} (${scope}). Next SMS re-resolves live.`, 'success');
    await loadSpeakersTab();
    await loadHealth();
  });
});

// ── 3. Tenants Management ───────────────────────────────────────────────────

async function loadTenants() {
  const { tenants } = await api('/api/v1/admin/tenants');
  state.tenants = tenants;
  $('#tenant-count').textContent = tenants.length;
  fillTenantSelects();

  const rows = tenants.map((t) => `
    <tr>
      <td><strong>${t.name}</strong></td>
      <td><code>${t.tenant_id}</code></td>
      <td><span class="pill">${t.adapter_type}</span></td>
      <td><span class="pill ${t.status === 'active' ? 'active' : 'warn'}">${t.status}</span></td>
      <td><small class="muted">${new Date(t.created_at).toLocaleDateString()}</small></td>
      <td>
        <button class="table-btn" data-edit-tenant="${t.tenant_id}">Configure</button>
      </td>
    </tr>`).join('');

  $('#tenant-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Name</th><th>Tenant ID</th><th>Adapter</th><th>Status</th><th>Registered</th><th>Actions</th></tr>
      </thead>
      <tbody>${rows || emptyRow(6, 'No tenants yet — register one above.')}</tbody>
    </table>`;

  $$('[data-edit-tenant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tenant = state.tenants.find((t) => t.tenant_id === btn.dataset.editTenant);
      if (tenant) openEditTenantModal(tenant);
    });
  });
}

function openEditTenantModal(tenant) {
  $('#edit-tenant-id').value = tenant.tenant_id;
  $('#edit-tenant-name').value = tenant.name;
  $('#edit-tenant-status').value = tenant.status || 'active';
  $('#edit-tenant-adapter').value = tenant.adapter_type || 'vfarm';
  $('#edit-tenant-config').value = tenant.adapter_config ? JSON.stringify(tenant.adapter_config, null, 2) : '';
  $('#modal-edit-tenant').classList.remove('hidden');
}

$('#btn-close-edit-tenant')?.addEventListener('click', () => $('#modal-edit-tenant').classList.add('hidden'));
$('#btn-cancel-edit-tenant')?.addEventListener('click', () => $('#modal-edit-tenant').classList.add('hidden'));

$('#form-edit-tenant')?.addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const tenantId = $('#edit-tenant-id').value;
    const name = $('#edit-tenant-name').value.trim();
    const status = $('#edit-tenant-status').value;
    const adapter_type = $('#edit-tenant-adapter').value.trim();

    let adapter_config;
    const raw = $('#edit-tenant-config').value.trim();
    if (raw) {
      try { adapter_config = JSON.parse(raw); } catch { throw new Error('Adapter config JSON is invalid'); }
    }

    await api(`/api/v1/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, status, adapter_type, adapter_config }),
    });

    $('#modal-edit-tenant').classList.add('hidden');
    showToast(`Updated tenant ${tenantId}.`, 'success');
    await loadTenants();
    await loadHealth();
  });
});

$('#tenant-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    let adapter_config;
    const raw = $('#tenant-config-input').value.trim();
    if (raw) {
      try { adapter_config = JSON.parse(raw); } catch { throw new Error('Adapter config must be valid JSON'); }
    }
    await api('/api/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: $('#tenant-id-input').value.trim(),
        name: $('#tenant-name-input').value.trim(),
        adapter_type: $('#tenant-adapter-input').value.trim() || 'vfarm',
        adapter_config,
      }),
    });
    event.target.reset();
    $('#tenant-adapter-input').value = 'vfarm';
    showToast('Tenant registered successfully.', 'success');
    await loadTenants();
    await loadHealth();
  });
});

// ── 4. Projects & Capabilities ───────────────────────────────────────────────

function renderProjectTable(projects) {
  const container = $('#project-list');
  if (!container) return;

  const rows = projects.map((p) => {
    const caps = p.capabilities || {};
    const capPills = ['sms', 'web', 'voice', 'whatsapp', 'email']
      .filter((cap) => caps[cap])
      .map((cap) => `<span class="tag-chip">${cap}</span>`)
      .join(' ') || '<span class="pill off">none</span>';

    return `
      <tr>
        <td><strong>${p.name}</strong><br><small class="muted">${p.project_id}</small></td>
        <td><code>${p.tenant_id}</code></td>
        <td>${capPills}</td>
        <td><span class="pill">${p.speaker_policy}</span></td>
        <td><small class="muted">${p.synced_at ? new Date(p.synced_at).toLocaleString() : '—'}</small></td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Project</th><th>Tenant</th><th>Capabilities</th><th>Speaker Policy</th><th>Last Synced</th></tr>
      </thead>
      <tbody>${rows || emptyRow(5, 'No projects pulled yet — sync a tenant above.')}</tbody>
    </table>`;
}

async function loadProjects() {
  const { projects } = await api('/api/v1/admin/projects');
  state.projects = projects;
  fillProjectSelects();
  fillVfarmOrgSelect();
}

$('#project-sync-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    const tenant_id = $('#project-sync-tenant').value;
    const result = await api('/api/v1/admin/projects/sync', {
      method: 'POST',
      body: JSON.stringify({ tenant_id }),
    });
    showToast(`Pulled ${result.count} project(s) from ${tenant_id}.`, 'success');
    await loadProjects();
    await loadHealth();
  });
});

$('#project-filter-tenant')?.addEventListener('change', () => {
  const filter = $('#project-filter-tenant').value;
  renderProjectTable(filter ? state.projects.filter((p) => p.tenant_id === filter) : state.projects);
});

function onProjectConfigSelectChange() {
  const projectId = $('#project-config-select').value;
  const project = state.projects.find((p) => p.project_id === projectId);
  if (!project) return;

  const caps = project.capabilities || {};
  $('#cap-sms').checked = !!caps.sms;
  $('#cap-web').checked = !!caps.web;
  $('#cap-voice').checked = !!caps.voice;
  $('#speaker-policy-select').value = project.speaker_policy || 'allowlist';
  $('#onboarding-reply-input').value = project.onboarding_reply || '';
  $('#voice-enabled-select').value = String(!!project.voice_enabled);
  $('#voice-id-input').value = project.elevenlabs_voice_id || '';
}

$('#project-config-select')?.addEventListener('change', onProjectConfigSelectChange);

$('#project-config-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    const project_id = $('#project-config-select').value;
    await api(`/api/v1/admin/projects/${project_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        capabilities: {
          sms: $('#cap-sms').checked,
          web: $('#cap-web').checked,
          voice: $('#cap-voice').checked,
        },
        speaker_policy: $('#speaker-policy-select').value,
        onboarding_reply: $('#onboarding-reply-input').value,
        voice_enabled: $('#voice-enabled-select').value === 'true',
        elevenlabs_voice_id: $('#voice-id-input').value.trim() || undefined,
      }),
    });
    showToast(`Saved configuration for project ${project_id}.`, 'success');
    await loadProjects();
    await loadHealth();
  });
});

// ── 5. Numbers & Twilio Binding ─────────────────────────────────────────────

async function loadNumbers() {
  const [candidates, bindings] = await Promise.all([
    api('/api/v1/admin/numbers/candidate'),
    api('/api/v1/admin/numbers/bindings'),
  ]);

  state.candidateNumbers = candidates.numbers;
  state.bindings = bindings.bindings;

  const boundSet = new Set(state.bindings.map((b) => b.phone_e164));
  const unbound = state.candidateNumbers.filter((n) => !boundSet.has(n));
  $('#bind-number-select').replaceChildren(...unbound.map((n) => new Option(n, n)));

  const candidateRows = state.candidateNumbers.map((num) => `
    <tr>
      <td><strong>${num}</strong></td>
      <td>${boundSet.has(num) ? '<span class="pill active">bound</span>' : '<span class="pill off">candidate</span>'}</td>
    </tr>`).join('');

  $('#candidate-list').innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Number (E.164)</th><th>Status</th></tr></thead>
      <tbody>${candidateRows || emptyRow(2, 'No candidate numbers synced yet.')}</tbody>
    </table>`;

  $('#binding-count').textContent = state.bindings.length;

  const bindingRows = state.bindings.map((b) => `
    <tr>
      <td><strong>${b.phone_e164}</strong></td>
      <td><code>${b.tenant_id}</code></td>
      <td><strong>${b.project_id}</strong></td>
      <td><span class="pill">${b.capability}</span></td>
      <td>
        <button class="table-btn danger" data-unbind="${b.phone_e164}">Unbind</button>
      </td>
    </tr>`).join('');

  $('#binding-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Bound DID</th><th>Tenant</th><th>Project</th><th>Channel</th><th>Action</th></tr>
      </thead>
      <tbody>${bindingRows || emptyRow(5, 'No service numbers bound yet.')}</tbody>
    </table>`;

  $$('#binding-list [data-unbind]').forEach((btn) => {
    btn.addEventListener('click', () => guarded(async () => {
      const phone = btn.dataset.unbind;
      await api('/api/v1/admin/numbers/unbind', {
        method: 'DELETE',
        body: JSON.stringify({ phone_e164: phone }),
      });
      showToast(`Unbound number ${phone}.`, 'info');
      await loadNumbers();
      await loadHealth();
    }));
  });
}

$('#number-sync-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    const tenant_id = $('#number-sync-tenant').value || undefined;
    const result = await api('/api/v1/admin/numbers/sync', {
      method: 'POST',
      body: JSON.stringify({ tenant_id }),
    });
    showToast(`Synced ${result.count} candidate number(s).`, 'success');
    await loadNumbers();
  });
});

$('#bind-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  guarded(async () => {
    const phone_e164 = $('#bind-number-select').value;
    const projectId = $('#bind-project-select').value;
    const project = state.projects.find((p) => p.project_id === projectId);
    if (!phone_e164 || !project) {
      throw new Error('Choose a candidate number and target project.');
    }

    await api('/api/v1/admin/numbers/bind', {
      method: 'POST',
      body: JSON.stringify({
        phone_e164,
        tenant_id: project.tenant_id,
        project_id: projectId,
        capability: $('#bind-capability-select').value,
      }),
    });

    showToast(`Bound ${phone_e164} to ${project.name}.`, 'success');
    await loadNumbers();
    await loadHealth();
  });
});

// ── 6. Fail-Closed Audit & Activity ─────────────────────────────────────────

async function loadAuditLogs() {
  const data = await api('/api/v1/admin/audit/logs');
  state.auditLogs = data;

  const secRows = (data.security_events || []).map((ev) => {
    const outcomeBadge = ev.outcome === 'refused'
      ? `<span class="pill warn">refused</span>`
      : (ev.outcome === 'error' ? `<span class="pill off" style="color:var(--danger)">error</span>` : `<span class="pill active">ok</span>`);

    return `
      <tr>
        <td><small class="muted">${new Date(ev.timestamp).toLocaleTimeString()}</small></td>
        <td><code>${ev.tenant_id || 'platform'}</code></td>
        <td><strong>${ev.actor}</strong> (${ev.role})</td>
        <td>${ev.tool_or_route}</td>
        <td>${outcomeBadge}</td>
        <td><small>${ev.reason || '—'}</small></td>
      </tr>`;
  }).join('');

  $('#audit-security-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Time</th><th>Tenant</th><th>Actor</th><th>Route / Tool</th><th>Outcome</th><th>Reason</th></tr>
      </thead>
      <tbody>${secRows || emptyRow(6, 'No security events recorded yet.')}</tbody>
    </table>`;

  const alertRows = (data.alert_audits || []).map((al) => `
    <tr>
      <td><small class="muted">${new Date(al.created_at).toLocaleTimeString()}</small></td>
      <td><code>${al.tenant_id}</code></td>
      <td><code>${al.outbound_message_id}</code></td>
      <td><div style="max-width:320px;font-family:'DM Mono',monospace;font-size:11px;">${al.rendered_body}</div></td>
      <td>${al.masked_at ? '<span class="pill active">masked</span>' : '<span class="pill off">clean</span>'}</td>
    </tr>`).join('');

  $('#audit-alerts-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr><th>Timestamp</th><th>Tenant</th><th>Outbound Msg ID</th><th>Rendered Body</th><th>Secret Masking</th></tr>
      </thead>
      <tbody>${alertRows || emptyRow(5, 'No outbound alerts written to audit log yet.')}</tbody>
    </table>`;
}

$('#reload-audit')?.addEventListener('click', () => guarded(loadAuditLogs));

// ── 7. Dynamic vFarm Operations & Telemetry Dashboard ────────────────────────
// All authentication (VFARM_JWT / VFARM_FARM_KEY / VFARM_ADMIN_EMAIL+PASSWORD)
// is handled server-side via environment variables.
// The browser sends ZERO credentials to these endpoints.

const vfarmState = {
  farms: [],          // FarmResponse[] from GET /api/v1/admin/vfarm/farms
  activeFarmId: null, // currently selected farm UUID
  dashboardData: null,
};

/**
 * Discover all farms accessible to this server.
 * No credentials are sent from the browser — the server reads them from env.
 * Populates #vfarm-farm-select with all discovered farms and their device counts.
 */
async function loadVfarmFarms() {
  try {
    // Plain call — no Authorization header, no query token
    const data = await api('/api/v1/admin/vfarm/farms');
    vfarmState.farms = data.farms || [];
    vfarmState.activeFarmId = data.active_farm_id || (vfarmState.farms[0]?.id ?? null);

    const select = $('#vfarm-farm-select');
    if (select) {
      const current = select.value;
      select.replaceChildren(
        ...vfarmState.farms.map((f) => {
          const label = `${f.name || f.id}  ·  ${(f.device_count ?? 0)} device(s)`;
          return new Option(label, f.id);
        })
      );
      // Keep the previously selected farm, or default to the server's active farm
      const toSelect = current && vfarmState.farms.find((f) => f.id === current)
        ? current
        : vfarmState.activeFarmId;
      if (toSelect) select.value = toSelect;
    }

    const badge = $('#vfarm-farm-badge');
    if (badge) {
      badge.innerHTML = vfarmState.farms.length > 0
        ? `<span class="pill active">● ${vfarmState.farms.length} farm(s) discovered</span>`
        : `<span class="pill warn">No farms found — check VFARM_JWT in .env</span>`;
    }

    return vfarmState.farms;
  } catch (err) {
    const badge = $('#vfarm-farm-badge');
    // err.message contains the upstream message; for auth failures the server
    // returns VFARM_AUTH_FAILED (502) so we show a targeted hint.
    const isAuthFailure = err.message && (
      err.message.includes('VFARM_AUTH_FAILED') ||
      err.message.includes('unauthorized') ||
      err.message.includes('Invalid or expired token') ||
      err.message.includes('List farms failed')
    );
    if (badge) {
      badge.innerHTML = isAuthFailure
        ? `<span class="pill off">⚠ vFarm JWT expired — set VFARM_ADMIN_PASSWORD in .env to auto-refresh</span>`
        : `<span class="pill off">Discovery failed</span>`;
    }
    showError(isAuthFailure
      ? `Farm discovery: vFarm JWT is expired or invalid. Add VFARM_ADMIN_PASSWORD to .env so the server can refresh it automatically, or paste a fresh VFARM_JWT.`
      : `Farm discovery failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch live telemetry for the currently selected farm and render the dashboard.
 * farm_id is the only thing sent — the server resolves its own key from env.
 */
async function loadVfarmDashboard() {
  const farmId = $('#vfarm-farm-select')?.value || vfarmState.activeFarmId;
  const queryParams = farmId ? `?farm_id=${encodeURIComponent(farmId)}` : '';
  try {
    const data = await api(`/api/v1/admin/vfarm/dashboard${queryParams}`);
    vfarmState.dashboardData = data;
    renderVfarmDashboard(data);
  } catch (err) {
    const container = $('#vfarm-devices-container');
    if (container) {
      container.innerHTML = `<p class="muted" style="padding:16px;">Failed to load telemetry: ${err.message}</p>`;
    }
  }
}

/**
 * Render the 4-card metrics grid and device digital-twin table
 * from the data returned by GET /api/v1/admin/vfarm/dashboard.
 */
function renderVfarmDashboard(data) {
  if (!data) return;

  const { farm, device_count, devices = [], health = {} } = data;

  // ── Metrics grid ──
  const metricsGrid = $('#vfarm-metrics-grid');
  if (metricsGrid) {
    const healthScore = health.health_score ?? health.score ?? null;
    const healthStatus = health.status || 'unknown';
    const onlineCount = health.online_count ?? null;
    const offlineCount = health.offline_count ?? null;

    metricsGrid.innerHTML = `
      <article class="metric-card blue-card">
        <span class="metric-label">ACTIVE FARM</span>
        <strong style="font-size:14px;">${farm?.name || data.farm_id || '—'}</strong>
        <small class="muted">${data.farm_id || ''}</small>
      </article>
      <article class="metric-card mint-card">
        <span class="metric-label">DEVICE DIGITAL TWINS</span>
        <strong>${device_count ?? devices.length}</strong>
        <small>Live device instances</small>
      </article>
      <article class="metric-card purple-card">
        <span class="metric-label">FARM HEALTH</span>
        <strong>${healthScore !== null ? healthScore + '%' : healthStatus}</strong>
        <small>${onlineCount !== null ? `${onlineCount} online · ${offlineCount ?? 0} offline` : `Status: ${healthStatus}`}</small>
      </article>
      <article class="metric-card coral-card">
        <span class="metric-label">FARM ACTIVE</span>
        <strong>${farm?.is_active !== false ? 'Yes' : 'No'}</strong>
        <small>${farm?.is_active !== false ? 'Operational' : 'Offline'}</small>
      </article>`;
  }

  // ── Devices heading ──
  const title = $('#vfarm-devices-title');
  if (title) {
    title.textContent = `Discovered Active Devices — ${farm?.name || data.farm_id || 'Farm'}`;
  }

  // ── Device table ──
  const container = $('#vfarm-devices-container');
  if (!container) return;

  if (!devices || devices.length === 0) {
    container.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Device ID</th><th>Name</th><th>Status</th><th>Last Seen</th><th>Readings</th></tr></thead>
        <tbody>${emptyRow(5, 'No active devices found on this farm.')}</tbody>
      </table>`;
    return;
  }

  const rows = devices.map((dev) => {
    // vFarm devices use 'status' with values like 'active', 'offline', 'unknown'
    // and may also have a 'connected' boolean
    const isOnline = dev.status === 'active' || dev.connected === true;
    const statusPill = isOnline
      ? `<span class="pill active">● active</span>`
      : `<span class="pill warn">${dev.status || 'unknown'}</span>`;

    const lastSeen = dev.last_seen_at || dev.last_reading_at || dev.updated_at
      ? new Date(dev.last_seen_at || dev.last_reading_at || dev.updated_at).toLocaleString()
      : '—';

    // Name resolution: vFarm uses device_type_label or device_model_name as the display name
    const displayName = dev.name || dev.label || dev.device_name
      || dev.device_type_label || dev.device_model_name || '—';

    // Show type as a small tag for context
    const typeTag = dev.device_type
      ? `<br><small class="muted">${dev.device_type}</small>`
      : '';

    const readingCount = dev.reading_count ?? dev.readings_count ?? dev.child_device_count ?? '—';

    return `
      <tr>
        <td><code>${dev.id || dev.device_id || '—'}</code></td>
        <td><strong>${displayName}</strong>${typeTag}</td>
        <td>${statusPill}</td>
        <td><small class="muted">${lastSeen}</small></td>
        <td>${readingCount}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Device ID</th>
          <th>Name / Label</th>
          <th>Status</th>
          <th>Last Seen</th>
          <th>Readings</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Switch the active farm: tell the server which farm_id to use,
 * then reload the dashboard. No credentials flow to the browser.
 */
async function switchVfarmFarm(farmId) {
  if (!farmId) return;
  try {
    const result = await api('/api/v1/admin/vfarm/select', {
      method: 'POST',
      body: JSON.stringify({ farm_id: farmId }),
    });
    vfarmState.activeFarmId = result.active_farm_id || farmId;
    showToast(`Active farm: ${farmId.slice(0, 8)}…`, 'success');
    await loadVfarmDashboard();
  } catch (err) {
    showError(`Farm switch failed: ${err.message}`);
  }
}

// ── Event Listeners: farm selector & refresh button ──────────────────────────

$('#vfarm-farm-select')?.addEventListener('change', (e) => {
  guarded(() => switchVfarmFarm(e.target.value));
});

$('#btn-refresh-farms')?.addEventListener('click', () => {
  guarded(async () => {
    showToast('Refreshing farms & telemetry…', 'info');
    await loadVfarmFarms();
    await loadVfarmDashboard();
    showToast('vFarm data refreshed.', 'success');
  });
});

/**
 * Combined entrypoint: discover farms, then load the dashboard for the active one.
 */
async function loadVfarmPanel() {
  await loadVfarmFarms();
  await loadVfarmDashboard();
}

// ── 8. vFarm Live E2E Console (admin proxy → live API) ───────────────────────

const vfarmLiveState = {
  deviceId: null,
  results: {},
};

function getVfarmLiveFarmId() {
  return $('#vfarm-live-farm-select')?.value
    || $('#vfarm-farm-select')?.value
    || vfarmState.activeFarmId
    || '';
}

// ── 8a. Farm layout hierarchy map (inline SVG) ──────────────────────────────
// Replaces the raw JSON dump for the `layout` section with a tiered box diagram
// built from the SAME GET /api/v1/admin/vfarm/layout response: farm → zones →
// locations → sublocations. No new endpoint, no charting library: the SVG string
// is assembled here and injected with innerHTML, like every other renderer in
// this file.
//
// All text from the API goes through escapeAdminHtml() before it reaches the
// markup, and no API value is ever placed in an attribute, so a zone named
// `</text><script>` renders as literal text.

const LAYOUT_MAP = {
  zoneW: 224,
  zonePad: 10,
  zoneHeader: 22,
  locHeader: 17,
  locGap: 6,
  locPad: 4,
  subH: 19,
  subGap: 3,
  subInset: 8,
  maxRowW: 980,
};

function truncateLayoutLabel(value, maxChars) {
  const text = String(value ?? '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function layoutBox({ x, y, w, h, cls, label, sublabel, maxLabelChars }) {
  const labelText = truncateLayoutLabel(label || '—', maxLabelChars);
  const baseline = y + (sublabel ? 12 : h / 2 + 3.5);
  const sub = sublabel
    ? `<text class="lm-sub" x="${x + 7}" y="${y + h - 5}">${escapeAdminHtml(truncateLayoutLabel(sublabel, maxLabelChars))}</text>`
    : '';
  return `<g>
    <rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>
    <text class="lm-label" x="${x + 7}" y="${baseline}">${escapeAdminHtml(labelText)}</text>
    ${sub}
  </g>`;
}

function measureVfarmLayoutZone(zone) {
  const { zoneHeader, locHeader, locGap, locPad, subH, subGap } = LAYOUT_MAP;
  const locations = Array.isArray(zone?.locations) ? zone.locations : [];
  const rows = locations.map((loc) => {
    const sublocations = Array.isArray(loc?.sublocations) ? loc.sublocations : [];
    const subBlockH = sublocations.length ? sublocations.length * subH + (sublocations.length - 1) * subGap : 0;
    return { loc, sublocations, height: locHeader + (subBlockH ? subBlockH + locPad : 0) + locPad };
  });
  const bodyH = rows.length
    ? rows.reduce((sum, r) => sum + r.height, 0) + (rows.length - 1) * locGap
    : locPad;
  const sublocations = locations.reduce(
    (sum, l) => sum + (Array.isArray(l?.sublocations) ? l.sublocations.length : 0), 0);
  return { zone, rows, sublocations, height: zoneHeader + bodyH };
}

function renderVfarmLayoutZone(measured, x, y) {
  const { zoneW, zonePad, zoneHeader, locHeader, locGap, locPad, subH, subGap, subInset } = LAYOUT_MAP;
  const { zone, rows, sublocations } = measured;
  const locX = x + zonePad;
  const locW = zoneW - zonePad * 2;
  const parts = [];

  let cursorY = y + zoneHeader;
  for (const row of rows) {
    const { loc, sublocations: subs } = row;
    parts.push(layoutBox({
      x: locX, y: cursorY, w: locW, h: row.height,
      cls: `lm-loc-box${loc?.is_active === false ? ' lm-inactive' : ''}`,
      label: `${loc?.name || loc?.id || 'location'}${loc?.kind ? ` · ${loc.kind}` : ''}`,
      sublabel: subs.length
        ? `${subs.length} sub${subs.length === 1 ? '' : 's'}${loc?.tier_index != null ? ` · tier ${loc.tier_index}` : ''}`
        : (loc?.tier_index != null ? `tier ${loc.tier_index}` : null),
      maxLabelChars: 26,
    }));

    let subY = cursorY + locHeader;
    for (const sub of subs) {
      parts.push(layoutBox({
        x: locX + subInset, y: subY, w: locW - subInset, h: subH,
        cls: `lm-sub-box${sub?.is_active === false ? ' lm-inactive' : ''}`,
        label: `${sub?.name || sub?.id || 'sublocation'}${sub?.bay_index != null ? ` · bay ${sub.bay_index}` : ''}`,
        maxLabelChars: 30,
      }));
      subY += subH + subGap;
    }
    cursorY += row.height + locGap;
  }

  parts.unshift(layoutBox({
    x, y, w: zoneW, h: measured.height,
    cls: `lm-zone-box${zone?.is_active === false ? ' lm-inactive' : ''}`,
    label: `${zone?.name || zone?.id || 'zone'}${zone?.kind ? ` · ${zone.kind}` : ''}`,
    sublabel: `${rows.length} location${rows.length === 1 ? '' : 's'} · ${sublocations} sublocation${sublocations === 1 ? '' : 's'}`,
    maxLabelChars: 28,
  }));

  return parts.join('');
}

function renderVfarmLayoutMap(data) {
  const zones = Array.isArray(data?.zones) ? data.zones : [];

  if (zones.length === 0) {
    return '<p class="lm-empty">No layout on this farm — <code>GET /vfarm/layout</code> returned an empty <code>zones</code> array. Register zones, locations, and sublocations in vFarm, then re-run this check.</p>';
  }

  const { zoneW, zonePad, locGap, maxRowW } = LAYOUT_MAP;
  const perRow = Math.max(1, Math.floor((maxRowW + locGap) / (zoneW + locGap)));
  const columns = Math.min(zones.length, perRow);

  // Measure every zone first so each SVG row can be as tall as its tallest box.
  const measured = zones.map(measureVfarmLayoutZone);
  const rowTops = [];
  let svgH = zonePad;
  for (let i = 0; i < measured.length; i += perRow) {
    rowTops.push(svgH);
    const tallest = measured.slice(i, i + perRow).reduce((max, m) => Math.max(max, m.height), 0);
    svgH += tallest + zonePad;
  }

  const svgW = columns * zoneW + (columns - 1) * locGap + zonePad * 2;
  const markup = measured
    .map((m, i) => renderVfarmLayoutZone(m, zonePad + (i % perRow) * (zoneW + locGap), rowTops[Math.floor(i / perRow)]))
    .join('');

  const locTotal = measured.reduce((sum, m) => sum + m.rows.length, 0);
  const subTotal = measured.reduce((sum, m) => sum + m.sublocations, 0);
  const caption = `${data?.farm_code || data?.farm_id || 'farm'} — ${zones.length} zone(s) · ${locTotal} location(s) · ${subTotal} sublocation(s)`;
  const safeCaption = escapeAdminHtml(caption);

  return `<p class="lm-caption">${safeCaption}</p>
    <svg class="lm-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${safeCaption}" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">${markup}</svg>`;
}

function setVfarmLiveSectionResult(section, ok, payload, errorMessage) {
  const statusEl = $(`#vfarm-e2e-status-${section}`);
  const jsonEl = $(`#vfarm-e2e-json-${section}`);
  vfarmLiveState.results[section] = ok ? 'pass' : 'fail';

  if (statusEl) {
    statusEl.innerHTML = ok
      ? '<span class="pill active">● PASS</span>'
      : `<span class="pill off">✗ FAIL${errorMessage ? `: ${errorMessage}` : ''}</span>`;
  }
  if (jsonEl) {
    // `layout` is the one section rendered graphically instead of as raw JSON;
    // every other section keeps its existing textContent JSON dump untouched.
    if (section === 'layout' && payload != null) {
      jsonEl.innerHTML = renderVfarmLayoutMap(payload);
    } else {
      jsonEl.textContent = payload != null
        ? JSON.stringify(payload, null, 2)
        : (errorMessage || '—');
    }
  }
}

function renderVfarmLiveSummary() {
  const summary = $('#vfarm-live-summary');
  if (!summary) return;
  const sections = ['dashboard', 'farms', 'devices', 'telemetry', 'alerts', 'layout', 'organizations', 'vision'];
  const passed = sections.filter((s) => vfarmLiveState.results[s] === 'pass').length;
  const failed = sections.filter((s) => vfarmLiveState.results[s] === 'fail').length;
  const pending = sections.length - passed - failed;

  summary.innerHTML = `
    <article class="metric-card mint-card">
      <span class="metric-label">PASSED</span>
      <strong>${passed}</strong>
    </article>
    <article class="metric-card coral-card">
      <span class="metric-label">FAILED</span>
      <strong>${failed}</strong>
    </article>
    <article class="metric-card blue-card">
      <span class="metric-label">PENDING</span>
      <strong>${pending}</strong>
    </article>
    <article class="metric-card purple-card">
      <span class="metric-label">ACTIVE FARM</span>
      <strong style="font-size:12px;">${getVfarmLiveFarmId().slice(0, 8) || '—'}…</strong>
    </article>`;
}

async function syncVfarmLiveFarmSelect() {
  await loadVfarmFarms();
  const liveSelect = $('#vfarm-live-farm-select');
  if (!liveSelect) return;
  const current = liveSelect.value;
  liveSelect.replaceChildren(
    ...vfarmState.farms.map((f) => {
      const label = `${f.name || f.id} · ${f.device_count ?? 0} device(s)`;
      return new Option(label, f.id);
    }),
  );
  const toSelect = current && vfarmState.farms.find((f) => f.id === current)
    ? current
    : vfarmState.activeFarmId;
  if (toSelect) liveSelect.value = toSelect;
}

async function runVfarmLiveSection(section) {
  const farmId = getVfarmLiveFarmId();
  const q = farmId ? `?farm_id=${encodeURIComponent(farmId)}` : '';

  try {
    if (section === 'dashboard') {
      const data = await api(`/api/v1/admin/vfarm/dashboard${q}`);
      setVfarmLiveSectionResult('dashboard', true, data);
      return;
    }
    if (section === 'farms') {
      const data = await api('/api/v1/admin/vfarm/farms');
      setVfarmLiveSectionResult('farms', true, data);
      return;
    }
    if (section === 'devices') {
      if (!farmId) throw new Error('Select a farm first');
      const data = await api(`/api/v1/admin/vfarm/devices?farm_id=${encodeURIComponent(farmId)}`);
      vfarmLiveState.deviceId = data?.devices?.[0]?.id || null;
      setVfarmLiveSectionResult('devices', true, data);
      return;
    }
    if (section === 'telemetry') {
      if (!farmId) throw new Error('Select a farm first');
      let deviceId = vfarmLiveState.deviceId;
      if (!deviceId) {
        const devRes = await api(`/api/v1/admin/vfarm/devices?farm_id=${encodeURIComponent(farmId)}`);
        deviceId = devRes?.devices?.[0]?.id;
        vfarmLiveState.deviceId = deviceId;
      }
      // Latest readings across the whole farm (up to 5)
      const latestFarm = await api(`/api/v1/admin/vfarm/readings/latest?farm_id=${encodeURIComponent(farmId)}&limit=5`);
      const payload = { farm_latest: latestFarm };
      if (deviceId) {
        payload.sensor_id = deviceId;
        // Per-sensor: latest reading, history, and 24h rolling stats
        payload.latest = await api(`/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=${encodeURIComponent(deviceId)}`)
          .catch((e) => ({ note: `Sensor-latest unavailable: ${e.message}` }));
        payload.history = await api(`/api/v1/admin/vfarm/readings?sensor_id=${encodeURIComponent(deviceId)}&limit=5`)
          .catch((e) => ({ note: `History unavailable: ${e.message}` }));
        payload.stats = await api(`/api/v1/admin/vfarm/readings/stats?sensor_id=${encodeURIComponent(deviceId)}&window=24h`)
          .catch((e) => ({ note: `Stats unavailable: ${e.message}` }));
      } else {
        payload.note = 'No devices on farm — skipped per-sensor telemetry';
      }
      setVfarmLiveSectionResult('telemetry', true, payload);
      return;
    }
    if (section === 'alerts') {
      if (!farmId) throw new Error('Select a farm first');
      const counts = await api(`/api/v1/admin/vfarm/alerts/counts?farm_id=${encodeURIComponent(farmId)}`);
      const open = await api(`/api/v1/admin/vfarm/alerts/open?farm_id=${encodeURIComponent(farmId)}&limit=10`);
      const history = await api(`/api/v1/admin/vfarm/alerts/history?farm_id=${encodeURIComponent(farmId)}&limit=10`);
      setVfarmLiveSectionResult('alerts', true, { counts, open, history });
      return;
    }
    if (section === 'layout') {
      if (!farmId) throw new Error('Select a farm first');
      const data = await api(`/api/v1/admin/vfarm/layout?farm_id=${encodeURIComponent(farmId)}`);
      setVfarmLiveSectionResult('layout', true, data);
      return;
    }
    if (section === 'organizations') {
      const data = await api('/api/v1/admin/vfarm/organizations');
      setVfarmLiveSectionResult('organizations', true, data);
      return;
    }
    if (section === 'vision') {
      if (!farmId) throw new Error('Select a farm first');
      const data = await api(`/api/v1/admin/vfarm/vision/latest?farm_id=${encodeURIComponent(farmId)}`);
      setVfarmLiveSectionResult('vision', true, data);
      return;
    }
    throw new Error(`Unknown section: ${section}`);
  } catch (err) {
    setVfarmLiveSectionResult(section, false, null, err.message);
  } finally {
    renderVfarmLiveSummary();
    const lastRun = $('#vfarm-live-last-run');
    if (lastRun) lastRun.textContent = new Date().toLocaleString();
  }
}

async function runAllVfarmLiveChecks() {
  const order = ['farms', 'dashboard', 'devices', 'telemetry', 'alerts', 'layout', 'organizations', 'vision'];
  showToast('Running vFarm live E2E checks…', 'info');
  for (const section of order) {
    await runVfarmLiveSection(section);
  }
  const failed = Object.values(vfarmLiveState.results).filter((r) => r === 'fail').length;
  showToast(failed === 0 ? 'All vFarm E2E checks passed.' : `${failed} check(s) failed — see section cards.`, failed === 0 ? 'success' : 'error');
}

async function loadVfarmLiveTab() {
  await syncVfarmLiveFarmSelect();
  renderVfarmLiveSummary();
}

$$('.btn-vfarm-live-section').forEach((btn) => {
  btn.addEventListener('click', () => {
    guarded(() => runVfarmLiveSection(btn.dataset.section));
  });
});

$('#btn-vfarm-live-run-all')?.addEventListener('click', () => guarded(runAllVfarmLiveChecks));
$('#btn-vfarm-live-refresh-farms')?.addEventListener('click', () => guarded(syncVfarmLiveFarmSelect));

// ── 8. Turn Stream (read-only view of GET /api/v1/admin/turn-stream) ─────────
// Reuses the existing admin endpoint. No new backend contract is introduced:
// if the route is unavailable or returns no turns, the tab says so explicitly.

const turnStreamState = { turns: [], available: null, loadedAt: null };

function escapeTurnStreamHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function turnStreamDeliveryBadge(status) {
  if (!status) return '<span class="pill off">no reply</span>';
  const value = String(status).toLowerCase();
  if (['delivered', 'sent', 'success', 'completed'].includes(value)) return `<span class="pill active">${escapeTurnStreamHtml(status)}</span>`;
  if (['failed', 'error', 'undelivered'].includes(value)) {
    return `<span class="pill warn">${escapeTurnStreamHtml(status)}</span>`;
  }
  return `<span class="pill off">${escapeTurnStreamHtml(status)}</span>`;
}

function turnStreamCorrelationBadge(correlated) {
  if (correlated === true) return '<span class="pill active">correlated</span>';
  if (correlated === false) return '<span class="pill warn">turn_id mismatch</span>';
  return '<span class="pill off">no delivery</span>';
}

function renderTurnStreamUnavailable(message) {
  turnStreamState.available = false;
  const summary = $('#turn-stream-summary');
  const list = $('#turn-stream-list');
  const badge = $('#turn-stream-count');
  const source = $('#turn-stream-source');
  if (badge) badge.textContent = '0';
  if (source) source.textContent = 'unavailable';
  if (summary) {
    summary.innerHTML = `
      <div class="metric-card">
        <span class="metric-label">Turn Stream</span>
        <strong class="metric-value">No data</strong>
        <small class="muted">${escapeTurnStreamHtml(message)}</small>
      </div>`;
  }
  if (list) {
    list.dataset.loaded = '1';
    list.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Status</th><th>Detail</th></tr></thead>
        <tbody>${emptyRow(2, `No turn-stream data is currently available. ${escapeTurnStreamHtml(message)}`)}</tbody>
      </table>`;
  }
}

function renderTurnStreamEmpty() {
  turnStreamState.available = true;
  const badge = $('#turn-stream-count');
  const source = $('#turn-stream-source');
  const list = $('#turn-stream-list');
  if (badge) badge.textContent = '0';
  if (source) source.textContent = turnStreamState.loadedAt ? `loaded ${turnStreamState.loadedAt}` : 'empty';
  if (list) list.dataset.loaded = '1';
  $('#turn-stream-summary').innerHTML = `
    <div class="metric-card">
      <span class="metric-label">Turns Recorded</span>
      <strong class="metric-value">0</strong>
      <small class="muted">Endpoint reachable — no turns captured yet.</small>
    </div>`;
  $('#turn-stream-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Received</th><th>Tenant</th><th>Project</th><th>Customer</th>
          <th>Inbound Text</th><th>Turn ID</th><th>Delivery</th><th>Reply</th><th>Correlation</th>
        </tr>
      </thead>
      <tbody>${emptyRow(9, 'No turn-stream data is currently available. The engine has not recorded any inbound turns in this process.')}</tbody>
    </table>`;
}

function renderTurnStream(turns) {
  turnStreamState.available = true;

  const answered = turns.filter((t) => t.delivery_status || t.reply_body).length;
  const mismatched = turns.filter((t) => t.correlated === false).length;
  const failed = turns.filter((t) => ['failed', 'error', 'undelivered'].includes(String(t.delivery_status || '').toLowerCase())).length;

  $('#turn-stream-count').textContent = turns.length;
  $('#turn-stream-source').textContent = turnStreamState.loadedAt ? `loaded ${turnStreamState.loadedAt}` : 'live';

  $('#turn-stream-summary').innerHTML = `
    <div class="metric-card">
      <span class="metric-label">Turns Shown</span>
      <strong class="metric-value">${turns.length}</strong>
      <small class="muted">Inbound turns returned by the endpoint</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">With Reply</span>
      <strong class="metric-value">${answered}</strong>
      <small class="muted">Joined outbound delivery records</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">Correlation Issues</span>
      <strong class="metric-value">${mismatched}</strong>
      <small class="muted">turn_id did not match the outbound record</small>
    </div>
    <div class="metric-card">
      <span class="metric-label">Failed Deliveries</span>
      <strong class="metric-value">${failed}</strong>
      <small class="muted">Outbound status reported an error</small>
    </div>`;

  const rows = turns.map((t) => `
    <tr>
      <td><small class="muted">${escapeTurnStreamHtml(t.received_at ? new Date(t.received_at).toLocaleString() : '—')}</small></td>
      <td><code>${escapeTurnStreamHtml(t.tenant_id || '—')}</code></td>
      <td><code>${escapeTurnStreamHtml(t.project_id || '—')}</code></td>
      <td>${escapeTurnStreamHtml(t.customer_phone || '—')}</td>
      <td><div style="max-width:280px;">${escapeTurnStreamHtml(t.inbound_text || '—')}</div></td>
      <td><code style="font-size:10px;">${escapeTurnStreamHtml(t.turn_id || '—')}</code></td>
      <td>${turnStreamDeliveryBadge(t.delivery_status)}${t.delivery_error ? `<br><small class="muted">${escapeTurnStreamHtml(t.delivery_error)}</small>` : ''}</td>
      <td><div style="max-width:280px;">${escapeTurnStreamHtml(t.reply_body || '—')}</div></td>
      <td>${turnStreamCorrelationBadge(t.correlated)}</td>
    </tr>`).join('');

  $('#turn-stream-list').innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Received</th><th>Tenant</th><th>Project</th><th>Customer</th>
          <th>Inbound Text</th><th>Turn ID</th><th>Delivery</th><th>Reply</th><th>Correlation</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function loadTurnStream() {
  const list = $('#turn-stream-list');
  if (!list) return;

  const params = new URLSearchParams();
  const tenantId = $('#turn-stream-filter-tenant')?.value || '';
  const correlation = $('#turn-stream-filter-correlation')?.value || '';
  const limit = $('#turn-stream-limit')?.value || '100';
  if (tenantId) params.set('tenant_id', tenantId);
  params.set('limit', limit);

  if (list.dataset.loaded !== '1') {
    list.innerHTML = `<table class="admin-table"><tbody>${emptyRow(1, 'Loading turn stream…')}</tbody></table>`;
  }

  let data;
  try {
    data = await api(`/api/v1/admin/turn-stream?${params.toString()}`);
  } catch (err) {
    if (String(err.message).includes('404') || String(err.message).includes('NOT_FOUND')) {
      renderTurnStreamUnavailable('The turn-stream endpoint is not registered on this deployment.');
      return;
    }
    throw err;
  }

  turnStreamState.loadedAt = new Date().toLocaleTimeString();

  const allTurns = Array.isArray(data?.turns) ? data.turns : [];
  if (allTurns.length === 0) {
    renderTurnStreamEmpty();
    return;
  }

  const filtered = correlation === 'correlated'
    ? allTurns.filter((t) => t.correlated === true)
    : correlation === 'uncorrelated'
      ? allTurns.filter((t) => t.correlated !== true)
      : allTurns;

  if (filtered.length === 0) {
    turnStreamState.available = true;
    $('#turn-stream-count').textContent = '0';
    $('#turn-stream-source').textContent = turnStreamState.loadedAt ? `loaded ${turnStreamState.loadedAt}` : 'live';
    $('#turn-stream-summary').innerHTML = `
      <div class="metric-card">
        <span class="metric-label">Turns Shown</span>
        <strong class="metric-value">0</strong>
        <small class="muted">No turns match the selected correlation filter (${allTurns.length} received).</small>
      </div>`;
    list.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Received</th><th>Tenant</th><th>Project</th><th>Customer</th><th>Inbound Text</th><th>Turn ID</th><th>Delivery</th><th>Reply</th><th>Correlation</th></tr></thead>
        <tbody>${emptyRow(9, 'No turns match the selected correlation filter.')}</tbody>
      </table>`;
    list.dataset.loaded = '1';
    return;
  }

  turnStreamState.turns = filtered;
  renderTurnStream(filtered);
  $('#turn-stream-list').dataset.loaded = '1';
}

$('#btn-turn-stream-refresh')?.addEventListener('click', () => guarded(loadTurnStream));
$('#turn-stream-filter-tenant')?.addEventListener('change', () => guarded(loadTurnStream));
$('#turn-stream-filter-correlation')?.addEventListener('change', () => guarded(loadTurnStream));
$('#turn-stream-limit')?.addEventListener('change', () => guarded(loadTurnStream));

// ── Boot & Refresh ───────────────────────────────────────────────────────────

$('#refresh-all')?.addEventListener('click', () => guarded(refreshAll));
$('#reload-health')?.addEventListener('click', () => guarded(loadHealth));

// ── Logout ───────────────────────────────────────────────────────────────────
$('#btn-logout')?.addEventListener('click', async () => {
  const token = localStorage.getItem('cst_admin_token');
  try {
    if (token) {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ token }),
      });
    }
  } catch (_) { /* ignore network errors on logout */ }
  localStorage.removeItem('cst_admin_token');
  localStorage.removeItem('cst_admin_email');
  localStorage.removeItem('cst_admin_name');
  showToast('Signed out successfully.', 'info');
  setTimeout(() => { window.location.replace('/admin/login'); }, 700);
});

async function refreshAll() {
  await loadTenants();
  await loadProjects();
  await loadNumbers();
  await loadSpeakersTab();
  await loadHealth();
  await loadVfarmPanel();
  showToast('All platform data refreshed.', 'info');
}

// ── SMS Consent Spine ─────────────────────────────────────────────────────────

let consentWordings = { version: '—', text: 'Loading…' };

async function loadConsentWordings() {
  try {
    const resp = await api('/api/v1/admin/sms-consent/wording');
    consentWordings = { version: resp.version, text: resp.text };
    $('#consent-wording-version').textContent = resp.version || '—';
    $('#consent-wording-text').textContent = resp.text || 'No wording available.';
  } catch (err) {
    $('#consent-wording-version').textContent = 'error';
    $('#consent-wording-text').textContent = `Failed to load wording: ${err.message}`;
  }
}

async function loadAllConsentRecords() {
  try {
    const tenantSelect = $('#consent-tenant-select');
    const tenantId = tenantSelect?.value;
    const projectId = $('#consent-project-input')?.value || undefined;
    const params = new URLSearchParams();
    if (tenantId) params.set('tenant_id', tenantId);
    if (projectId) params.set('project_id', projectId);

    const resp = await api(`/api/v1/admin/sms-consent?${params.toString()}`);
    const container = $('#consent-records-list');
    if (!resp.consents || resp.consents.length === 0) {
      container.innerHTML = '<p class="muted">No consent records found for this filter.</p>';
      return;
    }
    container.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = `
      <thead><tr>
        <th>Phone (masked)</th>
        <th>Status</th>
        <th>Consented At</th>
        <th>Opted Out At</th>
        <th>Project</th>
        <th>Word. Version</th>
        <th>Source</th>
      </tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    resp.consents.forEach((c) => {
      const row = document.createElement('tr');
      row.className = 'consent-row';
      row.innerHTML = `
        <td>${escapeAdminHtml(c.phone_e164_masked)}</td>
        <td><span class="pill ${c.consent_status === 'opted_in' ? 'on' : c.consent_status === 'opted_out' ? 'off' : 'off'}">${c.consent_status || 'not_consented'}</span></td>
        <td>${c.consented_at ? new Date(c.consented_at).toLocaleString() : '—'}</td>
        <td>${c.opted_out_at ? new Date(c.opted_out_at).toLocaleString() : '—'}</td>
        <td>${escapeAdminHtml(c.project_id || 'all projects')}</td>
        <td>${escapeAdminHtml(c.wording_version || '—')}</td>
        <td>${escapeAdminHtml(c.source || '—')}</td>
      `;
      row.addEventListener('click', () => {
        $('#consent-phone-input').value = c.phone_e164;
        $('#consent-tenant-select').value = c.tenant_id;
        $('#consent-project-input').value = c.project_id || '';
        loadConsentState();
        loadConsentAudit();
      });
      tbody.appendChild(row);
    });
    container.innerHTML = '';
    container.appendChild(table);
  } catch (err) {
    $('#consent-records-list').innerHTML = `<p class="muted">Failed to load consent records: ${err.message}</p>`;
  }
}

async function loadConsentState() {
  const tenantId = $('#consent-tenant-select')?.value;
  const phone = $('#consent-phone-input')?.value;
  const projectId = $('#consent-project-input')?.value || undefined;
  const display = $('#consent-state-display');

  if (!tenantId || !phone) {
    display.innerHTML = '<p class="muted">Enter a tenant and phone number to look up consent state.</p>';
    return;
  }

  try {
    const params = new URLSearchParams({ tenant_id: tenantId });
    if (projectId) params.set('project_id', projectId);
    const resp = await api(`/api/v1/admin/sms-consent/${encodeURIComponent(phone)}?${params.toString()}`);
    display.innerHTML = resp.consent
      ? `<table class="admin-table"><tbody>
          <tr><th>Status</th><td><span class="pill ${resp.consent.consent_status === 'opted_in' ? 'on' : 'off'}">${resp.consent.consent_status}</span></td></tr>
          <tr><th>Consented At</th><td>${resp.consent.consented_at ? new Date(resp.consent.consented_at).toLocaleString() : '—'}</td></tr>
          <tr><th>Opted Out At</th><td>${resp.consent.opted_out_at ? new Date(resp.consent.opted_out_at).toLocaleString() : '—'}</td></tr>
          <tr><th>Word. Version</th><td>${escapeAdminHtml(resp.consent.wording_version || '—')}</td></tr>
          <tr><th>Word. Snapshot</th><td class="wording-text">${escapeAdminHtml(resp.consent.wording_snapshot || '—')}</td></tr>
          <tr><th>Source</th><td>${escapeAdminHtml(resp.consent.source || '—')}</td></tr>
        </tbody></table>`
      : '<p class="muted">No consent record found for this phone. The phone is NOT consented — outbound SMS will be blocked until consent is granted.</p>';
  } catch (err) {
    display.innerHTML = `<p class="muted">Error: ${err.message}</p>`;
  }
}

async function loadConsentAudit() {
  const tenantId = $('#consent-tenant-select')?.value;
  const phone = $('#consent-phone-input')?.value;
  const projectId = $('#consent-project-input')?.value || undefined;
  const container = $('#consent-audit-list');

  if (!tenantId || !phone) {
    container.innerHTML = '<p class="muted">Look up a phone to see consent history.</p>';
    return;
  }

  try {
    const params = new URLSearchParams({ tenant_id: tenantId });
    if (projectId) params.set('project_id', projectId);
    const resp = await api(`/api/v1/admin/sms-consent/${encodeURIComponent(phone)}/history?${params.toString()}`);
    if (!resp.history || resp.history.length === 0) {
      container.innerHTML = '<p class="muted">No consent audit records.</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = `
      <thead><tr>
        <th>Timestamp</th>
        <th>Action</th>
        <th>Previous → New</th>
        <th>Actor</th>
        <th>Source</th>
        <th>Reason</th>
        <th>Correlation ID</th>
      </tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    resp.history.forEach((h) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${new Date(h.created_at).toLocaleString()}</td>
        <td>${escapeAdminHtml(h.action)}</td>
        <td>${escapeAdminHtml(h.previous_status || '—')} → ${escapeAdminHtml(h.new_status)}</td>
        <td>${escapeAdminHtml(h.actor)}</td>
        <td>${escapeAdminHtml(h.source)}</td>
        <td>${escapeAdminHtml(h.reason || '—')}</td>
        <td>${escapeAdminHtml(h.correlation_id)}</td>
      `;
      tbody.appendChild(row);
    });
    container.innerHTML = '';
    container.appendChild(table);
  } catch (err) {
    container.innerHTML = `<p class="muted">Error: ${err.message}</p>`;
  }
}

async function updateConsent(action) {
  const tenantId = $('#consent-tenant-select')?.value;
  const phone = $('#consent-phone-input')?.value;
  const projectId = $('#consent-project-input')?.value || undefined;

  if (!tenantId || !phone) {
    showError('Please enter a tenant and phone number.');
    return;
  }

  try {
    const resp = await api('/api/v1/admin/sms-consent', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId, project_id: projectId, phone_e164: phone, action }),
    });
    showToast(`SMS consent ${action === 'grant' ? 'granted' : 'revoked'} for ${phone}.`, 'info');
    await loadConsentState();
    await loadConsentAudit();
    await loadAllConsentRecords();
  } catch (err) {
    showError(`Failed to ${action} consent: ${err.message}`);
  }
}

// Consent UI event wiring
$('#consent-tenant-select')?.addEventListener('change', () => {
  loadAllConsentRecords();
  $('#consent-project-input')?.value && loadConsentState();
  $('#consent-phone-input')?.value && loadConsentState();
});
$('#consent-phone-input')?.addEventListener('input', () => {
  if ($('#consent-phone-input').value && $('#consent-tenant-select').value) {
    loadConsentState();
    loadConsentAudit();
  }
});
$('#consent-project-input')?.addEventListener('input', () => {
  if ($('#consent-phone-input').value && $('#consent-tenant-select').value) {
    loadConsentState();
    loadConsentAudit();
  }
});
$('#btn-consent-refresh')?.addEventListener('click', () => {
  loadConsentWordings();
  loadAllConsentRecords();
});
$('#btn-consent-grant')?.addEventListener('click', () => updateConsent('grant'));
$('#btn-consent-revoke')?.addEventListener('click', () => updateConsent('revoke'));

// Boot refresh only when a session token is already present. Without this the
// console fires an admin API call before the auth guard has redirected an
// anonymous visitor to /admin/login, producing a 401 in the browser log.
if (localStorage.getItem('cst_admin_token')) {
  guarded(refreshAll);
}

