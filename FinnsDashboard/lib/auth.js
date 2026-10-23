// Finns Dashboard — users, sessions, invitations and the activity log.
'use strict';
const crypto = require('crypto');
const S = require('./store');

const SESSION_MS = 12 * 3600 * 1000;
const INVITE_MS = 7 * 24 * 3600 * 1000;
const ROLES = ['viewer', 'editor', 'admin'];
const APPS = [
  { id: 'debtors', name: 'Aged Debtors', description: 'Receivables by client, matter and invoice, with ageing, weekly movement and matter statements.', path: 'debtors/index.html' },
  { id: 'staff', name: 'Staff Performance', description: 'Pay and super against receipted and invoiced work, measured against each staff member’s target.', path: 'staff/index.html' },
  { id: 'wip', name: 'Aged WIP', description: 'Unbilled work in progress by client, matter and staff, split between professional fees and on-costs.', path: 'wip/index.html' },
];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex') }; }
function checkPw(pw, u) { if (!u.pw) return false; const h = hashPw(pw, u.pw.salt).hash; return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.pw.hash, 'hex')); }

let db = S.readJSON('auth.json', null) || { users: [], sessions: {} };
function save() { S.writeJSON('auth.json', db); }
function prune() { const now = Date.now(); for (const k of Object.keys(db.sessions)) if (db.sessions[k].expires < now) delete db.sessions[k]; }

function audit(user, app, action, detail) {
  S.appendLine('audit.jsonl', JSON.stringify({ at: new Date().toISOString(), user: user ? (user.username || user) : '—', app: app || 'portal', action, detail: detail || '' }));
}
function auditRead(limit, app) {
  const raw = (S.readBuf('audit.jsonl') || Buffer.from('')).toString('utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = raw.length - 1; i >= 0 && out.length < limit; i--) { try { const e = JSON.parse(raw[i]); if (!app || (e.app || 'portal') === app) out.push(e); } catch (x) { /* skip */ } }
  return out;
}

const byId = (id) => db.users.find((u) => u.id === id);
const byName = (n) => db.users.find((u) => u.username.toLowerCase() === String(n || '').trim().toLowerCase());
function roleFor(u, app) { if (!u || u.status !== 'active') return ''; if (u.admin) return 'admin'; const r = (u.apps || {})[app]; return ROLES.includes(r) ? r : ''; }
function pub(u) {
  return { id: u.id, username: u.username, displayName: u.displayName || '', email: u.email || '', admin: !!u.admin, apps: u.admin ? {} : (u.apps || {}), status: u.status,
    hasPassword: !!u.pw, invitePending: !!(u.invite && u.invite.expires > Date.now()), inviteExpires: u.invite ? u.invite.expires : null, lastLoginAt: u.lastLoginAt || null };
}
function me(u) { return { id: u.id, username: u.username, displayName: u.displayName || '', email: u.email || '', admin: !!u.admin }; }

function newSession(u) { prune(); const t = token(); db.sessions[sha(t)] = { uid: u.id, expires: Date.now() + SESSION_MS }; u.lastLoginAt = new Date().toISOString(); save(); return t; }
function sessionUser(req) {
  const t = req.headers['x-session']; if (!t || typeof t !== 'string' || t.length > 200) return null;
  const s = db.sessions[sha(t)]; if (!s || s.expires < Date.now()) return null;
  const u = byId(s.uid); if (!u || u.status !== 'active') return null;
  return u;
}
function endSession(req) { const t = req.headers['x-session']; if (t) { delete db.sessions[sha(t)]; save(); } }
function killSessions(uid, keepReq) { const keep = keepReq && keepReq.headers['x-session'] ? sha(keepReq.headers['x-session']) : null; for (const k of Object.keys(db.sessions)) if (db.sessions[k].uid === uid && k !== keep) delete db.sessions[k]; }

function issueInvite(u, reset) { const t = token(); u.invite = { hash: sha(t), expires: Date.now() + INVITE_MS, reset: !!reset }; return t; }
function inviteUser(t) { if (!t || typeof t !== 'string') return null; const h = sha(t); const u = db.users.find((x) => x.invite && x.invite.hash === h); return u && u.invite.expires > Date.now() && u.status !== 'disabled' ? u : null; }

/* rate limits */
const attempts = new Map(), writes = new Map();
function limited(map, key, max, windowMs) {
  const now = Date.now(), a = (map.get(key) || []).filter((t) => now - t < windowMs); a.push(now); map.set(key, a); return a.length > max;
}
function clientIp(req) { const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean); return (xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || '').slice(0, 64); }
setInterval(() => { const now = Date.now(); for (const m of [attempts, writes]) { for (const [k, a] of m) if (!a.length || now - a[a.length - 1] > 15 * 60e3) m.delete(k); if (m.size > 50000) m.clear(); } }, 5 * 60e3).unref();

