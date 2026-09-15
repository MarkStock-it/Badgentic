/* Minimal UI logic. Rough styling; redesign the CSS freely. */

const state = {
  session: null,
  jobs: [],
  currentJob: null,
  logSeq: 0,
  pollTimer: null,
};

function el(id) {
  return document.getElementById(id);
}

function show(id) {
  for (const v of ['view-boot', 'view-settings', 'view-jobs', 'view-job']) {
    el(v).classList.toggle('hidden', v !== id);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Agentic-CSRF': '1' },
    credentials: 'same-origin',
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || res.statusText);
    err.code = body.error;
    err.hint = body.hint;
    throw err;
  }
  return body;
}

// ---- bootstrap: ?t=<jwt> → POST /auth/session → strip from URL ----
async function boot() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  if (token) {
    try {
      await api('/api/v1/auth/session', { method: 'POST', body: { token } });
      history.replaceState(null, '', location.pathname); // strip token from URL
    } catch (err) {
      el('identity').textContent = 'Handoff failed: ' + err.message;
    }
  }
  try {
    state.session = await api('/api/v1/auth/session');
    renderIdentity();
    if (!state.session.canvasConnected) {
      el('paste-token-form').classList.remove('hidden');
      el('view-boot').querySelector('h2').textContent = 'Connect Canvas';
      show('view-boot');
      return;
    }
    show('view-jobs');
    refreshJobs();
    if (!state.session.hasGeminiKey && !state.session.hasGroqKey) {
      openSettings('Add an AI key to start jobs.');
    }
    state.pollTimer = setInterval(refreshJobs, 5000);
  } catch {
    el('paste-token-form').classList.remove('hidden');
    el('view-boot').querySelector('h2').textContent = 'Sign in';
    show('view-boot');
  }
}

function renderIdentity() {
  el('identity').textContent = state.session ? `${state.session.name || state.session.userIdHash.slice(0, 12)}…` : 'Not signed in';
}

// ---- paste-token path (b) ----
el('paste-token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // No session yet → bootstrap via /auth/session with a canvas-token-only flow.
    if (!state.session) {
      const res = await fetch('/api/v1/auth/canvas-token-bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: el('canvas-token').value, domain: el('canvas-domain').value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Bootstrap failed');
    } else {
      await api('/api/v1/auth/canvas-token', {
        method: 'POST',
        body: { token: el('canvas-token').value, domain: el('canvas-domain').value },
      });
    }
    await boot();
  } catch (err) {
    alert(err.message);
  }
});

// ---- settings ----
function openSettings(msg = '') {
  el('settings-status').textContent = msg;
  el('view-settings').classList.remove('hidden');
}

el('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (el('set-canvas-token').value && el('set-canvas-domain').value) {
      await api('/api/v1/auth/canvas-token', {
        method: 'POST',
        body: { token: el('set-canvas-token').value, domain: el('set-canvas-domain').value },
      });
    }
    const keys = {};
    if (el('set-gemini-key').value) keys.gemini = el('set-gemini-key').value;
    if (el('set-groq-key').value) keys.groq = el('set-groq-key').value;
    if (Object.keys(keys).length) {
      await api('/api/v1/auth/ai-keys', { method: 'POST', body: keys });
    }
    el('settings-status').textContent = 'Saved.';
    el('set-canvas-token').value = '';
    el('set-gemini-key').value = '';
    el('set-groq-key').value = '';
    state.session = await api('/api/v1/auth/session');
    renderIdentity();
  } catch (err) {
    el('settings-status').textContent = err.message + (err.hint ? ` — ${err.hint}` : '');
  }
});

// ---- jobs ----
async function refreshJobs() {
  if (!state.session) return;
  try {
    const data = await api('/api/v1/jobs?limit=25');
    state.jobs = data.jobs || [];
    renderJobs();
  } catch {
    /* session expired — ignore poll errors */
  }
}

function renderJobs() {
  const list = el('jobs-list');
  if (!state.jobs.length) {
    list.innerHTML = '<p class="muted">No jobs yet. Create one above.</p>';
    return;
  }
  list.innerHTML = '';
  for (const job of state.jobs) {
    const div = document.createElement('div');
    div.className = 'job-row';
    div.innerHTML = `
      <span class="pill state-${job.state}">${job.state}</span>
      <span class="job-title">${escapeHtml(job.title || job.kind)}</span>
      <span class="muted">${new Date(job.updatedAt).toLocaleString()}</span>
    `;
    div.addEventListener('click', () => openJob(job.id));
    list.appendChild(div);
  }
}

