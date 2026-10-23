// Finns Dashboard — Aged WIP server module (/api/wip/*).
// The Aged WIP & Disbursements Report is the master; the Aged WIP Report supplies Staff Billed By and
// identifies WIP on draft invoices (excluded). The LEAP Matter List and Client Details are shared with Aged Debtors.
'use strict';
const zlib = require('zlib');
const S = require('./store');
const { err, audit } = require('./auth');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const P = require('../public/wip/parser.js');
const D = require('./debtors');

const okPeriod = (p) => /^\d{4}-\d{2}-\d{2}$/.test(p);
const LIST_KIND = { matters: 'matter-list', clients: 'client-details' };
let index = S.readJSON('wip/index.json', null) || { periods: [] };
if (!index.trust) index.trust = [];
const staged = new Map(); // user id -> { wipd, wip }

let leapCache = null;
function leap() {
  if (leapCache) return leapCache;
  const meta = S.readJSON('debtors/meta.json', { lists: {} }).lists || {};
  const out = { matters: null, clients: null, files: {}, updatedAt: null };
  for (const [k, kind] of Object.entries(LIST_KIND)) {
    const buf = S.readBuf(`debtors/lists/${kind}.xlsx`); if (!buf) continue;
    const rows = P.rowsOf(XLSX, XLSX.read(buf));
    out[k] = k === 'matters' ? P.parseMatters(rows) : P.parseClients(rows);
    out.files[k] = (meta[kind] || {}).name || kind + '.xlsx';
    const at = (meta[kind] || {}).uploadedAt; if (at && (!out.updatedAt || at > out.updatedAt)) out.updatedAt = at;
  }
  return (leapCache = out);
}
function leapInfo() { const l = leap(); return (l.matters || l.clients) ? { files: l.files, updatedAt: l.updatedAt, matters: l.matters ? Object.keys(l.matters).length : 0, clients: l.clients ? Object.keys(l.clients.byName).length : 0 } : null; }
function stagedInfo(uid) { const s = staged.get(uid) || {}, o = {}; for (const k in s) o[k] = { file: s[k].file, agedAt: s[k].data.agedAt || null }; return o; }

function savePeriod(ds) {
  S.writeBuf(`wip/periods/${ds.period}.json.gz`, zlib.gzipSync(JSON.stringify(ds)));
  const s = P.summarise(ds);
  s.recon = { wipdFees: ds.recon.wipdFees, wipTotal: ds.recon.wipTotal, draftAmt: ds.recon.draftAmt, draftCount: ds.recon.draftCount, wipOnlyAmt: ds.recon.wipOnlyAmt, includedTotal: ds.recon.includedTotal };
  index.periods = index.periods.filter((x) => x.period !== ds.period).concat([s]).sort((a, b) => (a.period < b.period ? 1 : -1));
  S.writeJSON('wip/index.json', index); return s;
}

/* ---------- trust balances ---------- */
const dmyIso = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const trustCache = {};
function saveTrust(t, file, by) {
  const date = dmyIso(t.atDate), replaced = index.trust.some((x) => x.date === date);
  S.writeJSON(`wip/trust/${date}.json`, { ...t, file, uploadedAt: new Date().toISOString(), uploadedBy: by }); delete trustCache[date];
  index.trust = index.trust.filter((x) => x.date !== date).concat([{ date, atDate: t.atDate, file, matters: t.lines.length, total: t.total, uploadedAt: new Date().toISOString(), uploadedBy: by }]).sort((a, b) => (a.date < b.date ? 1 : -1));
  S.writeJSON('wip/index.json', index); return { date, replaced };
}
// The trust report for a WIP period: the latest At Date on or before the reports' Aged at date, within 7 days.
function trustFor(agedAtIso) {
  const best = index.trust.filter((x) => x.date <= agedAtIso && (Date.parse(agedAtIso) - Date.parse(x.date)) / 864e5 <= 7).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!best) return null;
  if (!trustCache[best.date]) {
    const t = S.readJSON(`wip/trust/${best.date}.json`, null); if (!t) return null;
    const ML = leap().matters || {};
    trustCache[best.date] = { date: best.date, atDate: t.atDate, file: t.file, total: t.total, ledgerTotal: t.ledgerTotal, bank: t.bank,
      lines: t.lines.map((l) => { const L = ML[l.matter]; return [l.matter, l.amt, l.last, l.resp, l.client, l.desc, L ? L.status : '', L ? L.type : '', L ? L.client : '']; }) };
  }
  return trustCache[best.date];
}