const pwProblem = (pw) => (typeof pw !== 'string' || pw.length < 10) ? 'Use at least 10 characters.' : pw.length > 200 ? 'That password is too long.' : null;
function cleanApps(apps) { const o = {}; for (const a of APPS) { const r = (apps || {})[a.id]; if (ROLES.includes(r)) o[a.id] = r; } return o; }
const err = (status, error, message) => Object.assign(new Error(message || ''), { status, code: error });

/* Route handlers. ctx = { req, method, path, query, body(), json(), send(code,obj) } */
async function route(ctx) {
  const { req, method, path: p } = ctx;
  if (p === '/api/login' && method === 'POST') {
    const b = await ctx.json(); const ip = clientIp(req);
    const uname = String(b.username || '').toLowerCase().slice(0, 60);
    if (limited(attempts, ip + '|' + uname, 8, 10 * 60e3) || limited(attempts, ip, 40, 10 * 60e3) || limited(attempts, 'user|' + uname, 25, 10 * 60e3)) throw err(429, 'too_many_attempts');
    const u = byName(b.username);
    if (!u || !checkPw(b.password || '', u)) { audit(String(b.username || '').slice(0, 60) || '—', 'portal', 'login_failed', ''); throw err(401, 'invalid_credentials'); }
    if (u.status === 'disabled') throw err(403, 'account_disabled');
    if (u.status !== 'active') throw err(401, 'invalid_credentials');
    const t = newSession(u); audit(u, 'portal', 'login', '');
    return ctx.send(200, { token: t, user: me(u) });
  }
  if (p === '/api/logout' && method === 'POST') { const u = sessionUser(req); endSession(req); if (u) audit(u, 'portal', 'logout', ''); return ctx.send(200, { ok: true }); }
  if (p === '/api/invite' && method === 'GET') {
    const u = inviteUser(ctx.query.get('token')); if (!u) throw err(404, 'invite_invalid');
    return ctx.send(200, { username: u.username, displayName: u.displayName || '', reset: !!u.invite.reset });
  }
  if (p === '/api/invite/accept' && method === 'POST') {
    const b = await ctx.json(); if (limited(attempts, clientIp(req) + '|invite', 20, 10 * 60e3)) throw err(429, 'too_many_attempts');
    const u = inviteUser(b.token); if (!u) throw err(404, 'invite_invalid');
    const prob = pwProblem(b.password); if (prob) throw err(400, 'weak_password', prob);
    const wasReset = !!u.invite.reset; u.pw = hashPw(b.password); u.invite = null; u.status = 'active'; killSessions(u.id);
    const t = newSession(u); audit(u, 'portal', wasReset ? 'password_reset_completed' : 'invite_accepted', '');
    return ctx.send(200, { token: t, user: me(u) });
  }

  const u = sessionUser(req);
  if (!u) throw err(401, 'unauthorised', 'Your session has ended. Sign in again.');
  ctx.user = u;
  if (method !== 'GET' && limited(writes, u.id, 240, 60e3)) throw err(429, 'too_many_writes');

  if (p === '/api/session' && method === 'GET') return ctx.send(200, { user: me(u), apps: APPS.map((a) => ({ id: a.id, name: a.name, role: roleFor(u, a.id) })) });
  if (p === '/api/portal' && method === 'GET') {
    const apps = APPS.filter((a) => roleFor(u, a.id)).map((a) => ({ ...a, role: roleFor(u, a.id), stats: ctx.stats(a.id) }));
    return ctx.send(200, { user: me(u), apps, allApps: APPS.map(({ id, name, description }) => ({ id, name, description })) });
  }
  if (p === '/api/me/password' && method === 'POST') {
    const b = await ctx.json(); if (!checkPw(b.current || '', u)) throw err(400, 'bad_password', 'Your current password is not correct.');
    const prob = pwProblem(b.next); if (prob) throw err(400, 'weak_password', prob);
    u.pw = hashPw(b.next); killSessions(u.id, req); save(); audit(u, 'portal', 'password_changed', ''); return ctx.send(200, { ok: true });
  }

  // administration
  if (p === '/api/audit' || p.startsWith('/api/users')) {
    if (!u.admin) throw err(403, 'forbidden');
    if (p === '/api/audit' && method === 'GET') return ctx.send(200, { entries: auditRead(Math.min(2000, +ctx.query.get('limit') || 500), ctx.query.get('app') || '') });
    if (p === '/api/users' && method === 'GET') return ctx.send(200, { users: db.users.map(pub), apps: APPS.map(({ id, name }) => ({ id, name })) });
    if (p === '/api/users' && method === 'POST') {
      const b = await ctx.json(); const username = String(b.username || '').trim();
      if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) throw err(400, 'bad_username', 'Usernames are 3–60 letters, numbers, dots, dashes, underscores or @.');
      if (byName(username)) throw err(409, 'exists', 'That username is already in use.');
      const nu = { id: crypto.randomUUID(), username, displayName: String(b.displayName || '').slice(0, 80), email: String(b.email || '').slice(0, 120), admin: !!b.admin, apps: b.admin ? {} : cleanApps(b.apps), status: 'invited', pw: null, createdAt: new Date().toISOString() };
      const t = issueInvite(nu, false); db.users.push(nu); save();
      audit(u, 'portal', 'user_invited', `${username}${nu.admin ? ' (administrator)' : ''}`);
      return ctx.send(200, { user: pub(nu), inviteToken: t });
    }
    const m = /^\/api\/users\/([\w-]+)(\/reset)?$/.exec(p); const t = m && byId(m[1]);
    if (!t) throw err(404, 'not_found', 'User not found.');
    if (m[2] && method === 'POST') {
      if (t.status === 'disabled') throw err(400, 'disabled', 'Enable the user first.');
      const tok = issueInvite(t, !!t.pw); save(); audit(u, 'portal', t.pw ? 'password_reset_issued' : 'invite_reissued', t.username);
      return ctx.send(200, { user: pub(t), inviteToken: tok });
    }
    if (method === 'PATCH') {
      const b = await ctx.json(); const self = t.id === u.id;
      if ('displayName' in b) t.displayName = String(b.displayName || '').slice(0, 80);
      if ('email' in b) t.email = String(b.email || '').slice(0, 120);
      if ('admin' in b) { if (self && !b.admin) throw err(400, 'self', 'You cannot remove your own administrator access.'); t.admin = !!b.admin; }
      if ('apps' in b) t.apps = cleanApps(b.apps);
      if ('status' in b) {
        if (self) throw err(400, 'self', 'You cannot disable your own account.');
        if (b.status === 'disabled') { t.status = 'disabled'; killSessions(t.id); }
        else if (b.status === 'active') t.status = t.pw ? 'active' : 'invited';
      }
      save(); audit(u, 'portal', 'user_updated', t.username + ('status' in b ? ' → ' + t.status : ''));
      return ctx.send(200, { user: pub(t) });
    }
    if (method === 'DELETE') {
      if (t.id === u.id) throw err(400, 'self', 'You cannot delete your own account.');
      db.users = db.users.filter((x) => x.id !== t.id); killSessions(t.id); save(); audit(u, 'portal', 'user_deleted', t.username);
      return ctx.send(200, { ok: true });
    }
  }
  return null; // not handled here
}

