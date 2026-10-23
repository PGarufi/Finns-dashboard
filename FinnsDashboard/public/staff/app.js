/* Finn Roache Lawyers — Billable Staff Performance Dashboard
   Data is held in a shared server-side store behind a sign-in, so every
   signed-in user sees the same uploaded periods. */
(function () {
  'use strict';

  var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var state = { months: {}, aliases: {}, settings: { mult: 3.5, green: 100, amber: 85 } };
  // sort: null = default view, grouped by location. Otherwise a flat ranking.
  var ui = { view: 'dashboard', fy: null, basis: 'ytd', period: '', loc: '', staff: '', expanded: {}, sort: null, barMode: 'pct' };
  var model = null;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var v = Math.round(n);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-AU');
  }
  function money2(n) { return '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(n) { if (n === null || n === undefined || !isFinite(n)) return '—'; return (n * 100).toFixed(1) + '%'; }
  function monthLabel(m) { var p = m.split('-'); return MONTH_NAMES[+p[1] - 1] + ' ' + p[0]; }
  function fyOf(m) { var p = m.split('-'), y = +p[0], mo = +p[1]; return mo >= 7 ? y + '-' + (y + 1) : (y - 1) + '-' + y; }
  function fyLabel(fy) { var p = fy.split('-'); return 'FY ' + p[0] + '/' + p[1].slice(2); }
  function fyMonths(fy) { var y = +fy.split('-')[0], out = [], i; for (i = 7; i <= 12; i++) out.push(y + '-' + String(i).padStart(2, '0')); for (i = 1; i <= 6; i++) out.push((y + 1) + '-' + String(i).padStart(2, '0')); return out; }
  function quarterOf(m) { var mo = +m.split('-')[1]; return mo >= 7 && mo <= 9 ? 'Q1' : mo >= 10 && mo <= 12 ? 'Q2' : mo >= 1 && mo <= 3 ? 'Q3' : 'Q4'; }
  var QLABEL = { Q1: 'Q1 (Jul–Sep)', Q2: 'Q2 (Oct–Dec)', Q3: 'Q3 (Jan–Mar)', Q4: 'Q4 (Apr–Jun)' };

  function norm(s) {
    return String(s == null ? '' : s).replace(/\(.*?\)/g, ' ').toLowerCase()
      .replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function surname(n) { var t = norm(n).split(' '); return t[t.length - 1] || ''; }
  function isBonus(cat) { return /bonus/i.test(cat || ''); }
  // Offices are reported as one place: the payroll entity prefix (FIN - , SCS - )
  // is dropped so "FIN - Sydney" and "SCS - Sydney" consolidate into "Sydney",
  // including for a person paid by both entities in the same office.
  function officeOf(loc) {
    var t = String(loc == null ? '' : loc).trim();
    var m = t.match(/^[A-Za-z]{2,6}\s*[-\u2013\u2014/]\s*(.+)$/);
    return (m ? m[1] : t).replace(/\s+/g, ' ').trim();
  }

  /* ---------- shared store, behind the Finns Dashboard sign-in ----------
     Sign-in, sign-out and user management live in the portal (../index.html).
     Every request carries the shared session; the server checks this user's
     role in the Staff Performance app. */
  var POLL_MS = 45000;
  var AuthError = FD.AuthError;
  var ROLE = '';
  function can(role) { var R = ['viewer', 'editor', 'admin']; return R.indexOf(ROLE) >= R.indexOf(role); }
  function apiFetch(path, opts) {
    opts = opts || {};
    return FD.callJSON('/api/staff' + path.replace(/^\/api/, ''), { method: opts.method || 'GET', json: opts.body });
  }
  function onAuthLost() { FD.expired('staff'); }
  function enterApp(user, role) {
    ROLE = role;
    document.body.classList.toggle('can-edit', can('editor'));
    document.body.classList.toggle('can-admin', can('admin'));
    $('shell').hidden = false;
    $('whoami').textContent = user.displayName || user.username;
    $('roleChip').textContent = FD.ROLE_LABEL[role];
    ['multInput', 'greenInput', 'amberInput'].forEach(function (id) { $(id).disabled = !can('editor'); });
  }
  function signOut() { FD.signOut(); }

  /* ---- shared state ---- */
  var rev = -1;
  function applyState(d, jump) {
    var before = Object.keys(state.months).sort().join(',');
    state.months = d.months || {};
    state.aliases = d.aliases || {};
    if (d.settings) state.settings = Object.assign(state.settings, d.settings);
    rev = d.rev;
    latest = d.latest || null;
    var after = Object.keys(state.months).sort().join(',');
    if (jump || before !== after) focusLatest();
    render();
  }
  var latest = null;

  function focusLatest() {
    var ms = Object.keys(state.months).sort();
    if (!ms.length) return;
    var newest = ms[ms.length - 1];
    ui.fy = fyOf(newest);
    if (ui.basis === 'month') ui.period = newest;
    else if (ui.basis === 'quarter') ui.period = quarterOf(newest);
  }

  function pull(jump) {
    return apiFetch('/api/state').then(function (d) { applyState(d, jump); }).catch(function (e) {
      if (e instanceof AuthError) onAuthLost();
      else notice('Could not reach the shared store: ' + e.message);
    });
  }

  function poll() {
    if (!ROLE) return;
    apiFetch('/api/rev').then(function (d) {
      if (d.rev !== rev) {
        return apiFetch('/api/state').then(function (s) {
          var who = s.latest && s.latest.by ? s.latest.by : 'someone';
          applyState(s, true);
          toast('Updated data was loaded by ' + who + ' — this view has been refreshed.');
        });
      }
    }).catch(function (e) { if (e instanceof AuthError) onAuthLost(); });
  }

  function pushSettings() {
    return apiFetch('/api/settings', { method: 'POST', body: state.settings })
      .then(function (d) { if (typeof d.rev === 'number') rev = d.rev; if (d.settings) state.settings = d.settings; })
      .catch(function (e) { if (e instanceof AuthError) onAuthLost(); else notice('Could not save the settings: ' + e.message); });
  }
  function pushAliases() {
    return apiFetch('/api/aliases', { method: 'POST', body: { aliases: state.aliases } })
      .then(function (d) { if (typeof d.rev === 'number') rev = d.rev; })
      .catch(function (e) { if (e instanceof AuthError) onAuthLost(); else notice('Could not save the name mapping: ' + e.message); });
  }
  function removeMonth(m) {
    return apiFetch('/api/month?m=' + encodeURIComponent(m), { method: 'DELETE' })
      .then(function (d) { applyState(d, true); toast(monthLabel(m) + ' removed for everyone.'); })
      .catch(function (e) { if (e instanceof AuthError) onAuthLost(); else notice('Could not remove ' + monthLabel(m) + ': ' + e.message); });
  }
  function restoreBackup(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var j; try { j = JSON.parse(rd.result); } catch (e) { notice('That file is not a data backup.'); return; }
      var n = j && j.months ? Object.keys(j.months).length : 0;
      if (!n) { notice('That file holds no months of data.'); return; }
      if (!confirm('Replace the shared data for everyone with the ' + n + ' months in this backup?')) return;
      apiFetch('/api/import', { method: 'POST', body: { months: j.months, aliases: j.aliases || {}, settings: j.settings, latest: j.latest } })
        .then(function (d) { applyState(d, true); toast('Restored ' + n + ' months from the backup.'); })
        .catch(function (e) { if (e instanceof AuthError) onAuthLost(); else notice('Could not restore the backup: ' + e.message); });
    };
    rd.readAsText(file);
  }

  /* ---- messages ---- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 7000);
  }
  function notice(msg) {
    var n = $('notice');
    n.textContent = msg;
    n.hidden = !msg;
  }

  function backup() {
    var blob = new Blob([JSON.stringify({ months: state.months, aliases: state.aliases, settings: state.settings, latest: latest }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'FRL-dashboard-data-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  }

  /* ---------- model ---------- */
  function buildModel() {
    var fy = ui.fy;
    var months = Object.keys(state.months).filter(function (m) { return fyOf(m) === fy; }).sort();
    var staff = {};   // normName -> record
    var order = [];

    months.forEach(function (m) {
      (state.months[m].pay || []).forEach(function (r) {
        var k = norm(r.name); if (!k) return;
        if (!staff[k]) { staff[k] = { key: k, name: r.name, locs: {}, pay: {}, rec: {}, inv: {} }; order.push(k); }
        var s = staff[k];
        s.name = r.name;
        if (!isBonus(r.cat)) s.pay[m] = (s.pay[m] || 0) + (+r.amt || 0) + (+r.sup || 0);
        else s.pay[m] = s.pay[m] || 0;
        if (r.loc) {
          var L = officeOf(r.loc);
          s.locs[m] = s.locs[m] || {};
          s.locs[m][L] = (s.locs[m][L] || 0) + (+r.amt || 0);
        }
      });
    });

    // surname index for fuzzy matching
    var bySur = {};
    Object.keys(staff).forEach(function (k) { var s = surname(k); (bySur[s] = bySur[s] || []).push(k); });

    // A shared surname is not enough on its own: "Daniel Georges" in the
    // receipts report must not be credited to "Martin Georges" in payroll.
    // Given names have to be compatible too - identical, one a shortening of
    // the other (Greg/Gregory, Ken/Kenneth), or an initial - or the payroll
    // name has to sit inside the reported one (CJ Nhem / Darapiseth CJ Nhem,
    // or a maiden name added after marriage).
    function firstCompatible(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.length >= 3 && b.length >= 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return true;
      if (a.length === 1 || b.length === 1) return a.charAt(0) === b.charAt(0);
      return false;
    }
    function tokensWithin(inner, outer) {   // every token of inner appears in outer
      return inner.length > 1 && inner.every(function (t) { return outer.indexOf(t) >= 0; });
    }
    var matchLog = {};   // reported name -> payroll name it was credited to
    function resolve(reportName) {
      var n0 = norm(reportName);
      if (!n0) return null;
      if (state.aliases[n0] && staff[state.aliases[n0]]) return state.aliases[n0];
      if (staff[n0]) return n0;
      var n = n0.split(' ').filter(function (t) { return t !== 'nee'; }).join(' ');
      if (staff[n]) { matchLog[n0] = n; return n; }
      var t = n.split(' '), sur = t[t.length - 1], first = t[0];
      var cands = bySur[sur] || [], hits = [];
      cands.forEach(function (k) {
        var kt = k.split(' ');
        if (firstCompatible(first, kt[0]) || tokensWithin(kt, t) || tokensWithin(t, kt)) hits.push(k);
      });
      if (!hits.length) {   // surname may have changed - look for the payroll name inside the reported one
        Object.keys(staff).forEach(function (k) { if (tokensWithin(k.split(' '), t)) hits.push(k); });
      }
      if (hits.length === 1) { matchLog[n0] = hits[0]; return hits[0]; }
      return null;
    }

    var unmatched = {};   // normName -> {name, rec, inv, months:{}}
    function addUn(name, m, field, amt) {
      var n = norm(name);
      if (!unmatched[n]) unmatched[n] = { name: name, rec: 0, inv: 0, months: {} };
      unmatched[n][field] += amt;
      unmatched[n].months[m] = true;
      if (String(name).length > String(unmatched[n].name).length) unmatched[n].name = name;
    }

    months.forEach(function (m) {
      ['receipts', 'invoiced'].forEach(function (kind) {
        var field = kind === 'receipts' ? 'rec' : 'inv';
        (state.months[m][kind] || []).forEach(function (r) {
          var k = resolve(r.name);
          if (k) staff[k][field][m] = (staff[k][field][m] || 0) + (+r.amt || 0);
          else addUn(r.name, m, field, +r.amt || 0);
        });
      });
    });

    // reporting location = office with most pay in the latest month present
    Object.keys(staff).forEach(function (k) {
      var s = staff[k], chosen = '';
      months.forEach(function (m) {
        if (!s.locs[m]) return;
        var best = '', bestv = -1;
        Object.keys(s.locs[m]).forEach(function (L) { if (s.locs[m][L] > bestv) { bestv = s.locs[m][L]; best = L; } });
        chosen = best;
      });
      s.loc = chosen || '—';
      s.allLocs = {};
      months.forEach(function (m) { if (s.locs[m]) Object.keys(s.locs[m]).forEach(function (L) { s.allLocs[L] = true; }); });
      // Every staff member, at every location, is included in the calculation.
      // Only those with receipts or invoices recorded against them in the
      // financial year are shown, so support staff drop out of the view while
      // still being measured if any work is ever billed to them.
      s.hasWork = months.some(function (m) { return (s.rec[m] || 0) !== 0 || (s.inv[m] || 0) !== 0; });
      s.billable = s.hasWork;
      s.mixed = false;

      // ---- allocate each month to the location(s) the payroll recorded it under ----
      // share[m][L] = that location's slice of the month, from the pay amounts.
      // Months with no payroll rows (unpaid leave, a gap) carry the last known
      // split forward so any receipts or invoices still land somewhere sensible.
      var share = {}, last = null;
      months.forEach(function (m) {
        var lm = s.locs[m], tot = 0;
        if (lm) Object.keys(lm).forEach(function (L) { tot += Math.max(0, lm[L]); });
        if (lm && tot > 0) {
          share[m] = {};
          Object.keys(lm).forEach(function (L) { if (lm[L] > 0) share[m][L] = lm[L] / tot; });
          last = share[m];
        } else if (lm && Object.keys(lm).length) {
          // recorded at a location but with no positive amount: split it evenly
          share[m] = {}; var ks = Object.keys(lm);
          ks.forEach(function (L) { share[m][L] = 1 / ks.length; });
          last = share[m];
        } else if (last) share[m] = last;
      });
      var firstKnown = null;
      months.forEach(function (m) { if (!firstKnown && share[m]) firstKnown = share[m]; });
      months.forEach(function (m) { if (!share[m] && firstKnown) share[m] = firstKnown; });
      s.share = share;

      // per-location series: pay, receipts and invoices sliced by that share
      var split = {};
      months.forEach(function (m) {
        var sh = share[m]; if (!sh) return;
        Object.keys(sh).forEach(function (L) {
          var d = split[L] = split[L] || { pay: {}, rec: {}, inv: {}, months: {} };
          d.pay[m] = (d.pay[m] || 0) + (s.pay[m] || 0) * sh[L];
          d.rec[m] = (d.rec[m] || 0) + (s.rec[m] || 0) * sh[L];
          d.inv[m] = (d.inv[m] || 0) + (s.inv[m] || 0) * sh[L];
          if (s.locs[m] && s.locs[m][L] !== undefined) d.months[m] = true;
        });
      });
      // month-equivalents per location: a month shared 70/30 counts 0.7 and 0.3,
      // so every location's slice of the year adds back to the person's total
      var paidAll = months.filter(function (m) { return (s.pay[m] || 0) > 0; });
      Object.keys(split).forEach(function (L) {
        var d = split[L];
        d.fte = {};
        months.forEach(function (m) {
          d.fte[m] = (s.pay[m] || 0) > 0 && share[m] && share[m][L] ? share[m][L] : 0;
        });
        d.fteFY = paidAll.reduce(function (a, m) { return a + d.fte[m]; }, 0);
      });
      s.paidCount = paidAll.length;
      s.annualRate = paidAll.length ? sumOver(s.pay, months) / paidAll.length * 12 : 0;
      s.split = split;
      s.rowLocs = Object.keys(split).sort();
      if (!s.rowLocs.length) {   // paid but no location recorded anywhere
        s.rowLocs = ['(no location)'];
        split['(no location)'] = { pay: {}, rec: {}, inv: {}, months: {}, fte: {}, fteFY: paidAll.length };
        months.forEach(function (m) {
          split['(no location)'].pay[m] = s.pay[m] || 0;
          split['(no location)'].rec[m] = s.rec[m] || 0;
          split['(no location)'].inv[m] = s.inv[m] || 0;
          split['(no location)'].fte[m] = (s.pay[m] || 0) > 0 ? 1 : 0;
        });
      }
      s.multiFin = s.rowLocs.length > 1;
    });

    model = { fy: fy, months: months, staff: staff, order: order, unmatched: unmatched, matchLog: matchLog, resolve: resolve };
    return model;
  }

  function scopeMonths() {
    var ms = model.months;
    if (ui.basis === 'month') return ms.filter(function (m) { return m === ui.period; });
    if (ui.basis === 'quarter') return ms.filter(function (m) { return quarterOf(m) === ui.period; });
    return ms.slice();
  }

  function sumOver(obj, months) { var t = 0; months.forEach(function (m) { t += obj[m] || 0; }); return t; }

  function rows() {
    var sm = scopeMonths(), all = model.months, n = all.length, mult = +state.settings.mult || 0;
    var out = [];
    model.order.forEach(function (k) {
      var s = model.staff[k];
      if (!s.billable) return;
      // one row per office the person was recorded at, so a mid-year move
      // reports under each office for the months that office actually paid them
      s.rowLocs.forEach(function (L) {
      if (ui.loc && L !== ui.loc) return;
      var d = s.split[L];
      var payFY = sumOver(d.pay, all);
      var paidMonths = all.filter(function (m) { return (d.pay[m] || 0) > 0; });
      // fteScope / fteFY are this location's month-equivalents; s.annualRate is the
      // person's combined annualised salary, so the location rows apportion one
      // salary and one target rather than each claiming a full-time one.
      var fteScope = sm.reduce(function (a, m) { return a + (d.fte[m] || 0); }, 0);
      var fteFY = d.fteFY;
      var annual = s.paidCount ? s.annualRate * (fteFY / s.paidCount) : 0;
      var annualTarget = annual * mult;
      var paidInScope = sm.filter(function (m) { return (d.pay[m] || 0) > 0; }).length;
      var periodTarget = s.annualRate * mult * (fteScope / 12);
      var rec = sumOver(d.rec, sm), inv = sumOver(d.inv, sm);
      var recFY = sumOver(d.rec, all), invFY = sumOver(d.inv, all);
      // Pro-rata year-to-date target: the annual target scaled to the FY months
      // this person has actually been paid in. Used to colour the annual columns.
      var ytdTarget = s.annualRate * mult * (fteFY / 12);
      out.push({
        key: k + '||' + L, staffKey: k, name: s.name, loc: L, mixed: s.mixed, split: s.multiFin,
        series: d,
        paidMonths: paidMonths.length, paidInScope: paidInScope, partial: paidMonths.length < n,
        payPeriod: sumOver(d.pay, sm), payFY: payFY, annual: annual,
        annualTarget: annualTarget, periodTarget: periodTarget,
        rec: rec, inv: inv, recFY: recFY, invFY: invFY,
        recPeriodPct: periodTarget ? rec / periodTarget : null,
        invPeriodPct: periodTarget ? inv / periodTarget : null,
        recAnnualPct: annualTarget ? recFY / annualTarget : null,
        invAnnualPct: annualTarget ? invFY / annualTarget : null,
        ytdTarget: ytdTarget,
        recYtdPct: ytdTarget ? recFY / ytdTarget : null,
        invYtdPct: ytdTarget ? invFY / ytdTarget : null,
        recVar: rec - periodTarget, invVar: inv - periodTarget
      });
      });
    });
    out.sort(function (a, b) { return a.loc === b.loc ? a.name.localeCompare(b.name) : a.loc.localeCompare(b.loc); });
    return out;
  }

  function rag(p) {
    if (p === null || p === undefined || !isFinite(p)) return '';
    var g = (+state.settings.green || 100) / 100, a = (+state.settings.amber || 85) / 100;
    return p >= g ? 'g' : p >= a ? 'a' : 'r';
  }

  /* ---------- rendering ---------- */
  // `basis` lets a cell show one percentage but take its colour from another —
  // the annual columns show progress to the full-year target but are graded on
  // the pro-rata year-to-date target.
  function ragPill(p, basis) {
    var on = basis === null || basis === undefined ? p : basis;
    var sp = el('span', 'pill ' + rag(on), pct(p));
    if (basis !== null && basis !== undefined) sp.title = pct(basis) + ' of the pro-rata target for the months paid to date';
    return sp;
  }

  function renderControls() {
    var fys = {};
    Object.keys(state.months).forEach(function (m) { fys[fyOf(m)] = true; });
    var list = Object.keys(fys).sort();
    if (!list.length) list = [fyOf(new Date().toISOString().slice(0, 7))];
    if (!ui.fy || list.indexOf(ui.fy) < 0) ui.fy = list[list.length - 1];
    var fsel = $('fySel'); fsel.innerHTML = '';
    list.forEach(function (f) { var o = el('option', null, fyLabel(f)); o.value = f; if (f === ui.fy) o.selected = true; fsel.appendChild(o); });

    buildModel();

    $('basisSel').value = ui.basis;
    var pw = $('periodWrap'), ps = $('periodSel');
    if (ui.basis === 'ytd') { pw.hidden = true; ui.period = ''; }
    else {
      pw.hidden = false; ps.innerHTML = '';
      var opts = [];
      if (ui.basis === 'month') opts = model.months.map(function (m) { return { v: m, t: monthLabel(m) }; });
      else {
        var qs = {}; model.months.forEach(function (m) { qs[quarterOf(m)] = true; });
        opts = Object.keys(qs).sort().map(function (q) { return { v: q, t: QLABEL[q] }; });
      }
      if (!opts.length) opts = [{ v: '', t: 'No data' }];
      if (!opts.some(function (o) { return o.v === ui.period; })) ui.period = opts[opts.length - 1].v;
      opts.forEach(function (o) { var op = el('option', null, o.t); op.value = o.v; if (o.v === ui.period) op.selected = true; ps.appendChild(op); });
    }

    var locs = {};
    Object.keys(model.staff).forEach(function (k) {
      var s = model.staff[k]; if (!s.billable) return;
      s.rowLocs.forEach(function (L) { locs[L] = true; });
    });
    var ls = $('locSel'), keep = ui.loc; ls.innerHTML = '';
    var o0 = el('option', null, 'All locations'); o0.value = ''; ls.appendChild(o0);
    Object.keys(locs).sort().forEach(function (L) { var o = el('option', null, L); o.value = L; ls.appendChild(o); });
    ls.value = locs[keep] ? keep : ''; ui.loc = ls.value;

    $('multInput').value = state.settings.mult;
    $('greenInput').value = state.settings.green;
    $('amberInput').value = state.settings.amber;
  }

  function scopeText() {
    var sm = scopeMonths();
    if (!sm.length) return 'no loaded months';
    if (ui.basis === 'month') return monthLabel(sm[0]);
    if (ui.basis === 'quarter') return QLABEL[ui.period] + ' · ' + sm.length + ' month' + (sm.length > 1 ? 's' : '') + ' loaded';
    return 'Year to date · ' + monthLabel(sm[0]) + ' to ' + monthLabel(sm[sm.length - 1]);
  }

  function renderKpis(rs) {
    var sm = scopeMonths(), box = $('kpis'); box.innerHTML = '';
    var t = rs.reduce(function (a, r) {
      a.pay += r.payPeriod; a.rec += r.rec; a.inv += r.inv; a.tgt += r.periodTarget;
      a.recFY += r.recFY; a.invFY += r.invFY; a.annTgt += r.annualTarget; return a;
    }, { pay: 0, rec: 0, inv: 0, tgt: 0, recFY: 0, invFY: 0, annTgt: 0 });
    var recPct = t.tgt ? t.rec / t.tgt : null, invPct = t.tgt ? t.inv / t.tgt : null;
    function card(label, val, sub, cls) {
      var d = el('div', 'kpi' + (cls ? ' ' + cls : ''));
      d.appendChild(el('div', 'k-label', label));
      d.appendChild(el('div', 'k-val', val));
      d.appendChild(el('div', 'k-sub', sub));
      box.appendChild(d);
    }
    var uniq = {}; rs.forEach(function (r) { uniq[r.staffKey] = true; });
    var people = Object.keys(uniq).length;
    card('Billable staff', String(people),
      (ui.loc || 'All locations') + ' · ' + scopeText() + (rs.length > people ? ' · ' + rs.length + ' staff-location rows' : ''));
    card('Pay + super', money(t.pay), 'Selected period');
    card('Receipted', money(t.rec), 'Target ' + money(t.tgt));
    card('% of period receipt target', pct(recPct), (t.rec - t.tgt >= 0 ? 'Ahead by ' : 'Behind by ') + money(Math.abs(t.rec - t.tgt)), rag(recPct));
    card('Invoiced', money(t.inv), 'Target ' + money(t.tgt));
    card('% of period invoice target', pct(invPct), (t.inv - t.tgt >= 0 ? 'Ahead by ' : 'Behind by ') + money(Math.abs(t.inv - t.tgt)), rag(invPct));
    card('Receipted vs annual target', pct(t.annTgt ? t.recFY / t.annTgt : null), money(t.recFY) + ' of ' + money(t.annTgt) + ' · ' + sm.length + '/12 months loaded');
    card('Invoiced vs annual target', pct(t.annTgt ? t.invFY / t.annTgt : null), money(t.invFY) + ' of ' + money(t.annTgt));
  }

  var COLS = [
    { k: 'name', t: 'Staff member', l: true, g: 'staff', s: 'text' },
    { k: 'payPeriod', t: 'Pay + super (period)', f: money, g: 'staff', s: 'num' },
    { k: 'annual', t: 'Annualised salary + super', f: money, g: 'staff', s: 'num' },
    { k: 'periodTarget', t: 'Period target', f: money, g: 'tgt', s: 'num' },
    { k: 'rec', t: 'Receipted', f: money, g: 'rec', s: 'num' },
    { k: 'recPeriodPct', t: '% period target', p: true, g: 'rec', s: 'num' },
    { k: 'recVar', t: 'Receipt variance', f: money, g: 'rec', s: 'num' },
    { k: 'inv', t: 'Invoiced', f: money, g: 'inv', s: 'num' },
    { k: 'invPeriodPct', t: '% period target', p: true, g: 'inv', s: 'num' },
    { k: 'invVar', t: 'Invoice variance', f: money, g: 'inv', s: 'num' },
    { k: 'recAnnualPct', t: '% annual target (rec)', p: true, rk: 'recYtdPct', g: 'ann', s: 'num' },
    { k: 'invAnnualPct', t: '% annual target (inv)', p: true, rk: 'invYtdPct', g: 'ann', s: 'num' }
  ];

  var SORT_LABEL = {
    loc: 'location', name: 'staff member', payPeriod: 'pay + super', annual: 'annualised salary',
    periodTarget: 'period target', rec: 'receipted', recPeriodPct: '% of receipt target',
    recVar: 'receipt variance', inv: 'invoiced', invPeriodPct: '% of invoice target',
    invVar: 'invoice variance', recAnnualPct: '% of annual receipt target', invAnnualPct: '% of annual invoice target'
  };

  function setSort(k, kind) {
    if (ui.sort && ui.sort.k === k) {
      // same column: flip direction, then a third click returns to the location view
      if (ui.sort.flipped) ui.sort = null;
      else ui.sort = { k: k, kind: kind, dir: -ui.sort.dir, flipped: true };
    } else {
      ui.sort = { k: k, kind: kind, dir: kind === 'text' ? 1 : -1, flipped: false };
    }
    render();
  }

  function sortRows(rs) {
    var s = ui.sort;
    if (!s) return rs;
    var out = rs.slice();
    out.sort(function (a, b) {
      var x, y;
      if (s.kind === 'text') {
        x = String(a[s.k] || ''); y = String(b[s.k] || '');
        var c = x.localeCompare(y);
        if (c) return c * s.dir;
      } else {
        x = a[s.k]; y = b[s.k];
        if (x === null || x === undefined || !isFinite(x)) x = -Infinity;
        if (y === null || y === undefined || !isFinite(y)) y = -Infinity;
        if (x !== y) return (x < y ? -1 : 1) * s.dir;
      }
      // ties fall back to location then name so the order stays stable
      return a.loc === b.loc ? a.name.localeCompare(b.name) : a.loc.localeCompare(b.loc);
    });
    return out;
  }

  var COL_GROUPS = [
    { g: 'staff', t: 'Staff and remuneration', l: true },
    { g: 'tgt', t: 'Targets' },
    { g: 'rec', t: 'Receipted analysis' },
    { g: 'inv', t: 'Invoiced analysis' },
    { g: 'ann', t: 'Annual targets' }
  ];

  // First column of each group carries a divider so the blocks read as bands.
  var GROUP_START = {};
  COLS.forEach(function (c, i) { if (i === 0 || COLS[i - 1].g !== c.g) GROUP_START[i] = true; });

  function renderTable(rs) {
    var tb = $('mainTable'); tb.innerHTML = '';
    var thead = el('thead');
    var gtr = el('tr', 'colgrp');
    COL_GROUPS.forEach(function (grp, gi) {
      var span = 0;
      COLS.forEach(function (c) { if (c.g === grp.g) span++; });
      var th = el('th', (grp.l ? 'l ' : '') + 'gh' + (gi ? ' sep' : ''), grp.t);
      th.colSpan = span;
      gtr.appendChild(th);
    });
    thead.appendChild(gtr);
    var tr = el('tr', 'cols');
    COLS.forEach(function (c, i) {
      var cls = (c.l ? 'l' : '') + (GROUP_START[i] && i ? ' sep' : '');
      var active = ui.sort && ui.sort.k === c.k;
      if (c.s) cls += ' sortable' + (active ? ' sorted' : '');
      var th = el('th', cls, '');
      if (c.s) {
        var b = el('button', 'sortbtn', c.t + (active ? (ui.sort.dir > 0 ? ' \u25B2' : ' \u25BC') : ''));
        b.type = 'button';
        b.title = 'Sort by ' + (SORT_LABEL[c.k] || c.t.toLowerCase()) + (active ? ' \u2014 click to reverse, again to return to the location view' : '');
        b.onclick = function () { setSort(c.k, c.s); };
        th.appendChild(b);
        th.setAttribute('aria-sort', active ? (ui.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      } else th.textContent = c.t;
      if (c.rk) th.title = 'Receipted or invoiced for the year to date against the full annual target. The colour compares it with the pro-rata target for the months paid so far.';
      tr.appendChild(th);
    });
    thead.appendChild(tr); tb.appendChild(thead);
    // keep the column-name row stuck directly beneath the group band
    requestAnimationFrame(function () {
      var h = gtr.getBoundingClientRect().height;
      if (h) { for (var i = 0; i < tr.children.length; i++) tr.children[i].style.top = h + 'px'; }
    });
    var body = el('tbody');

    // Default view: one block per location with a subtotal line. When a sort is
    // active every staff member sits in a single ranked list instead.
    var groups = {}, gorder = [];
    if (ui.sort) {
      gorder = ['__flat__'];
      groups.__flat__ = sortRows(rs);
    } else {
      rs.forEach(function (r) { if (!groups[r.loc]) { groups[r.loc] = []; gorder.push(r.loc); } groups[r.loc].push(r); });
    }

    function numCells(tr, r) {
      COLS.forEach(function (c, i) {
        if (c.l) return;
        var td = el('td', GROUP_START[i] ? 'sep' : '');
        if (c.p) {
          if (r[c.k] === null || r[c.k] === undefined) td.textContent = '—';
          else td.appendChild(ragPill(r[c.k], c.rk ? r[c.rk] : null));
        } else td.textContent = c.f(r[c.k]);
        tr.appendChild(td);
      });
    }

    gorder.forEach(function (L) {
      var g = groups[L];
      var agg = g.reduce(function (a, r) {
        ['payPeriod', 'annual', 'annualTarget', 'periodTarget', 'rec', 'inv', 'recFY', 'invFY', 'recVar', 'invVar', 'ytdTarget'].forEach(function (k) { a[k] = (a[k] || 0) + r[k]; });
        return a;
      }, {});
      agg.recPeriodPct = agg.periodTarget ? agg.rec / agg.periodTarget : null;
      agg.invPeriodPct = agg.periodTarget ? agg.inv / agg.periodTarget : null;
      agg.recAnnualPct = agg.annualTarget ? agg.recFY / agg.annualTarget : null;
      agg.invAnnualPct = agg.annualTarget ? agg.invFY / agg.annualTarget : null;
      agg.recYtdPct = agg.ytdTarget ? agg.recFY / agg.ytdTarget : null;
      agg.invYtdPct = agg.ytdTarget ? agg.invFY / agg.ytdTarget : null;

      if (L !== '__flat__') {
        var gr = el('tr', 'grp');
        var gtd = el('td', 'l');
        gtd.appendChild(el('span', 'dot ' + rag(agg.recPeriodPct)));
        gtd.appendChild(document.createTextNode(L + '  (' + g.length + ')'));
        gr.appendChild(gtd);
        numCells(gr, agg);
        body.appendChild(gr);
      }

      g.forEach(function (r) {
        var tr2 = el('tr');
        var td = el('td', 'l name');
        var btn = el('button', 'exp', ui.expanded[r.key] ? '▾' : '▸');
        btn.title = 'Show monthly detail';
        btn.onclick = function () { ui.expanded[r.key] = !ui.expanded[r.key]; render(); };
        td.appendChild(btn);
        var a = el('span', null, r.name + (r.partial ? ' †' : '') + (r.split ? ' ‡' : ''));
        if (r.split) a.title = r.name + ' is recorded at more than one location this year; each location shows only its own months.';
        td.appendChild(a);
        // in a ranked list the location band is gone, so label each row with it
        if (ui.sort) td.appendChild(el('span', 'locTag', r.loc));
        tr2.appendChild(td);
        numCells(tr2, r);
        body.appendChild(tr2);

        if (ui.expanded[r.key]) {
          var s = r.series, mult = +state.settings.mult || 0;
          var annual = r.annual, rate = model.staff[r.staffKey].annualRate;
          scopeMonths().forEach(function (m) {
            // a month's target is the salary rate for the share of that month
            // recorded at this location
            var mTgt = rate * mult * (s.fte[m] || 0) / 12;
            var sr = el('tr', 'sub');
            var c0 = el('td', 'l', '     ' + monthLabel(m));
            sr.appendChild(c0);
            var d = {
              payPeriod: s.pay[m] || 0, annual: annual, annualTarget: annual * mult, periodTarget: mTgt,
              rec: s.rec[m] || 0, inv: s.inv[m] || 0,
              recPeriodPct: mTgt ? (s.rec[m] || 0) / mTgt : null, invPeriodPct: mTgt ? (s.inv[m] || 0) / mTgt : null,
              recVar: (s.rec[m] || 0) - mTgt, invVar: (s.inv[m] || 0) - mTgt,
              recAnnualPct: null, invAnnualPct: null, recYtdPct: null, invYtdPct: null
            };
            numCells(sr, d);
            body.appendChild(sr);
          });
        }
      });
    });

    if (rs.length) {
      var tot = rs.reduce(function (a, r) {
        ['payPeriod', 'annual', 'annualTarget', 'periodTarget', 'rec', 'inv', 'recFY', 'invFY', 'recVar', 'invVar', 'ytdTarget'].forEach(function (k) { a[k] = (a[k] || 0) + r[k]; });
        return a;
      }, {});
      tot.recPeriodPct = tot.periodTarget ? tot.rec / tot.periodTarget : null;
      tot.invPeriodPct = tot.periodTarget ? tot.inv / tot.periodTarget : null;
      tot.recAnnualPct = tot.annualTarget ? tot.recFY / tot.annualTarget : null;
      tot.invAnnualPct = tot.annualTarget ? tot.invFY / tot.annualTarget : null;
      tot.recYtdPct = tot.ytdTarget ? tot.recFY / tot.ytdTarget : null;
      tot.invYtdPct = tot.ytdTarget ? tot.invFY / tot.ytdTarget : null;
      var trt = el('tr', 'tot'); trt.appendChild(el('td', 'l', 'Total — ' + (ui.loc || 'all locations')));
      numCells(trt, tot); body.appendChild(trt);
    } else {
      var er = el('tr'); var etd = el('td', 'l', 'No staff with receipts or invoices for this selection.'); etd.colSpan = COLS.length; er.appendChild(etd); body.appendChild(er);
    }
    tb.appendChild(body);
    $('tableTitle').textContent = 'Billable staff performance — ' + scopeText()
      + (ui.sort ? '  ·  ranked by ' + (SORT_LABEL[ui.sort.k] || ui.sort.k) + (ui.sort.dir > 0 ? ' (low to high)' : ' (high to low)') : '');
    $('sortSel').value = ui.sort ? ui.sort.k : 'loc';
    $('sortDirBtn').textContent = ui.sort
      ? (ui.sort.dir > 0 ? (ui.sort.kind === 'text' ? 'A to Z' : 'Low to high') : (ui.sort.kind === 'text' ? 'Z to A' : 'High to low'))
      : 'A to Z';
    $('sortDirBtn').disabled = !ui.sort;
    $('resetSortBtn').hidden = !ui.sort;
    $('tableNote').textContent = (ui.sort ? 'Ranked across all selected locations; use Reset to location view for the grouped view with location subtotals. ' : '')
      + 'Columns are banded: staff and remuneration, then Targets, Receipted analysis, Invoiced analysis and Annual targets. The two annual columns show progress against the full-year target, but their traffic light grades the pro-rata year-to-date target (annual target × months paid so far ÷ 12), so someone on track reads green even early in the year. Period target = annual target × loaded months in period ÷ 12. Annual target = ' + state.settings.mult + ' × annualised salary + super. Click a name to expand monthly detail. Where a staff member moved office during the year, each month is reported under the location the payroll recorded it at, and a month split across two offices is apportioned on the pay recorded at each. Every staff member in the payroll export is measured, at every location, but only those with receipts or invoices recorded against them in the financial year are listed. † paid in only some loaded months (starter, leaver or unpaid leave), so targets count only the months they were paid. ‡ recorded at more than one location this year, so they appear under each office for its own months — the Staff detail tab combines them.';
  }

  function renderBars(container, rs, key, pctKey) {
    var box = $(container); box.innerHTML = '';
    var dollars = ui.barMode === 'dollar';
    // ranked by the measure on show, so the $ view ranks on value, not percentage
    var data = rs.slice().sort(function (a, b) {
      return dollars ? (b[key] || 0) - (a[key] || 0) : (b[pctKey] || 0) - (a[pctKey] || 0);
    });
    if (!data.length) { box.appendChild(el('p', 'note', 'No data for this selection.')); return; }
    var max;
    if (dollars) {
      max = data.reduce(function (m, r) { return Math.max(m, r[key] || 0, r.periodTarget || 0); }, 0) * 1.04;
      if (!max) max = 1;
    } else {
      max = Math.max(1.2, Math.min(3, data.reduce(function (m, r) { return Math.max(m, r[pctKey] || 0); }, 0) * 1.05));
    }
    data.forEach(function (r) {
      var row = el('div', 'bar-row');
      row.appendChild(el('div', 'bl', r.name + (r.split ? ' — ' + r.loc : '')));
      var tr = el('div', 'track');
      var f = el('div', 'fill ' + rag(r[pctKey]));
      var w = dollars ? (r[key] || 0) / max : (r[pctKey] || 0) / max;
      f.style.width = Math.max(0, Math.min(100, w * 100)) + '%';
      tr.appendChild(f);
      // the marker is the target: a shared 100% line in % mode, each person's own $ target in $ mode
      var mk = el('div', 'mark100');
      mk.style.left = Math.max(0, Math.min(100, (dollars ? (r.periodTarget || 0) / max : 1 / max) * 100)) + '%';
      mk.title = dollars ? 'Target ' + money(r.periodTarget) : '100% of target';
      tr.appendChild(mk);
      row.appendChild(tr);
      row.appendChild(el('div', 'bv', dollars ? money(r[key]) : pct(r[pctKey])));
      row.title = r.name + ' — ' + money(r[key]) + ' of ' + money(r.periodTarget) + ' (' + pct(r[pctKey]) + ')';
      box.appendChild(row);
    });
  }

  function renderBarPanels(rs) {
    var dollars = ui.barMode === 'dollar';
    var scope = scopeText();
    $('barsRecTitle').textContent = 'Receipted vs target \u2014 ' + scope;
    $('barsInvTitle').textContent = 'Invoiced vs target \u2014 ' + scope;
    var note = dollars
      ? 'Dollars for the selected reporting basis. The bar is the amount and the vertical line is that person\u2019s target for the same months; the colour still reflects the percentage achieved.'
      : 'Percentage of target for the selected reporting basis. The vertical line is 100% of target.';
    $('barsRecNote').textContent = note;
    $('barsInvNote').textContent = note;
    Array.prototype.forEach.call(document.querySelectorAll('.segbtn'), function (b) {
      var on = (b.dataset.mode === 'dollar') === dollars;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderBars('barsReceipted', rs, 'rec', 'recPeriodPct');
    renderBars('barsInvoiced', rs, 'inv', 'invPeriodPct');
  }

  function renderStaffView() {
    var rs = rows(), sel = $('staffSel');
    var all = [];
    model.order.forEach(function (k) { if (model.staff[k].billable) all.push(k); });
    all.sort(function (a, b) { return model.staff[a].name.localeCompare(model.staff[b].name); });
    sel.innerHTML = '';
    all.forEach(function (k) { var o = el('option', null, model.staff[k].name + ' — ' + (model.staff[k].rowLocs.join(' / ') || model.staff[k].loc)); o.value = k; sel.appendChild(o); });
    if (!ui.staff || all.indexOf(ui.staff) < 0) ui.staff = all[0] || '';
    sel.value = ui.staff;

    var box = $('staffDetail'); box.innerHTML = '';
    if (!ui.staff) { box.appendChild(el('p', 'note', 'No staff with receipts or invoices loaded.')); return; }
    var s = model.staff[ui.staff], mult = +state.settings.mult || 0;
    var paid = model.months.filter(function (m) { return (s.pay[m] || 0) > 0; });
    var payFY = sumOver(s.pay, model.months), annual = paid.length ? payFY / paid.length * 12 : 0, annTgt = annual * mult;
    var recFY = sumOver(s.rec, model.months), invFY = sumOver(s.inv, model.months);
    var ytdTgt = annTgt * paid.length / 12;

    var head = el('div', 'sd-head');
    [['Location', (s.rowLocs.join(', ') || s.loc)], ['Months paid', paid.length + ' of ' + model.months.length + ' loaded'],
     ['Pay + super ' + fyLabel(model.fy), money(payFY)], ['Annualised salary + super', money(annual)],
     ['Annual target (each)', money(annTgt)], ['Year-to-date target', money(ytdTgt)],
     ['Receipted YTD', money(recFY) + '  (' + pct(ytdTgt ? recFY / ytdTgt : null) + ')'],
     ['Invoiced YTD', money(invFY) + '  (' + pct(ytdTgt ? invFY / ytdTgt : null) + ')']
    ].forEach(function (p) {
      var b = el('div', 'sd-box'); b.appendChild(el('div', 'k-label', p[0])); b.appendChild(el('div', 'k-val', String(p[1]))); head.appendChild(b);
    });
    box.appendChild(head);
    box.appendChild(el('p', 'note', 'Figures on this tab combine every location this person worked at during the year. The breakdown below shows how the same figures are reported to each office.'));

    // per-location breakdown: how this person's year is apportioned between offices
    var locKeys = s.rowLocs;
    if (locKeys.length > 1) {
      var lt = el('table', 'grid'), lth = el('thead'), ltr = el('tr');
      ['Location', 'Months recorded', 'Pay + super', 'Annualised salary + super', 'Annual target', 'Year-to-date target', 'Receipted', 'Invoiced'].forEach(function (h, i) { ltr.appendChild(el('th', i === 0 ? 'l' : '', h)); });
      lth.appendChild(ltr); lt.appendChild(lth);
      var ltb = el('tbody');
      locKeys.forEach(function (L) {
        var d = s.split[L];
        var lpaid = model.months.filter(function (m) { return (d.pay[m] || 0) > 0; });
        var lpay = sumOver(d.pay, model.months);
        var lann = s.paidCount ? s.annualRate * (d.fteFY / s.paidCount) : 0;
        var ltgt = lann * mult;
        var r = el('tr');
        r.appendChild(el('td', 'l', L));
        r.appendChild(el('td', null, lpaid.map(monthLabel).join(', ') || '—'));
        [money(lpay), money(lann), money(ltgt), money(s.annualRate * mult * d.fteFY / 12),
         money(sumOver(d.rec, model.months)), money(sumOver(d.inv, model.months))].forEach(function (v) { r.appendChild(el('td', null, v)); });
        ltb.appendChild(r);
      });
      var ltt = el('tr', 'tot');
      ltt.appendChild(el('td', 'l', 'Combined'));
      ltt.appendChild(el('td', null, paid.length + ' months'));
      [money(payFY), money(annual), money(annTgt), money(ytdTgt), money(recFY), money(invFY)].forEach(function (v) { ltt.appendChild(el('td', null, v)); });
      ltb.appendChild(ltt);
      lt.appendChild(ltb);
      var lw = el('div', 'scroll'); lw.appendChild(lt); box.appendChild(lw);
    }

    var t = el('table', 'grid'), th = el('thead'), tr = el('tr');
    ['Month', 'Location', 'Pay + super', 'Monthly target', 'Receipted', '% target', 'Invoiced', '% target', 'Cumulative receipted', 'Cumulative target', '% cumulative'].forEach(function (h, i) {
      tr.appendChild(el('th', i < 2 ? 'l' : '', h));
    });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody'), cumR = 0, cumI = 0, cumT = 0, mTgtBase = annTgt / 12;
    model.months.forEach(function (m) {
      var mTgt = (s.pay[m] || 0) > 0 ? mTgtBase : 0;
      cumR += s.rec[m] || 0; cumI += s.inv[m] || 0; cumT += mTgt;
      var r = el('tr');
      r.appendChild(el('td', 'l', monthLabel(m)));
      var locm = s.locs[m] ? Object.keys(s.locs[m]).join(', ') : '—';
      r.appendChild(el('td', 'l', locm));
      r.appendChild(el('td', null, money(s.pay[m] || 0)));
      r.appendChild(el('td', null, money(mTgt)));
      r.appendChild(el('td', null, money(s.rec[m] || 0)));
      var p1 = el('td'); p1.appendChild(ragPill(mTgt ? (s.rec[m] || 0) / mTgt : null)); r.appendChild(p1);
      r.appendChild(el('td', null, money(s.inv[m] || 0)));
      var p2 = el('td'); p2.appendChild(ragPill(mTgt ? (s.inv[m] || 0) / mTgt : null)); r.appendChild(p2);
      r.appendChild(el('td', null, money(cumR)));
      r.appendChild(el('td', null, money(cumT)));
      var p3 = el('td'); p3.appendChild(ragPill(cumT ? cumR / cumT : null)); r.appendChild(p3);
      tb.appendChild(r);
    });
    var tr2 = el('tr', 'tot');
    tr2.appendChild(el('td', 'l', 'Total')); tr2.appendChild(el('td', 'l', ''));
    tr2.appendChild(el('td', null, money(payFY))); tr2.appendChild(el('td', null, money(cumT)));
    tr2.appendChild(el('td', null, money(recFY)));
    var q1 = el('td'); q1.appendChild(ragPill(cumT ? recFY / cumT : null)); tr2.appendChild(q1);
    tr2.appendChild(el('td', null, money(invFY)));
    var q2 = el('td'); q2.appendChild(ragPill(cumT ? invFY / cumT : null)); tr2.appendChild(q2);
    tr2.appendChild(el('td', null, money(recFY))); tr2.appendChild(el('td', null, money(cumT)));
    var q3 = el('td'); q3.appendChild(ragPill(cumT ? recFY / cumT : null)); tr2.appendChild(q3);
    tb.appendChild(tr2);
    t.appendChild(tb);
    var wrap = el('div', 'scroll'); wrap.appendChild(t); box.appendChild(wrap);

    // quarters
    var qs = {}; model.months.forEach(function (m) { var q = quarterOf(m); (qs[q] = qs[q] || []).push(m); });
    var qt = el('table', 'grid'), qh = el('thead'), qr = el('tr');
    ['Quarter', 'Months paid', 'Pay + super', 'Quarter target', 'Receipted', '% target', 'Invoiced', '% target'].forEach(function (h, i) { qr.appendChild(el('th', i === 0 ? 'l' : '', h)); });
    qh.appendChild(qr); qt.appendChild(qh);
    var qb = el('tbody');
    Object.keys(qs).sort().forEach(function (q) {
      var ms = qs[q], tgt = annTgt * ms.filter(function (m) { return (s.pay[m] || 0) > 0; }).length / 12;
      var r = el('tr');
      r.appendChild(el('td', 'l', QLABEL[q]));
      r.appendChild(el('td', null, ms.filter(function (m) { return (s.pay[m] || 0) > 0; }).length + ' of ' + ms.length));
      r.appendChild(el('td', null, money(sumOver(s.pay, ms))));
      r.appendChild(el('td', null, money(tgt)));
      r.appendChild(el('td', null, money(sumOver(s.rec, ms))));
      var a1 = el('td'); a1.appendChild(ragPill(tgt ? sumOver(s.rec, ms) / tgt : null)); r.appendChild(a1);
      r.appendChild(el('td', null, money(sumOver(s.inv, ms))));
      var a2 = el('td'); a2.appendChild(ragPill(tgt ? sumOver(s.inv, ms) / tgt : null)); r.appendChild(a2);
      qb.appendChild(r);
    });
    qt.appendChild(qb);
    box.appendChild(el('h3', null, 'Quarterly summary'));
    var w2 = el('div', 'scroll'); w2.appendChild(qt); box.appendChild(w2);
  }

  function renderLocations() {
    var rs = rows();
    var groups = {};
    rs.forEach(function (r) { (groups[r.loc] = groups[r.loc] || []).push(r); });
    var t = $('locTable'); t.innerHTML = '';
    var th = el('thead'), tr = el('tr');
    ['Location', 'Staff', 'Pay + super (period)', 'Annualised salary + super', 'Annual target', 'Period target', 'Receipted', '% period', 'Invoiced', '% period', '% annual (rec)'].forEach(function (h, i) { tr.appendChild(el('th', i === 0 ? 'l' : '', h)); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody'), bars = [];
    Object.keys(groups).sort().forEach(function (L) {
      var g = groups[L], a = { payPeriod: 0, annual: 0, annualTarget: 0, periodTarget: 0, rec: 0, inv: 0, recFY: 0 };
      g.forEach(function (r) { a.payPeriod += r.payPeriod; a.annual += r.annual; a.annualTarget += r.annualTarget; a.periodTarget += r.periodTarget; a.rec += r.rec; a.inv += r.inv; a.recFY += r.recFY; });
      var rp = a.periodTarget ? a.rec / a.periodTarget : null, ip = a.periodTarget ? a.inv / a.periodTarget : null;
      var r = el('tr');
      var c0 = el('td', 'l'); c0.appendChild(el('span', 'dot ' + rag(rp))); c0.appendChild(document.createTextNode(L)); r.appendChild(c0);
      [String(g.length), money(a.payPeriod), money(a.annual), money(a.annualTarget), money(a.periodTarget), money(a.rec)].forEach(function (v) { r.appendChild(el('td', null, v)); });
      var p1 = el('td'); p1.appendChild(ragPill(rp)); r.appendChild(p1);
      r.appendChild(el('td', null, money(a.inv)));
      var p2 = el('td'); p2.appendChild(ragPill(ip)); r.appendChild(p2);
      var p3 = el('td'); p3.appendChild(ragPill(a.annualTarget ? a.recFY / a.annualTarget : null)); r.appendChild(p3);
      tb.appendChild(r);
      bars.push({ name: L, rec: a.rec, periodTarget: a.periodTarget, recPeriodPct: rp });
    });
    t.appendChild(tb);
    renderBars('barsLoc', bars, 'rec', 'recPeriodPct');
  }

  function renderData() {
    var t = $('invTable'); t.innerHTML = '';
    var th = el('thead'), tr = el('tr');
    ['Month', 'FY', 'Pay rows', 'Receipt rows', 'Invoice rows', 'Loaded', ''].forEach(function (h, i) { tr.appendChild(el('th', i < 2 ? 'l' : '', h)); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    Object.keys(state.months).sort().forEach(function (m) {
      var d = state.months[m], r = el('tr');
      r.appendChild(el('td', 'l', monthLabel(m)));
      r.appendChild(el('td', 'l', fyLabel(fyOf(m))));
      r.appendChild(el('td', null, String((d.pay || []).length)));
      r.appendChild(el('td', null, String((d.receipts || []).length)));
      r.appendChild(el('td', null, String((d.invoiced || []).length)));
      r.appendChild(el('td', null, d.loadedAt || ''));
      var td = el('td');
      var b = el('button', 'btn ghost mini role-admin', 'Remove');
      b.onclick = function () { if (confirm('Remove ' + monthLabel(m) + ' from the shared store? Everyone signed in will lose this period.')) removeMonth(m); };
      td.appendChild(b); r.appendChild(td);
      tb.appendChild(r);
    });
    if (!Object.keys(state.months).length) { var e = el('tr'), etd = el('td', 'l', 'No data loaded.'); etd.colSpan = 7; e.appendChild(etd); tb.appendChild(e); }
    t.appendChild(tb);

    var ut = $('unmatchedTable'); ut.innerHTML = '';
    var uh = el('thead'), ur = el('tr');
    ['Name in report', 'Receipted (FY)', 'Invoiced (FY)', 'Map to payroll staff'].forEach(function (h, i) { ur.appendChild(el('th', i === 0 || i === 3 ? 'l' : '', h)); });
    uh.appendChild(ur); ut.appendChild(uh);
    var ub = el('tbody');
    var un = model.unmatched, keys = Object.keys(un).sort(function (a, b) { return (un[b].rec + un[b].inv) - (un[a].rec + un[a].inv); });
    keys.forEach(function (k) {
      var u = un[k], r = el('tr');
      r.appendChild(el('td', 'l', u.name));
      r.appendChild(el('td', null, money(u.rec)));
      r.appendChild(el('td', null, money(u.inv)));
      var td = el('td', 'l');
      var sel = el('select');
      var o0 = el('option', null, '— not payroll staff —'); o0.value = ''; sel.appendChild(o0);
      Object.keys(model.staff).sort().forEach(function (sk) { var o = el('option', null, model.staff[sk].name); o.value = sk; if (state.aliases[k] === sk) o.selected = true; sel.appendChild(o); });
      sel.disabled = !can('editor');
      sel.onchange = function () { if (sel.value) state.aliases[k] = sel.value; else delete state.aliases[k]; pushAliases().then(render); };
      td.appendChild(sel); r.appendChild(td);
      ub.appendChild(r);
    });
    if (!keys.length) { var e2 = el('tr'), etd2 = el('td', 'l', 'Every name in the receipt and invoice reports matched a payroll record.'); etd2.colSpan = 4; e2.appendChild(etd2); ub.appendChild(e2); }
    ut.appendChild(ub);

    var ft = $('fuzzyTable');
    if (ft) {
      ft.innerHTML = '';
      var fh = el('thead'), fr = el('tr');
      ['Name in report', 'Credited to payroll record'].forEach(function (h) { fr.appendChild(el('th', 'l', h)); });
      fh.appendChild(fr); ft.appendChild(fh);
      var fb = el('tbody');
      var ml = model.matchLog || {}, mk = Object.keys(ml).sort();
      mk.forEach(function (k) {
        var r = el('tr');
        r.appendChild(el('td', 'l', k));
        r.appendChild(el('td', 'l', (model.staff[ml[k]] || {}).name || ml[k]));
        fb.appendChild(r);
      });
      if (!mk.length) { var e3 = el('tr'), etd3 = el('td', 'l', 'Every matched name was spelled exactly as it appears in payroll.'); etd3.colSpan = 2; e3.appendChild(etd3); fb.appendChild(e3); }
      ft.appendChild(fb);
    }
  }

  function render() {
    renderControls();
    ['dashboard', 'staff', 'locations', 'data', 'method'].forEach(function (v) { $('view-' + v).hidden = v !== ui.view; });
    Array.prototype.forEach.call(document.querySelectorAll('#viewTabs .tab'), function (b) { b.classList.toggle('active', b.dataset.view === ui.view); });
    var rs = rows();
    if (ui.view === 'dashboard') { renderKpis(rs); renderTable(rs); renderBarPanels(rs); }
    if (ui.view === 'staff') renderStaffView();
    if (ui.view === 'locations') renderLocations();
    renderData();
    var sn = $('storeNote');
    if (sn) sn.textContent = latest && latest.by && latest.by !== 'build'
      ? 'Shared store — last updated ' + latest.at + ' by ' + latest.by +
        (latest.filename ? ' (' + latest.filename + ')' : '') + '. Other signed-in dashboards pick up changes within a minute.'
      : 'Shared store — currently holding the reports supplied with this dashboard. Every signed-in user sees the periods listed here.';
    var ms = Object.keys(state.months).sort();
    $('footNote').textContent = ms.length
      ? 'Loaded: ' + ms.map(monthLabel).join(', ') + '. Targets use a multiple of ' + state.settings.mult + '. Data is held in the firm-wide shared store behind this sign-in.'
      : 'No data loaded.';
  }

  /* ---------- CSV export ---------- */
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;      // neutralise spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    var rs = sortRows(rows()), lines = [];
    lines.push(['Financial year', csvCell(fyLabel(model.fy))].join(','));
    lines.push(['Basis', csvCell(scopeText())].join(','));
    lines.push(['Target multiple', state.settings.mult].join(','));
    lines.push('');
    var band = ['Staff and remuneration', '', '', '', 'Targets', '', 'Receipted analysis', '', '', 'Invoiced analysis', '', '', 'Annual targets', '', '', '', '', '', ''];
    lines.push(band.map(csvCell).join(','));
    var head = ['Staff member', 'Location', 'Pay + super (period)', 'Annualised salary + super', 'Annual target', 'Period target', 'Receipted', '% period target', 'Receipt variance', 'Invoiced', '% period target', 'Invoice variance', 'Receipted FY', '% annual target', 'Invoiced FY', '% annual target', 'Pro-rata YTD target', '% pro-rata YTD target (rec)', '% pro-rata YTD target (inv)'];
    lines.push(head.join(','));
    rs.forEach(function (r) {
      lines.push([csvCell(r.name), csvCell(r.loc), r.payPeriod.toFixed(2), r.annual.toFixed(2), r.annualTarget.toFixed(2), r.periodTarget.toFixed(2),
        r.rec.toFixed(2), (r.recPeriodPct * 100).toFixed(1), r.recVar.toFixed(2), r.inv.toFixed(2), (r.invPeriodPct * 100).toFixed(1), r.invVar.toFixed(2),
        r.recFY.toFixed(2), (r.recAnnualPct * 100).toFixed(1), r.invFY.toFixed(2), (r.invAnnualPct * 100).toFixed(1),
        r.ytdTarget.toFixed(2), (r.recYtdPct === null ? '' : (r.recYtdPct * 100).toFixed(1)), (r.invYtdPct === null ? '' : (r.invYtdPct * 100).toFixed(1))].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'FRL-staff-performance-' + model.fy + '-' + (ui.basis === 'ytd' ? 'YTD' : ui.period) + '.csv';
    a.click();
  }

  var parseWorkbook = FRLParser.parseWorkbook;

  function logMsg(cls, txt) {
    var l = $('uploadLog');
    l.insertBefore(el('div', cls, txt), l.firstChild);
  }

  var KIND_LABEL = { pay: 'Pay categories', receipts: 'Staff receipted funds', invoiced: 'Staff invoiced funds' };

  /* Send each recognised report to the shared store, one at a time, then show
     the refreshed firm-wide data. */
  function sendQueue(queue) {
    if (!queue.length) { render(); return; }
    var item = queue.shift();
    apiFetch('/api/month', { method: 'POST', body: item })
      .then(function (d) {
        var s = d.saved || {};
        logMsg('ok', '✓ ' + item.file + ' — ' + KIND_LABEL[item.kind] + ' for ' + monthLabel(item.month) + ': ' +
          s.rows + ' rows saved to the shared store' + (s.replaced ? ' (replaced ' + s.replaced + ' existing rows)' : '') + '.');
        applyState(d, true);
        sendQueue(queue);
      })
      .catch(function (e) {
        if (e instanceof AuthError) { onAuthLost(); return; }
        logMsg('err', '✕ ' + item.file + ' — could not be saved to the shared store: ' + e.message);
        sendQueue(queue);
      });
  }

  function handleFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var pending = list.length;
    var queue = [];
    list.forEach(function (f) {
      var rd = new FileReader();
      rd.onload = function (ev) {
        try {
          var wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
          var p = parseWorkbook(wb, f.name);
          if (!p.type) logMsg('err', '✕ ' + f.name + ' — could not recognise this report. Expected a Pay Categories export, or a Staff Receipted / Staff Invoiced Funds report with a Contribution column.');
          else if (!p.month) logMsg('err', '✕ ' + f.name + ' — recognised as ' + p.type + ' but no report date range was found, so the month is unknown.');
          else if (!p.rows.length) logMsg('err', '✕ ' + f.name + ' — no data rows found.');
          else {
            queue.push({ month: p.month, kind: p.type, rows: p.rows, file: f.name });
            p.warn.forEach(function (w) { logMsg('info', '   note: ' + w); });
          }
        } catch (e) {
          logMsg('err', '✕ ' + f.name + ' — ' + e.message);
        }
        if (--pending === 0) sendQueue(queue);
      };
      rd.onerror = function () { logMsg('err', '✕ ' + f.name + ' — could not read file.'); if (--pending === 0) sendQueue(queue); };
      rd.readAsArrayBuffer(f);
    });
  }

  /* ---------- events ---------- */
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('#viewTabs .tab'), function (b) {
      b.onclick = function () { ui.view = b.dataset.view; render(); };
    });
    $('fySel').onchange = function () { ui.fy = this.value; ui.period = ''; render(); };
    $('basisSel').onchange = function () { ui.basis = this.value; ui.period = ''; render(); };
    $('periodSel').onchange = function () { ui.period = this.value; render(); };
    $('locSel').onchange = function () { ui.loc = this.value; render(); };
    ['multInput', 'greenInput', 'amberInput'].forEach(function (id) {
      $(id).onchange = function () {
        state.settings.mult = +$('multInput').value || 3.5;
        state.settings.green = +$('greenInput').value || 100;
        state.settings.amber = +$('amberInput').value || 85;
        pushSettings().then(render);
      };
    });
    $('exportBtn').onclick = exportCsv;
    $('sortSel').onchange = function () {
      if (this.value === 'loc') { ui.sort = null; render(); return; }
      var col = null;
      COLS.forEach(function (c) { if (c.k === this.value) col = c; }, this);
      ui.sort = { k: this.value, kind: col && col.s === 'text' ? 'text' : 'num', dir: col && col.s === 'text' ? 1 : -1, flipped: false };
      render();
    };
    $('sortDirBtn').onclick = function () {
      if (!ui.sort) return;
      ui.sort = { k: ui.sort.k, kind: ui.sort.kind, dir: -ui.sort.dir, flipped: false };
      render();
    };
    $('resetSortBtn').onclick = function () { ui.sort = null; render(); };
    Array.prototype.forEach.call(document.querySelectorAll('.segbtn'), function (b) {
      b.onclick = function () { ui.barMode = b.dataset.mode; render(); };
    });
    $('staffSel').onchange = function () { ui.staff = this.value; render(); };
    $('fileInput').onchange = function () { handleFiles(this.files); this.value = ''; };
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (ev) { handleFiles(ev.dataTransfer.files); });
    $('backupBtn').onclick = backup;
    $('refreshBtn').onclick = function () { pull(true).then(function () { toast('Refreshed from the shared store.'); }); };
    $('restoreInput').onchange = function () { var f = this.files[0]; this.value = ''; if (f) restoreBackup(f); };
    $('signOutBtn').onclick = signOut;
  }

  /* ---------- boot ---------- */
  wire();
  setInterval(poll, POLL_MS);
  FD.guard('staff')
    .then(function (s) { enterApp(s.user, s.role); return pull(true); })
    .catch(function (e) { $('shell').hidden = false; notice('Could not reach the dashboard server: ' + e.message); });
})();
