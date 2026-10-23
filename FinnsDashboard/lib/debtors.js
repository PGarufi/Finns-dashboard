// Finns Dashboard — Aged Debtors server module (/api/debtors/*).
// Parses LEAP aged-debtors ledgers, resolves each ledger matter to a client and serves one shared dataset.
'use strict';
const S = require('./store');
const { err, audit } = require('./auth');
const XLSX = require('../public/vendor/xlsx.full.min.js');

const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = (v) => { if (typeof v === 'number') return v; const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
function excelDate(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : ''; }
  const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : '';
}
function rowsOf(buf, sheetName) {
  let wb; try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) { throw err(400, 'unreadable', 'That file could not be read as an Excel workbook.'); }
  const ws = sheetName ? wb.Sheets[sheetName] : wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  if (ws['!ref']) { const rg = XLSX.utils.decode_range(ws['!ref']); rg.s.c = 0; rg.s.r = 0; ws['!ref'] = XLSX.utils.encode_range(rg); }
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
}

/* ---------- parsers ---------- */
function parseLedger(buf) {
  const a = rowsOf(buf, 'Aged Debtors Report');
  if (!a) throw err(400, 'not_ledger', 'The workbook has no “Aged Debtors Report” sheet.');
  let asAt = '';
  for (const row of a.slice(0, 10)) for (const v of row) { const m = String(v).match(/Aged at:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) asAt = `${m[3]}-${pad(m[2])}-${pad(m[1])}`; }
  if (!asAt) throw err(400, 'no_date', 'The reporting date (“Aged at”) could not be found.');
  let staff = 'Unassigned', matter = '', client = '', desc = '', phone = ''; const records = [];
  for (const row of a.slice(6)) {
    const b = row[1], c = row[2], d = row[3], e = row[4], f = num(row[5]), g = num(row[6]), h = num(row[7]);
    if (String(b).trim().startsWith('Staff Responsible :')) { staff = String(b).split(':').slice(1).join(':').trim() || 'Unassigned'; matter = client = desc = phone = ''; continue; }
    if (b !== '' && c !== '' && String(d).trim() === '' && (typeof row[5] === 'number' || typeof row[6] === 'number')) { matter = String(b).trim(); client = str(c); desc = str(e); phone = ''; continue; }
    if (!str(b) && !str(c) && !str(d) && str(e).toLowerCase().startsWith('phone:')) { phone = String(e).split(':').slice(1).join(':').trim(); continue; }
    const ds = str(d);
    if (ds.startsWith('Inv:') && matter && client) records.push({ t: 0, staff, matter, short: client, desc, phone, inv: ds.split(':').slice(1).join(':').trim(), date: excelDate(c), amt: r2(f || g) });
    else if (ds.toLowerCase() === 'credit' && matter && client) records.push({ t: 1, staff, matter, short: client, desc, phone, inv: 'Credit', date: '', amt: r2(h || Math.abs(f)) });
  }
  if (!records.length) throw err(400, 'empty', 'No invoice or credit records were found.');
  return { asAt, records };
}
function parseMatterList(buf) {
  const rows = rowsOf(buf);
  const hi = rows.findIndex((r) => r && str(r[0]) === 'Matter No');
  if (hi < 0 || !/Matter List/i.test(str(rows[0] && rows[0][0]))) throw err(400, 'not_matter_list', 'That is not a LEAP Matter List export.');
  const H = rows[hi].map(str), c = (n) => H.indexOf(n);
  const map = {};
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i], no = str(r[c('Matter No')]), cl = str(r[c('Client')]);
    if (no && cl) map[no] = { client: cl, type: str(r[c('Matter Type')]), desc: str(r[c('Matter Description')]), status: str(r[c('Status')]), resp: str(r[c('Staff Resp.')]), act: str(r[c('Staff Act.')]) };
  }
  return map;
}
function parseClientDetails(buf) {
  const rows = rowsOf(buf);
  const H = (rows[0] || []).map(str), c = (n) => H.indexOf(n);
  if (c('Short Name') < 0 || c('Client Name') < 0) throw err(400, 'not_client_details', 'That is not a LEAP Client Details export.');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], name = str(r[c('Client Name')]); if (!name) continue;
    const phones = ['Phone', 'Mobile', 'Work', 'Home'].map((k) => str(r[c(k)])).filter((x) => x && x !== '-');
    out.push({ short: str(r[c('Short Name')]), name, email: str(r[c('First Email Address')]), phone: phones[0] || '', phones, suburb: [str(r[c('Suburb')]), str(r[c('State')])].filter((x) => x && x !== '-').join(' ') });
  }
  return out;
}
function digits(raw) { let d = String(raw || '').replace(/\D/g, ''); if (d.startsWith('61') && d.length === 11) d = '0' + d.slice(2); return d.length === 10 && d.startsWith('0') ? d : ''; }
function nameKey(n) {
  return String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(mr|mrs|ms|miss|mstr|master|dr|prof)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ---------- storage ---------- */
let meta = S.readJSON('debtors/meta.json', null) || { periods: {}, lists: {} };
let ovr = S.readJSON('debtors/overrides.json', null) || { contacts: {}, groupSeparations: [] };
const saveMeta = () => S.writeJSON('debtors/meta.json', meta);
const saveOvr = () => S.writeJSON('debtors/overrides.json', ovr);
const parsedCache = {};
function parsedPeriod(id) { if (!parsedCache[id]) parsedCache[id] = S.readJSON(`debtors/parsed/${id}.json`, null); return parsedCache[id]; }
let lists = null;
function loadLists() { if (!lists) lists = { matters: S.readJSON('debtors/parsed/matter-list.json', null) || {}, clients: S.readJSON('debtors/parsed/client-details.json', null) || [] }; return lists; }

/* ---------- dataset ---------- */
let DS = null;
function build() {
  const L = loadLists(), ML = L.matters, CL = L.clients;
  const byShort = {}, byPhone = {}, byName = {}, byKey = {};
  for (const e of CL) {
    (byShort[e.short.toLowerCase()] = byShort[e.short.toLowerCase()] || new Set()).add(e.name);
    for (const ph of e.phones) { const d = digits(ph); if (d) (byPhone[d] = byPhone[d] || new Set()).add(e.name); }
    (byName[e.name] = byName[e.name] || []).push(e);
    const k = nameKey(e.name); if (k) (byKey[k] = byKey[k] || []).push(e);
  }
  const shortsOf = (name) => new Set((byName[name] || []).map((e) => e.short.toLowerCase()));
  const sep = new Set(ovr.groupSeparations || []);
  const ids = Object.keys(meta.periods).sort();

  // pass 1: resolve identity per (matter, short)
  const ident = new Map(), unresolved = new Map();
  for (const id of ids) {
    const P = parsedPeriod(id); if (!P) continue;
    for (const r of P.records) {
      const k = r.matter + '\u0001' + r.short; if (ident.has(k)) continue;
      const off = ML[r.matter];
      let name = '', via = '';
      if (off) { name = off.client; via = 'matter-list'; }
      else {
        const d = digits(r.phone), cand = d && byPhone[d];
        if (cand && cand.size === 1) { const n = [...cand][0]; if (shortsOf(n).has(r.short.toLowerCase())) { name = n; via = 'telephone'; } }
        if (!name) { const s = byShort[r.short.toLowerCase()]; if (s && s.size === 1) { name = [...s][0]; via = 'short-name'; } }
        if (!name) { name = `${r.short} [Unresolved · matter ${r.matter}]`; via = 'unresolved'; unresolved.set(k, { short: r.short, matter: r.matter, description: r.desc, phone: r.phone }); }
      }
      ident.set(k, { name, via, type: off ? (off.type || 'Unspecified') : '', desc: (off && off.desc) || r.desc, short: r.short });
    }
  }
  // pass 2: grouping of equivalent Client List names (non-Matter-List identities only move)
  const weight = {};
  for (const v of ident.values()) if (v.via !== 'unresolved') { const k = nameKey(v.name); (weight[k] = weight[k] || {}); weight[k][v.name] = (weight[k][v.name] || 0) + (v.via === 'matter-list' ? 1000 : 1); }
  const primaryOf = {};
  for (const k of Object.keys(weight)) primaryOf[k] = Object.entries(weight[k]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const moved = {};
  for (const v of ident.values()) {
    v.client = v.name;
    if (v.via === 'unresolved' || v.via === 'matter-list') continue;
    const prim = primaryOf[nameKey(v.name)];
    if (prim && prim !== v.name && !sep.has(v.name)) { v.client = prim; (moved[prim] = moved[prim] || new Set()).add(v.name); }
  }
  // assemble compact dataset
  const staff = [], sIx = {}, clients = [], cIx = {}, matters = [], mIx = {};
  const si = (n) => (n in sIx ? sIx[n] : (sIx[n] = staff.push(n) - 1));
  const ci = (n) => (n in cIx ? cIx[n] : (cIx[n] = clients.push(n) - 1));
  const shortNames = {}, ledgerNames = new Set();
  const periods = ids.map((id) => {
    const P = parsedPeriod(id), M = meta.periods[id]; if (!P) return null;
    const records = P.records.map((r) => {
      const v = ident.get(r.matter + '\u0001' + r.short), mk = r.matter + '\u0001' + r.short;
      if (!(mk in mIx)) mIx[mk] = matters.push([r.matter, v.desc, r.short, v.type, v.via]) - 1;
      (shortNames[v.client] = shortNames[v.client] || new Set()).add(r.short); ledgerNames.add(v.name);
      return [r.t, si(r.staff), mIx[mk], ci(v.client), r.inv, r.date, r.amt];
    });
    return { asAt: id, sourceName: M.name, uploadedAt: M.uploadedAt, uploadedBy: M.uploadedBy, records };
  }).filter(Boolean);
  const groups = {};
  for (const name of clients) {
    const k = nameKey(name), entries = byKey[k] || [];
    if (entries.length < 2 && !moved[name]) continue;
    const seen = new Set();
    groups[name] = { grouped: !!(moved[name] && moved[name].size), entries: entries.filter((e) => { const x = e.name + '|' + e.short; if (seen.has(x)) return false; seen.add(x); return true; })
      .map((e) => ({ short: e.short, name: e.name, email: e.email, phone: e.phone, inLedger: ledgerNames.has(e.name), canSeparate: e.name !== name, separated: sep.has(e.name) })) };
  }
  const contacts = {};
  for (const name of clients) {
    const es = byName[name] || [];
    if (!es.length) { contacts[name] = { name: '', email: '', telephone: '' }; continue; }
    const emails = new Set(es.map((e) => e.email.toLowerCase()).filter(Boolean)), phones = new Set(es.map((e) => digits(e.phone) || e.phone).filter(Boolean));
    if (emails.size > 1 || phones.size > 1) contacts[name] = { name, email: '', telephone: '', conflict: true };
    else contacts[name] = { name, email: (es.find((e) => e.email) || {}).email || '', telephone: (es.find((e) => e.phone) || {}).phone || '' };
  }
  const sn = {}; for (const [k, v] of Object.entries(shortNames)) sn[k] = [...v].sort();
  DS = { version: 2, builtAt: new Date().toISOString(), staff, clients, matters, periods, contacts, groups, shortNames: sn, unresolved: [...unresolved.values()],
    sources: { matterList: meta.lists['matter-list'] ? { matters: Object.keys(ML).length } : null, clientDetails: meta.lists['client-details'] ? { clients: CL.length } : null } };
  DS._json = null;
  return DS;
}
function dataset() { if (!DS) build(); return DS; }
function invalidate() { DS = null; }

function storeLedger(buf, name, user) {
  const P = parseLedger(buf); const id = P.asAt, replaced = !!meta.periods[id];
  S.writeBuf(`debtors/ledgers/${id}.xlsx`, buf); S.writeJSON(`debtors/parsed/${id}.json`, P); parsedCache[id] = P;
  meta.periods[id] = { name, records: P.records.length, uploadedAt: new Date().toISOString(), uploadedBy: user };
  saveMeta(); invalidate(); return { id, replaced, records: P.records.length };
}
function storeList(kind, buf, name, user) {
  let parsed, rows;
  if (kind === 'matter-list') { parsed = parseMatterList(buf); rows = Object.keys(parsed).length; }
  else if (kind === 'client-details') { parsed = parseClientDetails(buf); rows = parsed.length; }
  else throw err(404, 'not_found');
  S.writeBuf(`debtors/lists/${kind}.xlsx`, buf); S.writeJSON(`debtors/parsed/${kind}.json`, parsed);
  meta.lists[kind] = { name, rows, uploadedAt: new Date().toISOString(), uploadedBy: user };
  saveMeta(); lists = null; invalidate(); return { kind, rows };
}

function todayISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function stats() {
  const ids = Object.keys(meta.periods).sort(); if (!ids.length) return null;
  const t = todayISO(), id = ids.filter((x) => x <= t).pop() || ids[ids.length - 1];
  const P = parsedPeriod(id); if (!P) return null;
  const asMs = Date.parse(id + 'T00:00:00Z'); let gross = 0, cred = 0, o90 = 0;
  for (const r of P.records) { if (r.t) cred += r.amt; else { gross += r.amt; if (r.date && (asMs - Date.parse(r.date + 'T00:00:00Z')) / 864e5 > 90) o90 += r.amt; } }
  return { net: r2(gross - cred), over90Share: gross ? o90 / gross : 0, asAt: id, periods: ids.length };
}

function sources() {
  return { periods: Object.entries(meta.periods).sort((a, b) => b[0].localeCompare(a[0])).map(([id, m]) => ({ id, ...m })), lists: meta.lists };
}

async function route(ctx, need) {
  const { method } = ctx, p = ctx.path.replace(/^\/api\/debtors/, '');
  need('viewer');
  if (p === '/dataset' && method === 'GET') { const d = dataset(); if (!d._json) Object.defineProperty(d, '_json', { value: JSON.stringify(d), writable: true, enumerable: false }); return ctx.sendRaw(200, d._json, 'application/json'); }
  if (p === '/overrides' && method === 'GET') return ctx.send(200, ovr);
  if (p === '/sources' && method === 'GET') return ctx.send(200, sources());
  if (p === '/report' && method === 'PUT') {
    need('editor'); const buf = await ctx.body(), name = ctx.fileName('ledger.xlsx');
    const r = storeLedger(buf, name, ctx.user.username);
    audit(ctx.user, 'debtors', r.replaced ? 'ledger_replaced' : 'ledger_uploaded', `${r.id} · ${name} · ${r.records} records`);
    return ctx.send(200, r);
  }
  let m = /^\/report\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m && method === 'GET') { const b = S.readBuf(`debtors/ledgers/${m[1]}.xlsx`); if (!b) throw err(404, 'not_found'); return ctx.download(b, (meta.periods[m[1]] || {}).name || m[1] + '.xlsx'); }
  if (m && method === 'DELETE') {
    need('admin'); if (!meta.periods[m[1]]) throw err(404, 'not_found');
    const nm = meta.periods[m[1]].name; delete meta.periods[m[1]]; delete parsedCache[m[1]]; S.remove(`debtors/ledgers/${m[1]}.xlsx`); S.remove(`debtors/parsed/${m[1]}.json`);
    saveMeta(); invalidate(); audit(ctx.user, 'debtors', 'ledger_deleted', `${m[1]} · ${nm}`);
    return ctx.send(200, { periods: sources().periods });
  }
  m = /^\/lists\/(matter-list|client-details)$/.exec(p);
  if (m && method === 'PUT') {
    need('admin'); const buf = await ctx.body(), name = ctx.fileName(m[1] + '.xlsx');
    const r = storeList(m[1], buf, name, ctx.user.username); audit(ctx.user, 'debtors', 'list_uploaded', `${m[1] === 'matter-list' ? 'Matter List' : 'Client Details'} · ${name} · ${r.rows} rows`);
    return ctx.send(200, { ok: true, ...r });
  }
  if (m && method === 'GET') { const b = S.readBuf(`debtors/lists/${m[1]}.xlsx`); if (!b) throw err(404, 'not_found'); return ctx.download(b, (meta.lists[m[1]] || {}).name || m[1] + '.xlsx'); }
  if (p === '/contacts' && (method === 'PUT' || method === 'DELETE')) {
    need('editor'); const b = await ctx.json(); const client = str(b.client); if (!client) throw err(400, 'bad_client', 'No client was given.');
    if (method === 'DELETE') { delete ovr.contacts[client]; saveOvr(); audit(ctx.user, 'debtors', 'contact_reverted', client); return ctx.send(200, ovr); }
    const email = str(b.email); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'bad_email', 'Enter a valid email address.');
    ovr.contacts[client] = { name: str(b.name).slice(0, 120), email: email.slice(0, 160), telephone: str(b.telephone).slice(0, 40), by: ctx.user.username, at: new Date().toISOString() };
    saveOvr(); audit(ctx.user, 'debtors', 'contact_saved', client); return ctx.send(200, ovr);
  }
  if (p === '/groups' && method === 'POST') {
    need('editor'); const b = await ctx.json(); const name = str(b.name); if (!name) throw err(400, 'bad_name');
    const s = new Set(ovr.groupSeparations || []); if (b.separate) s.add(name); else s.delete(name);
    ovr.groupSeparations = [...s].sort(); saveOvr(); invalidate(); audit(ctx.user, 'debtors', b.separate ? 'group_separated' : 'group_restored', name);
    return ctx.send(200, { ok: true });
  }
  return null;
}

module.exports = { route, stats, storeLedger, storeList, build, parseMatterList, parseClientDetails };
