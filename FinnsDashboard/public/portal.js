/* Finns Dashboard — portal: sign-in, invitations, dashboard tiles, users and access. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return d ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : `${MONTHS[Number(m) - 1]} ${y}`; };
const fmtStamp = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const compact = (v) => { const a = Math.abs(v || 0); if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'm'; if (a >= 1e3) return '$' + Math.round(v / 1e3).toLocaleString('en-AU') + 'k'; return '$' + Math.round(v || 0); };
const pct = (v) => (v * 100).toFixed(1) + '%';
const { AuthError, callJSON, call, ROLE_LABEL } = FD;

let ME = null, APPS = [], USERS = [];
const ICONS = { debtors: 'ic-debtors', staff: 'ic-staff', wip: 'ic-wip' };
const AREA = { portal: 'Portal', debtors: 'Aged Debtors', staff: 'Staff Performance', wip: 'Aged WIP' };

/* ---------------- shell helpers ---------------- */
function notice(msg, kind) { const n = $('#notice'); if (!msg) { n.hidden = true; return; } n.className = 'notice' + (kind ? ' ' + kind : ''); n.textContent = msg; n.hidden = false; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
function sessionExpired() { $$('dialog[open]').forEach((d) => d.close()); showGate('Your session has ended. Sign in again to continue.'); return false; }
function applyTheme(t) { document.documentElement.dataset.theme = t; FD.prefSet('fdash-theme', t); $('#themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); }
const params = new URLSearchParams(location.search);
const appName = (id) => (APPS.find((a) => a.id === id) || {}).name || AREA[id] || id;

/* ---------------- sign in / invitations ---------------- */
function showGate(msg) {
  ME = null; $('#shell').hidden = true; $('#gate').hidden = false; $('#inviteForm').hidden = true; $('#gateForm').hidden = false;
  const err = $('#gateErr'); err.hidden = !msg; err.textContent = msg || '';
  const next = params.get('next'), why = params.get('expired');
  const note = $('#gateNote');
  if (why) { note.hidden = false; note.textContent = 'Your session ended. Sign in again to return to ' + (AREA[why] || 'the dashboard') + '.'; }
  else if (next) { note.hidden = false; note.textContent = 'Sign in to open ' + (AREA[next] || 'that dashboard') + '. Every dashboard is reached through this page.'; }
  else note.hidden = true;
  setTimeout(() => $('#gateUser').focus(), 30);
}
async function enter() {
  $('#gate').hidden = true; $('#shell').hidden = false;
  try {
    const j = await callJSON('/api/portal');
    ME = j.user; APPS = j.allApps || [];
    document.body.classList.toggle('can-admin', !!ME.admin);
    $('#accountName').textContent = ME.displayName || ME.username;
    $('#accountRole').textContent = ME.admin ? 'Administrator' : 'User';
    $('#pwUser').value = ME.username;
    const next = params.get('next') || params.get('expired');
    const target = next && j.apps.find((a) => a.id === next);
    if (target) { location.replace(target.path); return; }
    const denied = params.get('denied');
    if (denied) notice(`You do not have access to ${AREA[denied] || 'that dashboard'}. Ask an administrator if you need it.`, 'warn');
    if (params.toString()) history.replaceState(null, '', location.pathname);
    renderTiles(j.apps);
  } catch (e) { if (e instanceof AuthError) return sessionExpired(); notice('Could not reach the dashboard server: ' + e.message, 'error'); }
}
function greeting() { const h = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }).format(new Date())); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
function tileStats(a) {
  const s = a.stats;
  if (!s) return '<div class="app-stats"><div class="app-stat"><b>—</b><span>No data loaded yet</span></div></div>';
  if (a.id === 'debtors') return `<div class="app-stats">
    <div class="app-stat"><b>${compact(s.net)}</b><span>Net debt</span></div>
    <div class="app-stat"><b class="warn">${pct(s.over90Share)}</b><span>Over 90 days</span></div>
    <div class="app-stat"><b>${esc(fmtDate(s.asAt))}</b><span>Latest ledger</span></div></div>`;
  if (a.id === 'staff') return `<div class="app-stats">
    <div class="app-stat"><b>${esc(fmtDate(s.latestMonth))}</b><span>Latest month loaded</span></div>
    <div class="app-stat"><b>${s.fyMonths} of 12</b><span>Months in FY ${esc(s.fy.slice(2, 4))}/${esc(s.fy.slice(7))}</span></div>
    <div class="app-stat"><b>${s.months}</b><span>Months held in total</span></div></div>`;
  if (a.id === 'wip') return `<div class="app-stats">
    <div class="app-stat"><b>${compact(s.total)}</b><span>Unbilled WIP</span></div>
    <div class="app-stat"><b class="warn">${pct(s.over90Share)}</b><span>Over 90 days</span></div>
    <div class="app-stat"><b>${esc(fmtDate(s.period))}</b><span>Latest week ending${s.partWeek ? ' (to date)' : ''}</span></div></div>`;
  return '';
}
function tileFoot(a) {
  const s = a.stats;
  if (a.id === 'debtors' && s) return `${s.periods} weekly ledger${s.periods === 1 ? '' : 's'} held`;
  if (a.id === 'staff' && s) return s.updatedAt ? `Last upload ${esc(s.updatedAt.slice(0, 10).split('-').reverse().join('/'))}${s.updatedBy && s.updatedBy !== 'build' ? ' by ' + esc(s.updatedBy) : ''}` : '';
  if (a.id === 'wip' && s) return `${s.periods} period${s.periods === 1 ? '' : 's'} held · excludes WIP on draft invoices`;
  return '';
}
function renderTiles(apps) {
  $('#hello').textContent = `${greeting()}, ${(ME.displayName || ME.username).replace(/\s*\(.*\)\s*$/, '')}`;
  $('#helloSub').textContent = apps.length ? 'Choose a dashboard to open. Your sign-in carries across all of them.' : '';
  $('#appTiles').innerHTML = apps.length ? apps.map((a) => `
    <a class="app-tile" href="${esc(a.path)}" aria-label="Open ${esc(a.name)}">
      <div class="app-head">
        <span class="app-icon"><svg width="24" height="24" aria-hidden="true"><use href="#${ICONS[a.id] || 'ic-app'}"/></svg></span>
        <div class="app-title"><h2>${esc(a.name)}</h2><p class="app-desc">${esc(a.description)}</p></div>
      </div>
      ${tileStats(a)}
      <div class="app-foot"><span>${tileFoot(a)}</span><span class="app-open"><span class="role-chip">${esc(ROLE_LABEL[a.role])}</span> Open <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>
    </a>`).join('') : '<div class="app-empty">You have not been given access to any dashboards yet. Ask an administrator to grant access.</div>';
  $('#portalFoot').textContent = 'Signed in as ' + ME.username + '. Sessions last 12 hours on this device.';
}
async function startInvite(token) {
  $('#gate').hidden = false; $('#shell').hidden = true; $('#gateForm').hidden = true; $('#inviteForm').hidden = false;
  $('#inviteForm').dataset.token = token;
  try {
    const j = await callJSON('/api/invite?token=' + encodeURIComponent(token), {}, true);
    $('#inviteTitle').textContent = j.reset ? 'Reset your password' : 'Set your password';
    $('#inviteSub').textContent = `${j.displayName ? j.displayName + ' · ' : ''}Username: ${j.username}`;
    $('#inviteUser').value = j.username;
    $('#invitePass').focus();
  } catch (e) {
    $('#inviteTitle').textContent = 'Link not valid';
    $('#inviteSub').textContent = e.message;
    $('#inviteBtn').disabled = true;
  }
}

/* ---------------- users ---------------- */
function accessFields(box, prefix, apps, current) {
  box.querySelectorAll('.field').forEach((f) => f.remove());
  for (const a of APPS) {
    const v = (current || {})[a.id] || '';
    box.insertAdjacentHTML('beforeend', `<label class="field"><span>${esc(a.name)}</span><select data-app="${esc(a.id)}" id="${prefix}-${esc(a.id)}">
      <option value="">No access</option><option value="viewer"${v === 'viewer' ? ' selected' : ''}>Viewer</option><option value="editor"${v === 'editor' ? ' selected' : ''}>Editor</option><option value="admin"${v === 'admin' ? ' selected' : ''}>Administrator</option></select></label>`);
  }
}
const readAccess = (box) => Object.fromEntries($$('select[data-app]', box).filter((s) => s.value).map((s) => [s.dataset.app, s.value]));
function syncAdminBox(check, box) { box.disabled = check.checked; }
async function openUsers() { const sel = $('#auditApp'); if (sel.options.length < 2 + APPS.length) for (const a of APPS) sel.insertAdjacentHTML('beforeend', `<option value="${esc(a.id)}">${esc(a.name)}</option>`); $('#usersDialog').showModal(); showUsersTab('users'); accessFields($('#nuAccess'), 'nu', APPS, {}); $('#nuAdmin').checked = false; syncAdminBox($('#nuAdmin'), $('#nuAccess')); await loadUsers(); }
async function loadUsers() {
  try { const j = await callJSON('/api/users'); USERS = j.users; APPS = j.apps || APPS; renderUsers(); }
  catch (e) { if (e instanceof AuthError) return sessionExpired(); $('#usersTable tbody').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`; }
}
function accessChips(u) {
  if (u.admin) return '<span class="access-chip admin">Portal administrator · all dashboards</span>';
  const chips = APPS.filter((a) => u.apps[a.id]).map((a) => `<span class="access-chip">${esc(a.name)}: ${ROLE_LABEL[u.apps[a.id]]}</span>`);
  return chips.length ? chips.join('') : '<span class="access-chip">No access</span>';
}
function renderUsers() {
  $('#usersTable tbody').innerHTML = USERS.map((u) => {
    const self = u.id === ME.id, st = u.status;
    const stLabel = u.status === 'invited' ? 'Invited' : u.status === 'disabled' ? 'Disabled' : 'Active';
    const link = u.status !== 'disabled' ? `<button class="btn btn-ghost btn-sm" type="button" data-ulink="${u.id}">${u.hasPassword ? 'Reset link' : 'New invite link'}</button>` : '';
    const toggle = self ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-utoggle="${u.id}">${u.status === 'disabled' ? 'Enable' : 'Disable'}</button>`;
    const del = self ? '' : `<button class="btn btn-danger btn-sm" type="button" data-udel="${u.id}">Delete</button>`;
    return `<tr><td><strong>${esc(u.displayName || u.username)}</strong>${self ? ' <span class="marker">You</span>' : ''}<div class="sub">${esc(u.username)}</div></td><td>${esc(u.email || '—')}</td><td><div class="access-chips">${accessChips(u)}</div></td><td><span class="status ${st}">${stLabel}</span>${u.invitePending ? `<div class="sub">Link expires ${fmtStamp(new Date(u.inviteExpires).toISOString())}</div>` : ''}</td><td>${u.lastLoginAt ? fmtStamp(u.lastLoginAt) : '—'}</td><td><div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" data-uedit="${u.id}">Edit</button>${link}${toggle}${del}</div></td></tr>`;
  }).join('');
}
function accessSentence(u) {
  if (u.admin) return 'every dashboard (portal administrator)';
  const parts = APPS.filter((a) => u.apps[a.id]).map((a) => `${a.name} (${ROLE_LABEL[u.apps[a.id]]})`);
  return parts.join(' and ') || 'no dashboards';
}
function showInvite(u, token, kind) {
  const link = `${location.origin}${location.pathname}#invite=${token}`;
  $('#inviteBox').classList.remove('hidden');
  $('#inviteBoxText').innerHTML = kind === 'reset'
    ? `Password reset link for <strong>${esc(u.displayName || u.username)}</strong>. Their current password keeps working until they use it.`
    : `Invitation created for <strong>${esc(u.displayName || u.username)}</strong> with access to ${esc(accessSentence(u))}. Send them this link so they can set their password.`;
  $('#inviteLink').value = link;
  const subject = kind === 'reset' ? 'Reset your Finns Dashboard password' : 'Invitation to Finns Dashboard — Finn Roache Lawyers';
  const body = `Hello ${u.displayName || u.username},\n\n${kind === 'reset' ? 'Use this link to set a new password for Finns Dashboard' : 'You have been given access to Finns Dashboard (' + accessSentence(u) + '). Use this link to set your password'} (it works once and expires in 7 days):\n\n${link}\n\nYour username is: ${u.username}\n`;
  $('#inviteMail').href = `mailto:${encodeURIComponent(u.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $('#inviteBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
const AUDIT_LABEL = { login: 'Signed in', logout: 'Signed out', login_failed: 'Failed sign-in', user_invited: 'User invited', user_updated: 'User updated', user_deleted: 'User deleted', invite_reissued: 'Invite link reissued', invite_accepted: 'Invitation accepted', password_reset_issued: 'Password reset link issued', password_reset_completed: 'Password reset completed', password_changed: 'Password changed',
  ledger_uploaded: 'Ledger uploaded', ledger_replaced: 'Ledger replaced', ledger_deleted: 'Ledger deleted', list_uploaded: 'Client list uploaded', contact_saved: 'Contact saved', contact_reverted: 'Contact reverted', group_separated: 'Grouping separated', group_restored: 'Grouping restored',
  month_uploaded: 'Month uploaded', month_replaced: 'Month replaced', month_deleted: 'Month removed', settings_changed: 'Settings changed', name_mapping_changed: 'Name mapping changed', backup_restored: 'Backup restored',
  backup_downloaded: 'Backup downloaded', wip_trust_uploaded: 'Trust balance uploaded', wip_trust_replaced: 'Trust balance replaced', wip_trust_deleted: 'Trust balance deleted',
  wip_period_added: 'WIP period added', wip_period_replaced: 'WIP period replaced', wip_period_deleted: 'WIP period deleted' };
async function auditLoad() {
  $('#auditTable tbody').innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
  const app = $('#auditApp').value;
  try {
    const { entries } = await callJSON('/api/audit?limit=500' + (app ? '&app=' + encodeURIComponent(app) : ''));
    $('#auditTable tbody').innerHTML = entries.map((e) => `<tr><td style="white-space:nowrap">${fmtStamp(e.at)}</td><td>${esc(e.user)}</td><td>${esc(AREA[e.app || 'portal'] || e.app)}</td><td>${esc(AUDIT_LABEL[e.action] || e.action)}</td><td>${esc(e.detail)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
  } catch (e) { if (e instanceof AuthError) return sessionExpired(); $('#auditTable tbody').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`; }
}
function showUsersTab(t) {
  $('#tabUsers').classList.toggle('active', t === 'users'); $('#tabAudit').classList.toggle('active', t !== 'users');
  $('#tabUsers').setAttribute('aria-selected', t === 'users'); $('#tabAudit').setAttribute('aria-selected', t !== 'users');
  $('#usersPane').hidden = t !== 'users'; $('#auditPane').hidden = t === 'users';
  if (t !== 'users') auditLoad();
}

/* ---------------- wiring ---------------- */
function wire() {
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = $('#gateBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const j = await callJSON('/api/login', { method: 'POST', json: { username: $('#gateUser').value, password: $('#gatePass').value } }, true);
      FD.writeTok(j.token, 12 * 3600); $('#gatePass').value = ''; await enter();
    } catch (err) { const el = $('#gateErr'); el.hidden = false; el.textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  $('#inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#inviteErr'); err.hidden = true;
    if ($('#invitePass').value !== $('#invitePass2').value) { err.hidden = false; err.textContent = 'The two passwords do not match.'; return; }
    try {
      const j = await callJSON('/api/invite/accept', { method: 'POST', json: { token: $('#inviteForm').dataset.token, password: $('#invitePass').value } }, true);
      FD.writeTok(j.token, 12 * 3600); history.replaceState(null, '', location.pathname + location.search); await enter();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
  });
  $('#inviteBack').addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname + location.search); showGate(''); });

  $('#accountBtn').addEventListener('click', () => { const m = $('#accountMenu'); m.hidden = !m.hidden; $('#accountBtn').setAttribute('aria-expanded', String(!m.hidden)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.account')) { $('#accountMenu').hidden = true; $('#accountBtn').setAttribute('aria-expanded', 'false'); } });
  $('#signOut').addEventListener('click', async () => { try { await call('/api/logout', { method: 'POST' }, true); } catch (e) { /* */ } FD.writeTok('', 0); showGate(''); });
  $('#pwOpen').addEventListener('click', () => { $('#accountMenu').hidden = true; $('#pwForm').reset(); $('#pwErr').hidden = true; $('#pwDialog').showModal(); });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#pwErr'); err.hidden = true;
    if ($('#pwNext').value !== $('#pwNext2').value) { err.hidden = false; err.textContent = 'The new passwords do not match.'; return; }
    try { await callJSON('/api/me/password', { method: 'POST', json: { current: $('#pwCurrent').value, next: $('#pwNext').value } }); $('#pwDialog').close(); toast('Password changed. Other sessions have been signed out.'); }
    catch (ex) { if (ex instanceof AuthError) return sessionExpired(); err.hidden = false; err.textContent = ex.message; }
  });
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog.dlg').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('#usersOpen').addEventListener('click', openUsers);
  $('#tabUsers').addEventListener('click', () => showUsersTab('users'));
  $('#tabAudit').addEventListener('click', () => showUsersTab('audit'));
  $('#auditApp').addEventListener('change', auditLoad);
  $('#nuAdmin').addEventListener('change', () => syncAdminBox($('#nuAdmin'), $('#nuAccess')));
  $('#euAdmin').addEventListener('change', () => syncAdminBox($('#euAdmin'), $('#euAccess')));
  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#nuErr'); err.hidden = true;
    try {
      const j = await callJSON('/api/users', { method: 'POST', json: { username: $('#nuUser').value.trim(), displayName: $('#nuName').value.trim(), email: $('#nuEmail').value.trim(), admin: $('#nuAdmin').checked, apps: readAccess($('#nuAccess')) } });
      $('#addUserForm').reset(); accessFields($('#nuAccess'), 'nu', APPS, {}); syncAdminBox($('#nuAdmin'), $('#nuAccess'));
      await loadUsers(); showInvite(j.user, j.inviteToken, 'invite');
    } catch (ex) { if (ex instanceof AuthError) return sessionExpired(); err.hidden = false; err.textContent = ex.message; }
  });
  $('#inviteCopy').addEventListener('click', async () => { const i = $('#inviteLink'); i.select(); try { await navigator.clipboard.writeText(i.value); toast('Link copied.'); } catch (e) { toast('Link selected — copy it with Ctrl+C.'); } });
  $('#usersTable').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.uedit || b.dataset.ulink || b.dataset.utoggle || b.dataset.udel, u = USERS.find((x) => x.id === id); if (!u) return;
    try {
      if (b.dataset.uedit) {
        $('#euTitle').textContent = u.displayName || u.username; $('#euSub').textContent = 'Username: ' + u.username;
        $('#euName').value = u.displayName || ''; $('#euEmail').value = u.email || '';
        $('#euAdmin').checked = !!u.admin; accessFields($('#euAccess'), 'eu', APPS, u.admin ? {} : u.apps); syncAdminBox($('#euAdmin'), $('#euAccess'));
        $('#editUserForm').dataset.id = u.id; $('#euErr').hidden = true; $('#editUserDialog').showModal();
      } else if (b.dataset.ulink) {
        const j = await callJSON(`/api/users/${u.id}/reset`, { method: 'POST' }); await loadUsers(); showInvite(j.user, j.inviteToken, u.hasPassword ? 'reset' : 'invite');
      } else if (b.dataset.utoggle) {
        const next = u.status === 'disabled' ? 'active' : 'disabled';
        if (next === 'disabled' && !confirm(`Disable ${u.displayName || u.username}? They will be signed out of every dashboard and unable to sign in until re-enabled.`)) return;
        await callJSON(`/api/users/${u.id}`, { method: 'PATCH', json: { status: next } }); await loadUsers(); toast(next === 'disabled' ? 'User disabled.' : 'User enabled.');
      } else if (b.dataset.udel) {
        if (!confirm(`Delete ${u.displayName || u.username} permanently? Their activity history is kept in the log.`)) return;
        await callJSON(`/api/users/${u.id}`, { method: 'DELETE' }); await loadUsers(); toast('User deleted.');
      }
    } catch (ex) { if (ex instanceof AuthError) return sessionExpired(); alert(ex.message); }
  });
  $('#editUserForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#euErr'); err.hidden = true;
    try {
      const j = await callJSON(`/api/users/${$('#editUserForm').dataset.id}`, { method: 'PATCH', json: { displayName: $('#euName').value.trim(), email: $('#euEmail').value.trim(), admin: $('#euAdmin').checked, apps: readAccess($('#euAccess')) } });
      $('#editUserDialog').close(); await loadUsers(); toast('User updated.');
      if (j.user.id === ME.id) { ME = { ...ME, ...j.user }; $('#accountName').textContent = ME.displayName || ME.username; }
    } catch (ex) { if (ex instanceof AuthError) return sessionExpired(); err.hidden = false; err.textContent = ex.message; }
  });
}

/* ---------------- boot ---------------- */
(async function boot() {
  const theme = FD.prefGet('fdash-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
  wire();
  const inv = (location.hash.match(/^#invite=([A-Za-z0-9_-]{10,100})$/) || [])[1];
  if (inv) return startInvite(inv);
  if (!FD.readTok()) return showGate('');
  try {
    const r = await call('/api/session', {}, true);
    if (r.ok) return enter();
  } catch (e) { /* offline */ }
  showGate('');
})();
