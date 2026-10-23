/* Finns Dashboard — Aged WIP */
(function () {
  'use strict';
  var P = window.WipParser, BUCKETS = P.BUCKETS, bucketOf = P.bucketOf;
  var SHORT_B = ['0–30', '31–60', '61–90', '91–180', '181 d–1 yr', 'Over 1 yr'];
  var KIND_LABEL = ['Professional fees', 'Cost recovery', 'Anticipated payment'];
  var NOT_ON_WIP = 'Not on Aged WIP Report';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var F0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  var F2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var N0 = new Intl.NumberFormat('en-AU');
  function m0(v) { if (Math.abs(v) < 0.5) return '<span class="zero">–</span>'; return '<span class="' + (v < 0 ? 'neg' : '') + '">' + F0.format(v) + '</span>'; }
  function m2(v) { return '<span class="' + (v < 0 ? 'neg' : '') + '">' + F2.format(v) + '</span>'; }
  function plural(n, w) { return N0.format(n) + ' ' + w + (n === 1 ? '' : 's'); }
  function pct(v, t) { return t ? (v / t * 100).toFixed(1) + '%' : '–'; }
  function dmy(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

  /* ---------- API ---------- */
  // Every request goes through the shared Finns Dashboard session (../shell.js); the server checks this user's Aged WIP role.
  var ROLE = '';
  function can(role) { var R = ['viewer', 'editor', 'admin']; return R.indexOf(ROLE) >= R.indexOf(role); }
  function api(path, opts) {
    opts = opts || {};
    return FD.call('/api/wip' + path.replace(/^\/api/, ''), { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body }).then(function (r) {
      return r.text().then(function (t) {
        var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { /* */ }
        if (!r.ok) { var e = new Error(j.message || FD.MESSAGES[j.error] || ('Request failed (' + r.status + ').')); e.status = r.status; e.code = j.error; throw e; }
        return j;
      });
    }, function (e) { if (e instanceof FD.AuthError) { FD.expired('wip'); } throw e; });
  }

  /* ---------- state ---------- */
  var S = { periods: [], leap: null, ds: null, period: '', type: 'all', bucket: '', resp: '', billed: '', mtype: '', q: '', view: 'client', sort: { key: 'total', dir: -1 }, client: null, matter: null, cache: {} };
  var charts = {};

  function notice(msg, kind) { var n = $('#notice'); if (!msg) { n.hidden = true; return; } n.className = 'notice' + (kind ? ' ' + kind : ''); n.innerHTML = msg; n.hidden = false; }
  var toastT; function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3800); }

  /* ---------- filtering ---------- */
  function lineFilter(opts) {
    opts = opts || {};
    var ds = S.ds, type = S.type, b = S.bucket, resp = S.resp === '' ? null : +S.resp, billed = S.billed, mt = S.mtype, ms = S.mstatus || '', q = S.q.trim().toLowerCase();
    var matchM = null;
    if (q) {
      matchM = new Uint8Array(ds.matters.length);
      ds.matters.forEach(function (m, i) {
        var c = ds.clients[m.c];
        if ((m.no + ' ' + m.desc + ' ' + c.name + ' ' + c.short + ' ' + m.type).toLowerCase().indexOf(q) >= 0) matchM[i] = 1;
      });
    }
    var bset = b === '' ? null : b === 'o90' ? { 3: 1, 4: 1, 5: 1 } : b === 'u90' ? { 0: 1, 1: 1, 2: 1 } : (function () { var o = {}; o[+b] = 1; return o; })();
    return function (l) {
      if (type === 'fees' && l[1] !== 0) return false;
      if (type === 'oncost' && l[1] === 0) return false;
      if (bset && !bset[bucketOf(l[2])]) return false;
      if (!opts.ignoreBilled && billed !== '') { if (l[1] !== 0) return false; if (billed === 'none' ? l[4] !== -1 : l[4] !== +billed) return false; }
      var m = ds.matters[l[0]];
      if (resp !== null && m.resp !== resp) return false;
      if (mt !== '' && typeKey(m) !== mt) return false;
      if (ms && !statusMatch(m.status, ms)) return false;
      if (matchM && !opts.ignoreSearch && !matchM[l[0]]) return false;
      return true;
    };
  }
  var NO_TYPE = '~none', NO_TYPE_LABEL = 'Not on the Matter List';
  /* Matter status filter: '' all, 'active' (not archived, on the Matter List), 'archived', 'none' (not on the Matter List), 's:<LEAP status>' */
  function statusMatch(st, f) {
    if (!f) return true;
    if (f === 'active') return !!st && st !== 'Archived';
    if (f === 'archived') return st === 'Archived';
    if (f === 'none') return !st;
    return st === f.slice(2);
  }
  function statusFilterLabel(f) { return f === 'active' ? 'Active' : f === 'archived' ? 'Archived' : f === 'none' ? NO_TYPE_LABEL : f.slice(2); }
  function typeKey(m) { return m.type || NO_TYPE; }
  function typeLabel(k) { return k === NO_TYPE ? NO_TYPE_LABEL : k; }
  function blank() { return { b: [0, 0, 0, 0, 0, 0], t: 0, fees: 0, oncost: 0, n: 0, mset: {}, cset: {} }; }
  function add(a, l) { var bk = bucketOf(l[2]); a.b[bk] += l[3]; a.t += l[3]; if (l[1] === 0) a.fees += l[3]; else a.oncost += l[3]; a.n++; a.mset[l[0]] = 1; a.cset[S.ds.matters[l[0]].c] = 1; }
  function group(lines, keyFn) { var o = {}; lines.forEach(function (l) { var k = keyFn(l); (o[k] = o[k] || blank()); add(o[k], l); }); return o; }
  function count(o) { return Object.keys(o).length; }

  /* ---------- trust balances ----------
     Trust balance available = the LEAP Trust Trial Balance for the matter (latest At Date on or before the WIP Aged at date).
     Colour: green when trust is more than the WIP shown, orange when there is a balance but it is less, red when nil. */
  function trustNo(no) { return S.trust && S.trust.map[no] || 0; }
  function trustOfSet(mset) { var t = 0; for (var k in mset) t += trustNo(S.ds.matters[k].no); return t; }
  function trustClass(trust, wip) { return trust <= 0.004 ? 'tr-r' : trust > wip ? 'tr-g' : 'tr-o'; }
  function trustTitle(trust, wip) { return trust <= 0.004 ? 'No money in trust' : trust > wip ? 'Trust balance is more than the WIP shown' : 'Trust balance is less than the WIP shown'; }
  function trustCell(trust, wip, tag) { tag = tag || 'td'; if (!S.trust) return '<' + tag + ' class="num muted">n/a</' + tag + '>'; return '<' + tag + ' class="num"><span class="trust ' + trustClass(trust, wip) + '" title="' + trustTitle(trust, wip) + '">' + (trust <= 0.004 ? 'Nil' : F0.format(trust)) + '</span></' + tag + '>'; }
  function statusLabel(st) { return !st ? 'Not on Matter List' : st === 'Archived' ? 'Archived' : 'Active'; }
  function statusCell(st) { var l = statusLabel(st); return '<span class="status ' + (l === 'Archived' ? 'st-arch' : l === 'Active' ? 'st-act' : 'st-none') + '">' + l + '</span>' + (st && st !== 'Archived' ? '<span class="aka">' + esc(st) + '</span>' : ''); }

  /* ---------- loading ---------- */
  function loadIndex() {
    return api('/api/periods').then(function (j) { S.periods = j.periods || []; S.leap = j.leap; S.trustIndex = j.trust || []; });
  }
  function loadPeriod(p) {
    if (S.cache[p]) return Promise.resolve(S.cache[p]);
    return api('/api/period/' + p).then(function (ds) { S.cache = {}; S.cache[p] = ds; return ds; });
  }
  function selectPeriod(p) {
    $('#subtitle').textContent = 'Loading period…';
    return Promise.all([loadPeriod(p), api('/api/trust?period=' + p).catch(function () { return { trust: null }; })]).then(function (res) {
      var ds = res[0], t = res[1].trust;
      S.trust = t ? { atDate: t.atDate, file: t.file, total: t.total, lines: t.lines, map: {} } : null;
      if (S.trust) t.lines.forEach(function (l) { S.trust.map[l[0]] = (S.trust.map[l[0]] || 0) + l[1]; });
      S.ds = ds; S.period = p; S.client = null; S.matter = null;
      buildFilters(); render();
    });
  }

  function buildFilters() {
    var ds = S.ds;
    $('#periodFilter').innerHTML = S.periods.map(function (p) { return '<option value="' + p.period + '"' + (p.period === S.period ? ' selected' : '') + '>' + esc(p.periodLabel) + (p.partWeek ? ' (to ' + esc(p.agedAt.slice(0, 5)) + ')' : '') + '</option>'; }).join('');
    $('#bucketFilter').innerHTML = '<option value="">All aged breaks</option>' + BUCKETS.map(function (b, i) { return '<option value="' + i + '">0' + (i + 1) + ' – ' + esc(b) + '</option>'; }).join('') +
      '<option value="u90">Up to 90 days</option><option value="o90">Over 90 days</option>';
    // staff lists only include people with WIP in this period
    var respUsed = {}, billUsed = {};
    ds.matters.forEach(function (m) { if (m.resp >= 0) respUsed[m.resp] = 1; });
    ds.lines.forEach(function (l) { if (l[4] >= 0) billUsed[l[4]] = 1; });
    function opts(used, first, extra) {
      return '<option value="">' + first + '</option>' + (extra || '') + Object.keys(used).map(Number).sort(function (a, b) { return ds.staff[a].localeCompare(ds.staff[b]); })
        .map(function (i) { return '<option value="' + i + '">' + esc(ds.staff[i]) + '</option>'; }).join('');
    }
    $('#respFilter').innerHTML = opts(respUsed, 'All responsible staff');
    $('#billedFilter').innerHTML = ds.recon.hasWip ? opts(billUsed, 'All fee earners') : '<option value="">Not available — no Aged WIP Report</option>';
    $('#billedFilter').disabled = !ds.recon.hasWip;
    var typesUsed = {}; ds.matters.forEach(function (m) { typesUsed[typeKey(m)] = 1; });
    $('#mtypeFilter').innerHTML = '<option value="">All matter types</option>' + Object.keys(typesUsed).sort(function (a, b) { return a === NO_TYPE ? 1 : b === NO_TYPE ? -1 : a.localeCompare(b); })
      .map(function (k) { return '<option value="' + esc(k) + '">' + esc(typeLabel(k)) + '</option>'; }).join('');
    var stUsed = {}; ds.matters.forEach(function (m) { if (m.status) stUsed[m.status] = 1; });
    if (S.trust) S.trust.lines.forEach(function (l) { if (l[6]) stUsed[l[6]] = 1; });
    $('#statusFilter').innerHTML = '<option value="">All matters</option><option value="active">Active (not archived)</option><option value="archived">Archived</option>' +
      '<optgroup label="LEAP status">' + Object.keys(stUsed).filter(function (k) { return k !== 'Archived'; }).sort().map(function (k) { return '<option value="s:' + esc(k) + '">' + esc(k) + '</option>'; }).join('') + '</optgroup>' +
      '<option value="none">' + NO_TYPE_LABEL + '</option>';
    S.mstatus = S.mstatus || ''; $('#statusFilter').value = S.mstatus; if ($('#statusFilter').value !== S.mstatus) S.mstatus = '';
    $('#bucketFilter').value = S.bucket; $('#respFilter').value = S.resp; $('#billedFilter').value = S.billed; $('#mtypeFilter').value = S.mtype;
    if ($('#respFilter').value !== S.resp) S.resp = ''; if ($('#billedFilter').value !== S.billed) S.billed = ''; if ($('#mtypeFilter').value !== S.mtype) S.mtype = '';
  }

  /* ---------- render ---------- */
  function render() {
    var ds = S.ds; if (!ds) return;
    var p = S.periods.filter(function (x) { return x.period === S.period; })[0] || {};
    $('#subtitle').innerHTML = 'Week ending <b>' + esc(ds.periodLabel.replace(/^W\/E /, '')) + '</b>' + (ds.agedAt && ds.partWeek ? ' · aged at ' + esc(ds.agedAt) + ' (week to date)' : '') + ' · ' + N0.format(ds.lines.length) + ' transactions' + (p.uploadedAt ? ' · loaded ' + esc(p.uploadedAt.slice(0, 10).split('-').reverse().join('/')) : '') + (S.trust ? ' · trust at ' + esc(S.trust.atDate) : ' · no trust report for this week');
    $$('[data-type]').forEach(function (b) { var on = b.dataset.type === S.type; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    $$('#viewSeg button').forEach(function (b) { var on = b.dataset.view === S.view; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    var notes = [];
    if (S.billed !== '' && S.type !== 'fees') notes.push('Staff billed by applies to professional fees only, so on-costs are excluded while a fee earner is selected.');
    if (S.view === 'billed' && S.type !== 'fees') notes.push('The Staff billed by view shows professional fees only; on-costs have no fee earner.');
    if (ds.warnings && ds.warnings.length) notes = notes.concat(ds.warnings);
    if (!S.trust) notes.push('No Trust Trial Balance is held for this week, so trust balances are not shown. Upload the Trust Trial Balance at the same date.');
    $('#filterNote').hidden = !notes.length; $('#filterNote').innerHTML = notes.map(esc).join('<br>');

    var keep = lineFilter(); var lines = ds.lines.filter(keep);
    S.lines = lines;
    renderTiles(lines); renderAgeChart(lines); renderTrend(); renderList(lines);
    renderClient(); renderMatter();
  }

  function tile(label, value, sub, cls) { return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="label">' + label + '</div><div class="value">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>'; }
  function renderTiles(lines) {
    var a = blank(); lines.forEach(function (l) { add(a, l); });
    var h = tile('Total WIP', F0.format(a.t), N0.format(count(a.cset)) + ' clients · ' + N0.format(count(a.mset)) + ' matters', 'accent');
    h += tile('Professional fees', F0.format(a.fees), pct(a.fees, a.t) + ' of total');
    h += tile('On-costs', F0.format(a.oncost), pct(a.oncost, a.t) + ' of total');
    if (S.trust) { var tw = trustOfSet(a.mset); h += tile('Trust on these matters', '<span class="trust-v ' + trustClass(tw, a.t) + '">' + F0.format(tw) + '</span>', 'At ' + esc(S.trust.atDate) + ' · all trust ' + F0.format(S.trust.total), 'trust-tile'); }
    BUCKETS.forEach(function (b, i) { h += tile(esc(b), F0.format(a.b[i]), pct(a.b[i], a.t) + ' of total', i >= 3 ? 'aged' + (i >= 5 ? ' old' : '') : ''); });
    $('#tiles').innerHTML = h;
  }

  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function palette() {
    var dark = document.documentElement.dataset.theme === 'dark';
    return { buckets: dark ? ['#8BDDF5', '#4FCAEE', '#2C9BD0', '#5E7FB8', '#E59A5B', '#F08A98'] : ['#4FCAEE', '#00A9DB', '#2C61A0', '#00224A', '#C7792F', '#B42D3E'],
      fees: dark ? '#4FCAEE' : '#00224A', oncost: dark ? '#F7B91A' : '#00A9DB', text: css('--color-text-muted') || '#4B5B70', grid: css('--color-divider') || '#E4EBF2' };
  }
  function chartBase(pal, stacked) {
    return { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'bottom', labels: { color: pal.text, boxWidth: 12, font: { family: 'Figtree' } } },
        tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + F0.format(c.parsed.y); } } } },
      scales: { x: { stacked: stacked, ticks: { color: pal.text, font: { family: 'Figtree' } }, grid: { display: false } },
        y: { stacked: stacked, ticks: { color: pal.text, font: { family: 'Figtree' }, callback: function (v) { return Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'm' : '$' + Math.round(v / 1000) + 'k'; } }, grid: { color: pal.grid } } } };
  }
  function renderAgeChart(lines) {
    if (!window.Chart) return;
    var pal = palette(), f = [0, 0, 0, 0, 0, 0], o = [0, 0, 0, 0, 0, 0];
    lines.forEach(function (l) { (l[1] === 0 ? f : o)[bucketOf(l[2])] += l[3]; });
    var sets = [];
    if (S.type !== 'oncost') sets.push({ label: 'Professional fees', data: f, backgroundColor: pal.fees, borderRadius: 3 });
    if (S.type !== 'fees') sets.push({ label: 'On-costs', data: o, backgroundColor: pal.oncost, borderRadius: 3 });
    if (charts.age) charts.age.destroy();
    charts.age = new Chart($('#ageChart'), { type: 'bar', data: { labels: BUCKETS, datasets: sets }, options: chartBase(pal, true) });
  }
  function renderTrend() {
    if (!window.Chart) return;
    var pal = palette(), ps = S.periods.slice().reverse();
    var data = BUCKETS.map(function (b, i) {
      return { label: b, data: ps.map(function (p) { return (S.type !== 'oncost' ? p.fees[i] : 0) + (S.type !== 'fees' ? p.oncost[i] : 0); }), backgroundColor: pal.buckets[i], borderRadius: 2, maxBarThickness: 64 };
    });
    if (charts.trend) charts.trend.destroy();
    charts.trend = new Chart($('#trendChart'), { type: 'bar', data: { labels: ps.map(function (p) { return p.periodLabel; }), datasets: data }, options: chartBase(pal, true) });
    $('#trendSub').textContent = (ps.length > 1 ? ps.length + ' periods' : 'One period so far — the history builds with each upload') + ' · ' + ({ all: 'all WIP', fees: 'professional fees', oncost: 'on-costs' })[S.type] + ' · not affected by staff, break or search filters';
  }

  /* ---------- main list ---------- */
  var VIEW_TITLE = { client: 'WIP by client', bucket: 'WIP by aged break', resp: 'WIP by responsible staff', billed: 'WIP by staff billed by', mtype: 'WIP by matter type', trust: 'Trust balances with no time recorded', period: 'WIP by period ended' };
  function sortRows(rows) {
    var k = S.sort.key, d = S.sort.dir;
    rows.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (typeof x === 'string') return d * x.localeCompare(y);
      return d * ((x || 0) - (y || 0)) || b.total - a.total;
    });
    return rows;
  }
  function th(key, label, num) {
    var s = S.sort.key === key ? ' sorted' + (S.sort.dir > 0 ? ' asc' : '') : '';
    return '<th data-sort="' + key + '" class="' + (num ? 'num' : '') + s + '">' + label + '</th>';
  }
  function bucketHeads() { return BUCKETS.map(function (b, i) { return th('b' + i, SHORT_B[i] + (i < 4 ? ' days' : ''), true); }).join(''); }
  function rowFrom(name, a, extra) {
    var r = { name: name, total: a.t, fees: a.fees, oncost: a.oncost, matters: count(a.mset), clients: count(a.cset), n: a.n };
    a.b.forEach(function (v, i) { r['b' + i] = v; }); return Object.assign(r, extra || {});
  }

  function renderList(lines) {
    var ds = S.ds, v = S.view, rows = [], head = '', body = '', foot = '', hint = '';
    $('#listTitle').textContent = VIEW_TITLE[v];
    $('#trustBar').hidden = v !== 'trust' || !S.trust; $('#listCard').classList.toggle('trust-view', v === 'trust');
    $$('#statusSeg button').forEach(function (b) { var on = b.dataset.st === (S.mstatus || 'all'); b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    var grand = blank(); lines.forEach(function (l) { add(grand, l); });
    if (v === 'client' || v === 'resp' || v === 'billed' || v === 'mtype') {
      var src = v === 'billed' ? lines.filter(function (l) { return l[1] === 0; }) : lines;
      var g = group(src, v === 'client' ? function (l) { return ds.matters[l[0]].c; } : v === 'mtype' ? function (l) { return typeKey(ds.matters[l[0]]); } : v === 'resp' ? function (l) { return ds.matters[l[0]].resp; } : function (l) { return l[4]; });
      var tot = 0; Object.keys(g).forEach(function (k) { tot += g[k].t; });
      Object.keys(g).forEach(function (k) {
        var name = v === 'client' ? ds.clients[k].name : v === 'mtype' ? typeLabel(k) : (+k >= 0 ? ds.staff[k] : (v === 'billed' ? NOT_ON_WIP + ' (draft invoices)' : 'Unassigned'));
        rows.push(rowFrom(name, g[k], { key: k, short: v === 'client' ? ds.clients[k].short : '', trust: trustOfSet(g[k].mset) }));
      });
      sortRows(rows);
      var cum = 0;
      head = '<tr>' + th('rank', 'Rank', true) + th('name', v === 'client' ? 'Client' : v === 'mtype' ? 'Matter type' : 'Staff member') + (v === 'client' ? th('matters', 'Matters', true) : th('clients', 'Clients', true) + th('matters', 'Matters', true)) + bucketHeads() + th('total', 'Total', true) + th('trust', 'Trust available', true) + '<th class="num">% of total</th><th class="num">Cumulative</th></tr>';
      var LIMIT = S.showAll ? rows.length : 400;
      body = rows.slice(0, LIMIT).map(function (r, i) {
        cum += r.total;
        var sel = (v === 'client' && S.client === +r.key) ? ' selected' : '';
        return '<tr class="row-link' + sel + (v === 'mtype' && S.mtype === r.key ? ' selected' : '') + '" data-key="' + esc(r.key) + '"><td class="num rank">' + (i + 1) + '</td><td class="name-cell"><b>' + esc(r.name) + '</b>' + (r.short && r.short !== r.name ? '<span class="aka">' + esc(r.short) + '</span>' : '') + '</td>' +
          (v === 'client' ? '<td class="num">' + r.matters + '</td>' : '<td class="num">' + r.clients + '</td><td class="num">' + r.matters + '</td>') +
          [0, 1, 2, 3, 4, 5].map(function (j) { return '<td class="num b' + j + '">' + m0(r['b' + j]) + '</td>'; }).join('') +
          '<td class="num total">' + m0(r.total) + '</td>' + trustCell(r.trust, r.total) + '<td class="num">' + pct(r.total, tot) + '</td><td class="num muted">' + pct(cum, tot) + '</td></tr>';
      }).join('');
      if (rows.length > LIMIT) body += '<tr class="more"><td colspan="15"><button class="btn btn-ghost btn-sm" id="showAll" type="button">Show all ' + N0.format(rows.length) + ' rows</button></td></tr>';
      var T = blank(); src.forEach(function (l) { add(T, l); });
      foot = '<tr><th></th><th>Total · ' + N0.format(rows.length) + (v === 'client' ? ' clients' : v === 'mtype' ? ' matter types' : ' staff') + '</th>' + (v === 'client' ? '<th class="num">' + count(T.mset) + '</th>' : '<th class="num">' + count(T.cset) + '</th><th class="num">' + count(T.mset) + '</th>') +
        T.b.map(function (x) { return '<th class="num">' + m0(x) + '</th>'; }).join('') + '<th class="num">' + m0(T.t) + '</th>' + trustCell(trustOfSet(T.mset), T.t, 'th') + '<th class="num">100%</th><th></th></tr>';
      hint = (S.trust ? 'Trust available: green when more than the WIP shown, orange when less, red when nil (Trust Trial Balance at ' + S.trust.atDate + ', matters with WIP in the row' + (v === 'billed' ? '; a matter worked on by several fee earners counts in each of their rows' : '') + '). ' : '') + (v === 'client' ? 'Select a client to break the WIP down by matter.' : v === 'mtype' ? 'Select a matter type to filter every report to it.' : 'Select a staff member to filter the client list to them.');
      S.listRows = rows;
    } else if (v === 'trust') {
      if (!S.trust) { head = ''; body = '<tr><td class="muted">No Trust Trial Balance is held for this week.</td></tr>'; hint = ''; S.listRows = []; }
      else {
        var feeM = {}, onM = {}; ds.lines.forEach(function (l) { var no = ds.matters[l[0]].no; if (l[1] === 0) feeM[no] = 1; else onM[no] = (onM[no] || 0) + l[3]; });
        var miss = {}; (ds.recon.wipMattersNotInWipd || []).forEach(function (x) { miss[Array.isArray(x) ? x[0] : x] = 1; });
        var draft = {}; (ds.recon.draftMatters || []).forEach(function (d) { draft[d[0]] = d[4]; });
        var respName = S.resp !== '' ? ds.staff[+S.resp] : null, q = S.q.trim().toLowerCase();
        rows = S.trust.lines.filter(function (l) { return l[1] > 0.004 && !feeM[l[0]]; }).map(function (l) {
          return { key: l[0], no: l[0], trust: l[1], last: l[2], resp: l[3], client: l[8] || l[4], desc: l[5], status: l[6], type: l[7], oncost: onM[l[0]] || 0, draft: draft[l[0]] || 0, total: l[1], miss: !!miss[l[0]] };
        }).filter(function (r) {
          if (respName && r.resp !== respName) return false;
          if (S.mtype !== '' && (r.type || NO_TYPE) !== S.mtype) return false;
          if (q && (r.no + ' ' + r.client + ' ' + r.desc + ' ' + r.type).toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        var nAct = rows.filter(function (r) { return statusLabel(r.status) === 'Active'; }).length, nArc = rows.filter(function (r) { return statusLabel(r.status) === 'Archived'; }).length, nAll = rows.length;
        $$('#statusSeg button').forEach(function (b) { b.textContent = { active: 'Active', archived: 'Archived', all: 'All' }[b.dataset.st] + ' (' + N0.format({ active: nAct, archived: nArc, all: nAll }[b.dataset.st]) + ')'; });
        $('#trustBarNote').textContent = nAll - nAct - nArc ? 'All includes ' + N0.format(nAll - nAct - nArc) + ' matters not on the Matter List.' : '';
        if (S.mstatus) rows = rows.filter(function (r) { return statusMatch(r.status, S.mstatus); });
        if (S.sort.key === 'trust' || S.sort.key === 'total' || !(S.sort.key in (rows[0] || {}))) rows.sort(function (a, b) { return S.sort.dir * (a.trust - b.trust); }); else sortRows(rows);
        var act = rows.filter(function (r) { return statusLabel(r.status) === 'Active'; }), arc = rows.filter(function (r) { return statusLabel(r.status) === 'Archived'; });
        var sumT = function (a) { return a.reduce(function (x, r) { return x + r.trust; }, 0); };
        head = '<tr>' + th('no', 'Matter') + th('client', 'Client') + '<th>Description</th>' + th('type', 'Matter type') + th('resp', 'Responsible') + th('last', 'Last trust trans.') + th('oncost', 'On-costs WIP', true) + th('draft', 'Draft invoice WIP', true) + th('trust', 'Trust balance', true) + '</tr>';
        body = rows.map(function (r) {
          return '<tr><td><b>' + esc(r.no) + '</b><br>' + statusCell(r.status) + (r.miss ? '<span class="aka warn-note" title="This matter has time on the Aged WIP Report but is missing from the Aged WIP &amp; Disbursements Report">Time on Aged WIP Report only</span>' : '') + '</td><td>' + esc(r.client) + '</td><td>' + esc(r.desc) + '</td><td class="muted">' + esc(r.type) + '</td><td>' + esc(r.resp) + '</td><td class="muted">' + esc(r.last) + '</td><td class="num">' + m0(r.oncost) + '</td><td class="num">' + m0(r.draft) + '</td><td class="num total">' + F0.format(r.trust) + '</td></tr>';
        }).join('') || '<tr><td colspan="9" class="muted">No matters match the current filters.</td></tr>';
        foot = '<tr><th colspan="5">' + plural(rows.length, 'matter') + ' · active ' + N0.format(act.length) + ' (' + F0.format(sumT(act)) + ') · archived ' + N0.format(arc.length) + ' (' + F0.format(sumT(arc)) + ')' + (rows.length - act.length - arc.length ? ' · not on Matter List ' + (rows.length - act.length - arc.length) : '') + '</th><th colspan="3"></th><th class="num">' + F0.format(sumT(rows)) + '</th></tr>';
        hint = 'Matters with money in trust at ' + S.trust.atDate + ' but no unbilled time (professional fees) in this week’s WIP. Status is from the LEAP Matter List: Archived, or Active with its LEAP status. “Draft invoice WIP” shows time already on a draft invoice, which this dashboard leaves out. Responsible staff, matter type and search filters apply.' + (rows.some(function (r) { return r.miss; }) ? ' ' + rows.filter(function (r) { return r.miss; }).length + ' matters are flagged “Time on Aged WIP Report only”: they do have time, but the master report for this week left them out.' : '');
        S.listRows = rows;
      }
    } else if (v === 'bucket') {
      var gb = group(lines, function (l) { return bucketOf(l[2]); });
      head = '<tr><th>Aged break</th><th class="num">Professional fees</th><th class="num">Cost recoveries</th><th class="num">Anticipated payments</th><th class="num">Total</th><th class="num">% of total</th><th class="num">Clients</th><th class="num">Matters</th></tr>';
      rows = BUCKETS.map(function (b, i) {
        var a = gb[i] || blank(), cr = 0, ap = 0;
        lines.forEach(function (l) { if (bucketOf(l[2]) === i) { if (l[1] === 1) cr += l[3]; else if (l[1] === 2) ap += l[3]; } });
        return { key: i, name: '0' + (i + 1) + ' – ' + b, fees: a.fees, cr: cr, ap: ap, total: a.t, clients: count(a.cset), matters: count(a.mset) };
      });
      body = rows.map(function (r) {
        return '<tr class="row-link' + (S.bucket === String(r.key) ? ' selected' : '') + '" data-key="' + r.key + '"><td><span class="swatch s' + r.key + '"></span><b>' + esc(r.name) + '</b></td><td class="num">' + m0(r.fees) + '</td><td class="num">' + m0(r.cr) + '</td><td class="num">' + m0(r.ap) + '</td><td class="num total">' + m0(r.total) + '</td><td class="num">' + pct(r.total, grand.t) + '</td><td class="num">' + r.clients + '</td><td class="num">' + r.matters + '</td></tr>';
      }).join('');
      var sf = 0, sc = 0, sa = 0; rows.forEach(function (r) { sf += r.fees; sc += r.cr; sa += r.ap; });
      foot = '<tr><th>Total</th><th class="num">' + m0(sf) + '</th><th class="num">' + m0(sc) + '</th><th class="num">' + m0(sa) + '</th><th class="num">' + m0(grand.t) + '</th><th class="num">100%</th><th class="num">' + count(grand.cset) + '</th><th class="num">' + count(grand.mset) + '</th></tr>';
      hint = 'Select an aged break to filter every report to it.';
      S.listRows = rows;
    } else if (v === 'period') {
      head = '<tr><th>Period ended</th>' + BUCKETS.map(function (b, i) { return '<th class="num">' + SHORT_B[i] + (i < 4 ? ' days' : '') + '</th>'; }).join('') + '<th class="num">Total</th><th class="num">Change</th><th class="num">Clients</th><th class="num">Matters</th><th>Loaded</th></tr>';
      var ps = S.periods;
      rows = ps.map(function (p) {
        var b = BUCKETS.map(function (x, i) { return (S.type !== 'oncost' ? p.fees[i] : 0) + (S.type !== 'fees' ? p.oncost[i] : 0); });
        return { key: p.period, name: p.periodLabel + (p.partWeek ? ' · aged at ' + p.agedAt + ' (week to date)' : ''), b: b, total: b.reduce(function (s, x) { return s + x; }, 0), clients: p.clients, matters: p.matters, loaded: p.uploadedAt };
      });
      body = rows.map(function (r, i) {
        var prev = rows[i + 1], ch = prev ? r.total - prev.total : null;
        return '<tr class="row-link' + (r.key === S.period ? ' selected' : '') + '" data-key="' + r.key + '"><td><b>' + esc(r.name) + '</b>' + (r.key === S.period ? ' <span class="role-chip">Showing</span>' : '') + '</td>' + r.b.map(function (x) { return '<td class="num">' + m0(x) + '</td>'; }).join('') +
          '<td class="num total">' + m0(r.total) + '</td><td class="num">' + (ch === null ? '<span class="zero">–</span>' : m0(ch)) + '</td><td class="num">' + N0.format(r.clients) + '</td><td class="num">' + N0.format(r.matters) + '</td><td class="muted">' + esc((r.loaded || '').slice(0, 10).split('-').reverse().join('/')) + '</td></tr>';
      }).join('');
      hint = 'Select a period to report on it. Staff, break and search filters do not apply to this view. Each period is the week ending Sunday that contains the reports’ Aged at date; a later upload for the same week replaces it.';
      S.listRows = rows;
    }
    $('#listTable thead').innerHTML = head; $('#listTable tbody').innerHTML = body; $('#listTable tfoot').innerHTML = foot;
    $('#listSub').textContent = describeFilters();
    $('#listHint').textContent = hint;
  }

  function describeFilters() {
    var ds = S.ds, parts = [({ all: 'All WIP', fees: 'Professional services', oncost: 'On-costs / disbursements' })[S.type]];
    if (S.bucket !== '') parts.push($('#bucketFilter').selectedOptions[0].textContent);
    if (S.resp !== '') parts.push('Responsible: ' + ds.staff[+S.resp]);
    if (S.billed !== '') parts.push('Billed by: ' + (S.billed === 'none' ? NOT_ON_WIP : ds.staff[+S.billed]));
    if (S.mtype !== '') parts.push('Matter type: ' + typeLabel(S.mtype));
    if (S.mstatus) parts.push('Matter status: ' + statusFilterLabel(S.mstatus));
    if (S.q) parts.push('Search: “' + S.q + '”');
    return parts.join(' · ') + ' · ordered largest to smallest unless re-sorted';
  }

  /* ---------- client detail ---------- */
  function clientLines() { var c = S.client; return S.lines.filter(function (l) { return S.ds.matters[l[0]].c === c; }); }
  function renderClient() {
    var card = $('#clientCard');
    if (S.client === null || S.view !== 'client') { card.classList.add('hidden'); return; }
    var ds = S.ds, c = ds.clients[S.client], lines = clientLines();
    card.classList.remove('hidden');
    $('#clientTitle').textContent = c.name;
    var bits = []; if (c.short && c.short !== c.name) bits.push('LEAP short name: ' + c.short); if (c.email) bits.push(c.email); if (c.phone) bits.push(c.phone); if (c.suburb) bits.push(c.suburb);
    if (c.via === 'wip') bits.push('Not on the LEAP Matter List — name taken from the WIP report');
    $('#clientSub').textContent = bits.join(' · ');
    var a = blank(); lines.forEach(function (l) { add(a, l); });
    $('#clientTiles').innerHTML = tile('Total WIP', F0.format(a.t), plural(count(a.mset), 'matter'), 'accent') + tile('Professional fees', F0.format(a.fees)) + tile('On-costs', F0.format(a.oncost)) +
      tile('Up to 90 days', F0.format(a.b[0] + a.b[1] + a.b[2])) + tile('Over 90 days', F0.format(a.b[3] + a.b[4] + a.b[5]), pct(a.b[3] + a.b[4] + a.b[5], a.t) + ' of client WIP', 'aged') +
      (S.trust ? tile('Trust available', '<span class="trust-v ' + trustClass(trustOfSet(a.mset), a.t) + '">' + (trustOfSet(a.mset) > 0.004 ? F0.format(trustOfSet(a.mset)) : 'Nil') + '</span>', trustTitle(trustOfSet(a.mset), a.t) + ' · at ' + esc(S.trust.atDate)) : '');
    var g = group(lines, function (l) { return l[0]; });
    var rows = Object.keys(g).map(function (k) { var m = ds.matters[k]; return rowFrom(m.no, g[k], { key: k, desc: m.desc, type: m.type, resp: m.resp >= 0 ? ds.staff[m.resp] : '', status: m.status, trust: trustNo(m.no) }); }).sort(function (x, y) { return y.total - x.total; });
    S.clientRows = rows;
    $('#matterTable thead').innerHTML = '<tr><th>Matter</th><th>Description</th><th>Matter type</th><th>Responsible</th><th class="num">Fees</th><th class="num">On-costs</th>' + BUCKETS.map(function (b, i) { return '<th class="num">' + SHORT_B[i] + '</th>'; }).join('') + '<th class="num">Total</th><th class="num">Trust available</th></tr>';
    $('#matterTable tbody').innerHTML = rows.map(function (r) {
      return '<tr class="row-link' + (S.matter === +r.key ? ' selected' : '') + '" data-key="' + r.key + '"><td class="nowrap"><b>' + esc(r.name) + '</b><br>' + statusCell(r.status) + '</td><td class="desc-cell">' + esc(r.desc) + '</td><td class="muted">' + esc(r.type) + '</td><td class="nowrap">' + esc(r.resp) + '</td><td class="num">' + m0(r.fees) + '</td><td class="num">' + m0(r.oncost) + '</td>' +
        [0, 1, 2, 3, 4, 5].map(function (j) { return '<td class="num">' + m0(r['b' + j]) + '</td>'; }).join('') + '<td class="num total">' + m0(r.total) + '</td>' + trustCell(r.trust, r.total) + '</tr>';
    }).join('') || '<tr><td colspan="14" class="muted">No WIP for this client with the current filters.</td></tr>';
    $('#matterTable tfoot').innerHTML = '<tr><th colspan="4">Total · ' + plural(rows.length, 'matter') + '</th><th class="num">' + m0(a.fees) + '</th><th class="num">' + m0(a.oncost) + '</th>' + a.b.map(function (x) { return '<th class="num">' + m0(x) + '</th>'; }).join('') + '<th class="num">' + m0(a.t) + '</th>' + trustCell(trustOfSet(a.mset), a.t, 'th') + '</tr>';
  }

  /* ---------- matter detail ---------- */
  function matterLines() { var m = S.matter; return S.lines.filter(function (l) { return l[0] === m; }); }
  function renderMatter() {
    var card = $('#matterCard');
    if (S.matter === null || S.client === null || S.view !== 'client') { card.classList.add('hidden'); return; }
    var ds = S.ds, m = ds.matters[S.matter], lines = matterLines();
    card.classList.remove('hidden');
    $('#matterTitle').textContent = m.no + ' · ' + ds.clients[m.c].name;
    $('#matterSub').textContent = [m.desc, m.type, statusLabel(m.status) + (m.status && m.status !== 'Archived' ? ' (' + m.status + ')' : ''), m.resp >= 0 ? 'Responsible: ' + ds.staff[m.resp] : ''].filter(Boolean).join(' · ');
    var a = blank(); lines.forEach(function (l) { add(a, l); });
    var oldest = lines.reduce(function (x, l) { return Math.max(x, l[2]); }, 0);
    $('#matterTiles').innerHTML = tile('Total WIP', F0.format(a.t), a.n + ' transactions', 'accent') + tile('Professional fees', F0.format(a.fees)) + tile('On-costs', F0.format(a.oncost)) +
      tile('Over 90 days', F0.format(a.b[3] + a.b[4] + a.b[5]), pct(a.b[3] + a.b[4] + a.b[5], a.t) + ' of matter WIP', 'aged') + tile('Oldest item', lines.length ? N0.format(oldest) + ' days' : '–') +
      (S.trust ? (function () { var tb = trustNo(m.no), tl = S.trust.lines.filter(function (x) { return x[0] === m.no; })[0];
        return tile('Trust balance', '<span class="trust-v ' + trustClass(tb, a.t) + '">' + (tb > 0.004 ? F0.format(tb) : 'Nil') + '</span>', trustTitle(tb, a.t) + ' · at ' + esc(S.trust.atDate) + (tl && tl[2] ? ' · last trust transaction ' + esc(tl[2]) : '')); })() : '') +
      tile('Matter status', esc(statusLabel(m.status)), m.status && m.status !== 'Archived' ? 'LEAP status: ' + esc(m.status) : 'From the LEAP Matter List');
    // staff rows (fees by Staff Billed By) then on-cost rows
    var staffG = group(lines.filter(function (l) { return l[1] === 0; }), function (l) { return l[4]; });
    var rows = Object.keys(staffG).map(function (k) { return { label: +k >= 0 ? ds.staff[k] : (ds.recon.hasWip ? NOT_ON_WIP + ' (draft invoice)' : 'Fees'), kind: 'Fee earner', a: staffG[k] }; }).sort(function (x, y) { return y.a.t - x.a.t; });
    [1, 2].forEach(function (k) { var sub = lines.filter(function (l) { return l[1] === k; }); if (sub.length) { var x = blank(); sub.forEach(function (l) { add(x, l); }); rows.push({ label: k === 1 ? 'Cost recoveries' : 'Anticipated payments', kind: 'On-cost', a: x }); } });
    S.matterRows = rows;
    $('#staffTable thead').innerHTML = '<tr><th>Staff / on-cost</th><th>Type</th><th class="num">Items</th>' + BUCKETS.map(function (b, i) { return '<th class="num">' + SHORT_B[i] + '</th>'; }).join('') + '<th class="num">Total</th><th class="num">Share</th></tr>';
    $('#staffTable tbody').innerHTML = rows.map(function (r) {
      return '<tr class="' + (r.kind === 'On-cost' ? 'oncost-row' : '') + '"><td><b>' + esc(r.label) + '</b></td><td class="muted">' + r.kind + '</td><td class="num">' + r.a.n + '</td>' + r.a.b.map(function (x) { return '<td class="num">' + m0(x) + '</td>'; }).join('') + '<td class="num total">' + m0(r.a.t) + '</td><td class="num">' + pct(r.a.t, a.t) + '</td></tr>';
    }).join('') || '<tr><td colspan="11" class="muted">No WIP for this matter with the current filters.</td></tr>';
    $('#staffTable tfoot').innerHTML = '<tr><th colspan="2">Matter total</th><th class="num">' + a.n + '</th>' + a.b.map(function (x) { return '<th class="num">' + m0(x) + '</th>'; }).join('') + '<th class="num">' + m0(a.t) + '</th><th class="num">100%</th></tr>';
    var tx = lines.slice().sort(function (x, y) { return x[2] - y[2] || y[3] - x[3]; });
    $('#txnSub').textContent = '· ' + tx.length + ' items, newest first';
    $('#txnTable thead').innerHTML = '<tr><th>Date</th><th>Type</th><th>Staff billed by</th><th>Reference</th><th>Description</th><th class="num">Days</th><th>Aged break</th><th class="num">Amount</th></tr>';
    $('#txnTable tbody').innerHTML = tx.map(function (l) {
      var bk = bucketOf(l[2]);
      return '<tr><td class="nowrap">' + esc(l[5]) + '</td><td class="nowrap">' + KIND_LABEL[l[1]] + '</td><td class="nowrap">' + (l[1] === 0 ? esc(l[4] >= 0 ? ds.staff[l[4]] : (ds.recon.hasWip ? NOT_ON_WIP : '')) : '<span class="muted">–</span>') + '</td><td class="nowrap muted">' + esc(l[6]) + '</td><td class="desc-cell">' + esc(l[7]) + '</td><td class="num">' + l[2] + '</td><td class="nowrap"><span class="swatch s' + bk + '"></span>' + SHORT_B[bk] + '</td><td class="num">' + m2(l[3]) + '</td></tr>';
    }).join('');
  }

  /* ---------- reconciliation ---------- */
  function renderRecon() {
    var ds = S.ds, R = ds.recon;
    $('#reconDesc').textContent = ds.periodLabel + (ds.agedAt ? ' · reports aged at ' + ds.agedAt : '') + '. Source files: ' + [ds.files.wipd, ds.files.wip].filter(Boolean).join(' and ') + '.';
    if (R.draftAmt == null) { $('#reconBody').innerHTML = '<p>This period was loaded under the earlier rules. Upload its two WIP reports again to apply the draft-invoice exclusion.</p>'; return; }
    var check = Math.round((R.includedFees + R.wipOnlyAmt - R.wipTotal) * 100) / 100;
    var h = '<div class="recon-verdict ' + (Math.abs(check) < 0.01 ? 'ok' : 'warn') + '"><b>' + (Math.abs(check) < 0.01 ? 'The professional fees reported here agree to the Aged WIP Report, after its own extra lines.' : 'The professional fees reported here differ from the Aged WIP Report by ' + F2.format(check) + '.') + '</b>' +
      ' The Aged WIP &amp; Disbursements Report is the master. Fee lines on it that are not on the Aged WIP Report are WIP on draft invoices and are left out. Lines on the Aged WIP Report only are ignored. The Aged WIP Report is otherwise used only to show Staff Billed By.</div>';
    h += '<table class="data recon-table"><tbody>' +
      '<tr><td>Aged WIP &amp; Disbursements Report — total</td><td class="num">' + m2(R.wipdTotal) + '</td></tr>' +
      '<tr class="indent"><td>Professional fees</td><td class="num">' + m2(R.wipdFees) + '</td></tr>' +
      '<tr class="indent"><td>Cost recoveries</td><td class="num">' + m2(R.wipdCostRec) + '</td></tr>' +
      '<tr class="indent"><td>Anticipated payments</td><td class="num">' + m2(R.wipdAnticipated) + '</td></tr>' +
      '<tr class="indent"><td>Less: WIP on draft invoices — fee lines not on the Aged WIP Report (' + N0.format(R.draftCount) + ' lines, ' + N0.format(R.draftMatters.length) + ' matters)</td><td class="num">' + m2(-R.draftAmt) + '</td></tr>' +
      '<tr class="sep"><td><b>WIP reported in this dashboard</b></td><td class="num"><b>' + m2(R.includedTotal) + '</b></td></tr>' +
      '<tr class="indent"><td>of which professional fees</td><td class="num">' + m2(R.includedFees) + '</td></tr>' +
      '<tr class="indent"><td>of which on-costs / disbursements</td><td class="num">' + m2(R.includedTotal - R.includedFees) + '</td></tr>' +
      '<tr class="sep"><td><b>Check: professional fees reported here</b></td><td class="num"><b>' + m2(R.includedFees) + '</b></td></tr>' +
      '<tr class="indent"><td>Add: lines on the Aged WIP Report only — ignored (' + N0.format(R.wipOnlyCount) + ' lines' + (R.wipMattersNotInWipd.length ? (R.wipMattersNotInWipd.length <= 3 ? '; includes matter ' + esc(R.wipMattersNotInWipd.join(', ')) + ', which is not on the WIP &amp; Disbursements Report' : '; ' + N0.format(R.wipMattersNotInWipd.length) + ' of these matters are not on the WIP &amp; Disbursements Report at all') : '') + ')</td><td class="num">' + m2(R.wipOnlyAmt) + '</td></tr>' +
      '<tr class="sep"><td><b>Aged WIP Report — total</b></td><td class="num"><b>' + m2(R.wipTotal) + '</b></td></tr>' +
      '</tbody></table>' +
      '<p class="hint">On-costs cannot be matched to the Aged WIP Report, which carries professional fees only, so disbursements already on a draft invoice cannot be identified and remain included.</p>';
    h += '<h4 class="table-title">WIP on draft invoices excluded, by matter <span class="sub">· ' + R.draftMatters.length + ' matters · top 50 shown, export for every line</span></h4><div class="table-wrap"><table class="data"><thead><tr><th>Matter</th><th>Client</th><th>Responsible</th><th class="num">Lines</th><th class="num">Amount</th></tr></thead><tbody>' +
      R.draftMatters.slice(0, 50).map(function (r) { return '<tr><td class="nowrap"><b>' + esc(r[0]) + '</b>' + (r[5] ? '' : ' <span class="muted" title="Every WIP line on this matter is on a draft invoice">(all draft)</span>') + '</td><td>' + esc(r[1]) + '</td><td class="nowrap">' + esc(r[2]) + '</td><td class="num">' + r[3] + '</td><td class="num">' + m2(r[4]) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    h += '<h4 class="table-title">Lines on the Aged WIP Report only — ignored <span class="sub">· fees with no matching line on the master report</span></h4><div class="table-wrap"><table class="data"><thead><tr><th>Matter</th><th>Staff billed by</th><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>' +
      R.wipOnly.map(function (w) { return '<tr><td class="nowrap">' + esc(w[0]) + '</td><td class="nowrap">' + esc(w[1]) + '</td><td class="nowrap">' + esc(w[2]) + '</td><td class="desc-cell">' + esc(w[4]) + '</td><td class="num">' + m2(w[3]) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    $('#reconBody').innerHTML = h;
  }

  /* ---------- CSV ---------- */
  function csv(name, head, rows) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var text = [head].concat(rows).map(function (r) { return r.map(q).join(','); }).join('\r\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  function exportList() {
    var v = S.view, rows = S.listRows || [], tag = S.ds.period + '-' + S.type;
    if (v === 'bucket') return csv('aged-wip-breaks-' + tag + '.csv', ['Aged break', 'Professional fees', 'Cost recoveries', 'Anticipated payments', 'Total', 'Clients', 'Matters'], rows.map(function (r) { return [r.name, r2(r.fees), r2(r.cr), r2(r.ap), r2(r.total), r.clients, r.matters]; }));
    if (v === 'period') return csv('aged-wip-history-' + S.type + '.csv', ['Period ended'].concat(BUCKETS, ['Total', 'Clients', 'Matters']), rows.map(function (r) { return [r.name].concat(r.b.map(r2), [r2(r.total), r.clients, r.matters]); }));
    if (v === 'trust') return csv('trust-no-time-' + (S.mstatus ? S.mstatus.replace(/^s:/, '').replace(/\W+/g, '-').toLowerCase() : 'all') + '-' + S.ds.period + '.csv', ['Matter', 'Client', 'Description', 'Matter type', 'Responsible', 'Active / archived', 'LEAP status', 'Last trust transaction', 'On-costs WIP', 'WIP on draft invoice', 'Time on Aged WIP Report only', 'Trust balance'], rows.map(function (r) { return [r.no, r.client, r.desc, r.type, r.resp, statusLabel(r.status), r.status, r.last, r2(r.oncost), r.draft ? r2(r.draft) : '', r.miss ? 'Yes' : '', r2(r.trust)]; }));
    csv('aged-wip-by-' + v + '-' + tag + '.csv', ['Rank', v === 'client' ? 'Client' : v === 'mtype' ? 'Matter type' : 'Staff member', 'Matters'].concat(BUCKETS, ['Total', 'Professional fees', 'On-costs', 'Trust available', 'Trust vs WIP']), rows.map(function (r, i) { return [i + 1, r.name, r.matters, r2(r.b0), r2(r.b1), r2(r.b2), r2(r.b3), r2(r.b4), r2(r.b5), r2(r.total), r2(r.fees), r2(r.oncost), S.trust ? r2(r.trust || 0) : '', S.trust ? ({ 'tr-g': 'More than WIP', 'tr-o': 'Less than WIP', 'tr-r': 'Nil' })[trustClass(r.trust || 0, r.total)] : '']; }));
  }

  /* ---------- upload ---------- */
  var KIND_NAME = { trust: 'Trust Trial Balance (saved)', wipd: 'Aged WIP & Disbursements Report', wip: 'Aged WIP Report', matters: 'Matter List', clients: 'Client Details' };
  function leapText() { var l = S.leap; return l ? 'LEAP lists held — Matter List: ' + esc((l.files && l.files.matters) || '—') + ' (' + N0.format(l.matters) + ' matters) · Client Details: ' + esc((l.files && l.files.clients) || '—') + ' (' + N0.format(l.clients) + ' clients). Upload new ones only when they change.' : 'No LEAP lists held yet — include the Matter List and Client Details.'; }
  var staged = {};
  function renderStaged(list) {
    $('#fileList').innerHTML = list.map(function (f) {
      return '<li class="' + f.state + '"><b>' + esc(f.name) + '</b><span>' + esc(f.msg) + '</span></li>';
    }).join('');
    $('#commitBtn').disabled = !(staged.wipd && staged.wip);
  }
  function stageFiles(files) {
    var list = Array.prototype.slice.call(files).map(function (f) { return { file: f, name: f.name, state: 'busy', msg: 'Reading…' }; });
    $('#uploadErr').hidden = true; renderStaged(list);
    var chain = Promise.resolve(), trustSaved = false;
    list.forEach(function (it) {
      chain = chain.then(function () {
        return it.file.arrayBuffer().then(function (buf) {
          return api('/api/stage', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(it.name) }, body: buf });
        }).then(function (j) {
          it.state = 'ok'; if (j.kind === 'trust') trustSaved = true;
          it.msg = KIND_NAME[j.kind] + (j.agedAt ? ' · aged at ' + j.agedAt + ' · ' + N0.format(j.lines) + ' lines · ' + F2.format(j.total) : ' · saved');
          if (j.leap) { S.leap = j.leap; $('#leapInfo').innerHTML = leapText(); }
          staged = j.staged || staged;
        }, function (e) { it.state = 'err'; it.msg = e.message; }).then(function () { renderStaged(list); });
      });
    });
    return chain.then(function () {
      if (trustSaved && S.period) loadIndex().then(function () { return selectPeriod(S.period); });
      if (staged.wipd && staged.wip && staged.wipd.agedAt !== staged.wip.agedAt) { $('#uploadErr').textContent = 'The two WIP reports are aged at different dates. Upload a matching pair.'; $('#uploadErr').hidden = false; }
    });
  }
  function commit() {
    $('#commitBtn').disabled = true; $('#commitBtn').textContent = 'Adding…';
    api('/api/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).then(function (j) {
      S.periods = j.periods; S.cache = {}; staged = {};
      $('#uploadDialog').close();
      toast((j.replaced ? 'Replaced' : 'Added') + ' period ended ' + dmy(j.period) + '.');
      return selectPeriod(j.period);
    }).catch(function (e) { $('#uploadErr').textContent = e.message; $('#uploadErr').hidden = false; })
      .then(function () { $('#commitBtn').textContent = 'Add period'; $('#commitBtn').disabled = !(staged.wipd && staged.wip); });
  }

  /* ---------- events ---------- */
  function wire() {
    $('#periodFilter').addEventListener('change', function (e) { selectPeriod(e.target.value); });
    $$('[data-type]').forEach(function (b) { b.addEventListener('click', function () { S.type = b.dataset.type; render(); }); });
    $('#bucketFilter').addEventListener('change', function (e) { S.bucket = e.target.value; render(); });
    $('#respFilter').addEventListener('change', function (e) { S.resp = e.target.value; render(); });
    $('#billedFilter').addEventListener('change', function (e) { S.billed = e.target.value; render(); });
    $('#mtypeFilter').addEventListener('change', function (e) { S.mtype = e.target.value; render(); });
    $('#statusFilter').addEventListener('change', function (e) { S.mstatus = e.target.value; render(); });
    var st; $('#search').addEventListener('input', function (e) { clearTimeout(st); st = setTimeout(function () { S.q = e.target.value; render(); }, 180); });
    $('#clearFilters').addEventListener('click', function () { S.type = 'all'; S.bucket = ''; S.resp = ''; S.billed = ''; S.mtype = ''; S.mstatus = ''; S.q = ''; $('#search').value = ''; buildFilters(); render(); });
    $$('#statusSeg button').forEach(function (b) { b.addEventListener('click', function () { S.mstatus = b.dataset.st === 'all' ? '' : b.dataset.st; $('#statusFilter').value = S.mstatus; render(); }); });
    $$('#viewSeg button').forEach(function (b) { b.addEventListener('click', function () { S.view = b.dataset.view; S.sort = { key: 'total', dir: -1 }; S.showAll = false; render(); }); });
    $('#listTable thead').addEventListener('click', function (e) {
      var t = e.target.closest('th[data-sort]'); if (!t) return;
      var k = t.dataset.sort; if (k === 'rank') k = 'total';
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'name' ? 1 : -1 }; renderList(S.lines);
    });
    $('#listTable tbody').addEventListener('click', function (e) {
      if (e.target.id === 'showAll') { S.showAll = true; renderList(S.lines); return; }
      var tr = e.target.closest('tr[data-key]'); if (!tr) return;
      var k = tr.dataset.key, v = S.view;
      if (v === 'client') { S.client = +k; S.matter = null; renderList(S.lines); renderClient(); renderMatter(); $('#clientCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else if (v === 'resp') { S.resp = +k >= 0 ? k : ''; S.view = 'client'; buildFilters(); render(); }
      else if (v === 'billed') { S.billed = +k >= 0 ? k : 'none'; S.view = 'client'; buildFilters(); render(); }
      else if (v === 'mtype') { S.mtype = k; S.view = 'client'; buildFilters(); render(); }
      else if (v === 'bucket') { S.bucket = k; S.view = 'client'; buildFilters(); render(); }
      else if (v === 'period') { S.view = 'client'; selectPeriod(k); }
    });
    $('#matterTable tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-key]'); if (!tr) return;
      S.matter = +tr.dataset.key; renderClient(); renderMatter(); $('#matterCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#clientClose').addEventListener('click', function () { S.client = null; S.matter = null; renderList(S.lines); renderClient(); renderMatter(); $('#listCard').scrollIntoView({ behavior: 'smooth' }); });
    $('#matterClose').addEventListener('click', function () { S.matter = null; renderClient(); renderMatter(); $('#clientCard').scrollIntoView({ behavior: 'smooth' }); });
    $('#exportList').addEventListener('click', exportList);
    $('#exportClient').addEventListener('click', function () {
      var c = S.ds.clients[S.client];
      csv('aged-wip-' + c.name.replace(/[^\w]+/g, '-').slice(0, 40) + '-' + S.ds.period + '.csv', ['Matter', 'Description', 'Matter type', 'Responsible', 'Professional fees', 'On-costs'].concat(BUCKETS, ['Total']),
        S.clientRows.map(function (r) { return [r.name, r.desc, r.type, r.resp, r2(r.fees), r2(r.oncost), r2(r.b0), r2(r.b1), r2(r.b2), r2(r.b3), r2(r.b4), r2(r.b5), r2(r.total)]; }));
    });
    $('#exportMatter').addEventListener('click', function () {
      var ds = S.ds, m = ds.matters[S.matter];
      csv('aged-wip-matter-' + m.no + '-' + ds.period + '.csv', ['Date', 'Type', 'Staff billed by', 'Reference', 'Description', 'Days', 'Aged break', 'Amount'],
        matterLines().map(function (l) { return [l[5], KIND_LABEL[l[1]], l[1] === 0 ? (l[4] >= 0 ? ds.staff[l[4]] : NOT_ON_WIP) : '', l[6], l[7], l[2], BUCKETS[bucketOf(l[2])], l[3]]; }));
    });
    $('#reconOpen').addEventListener('click', function () { renderRecon(); $('#reconDialog').showModal(); });
    $('#exportRecon').addEventListener('click', function () {
      var ds = S.ds, R = ds.recon, rows = [], info = {};
      R.draftMatters.forEach(function (m) { info[m[0]] = m; });
      (R.draftLines || []).forEach(function (l) { var m = info[l[0]] || []; rows.push(['Excluded — WIP on draft invoice', l[0], m[1] || '', m[2] || '', '', l[1], l[2], l[3], l[4]]); });
      R.wipOnly.forEach(function (w) { rows.push(['Ignored — Aged WIP Report only', w[0], '', '', w[1], w[2], '', w[4], w[3]]); });
      csv('wip-reconciliation-differences-' + ds.period + '.csv', ['Treatment', 'Matter', 'Client', 'Responsible', 'Staff billed by', 'Date', 'Reference', 'Description', 'Amount'], rows);
    });
    $('#deletePeriod').addEventListener('click', function () {
      if (!confirm('Delete ' + S.ds.periodLabel + '? You can add it again by re-uploading its reports.')) return;
      api('/api/period/' + S.period, { method: 'DELETE' }).then(function (j) {
        S.periods = j.periods; S.cache = {}; $('#reconDialog').close(); toast('Period deleted.');
        if (S.periods.length) selectPeriod(S.periods[0].period); else empty();
      }).catch(function (e) { toast(e.message); });
    });
    $('#uploadOpen').addEventListener('click', function () { $('#fileList').innerHTML = ''; $('#uploadErr').hidden = true; $('#leapInfo').innerHTML = leapText(); staged = {}; api('/api/stage/clear', { method: 'POST' }).catch(function () {}); $('#commitBtn').disabled = true; $('#uploadDialog').showModal(); });
    $('#fileInput').addEventListener('change', function (e) { if (e.target.files.length) stageFiles(e.target.files); e.target.value = ''; });
    var drop = $('#drop');
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files); });
    $('#commitBtn').addEventListener('click', commit);
    $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
    $('#themeBtn').addEventListener('click', function () {
      var d = document.documentElement, next = d.dataset.theme === 'dark' ? 'light' : 'dark'; d.dataset.theme = next;
      $('#themeBtn').setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      if (S.ds) { renderAgeChart(S.lines); renderTrend(); }
    });
  }

  function empty() {
    S.ds = null; $('#subtitle').textContent = 'No periods loaded';
    notice('No WIP periods are held yet. An editor can select <b>Upload period</b> and add the Aged WIP &amp; Disbursements Report and the Aged WIP Report for the period.', 'warn');
  }

  function enter(user, role) {
    ROLE = role;
    document.body.classList.toggle('can-edit', can('editor'));
    document.body.classList.toggle('can-admin', can('admin'));
    $('#shell').hidden = false;
    $('#accountName').textContent = user.displayName || user.username;
    $('#accountRole').textContent = FD.ROLE_LABEL[role] || role;
  }
  function wireAccount() {
    $('#accountBtn').addEventListener('click', function () { var m = $('#accountMenu'); m.hidden = !m.hidden; $('#accountBtn').setAttribute('aria-expanded', String(!m.hidden)); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.account')) { $('#accountMenu').hidden = true; $('#accountBtn').setAttribute('aria-expanded', 'false'); } });
    $('#signOut').addEventListener('click', function () { FD.signOut(); });
  }

  wire(); wireAccount();
  if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
  FD.guard('wip').then(function (sess) {
    enter(sess.user, sess.role);
    return loadIndex().then(function () {
      if (!S.periods.length) return empty();
      return selectPeriod(S.periods[0].period);
    });
  }).catch(function (e) { if (e instanceof FD.AuthError || e.redirected) return; $('#shell').hidden = false; notice('Could not load the WIP data: ' + esc(e.message), 'error'); $('#subtitle').textContent = 'Error'; });
})();
