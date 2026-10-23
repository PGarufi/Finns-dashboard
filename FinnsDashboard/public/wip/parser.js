/* Finns Dashboard — WIP report parser.
   Reads LEAP exports (Aged WIP & Disbursements, Aged WIP, Matter List, Client Details)
   and builds one period dataset. Runs in the browser (window.WipParser) and in Node (module.exports). */
(function (root) {
  'use strict';

  var DATE_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/;
  var BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '91–180 days', '181 days – 1 year', 'Over 1 year'];
  var KINDS = ['Professional fees', 'Cost recoveries', 'Anticipated payments'];

  function isDate(v) { return typeof v === 'string' && DATE_RE.test(v); }
  function toDay(s) { var m = DATE_RE.exec(s); return Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000; }
  /* Week ending: the Sunday on or after a day number (day 0 = Thu 1/1/1970). */
  function weekEnding(day) { var dow = (day + 4) % 7; return day + (7 - dow) % 7; }
  function dayLabel(day) { var d = new Date(day * 86400000); return ('0' + d.getUTCDate()).slice(-2) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + d.getUTCFullYear(); }
  function iso(s) { var m = DATE_RE.exec(s); return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  function num(v) { if (typeof v === 'number') return v; var n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function bucketOf(days) { return days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : days <= 180 ? 3 : days <= 365 ? 4 : 5; }

  /* Sheet -> array of rows, always indexed from column A. */
  function rowsOf(XLSX, wb) {
    var ws = wb.Sheets[wb.SheetNames[0]];
    if (ws['!ref']) { var rg = XLSX.utils.decode_range(ws['!ref']); rg.s.c = 0; rg.s.r = 0; ws['!ref'] = XLSX.utils.encode_range(rg); }
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  }

  function textHead(rows, n) {
    var t = [];
    for (var i = 0; i < Math.min(n, rows.length); i++) for (var j = 0; j < Math.min(6, rows[i].length); j++) if (rows[i][j] != null) t.push(String(rows[i][j]));
    return t.join('\n');
  }

  function identify(rows) {
    var head = textHead(rows, 8);
    if (/Trust Trial Balance/i.test(head)) return 'trust';
    if (/Aged WIP & Disbursements Report/i.test(head)) return 'wipd';
    if (/Aged WIP Report/i.test(head)) return 'wip';
    if (/^Matter List/m.test(head)) return 'matters';
    if (rows[0] && str(rows[0][0]) === 'Short Name' && str(rows[0][1]) === 'Client Name') return 'clients';
    return null;
  }

  function agedAt(rows) {
    var m = /Aged at:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(textHead(rows, 8));
    return m ? m[1] : null;
  }

  function headerRow(rows) {
    for (var i = 0; i < Math.min(30, rows.length); i++) {
      var r = rows[i] || [];
      if (r.some(function (c) { return str(c) === 'Matter No'; })) {
        var tot = r.findIndex(function (c) { return str(c) === 'Total'; });
        return { index: i, total: tot };
      }
    }
    throw new Error('Could not find the column headings (Matter No … Total).');
  }

  /* Aged WIP & Disbursements — grouped by Staff Responsible, then matter, then type. */
  function parseWipD(rows) {
    var h = headerRow(rows), T = h.total, out = { agedAt: agedAt(rows), matters: [], lines: [], reportTotal: 0, staffTotals: {} };
    var staff = '', matter = null, cat = '';
    for (var i = h.index + 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var b = str(r[1]), c = r[2];
      if (/^Staff Responsible/i.test(b)) { staff = str(c) || 'Unassigned'; out.staffTotals[staff] = num(r[T]); continue; }
      if (b && !isDate(b) && str(c)) {
        matter = { no: b, short: str(c), desc: str(r[6]), resp: staff, total: num(r[T]) };
        out.matters.push(matter); continue;
      }
      if (!b && c != null && !isDate(c) && str(c)) { cat = str(c); continue; }
      if (!b && isDate(c) && matter) {
        var kind = /^Fees?$/i.test(cat) ? 0 : /^Anticipated/i.test(cat) ? 2 : 1;
        out.lines.push({ matter: matter.no, kind: kind, cat: cat, date: str(c), ref: str(r[3]), desc: str(r[4]), amt: num(r[T]) });
        continue;
      }
      if (!b && !str(c) && num(r[T])) out.reportTotal = num(r[T]);
    }
    return out;
  }

  /* Aged WIP (fees) — grouped by Staff Billed By, then matter. */
  function parseWip(rows) {
    var h = headerRow(rows), T = h.total, out = { agedAt: agedAt(rows), matters: [], lines: [], reportTotal: 0, staffTotals: {} };
    var staff = '', matter = null;
    for (var i = h.index + 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var b = str(r[1]), c = str(r[2]);
      if (/^Staff Billed By/i.test(b)) { staff = c || 'Unassigned'; out.staffTotals[staff] = num(r[T]); continue; }
      if (isDate(b)) { if (matter) out.lines.push({ matter: matter.no, billedBy: staff, date: b, desc: c, amt: num(r[T]) }); continue; }
      if (b && c) { matter = { no: b, short: c, desc: str(r[4]), billedBy: staff, total: num(r[T]) }; out.matters.push(matter); continue; }
      if (!b && !c && num(r[T])) out.reportTotal = num(r[T]);
    }
    return out;
  }

  function parseMatters(rows) {
    var hi = rows.findIndex(function (r) { return r && str(r[0]) === 'Matter No'; });
    if (hi < 0) throw new Error('Matter List: column headings not found.');
    var H = rows[hi].map(str), col = function (n) { return H.indexOf(n); };
    var cNo = col('Matter No'), cCl = col('Client'), cSt = col('Status'), cTy = col('Matter Type'), cDe = col('Matter Description'), cRe = col('Staff Resp.'), cAc = col('Staff Act.');
    var map = {};
    for (var i = hi + 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var no = str(r[cNo]), cl = str(r[cCl]);
      if (!no || !cl) continue;
      map[no] = { client: cl, status: str(r[cSt]), type: str(r[cTy]), desc: str(r[cDe]), resp: str(r[cRe]), act: str(r[cAc]) };
    }
    return map;
  }

  function parseClients(rows) {
    var H = rows[0].map(str), col = function (n) { return H.indexOf(n); };
    var cS = col('Short Name'), cN = col('Client Name'), cE = col('First Email Address'), cP = col('Phone'), cM = col('Mobile'), cW = col('Work'), cSub = col('Suburb'), cState = col('State');
    var byName = {}, byShort = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [], name = str(r[cN]), sh = str(r[cS]);
      if (!name) continue;
      var rec = { short: sh, email: str(r[cE]), phone: str(r[cP]) || str(r[cM]) || str(r[cW]), suburb: [str(r[cSub]), str(r[cState])].filter(function (x) { return x && x !== '-'; }).join(' ') };
      if (!byName[name]) byName[name] = rec;
      if (sh) { (byShort[sh] = byShort[sh] || {})[name] = 1; }
    }
    return { byName: byName, byShort: byShort };
  }

  /* Match each fee line in the WIP & Disbursements report to the Aged WIP report to find Staff Billed By. */
  function norm(s) { return str(s).toLowerCase().slice(0, 80); }
  function matchBilledBy(fees, wipLines) {
    var k1 = {}, k2 = {}, used = new Array(wipLines.length);
    wipLines.forEach(function (w, i) {
      var a = w.matter + '|' + w.date + '|' + r2(w.amt).toFixed(2), b = a + '|' + norm(w.desc);
      (k1[b] = k1[b] || []).push(i); (k2[a] = k2[a] || []).push(i);
    });
    function take(list) { if (!list) return -1; for (var j = 0; j < list.length; j++) if (!used[list[j]]) { used[list[j]] = 1; return list[j]; } return -1; }
    var pending = [];
    fees.forEach(function (f) {
      var a = f.matter + '|' + f.date + '|' + r2(f.amt).toFixed(2);
      var i = take(k1[a + '|' + norm(f.desc)]);
      if (i >= 0) f.billedBy = wipLines[i].billedBy; else pending.push(f);
    });
    pending.forEach(function (f) {
      var i = take(k2[f.matter + '|' + f.date + '|' + r2(f.amt).toFixed(2)]);
      f.billedBy = i >= 0 ? wipLines[i].billedBy : null;
    });
    var wipOnly = wipLines.filter(function (w, i) { return !used[i]; });
    return { wipOnly: wipOnly };
  }

  /* Build a compact period dataset.
     Rules: the Aged WIP & Disbursements Report is the master record. Each fee line is matched to the Aged WIP Report
     only to find Staff Billed By. Fee lines that are not on the Aged WIP Report are WIP on draft invoices (LEAP leaves
     them out of that report) and are excluded. Lines found only on the Aged WIP Report are ignored.
     leap = { matters: map, clients: {byName, byShort} } (either may be null). */
  function build(wipd, wip, leap, meta) {
    if (!wipd) throw new Error('The Aged WIP & Disbursements Report is required.');
    if (!wip) throw new Error('The Aged WIP Report is required: it identifies Staff Billed By and the WIP on draft invoices.');
    var periodStr = wipd.agedAt || wip.agedAt;
    if (!periodStr) throw new Error('Could not read the "Aged at" date from the report.');
    var warnings = [];
    if (wip.agedAt && wipd.agedAt && wip.agedAt !== wipd.agedAt) warnings.push('The two WIP reports have different "Aged at" dates (' + wipd.agedAt + ' and ' + wip.agedAt + ').');
    var pDay = toDay(periodStr);
    var lm = (leap && leap.matters) || {}, lc = (leap && leap.clients) || { byName: {}, byShort: {} };
    var sum = function (arr, f) { return arr.reduce(function (s, x) { return s + f(x); }, 0); };
    var amt = function (l) { return l.amt; };

    var fees = wipd.lines.filter(function (l) { return l.kind === 0; });
    var wipOnly = matchBilledBy(fees, wip.lines).wipOnly;
    var drafts = fees.filter(function (l) { return l.billedBy == null; });
    var kept = wipd.lines.filter(function (l) { return l.kind !== 0 || l.billedBy != null; });
    var keptMatter = {}; kept.forEach(function (l) { keptMatter[l.matter] = 1; });

    var staff = [], staffIx = {};
    function sIx(n) { if (n == null) return -1; if (!(n in staffIx)) { staffIx[n] = staff.length; staff.push(n); } return staffIx[n]; }
    var clients = [], clientIx = {}, matters = [], matterIx = {}, mInfo = {};
    var unlisted = 0;
    wipd.matters.forEach(function (m) {
      if (m.no in mInfo) return;
      var L = lm[m.no], name, via;
      if (L) { name = L.client; via = 'matter'; }
      else {
        var cands = lc.byShort[m.short] ? Object.keys(lc.byShort[m.short]) : [];
        if (cands.length === 1) { name = cands[0]; via = 'short'; } else { name = m.short; via = 'wip'; }
      }
      mInfo[m.no] = { name: name, via: via, resp: m.resp, L: L, m: m };
      if (!keptMatter[m.no]) return;
      if (via !== 'matter') unlisted++;
      if (!(name in clientIx)) {
        var cd = lc.byName[name] || {};
        clientIx[name] = clients.length;
        clients.push({ name: name, short: m.short, email: cd.email || '', phone: cd.phone || '', suburb: cd.suburb || '', via: via });
      }
      matterIx[m.no] = matters.length;
      matters.push({ no: m.no, c: clientIx[name], desc: (L && L.desc) || m.desc, type: (L && L.type) || '', status: (L && L.status) || '', resp: sIx(m.resp) });
    });

    var lines = kept.map(function (l) {
      return [matterIx[l.matter], l.kind, pDay - toDay(l.date), r2(l.amt), l.kind === 0 ? sIx(l.billedBy) : -1, l.date, l.ref, l.desc];
    });

    var draftByMatter = {};
    drafts.forEach(function (l) { var x = draftByMatter[l.matter] || (draftByMatter[l.matter] = { n: 0, amt: 0 }); x.n++; x.amt += l.amt; });
    var feeTotal = r2(sum(fees, amt)), included = r2(feeTotal - sum(drafts, amt));
    var recon = {
      wipdTotal: r2(wipd.reportTotal || sum(wipd.lines, amt)),
      wipdLines: r2(sum(wipd.lines, amt)),
      wipdFees: feeTotal,
      wipdCostRec: r2(sum(wipd.lines.filter(function (l) { return l.kind === 1; }), amt)),
      wipdAnticipated: r2(sum(wipd.lines.filter(function (l) { return l.kind === 2; }), amt)),
      draftCount: drafts.length,
      draftAmt: r2(sum(drafts, amt)),
      includedFees: included,
      includedTotal: r2(sum(kept, amt)),
      wipTotal: r2(wip.reportTotal || sum(wip.lines, amt)),
      wipLines: r2(sum(wip.lines, amt)),
      matchedCount: fees.length - drafts.length,
      wipOnlyCount: wipOnly.length,
      wipOnlyAmt: r2(sum(wipOnly, amt)),
      wipOnly: wipOnly.map(function (w) { return [w.matter, w.billedBy, w.date, r2(w.amt), w.desc]; }),
      wipMattersNotInWipd: wip.matters.filter(function (m) { return !(m.no in mInfo); }).map(function (m) { return m.no; }).filter(function (v, i, a) { return a.indexOf(v) === i; }),
      draftMatters: Object.keys(draftByMatter).map(function (no) { var i = mInfo[no] || {}; return [no, i.name || '', i.resp || '', draftByMatter[no].n, r2(draftByMatter[no].amt), no in matterIx ? 1 : 0]; }).sort(function (a, b) { return b[4] - a[4]; }),
      draftLines: drafts.map(function (l) { return [l.matter, l.date, l.ref, l.desc, r2(l.amt)]; }),
      unlistedMatters: unlisted,
      hasWip: true,
    };
    if (recon.wipMattersNotInWipd.length > 5) {
      var missAmt = 0, missSet = {}; recon.wipMattersNotInWipd.forEach(function (n) { missSet[n] = 1; });
      wip.lines.forEach(function (l) { if (missSet[l.matter]) missAmt += l.amt; });
      warnings.push(recon.wipMattersNotInWipd.length + ' matters with $' + Math.round(missAmt).toLocaleString('en-AU') + ' of fees on the Aged WIP Report are missing from the Aged WIP & Disbursements Report, so they are not included. Check the master report was run for all Responsible Staff.');
    }
    if (Math.abs(recon.wipdTotal - recon.wipdLines) > 0.05) warnings.push('WIP & Disbursements lines (' + recon.wipdLines + ') do not add to the report total (' + recon.wipdTotal + ').');
    if (Math.abs(recon.wipTotal - recon.wipLines) > 0.05) warnings.push('Aged WIP lines (' + recon.wipLines + ') do not add to the report total (' + recon.wipTotal + ').');

    return {
      version: 2,
      period: iso(dayLabel(weekEnding(pDay))),
      periodLabel: 'W/E ' + dayLabel(weekEnding(pDay)),
      agedAt: periodStr,
      partWeek: weekEnding(pDay) !== pDay,
      uploadedAt: (meta && meta.uploadedAt) || new Date().toISOString(),
      uploadedBy: (meta && meta.uploadedBy) || '',
      files: (meta && meta.files) || {},
      staff: staff, clients: clients, matters: matters, lines: lines,
      recon: recon, warnings: warnings,
    };
  }

  /* LEAP Trust Trial Balance (grouped by Staff Responsible, "With balances only").
     Returns { atDate, bank, lines: [{matter, client, desc, last, amt, resp}], total, ledgerTotal }. */
  function parseTrust(rows) {
    var head = textHead(rows, 8);
    var m = /At Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(head);
    if (!m) throw new Error('Could not read the "At Date" from the Trust Trial Balance.');
    var bank = (/Bank Account:\s*([^\n]*)/i.exec(head) || [])[1] || '';
    var resp = '', lines = [], ledgerTotal = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || [], b = str(r[1]);
      if (b === 'Staff Responsible:') { resp = str(r[6]) || str(r.slice(2).filter(function (v) { return str(v); })[0]); continue; }
      if (r.some(function (v) { return str(v) === 'Total Client Ledger Accounts:'; })) { var nums = r.filter(function (v) { return typeof v === 'number'; }); if (nums.length) ledgerTotal = nums[nums.length - 1]; continue; }
      if (b && b !== 'Matter' && typeof r[16] === 'number' && str(r[3])) {
        lines.push({ matter: b, client: str(r[3]), desc: str(r[9]), last: str(r[15]), amt: r2(r[16]), resp: resp });
      }
    }
    if (!lines.length) throw new Error('No matter balances were found in the Trust Trial Balance.');
    var total = r2(lines.reduce(function (a, l) { return a + l.amt; }, 0));
    return { atDate: m[1], bank: str(bank), lines: lines, total: total, ledgerTotal: ledgerTotal == null ? null : r2(ledgerTotal) };
  }

  /* Summary for the history index (one row per period). */
  function summarise(ds) {
    var s = { period: ds.period, periodLabel: ds.periodLabel, agedAt: ds.agedAt || ds.periodLabel, partWeek: !!ds.partWeek, uploadedAt: ds.uploadedAt, uploadedBy: ds.uploadedBy, fees: [0, 0, 0, 0, 0, 0], oncost: [0, 0, 0, 0, 0, 0], clients: ds.clients.length, matters: ds.matters.length };
    ds.lines.forEach(function (l) { var b = bucketOf(l[2]); if (l[1] === 0) s.fees[b] += l[3]; else s.oncost[b] += l[3]; });
    s.fees = s.fees.map(r2); s.oncost = s.oncost.map(r2);
    return s;
  }

  function readWorkbook(XLSX, data) { return XLSX.read(data, { type: typeof data === 'string' ? 'binary' : 'array', dense: false }); }

  var api = { BUCKETS: BUCKETS, KINDS: KINDS, bucketOf: bucketOf, rowsOf: rowsOf, identify: identify, parseWipD: parseWipD, parseWip: parseWip, parseTrust: parseTrust, parseMatters: parseMatters, parseClients: parseClients, build: build, summarise: summarise, readWorkbook: readWorkbook };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WipParser = api;
})(typeof window !== 'undefined' ? window : this);
