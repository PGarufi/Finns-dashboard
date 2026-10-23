// Finns Dashboard portal server — one shared sign-in for Aged Debtors, Staff Performance and Aged WIP.
// No external dependencies. Static files come from public/ (allow-list); the API lives under /api.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const A = require('./lib/auth');
const D = require('./lib/debtors');
const ST = require('./lib/staff');
const W = require('./lib/wip');

const PORT = +process.env.PORT || 5000;
const PUB = path.join(__dirname, 'public');
const MAX_BODY = Math.floor(9.5 * 1024 * 1024);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };
const STATIC = new Set();
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else STATIC.add('/' + path.relative(PUB, p).split(path.sep).join('/')); } })(PUB);

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' };
function stats(app) { try { return app === 'debtors' ? D.stats() : app === 'staff' ? ST.stats() : app === 'wip' ? W.stats() : null; } catch (e) { console.error(e); return null; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname.replace(/^\/port\/5000(?=\/)/, '');
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = (code, body, headers) => { if (!res.headersSent) { res.writeHead(code, Object.assign({}, SECURITY, headers)); res.end(body); } };
  const sendRaw = (code, str, type) => { const buf = Buffer.isBuffer(str) ? str : Buffer.from(str); if (gz && buf.length > 2048) return out(code, zlib.gzipSync(buf), { 'content-type': type, 'content-encoding': 'gzip' }); out(code, buf, { 'content-type': type }); };
  if (p.startsWith('/api/')) {
    const ctx = {
      req, method: req.method, path: p, query: url.searchParams, user: null, stats,
      send: (code, obj) => sendRaw(code, JSON.stringify(obj), 'application/json'),
      sendRaw,
      sendGz: (buf) => gz ? out(200, buf, { 'content-type': 'application/json', 'content-encoding': 'gzip' }) : out(200, zlib.gunzipSync(buf), { 'content-type': 'application/json' }),
      download: (buf, name) => out(200, buf, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${String(name).replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` }),
      fileName: (dflt) => { let n = String(req.headers['x-file-name'] || req.headers['x-filename'] || dflt); try { n = decodeURIComponent(n); } catch (e) { /* keep */ } return n.replace(/[\\/]/g, '_').slice(0, 200) || dflt; },
      body: () => new Promise((resolve, reject) => {
        const chunks = []; let n = 0;
        req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(A.err(413, 'too_large')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
      }),
    };
    ctx.json = async () => { const b = await ctx.body(); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw A.err(400, 'bad_json', 'The request could not be read.'); } };
    try {
      if (await A.route(ctx) !== null || res.headersSent) return;
      // Full data backup for administrators (used to carry live data across a republish).
      if (p === '/api/admin/backup' && req.method === 'GET') {
        if (!ctx.user.admin) throw A.err(403, 'forbidden');
        const S = require('./lib/store'), files = {};
        (function walk(rel) { for (const f of fs.readdirSync(path.join(S.ROOT, rel))) { const r = rel ? rel + '/' + f : f; const st = fs.statSync(path.join(S.ROOT, r)); if (st.isDirectory()) walk(r); else if (!f.endsWith('.tmp')) files[r] = fs.readFileSync(path.join(S.ROOT, r)).toString('base64'); } })('');
        A.audit(ctx.user, 'portal', 'backup_downloaded', Object.keys(files).length + ' files');
        return sendRaw(200, JSON.stringify({ at: new Date().toISOString(), files }), 'application/json');
      }
      const m = /^\/api\/(debtors|staff|wip)(\/|$)/.exec(p);
      if (m) {
        const app = m[1], role = A.roleFor(ctx.user, app), R = A.ROLES;
        const need = (min, msg) => { if (!role) throw A.err(403, 'no_access'); if (R.indexOf(role) < R.indexOf(min)) throw A.err(403, 'forbidden', msg); };
        const mod = app === 'debtors' ? D : app === 'staff' ? ST : W;
        if (await mod.route(ctx, need) !== null || res.headersSent) { if (app === 'debtors' && req.method === 'PUT' && /\/lists\//.test(p)) W.resetLeap(); return; }
      }
      return ctx.send(404, { error: 'not_found', message: 'Not found.' });
    } catch (e) {
      if (!e.status) console.error(e);
      return ctx.send(e.status || 500, { error: e.code || 'server_error', message: e.status ? (e.message || undefined) : 'Something went wrong on the server.' });
    }
  }
  // static
  if (req.method !== 'GET' && req.method !== 'HEAD') return out(405, 'Method not allowed', { 'content-type': 'text/plain' });
  if (p.endsWith('/')) p += 'index.html';
  if (!STATIC.has(p)) return out(404, 'Not found', { 'content-type': 'text/plain' });
  const ext = path.extname(p), type = TYPES[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(path.join(PUB, p));
  const h = { 'content-type': type, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' };
  if (gz && /text|javascript|json|svg/.test(type) && buf.length > 1024) { h['content-encoding'] = 'gzip'; return out(200, zlib.gzipSync(buf), h); }
  out(200, buf, h);
});
setImmediate(() => { try { D.build(); } catch (e) { console.error(e); } });
server.listen(PORT, () => console.log('Finns Dashboard portal on :' + PORT));