function stats() {
  const s = index.periods[0]; if (!s) return null;
  const all = s.fees.map((v, i) => v + s.oncost[i]), total = all.reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 100) / 100, fees: Math.round(s.fees.reduce((a, b) => a + b, 0) * 100) / 100, over90Share: total ? (all[3] + all[4] + all[5]) / total : 0, period: s.period, periodLabel: s.periodLabel, partWeek: !!s.partWeek, agedAt: s.agedAt, periods: index.periods.length, clients: s.clients };
}

async function route(ctx, need) {
  const { method } = ctx, p = ctx.path.replace(/^\/api\/wip/, ''), uid = ctx.user.id;
  need('viewer');
  if (p === '/periods' && method === 'GET') return ctx.send(200, { periods: index.periods, trust: index.trust, leap: leapInfo(), staged: stagedInfo(uid) });
  if (p === '/trust' && method === 'GET') {
    const per = index.periods.find((x) => x.period === ctx.query.get('period'));
    if (!per) throw err(404, 'not_found', 'That period is not held.');
    return ctx.send(200, { trust: trustFor(dmyIso(per.agedAt || per.periodLabel)) });
  }
  const tm = /^\/trust\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (tm && method === 'DELETE') {
    need('admin'); if (!index.trust.some((x) => x.date === tm[1])) throw err(404, 'not_found', 'That trust report is not held.');
    S.remove(`wip/trust/${tm[1]}.json`); delete trustCache[tm[1]]; index.trust = index.trust.filter((x) => x.date !== tm[1]); S.writeJSON('wip/index.json', index);
    audit(ctx.user, 'wip', 'wip_trust_deleted', tm[1]); return ctx.send(200, { ok: true, trust: index.trust });
  }
  const m = /^\/period\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m && method === 'GET') {
    const gz = S.readBuf(`wip/periods/${m[1]}.json.gz`); if (!gz) throw err(404, 'not_found', 'That period is not held.');
    return ctx.sendGz(gz);
  }
  if (m && method === 'DELETE') {
    need('admin'); if (!index.periods.some((x) => x.period === m[1])) throw err(404, 'not_found', 'That period is not held.');
    S.remove(`wip/periods/${m[1]}.json.gz`); index.periods = index.periods.filter((x) => x.period !== m[1]); S.writeJSON('wip/index.json', index);
    audit(ctx.user, 'wip', 'wip_period_deleted', m[1]);
    return ctx.send(200, { ok: true, periods: index.periods });
  }
  if (p === '/stage' && method === 'POST') {
    need('editor'); const name = ctx.fileName('upload.xlsx'); const buf = await ctx.body();
    let rows; try { rows = P.rowsOf(XLSX, XLSX.read(buf)); } catch (e) { throw err(400, 'unreadable', name + ' could not be read as an Excel workbook.'); }
    const kind = P.identify(rows);
    if (!kind) throw err(400, 'unknown', name + ' is not a recognised LEAP report (expected Aged WIP & Disbursements, Aged WIP, Trust Trial Balance, Matter List or Client Details).');
    if (kind === 'matters' || kind === 'clients') {
      need('admin', 'Only administrators can replace the LEAP ' + (kind === 'matters' ? 'Matter List' : 'Client Details') + ', because Aged Debtors uses it too.');
      const r = D.storeList(LIST_KIND[kind], buf, name, ctx.user.username); leapCache = null;
      audit(ctx.user, 'wip', 'list_uploaded', `${kind === 'matters' ? 'Matter List' : 'Client Details'} · ${name} · ${r.rows} rows`);
      return ctx.send(200, { kind, file: name, saved: true, staged: stagedInfo(uid), leap: leapInfo() });
    }
    if (kind === 'trust') {
      let t; try { t = P.parseTrust(rows); } catch (e) { throw err(400, 'parse', name + ': ' + e.message); }
      if (t.ledgerTotal != null && Math.abs(t.ledgerTotal - t.total) > 0.05) throw err(400, 'parse', name + ': the matter balances (' + t.total + ') do not add to the report total (' + t.ledgerTotal + ').');
      const r = saveTrust(t, name, ctx.user.displayName || ctx.user.username);
      audit(ctx.user, 'wip', r.replaced ? 'wip_trust_replaced' : 'wip_trust_uploaded', `${t.atDate} · ${t.lines.length} matters · ${name}`);
      return ctx.send(200, { kind, file: name, saved: true, agedAt: t.atDate, lines: t.lines.length, total: t.total, staged: stagedInfo(uid), trust: index.trust });
    }
    let data; try { data = kind === 'wipd' ? P.parseWipD(rows) : P.parseWip(rows); } catch (e) { throw err(400, 'parse', name + ': ' + e.message); }
    const s = staged.get(uid) || {}; s[kind] = { file: name, data }; staged.set(uid, s);
    return ctx.send(200, { kind, file: name, agedAt: data.agedAt, lines: data.lines.length, total: data.reportTotal, staged: stagedInfo(uid) });
  }
  if (p === '/commit' && method === 'POST') {
    need('editor'); const s = staged.get(uid) || {};
    const wipd = s.wipd && s.wipd.data, wip = s.wip && s.wip.data;
    if (!wipd || !wip) throw err(400, 'missing', 'Upload both reports for the period: the Aged WIP & Disbursements Report (the master) and the Aged WIP Report (used for Staff Billed By and to leave out WIP on draft invoices).');
    if (wip.agedAt !== wipd.agedAt) throw err(409, 'mismatch', 'The two reports are aged at different dates (' + wipd.agedAt + ' and ' + wip.agedAt + '). Upload matching reports.');
    let ds; try { ds = P.build(wipd, wip, leap(), { uploadedBy: ctx.user.displayName || ctx.user.username, files: { wipd: s.wipd.file, wip: s.wip.file } }); } catch (e) { throw err(400, 'parse', e.message); }
    const replaced = index.periods.some((x) => x.period === ds.period);
    const sum = savePeriod(ds); staged.delete(uid);
    audit(ctx.user, 'wip', replaced ? 'wip_period_replaced' : 'wip_period_added', `${ds.periodLabel} · ${ds.clients.length} clients · ${ds.recon.draftCount} draft-invoice lines excluded`);
    return ctx.send(200, { ok: true, period: ds.period, replaced, summary: sum, warnings: ds.warnings, periods: index.periods });
  }
  if (p === '/stage/clear' && method === 'POST') { need('editor'); staged.delete(uid); return ctx.send(200, { ok: true }); }
  return null;
}
function seedPeriod(wipdBuf, wipBuf, names) {
  const rows = (b) => P.rowsOf(XLSX, XLSX.read(b));
  const ds = P.build(P.parseWipD(rows(wipdBuf)), P.parseWip(rows(wipBuf)), leap(), { uploadedBy: 'Initial load', files: names });
  savePeriod(ds); return ds;
}
function resetLeap() { leapCache = null; for (const k in trustCache) delete trustCache[k]; }
function seedTrust(buf, name) { const t = P.parseTrust(P.rowsOf(XLSX, XLSX.read(buf))); return { ...saveTrust(t, name, 'Initial load'), t }; }

module.exports = { route, stats, seedPeriod, seedTrust, resetLeap };