/* Create the first administrator when no users exist. Returns a one-time invite token. */
function bootstrap(username, displayName) {
  if (db.users.length) return null;
  const nu = { id: crypto.randomUUID(), username, displayName: displayName || username, email: '', admin: true, apps: {}, status: 'invited', pw: null, createdAt: new Date().toISOString() };
  const t = issueInvite(nu, false); db.users.push(nu); save(); audit('system', 'portal', 'user_invited', username + ' (administrator, initial set-up)');
  return t;
}
function setPassword(username, pw) { const u = byName(username); if (!u) return false; u.pw = hashPw(pw); u.status = 'active'; u.invite = null; save(); return true; }

function addInvited(spec) {
  if (byName(spec.username)) return null;
  const nu = { id: crypto.randomUUID(), username: spec.username, displayName: spec.displayName || '', email: spec.email || '', admin: !!spec.admin, apps: spec.admin ? {} : cleanApps(spec.apps), status: 'invited', pw: null, createdAt: new Date().toISOString() };
  const t = issueInvite(nu, false); db.users.push(nu); save(); audit('system', 'portal', 'user_invited', spec.username + ' (re-created after rebuild)'); return t;
}
module.exports = { addInvited, route, roleFor, audit, APPS, ROLES, err, bootstrap, setPassword, sessionUser };
