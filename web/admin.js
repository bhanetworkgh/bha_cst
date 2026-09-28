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
  // Session expired – redirect to login
  if (response.status === 401) {
    localStorage.removeItem('cst_admin_token');
    window.location.replace('/admin/login');
    throw new Error('Session expired. Redirecting to login...');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${response.status})`);
  }
  return data;
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

// ── Tabs Navigation ──────────────────────────────────────────────────────────

function activateTab(tab) {
  $$('.admin-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.admin-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-${tab}`));

  // Tab-specific lazy refreshes
  if (tab === 'speakers') loadSpeakers();
  if (tab === 'audit') loadAuditLogs();
  if (tab === 'overview') loadHealth();
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
  ];

  selects.forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    const keepFirst = ['#project-filter-tenant', '#number-sync-tenant', '#speaker-filter-tenant'].includes(selector);
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
  ];

  projectSelects.forEach((selector) => {
    const select = $(selector);
    if (!select) return;
    const keepFirst = selector === '#speaker-filter-project';
    const current = select.value;

    select.replaceChildren(
      ...(keepFirst ? [new Option('All projects', '')] : []),
      ...state.projects.map((p) => new Option(`${p.name} (${p.project_id})`, p.project_id))
    );

    if (current && [...select.options].some((opt) => opt.value === current)) {
      select.value = current;
    }
  });

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

  const rows = filtered.map((speaker) => {
    const avatarLetter = (speaker.customer_ref || speaker.phone_e164).slice(0, 2).toUpperCase();
    const farmChips = (speaker.farm_ids && speaker.farm_ids.length > 0)
      ? speaker.farm_ids.map((farm) => `<span class="tag-chip">${farm}</span>`).join(' ')
      : '<span class="tag-chip-empty">Zero farm grants (Onboarding only)</span>';

    const cachePill = speaker.is_cache_active
      ? `<span class="cache-pill active"><span class="pulse-dot"></span> Active TTL</span>`
      : `<span class="cache-pill expired"><span class="pulse-dot"></span> Expired (Live resolve)</span>`;

    return `
      <tr>
        <td>
          <div class="user-identity-cell">
            <div class="user-avatar">${avatarLetter}</div>
            <div class="user-identity-text">
              <strong>${speaker.customer_ref || 'Unknown Person'}</strong>
              <small>${speaker.phone_e164}</small>
            </div>
          </div>
        </td>
        <td>
          <strong>${speaker.project_id || '—'}</strong><br>
          <small class="muted">${speaker.tenant_id}</small>
        </td>
        <td>
          <span class="role-badge ${speaker.role}">${speaker.role}</span>
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
            <button class="table-btn" data-edit-speaker="${speaker.phone_e164}" data-tenant="${speaker.tenant_id}" data-project="${speaker.project_id}">Edit</button>
            <button class="table-btn" data-invalidate-speaker="${speaker.phone_e164}" data-tenant="${speaker.tenant_id}" data-project="${speaker.project_id}" title="Force fresh resolve on next message">Invalidate</button>
            <button class="table-btn danger" data-delete-speaker="${speaker.phone_e164}" data-tenant="${speaker.tenant_id}" data-project="${speaker.project_id}">Revoke</button>
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
      await loadSpeakers();
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
      await loadSpeakers();
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
    await loadSpeakers();
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
    await loadSpeakers();
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
    await loadSpeakers();
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
      await loadSpeakers();
    });
  }
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
    if (badge) badge.innerHTML = `<span class="pill off">Discovery failed</span>`;
    showError(`Farm discovery failed: ${err.message}`);
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
  await loadSpeakers();
  await loadHealth();
  await loadVfarmPanel();
  showToast('All platform data refreshed.', 'info');
}

guarded(refreshAll);

