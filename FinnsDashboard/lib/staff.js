// Finns Dashboard — Staff Performance shared store (/api/staff/*).
'use strict';
const S = require('./store');
const { err, audit } = require('./auth');

const KINDS = ['pay', 'receipts', 'invoiced'];
const LABEL = { pay: 'pay categories', receipts: 'receipts', invoiced: 'invoiced' };
let st = S.readJSON('staff/state.json', null) || { rev: 0, months: {}, aliases: {}, settings: { mult: 3.5, green: 100, amber: 85 }, latest: null };
function save() { st.rev++; S.writeJSON('staff/state.json', st); }
const stamp = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(',', '');
const out = () => ({ rev: st.rev, months: st.months, aliases: st.aliases, settings: st.settings, latest: st.latest, serverTime: new Date().toISOString() });
const okMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const num = (v) => { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);
function cleanRows(kind, rows) {
  if (!Array.isArray(rows) || rows.length > 5000) throw err(400, 'bad_rows', 'The report rows could not be read.');
  return rows.map((r) => kind === 'pay' ? { name: str(r.name), loc: str(r.loc), cat: str(r.cat), amt: num(r.amt), sup: num(r.sup) } : { name: str(r.name), amt: num(r.amt) });
}
function fyOf(m) { const [y, mo] = m.split('-').map(Number); const s = mo >= 7 ? y : y - 1; return s + '-' + (s + 1); }

function stats() {
  const ms = Object.keys(st.months).sort(); if (!ms.length) return null;
  const last = ms[ms.length - 1], fy = fyOf(last);
  return { latestMonth: last, fy, fyMonths: ms.filter((m) => fyOf(m) === fy).length, months: ms.length, updatedAt: st.latest ? String(st.latest.at || '').replace(' ', 'T') : '', updatedBy: st.latest ? st.latest.by : '' };
}

async function route(ctx, need) {
  const { method } = ctx, p = ctx.path.replace(/^\/api\/staff/, '') || '/';
  need('viewer');
  if (p === '/state' && method === 'GET') return ctx.send(200, out());
  if (p === '/rev' && method === 'GET') return ctx.send(200, { rev: st.rev });
  if (p === '/settings' && method === 'POST') {
    need('editor'); const b = await ctx.json();
    const mult = Number(b.mult), green = Number(b.green), amber = Number(b.amber);
    if (!(mult > 0 && mult < 50) || !(green > 0 && green < 1000) || !(amber > 0 && amber <= green)) throw err(400, 'bad_settings', 'Check the target multiple and the traffic-light thresholds.');
    st.settings = { mult, green, amber }; save(); audit(ctx.user, 'staff', 'settings_changed', `Multiple ${mult} · green ${green}% · amber ${amber}%`);
    return ctx.send(200, { rev: st.rev, settings: st.settings });
  }
  if (p === '/aliases' && method === 'POST') {
    need('editor'); const b = await ctx.json(); const a = {};
    for (const [k, v] of Object.entries(b.aliases || {}).slice(0, 2000)) a[str(k)] = str(v);
    st.aliases = a; save(); audit(ctx.user, 'staff', 'name_mapping_changed', Object.keys(a).length + ' mappings');
    return ctx.send(200, { rev: st.rev });
  }
  if (p === '/month' && method === 'POST') {
    need('editor'); const b = await ctx.json();
    if (!okMonth(b.month) || !KINDS.includes(b.kind)) throw err(400, 'bad_month', 'The report month or type was not recognised.');
    const rows = cleanRows(b.kind, b.rows);
    const m = st.months[b.month] || (st.months[b.month] = { pay: [], receipts: [], invoiced: [], sources: {}, loadedAt: '', by: {} });
    const replaced = (m[b.kind] || []).length;
    m[b.kind] = rows; m.sources = m.sources || {}; m.sources[b.kind] = str(b.file, 200); m.by = m.by || {}; m.by[b.kind] = ctx.user.username; m.loadedAt = stamp();
    st.latest = { month: b.month, kind: b.kind, filename: str(b.file, 200), at: m.loadedAt, by: ctx.user.username };
    save(); audit(ctx.user, 'staff', replaced ? 'month_replaced' : 'month_uploaded', `${b.month} ${LABEL[b.kind]} · ${rows.length} rows · ${str(b.file, 200)}`);
    return ctx.send(200, Object.assign(out(), { saved: { rows: rows.length, replaced } }));
  }
  if (p === '/month' && method === 'DELETE') {
    need('admin'); const m = ctx.query.get('m'); if (!okMonth(m) || !st.months[m]) throw err(404, 'not_found', 'That month is not held.');
    delete st.months[m]; save(); audit(ctx.user, 'staff', 'month_deleted', m);
    return ctx.send(200, out());
  }
  if (p === '/import' && method === 'POST') {
    need('admin'); const b = await ctx.json(); const months = {};
    for (const [m, d] of Object.entries(b.months || {})) {
      if (!okMonth(m)) continue;
      months[m] = { pay: cleanRows('pay', d.pay || []), receipts: cleanRows('receipts', d.receipts || []), invoiced: cleanRows('invoiced', d.invoiced || []), sources: d.sources || {}, loadedAt: str(d.loadedAt, 40), by: d.by || {} };
    }
    if (!Object.keys(months).length) throw err(400, 'empty', 'That backup holds no months of data.');
    st.months = months; st.aliases = b.aliases || {}; if (b.settings) st.settings = Object.assign(st.settings, b.settings); st.latest = b.latest || st.latest;
    save(); audit(ctx.user, 'staff', 'backup_restored', Object.keys(months).length + ' months');
    return ctx.send(200, out());
  }
  return null;
}
function importRaw(b) { st.months = b.months; st.aliases = b.aliases || {}; st.settings = Object.assign(st.settings, b.settings || {}); st.latest = b.latest || null; save(); }

module.exports = { route, stats, importRaw };