el('new-job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const job = await api('/api/v1/jobs', {
      method: 'POST',
      body: {
        kind: el('job-kind').value,
        canvasCourseId: Number(el('job-course').value),
        canvasAssignmentId: Number(el('job-assignment').value),
      },
    });
    await refreshJobs();
    openJob(job.id);
  } catch (err) {
    alert(err.message + (err.hint ? `\n${err.hint}` : ''));
  }
});

// ---- job detail ----
async function openJob(jobId) {
  show('view-job');
  state.logSeq = 0;
  el('job-logs').textContent = '';
  await refreshJob();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshJob, 2000);
}

async function refreshJob() {
  const jobId = state.currentJob?.id || (state.jobs[0] && state.jobs[0].id);
  if (!jobId) return;
  try {
    const { job, latestRun } = await api(`/api/v1/jobs/${jobId}`);
    state.currentJob = job;
    el('job-title').textContent = job.title || job.kind;
    const pill = el('job-state');
    pill.textContent = job.state;
    pill.className = `pill state-${job.state}`;
    el('job-cancel').classList.toggle('hidden', ['COMPLETED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'].includes(job.state));
    el('job-retry').classList.toggle('hidden', job.state !== 'FAILED');
    el('job-download').classList.toggle('hidden', !(job.result && job.result.artifact));
    if (job.result?.artifact) {
      el('job-download').onclick = () => window.open(`/api/v1/artifacts/${job.result.artifact.id}/download`, '_blank');
    }
    const errEl = el('job-error');
    if (job.failureReason) {
      errEl.textContent = job.failureReason;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
    await tailLogs();
    await renderApprovals();
  } catch {
    /* ignore poll errors */
  }
}

async function tailLogs() {
  const run = state.currentJob && (await api(`/api/v1/jobs/${state.currentJob.id}/runs`)).runs[0];
  if (!run) return;
  const { logs, nextSeq } = await api(`/api/v1/runs/${run.id}/logs?sinceSeq=${state.logSeq}`);
  state.logSeq = nextSeq;
  if (logs.length) {
    el('job-logs').textContent += logs.map((l) => `[${l.type}] ${JSON.stringify(l.detail || {})}\n`).join('');
    el('job-logs').scrollTop = el('job-logs').scrollHeight;
  }
}

async function renderApprovals() {
  if (!state.currentJob) return;
  const { approvals } = await api(`/api/v1/jobs/${state.currentJob.id}/approvals`);
  const container = el('job-approvals');
  container.innerHTML = '';
  for (const approval of approvals) {
    const div = document.createElement('div');
    div.className = 'approval';
    const pending = approval.state === 'PENDING';
    div.innerHTML = `
      <strong>${approval.type}</strong>
      <span class="pill">${approval.state}</span>
      <pre class="muted">${escapeHtml(JSON.stringify(approval.payload || {}, null, 2))}</pre>
      ${pending ? '<button class="approve">Approve</button> <button class="danger deny">Deny</button>' : ''}
    `;
    if (pending) {
      div.querySelector('.approve').onclick = () => decide(approval.id, 'approve');
      div.querySelector('.deny').onclick = () => decide(approval.id, 'deny');
    }
    container.appendChild(div);
  }
}

async function decide(approvalId, action) {
  await api(`/api/v1/approvals/${approvalId}/${action}`, { method: 'POST', body: {} });
  await renderApprovals();
}

el('job-cancel').addEventListener('click', async () => {
  if (!state.currentJob) return;
  await api(`/api/v1/jobs/${state.currentJob.id}/cancel`, { method: 'POST', body: {} });
  await refreshJob();
});

el('job-retry').addEventListener('click', async () => {
  if (!state.currentJob) return;
  await api(`/api/v1/jobs/${state.currentJob.id}/retry`, { method: 'POST', body: {} });
  await refreshJob();
});

el('back-to-jobs').addEventListener('click', () => {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.currentJob = null;
  show('view-jobs');
  refreshJobs();
  state.pollTimer = setInterval(refreshJobs, 5000);
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

boot();
