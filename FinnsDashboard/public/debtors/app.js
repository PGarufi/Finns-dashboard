/* Finn Roache Lawyers — Aged Debtors Dashboard (server-held edition).
   The server parses and stores every LEAP export and resolves client identities;
   this file renders the reports from that shared dataset. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moneyFmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => moneyFmt.format(Math.abs(v) < 0.005 ? 0 : v || 0);
const signedMoney = (v) => (v > 0.005 ? '+' : '') + money(v);
const compactMoney = (v) => { const a = Math.abs(v); if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'm'; if (a >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'k'; return '$' + Math.round(v); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
const fmtStamp = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const store = { get: (k) => FD.prefGet(k), set: (k, v) => FD.prefSet(k, v) };

/* ---------------- server access (shared Finns Dashboard session) ---------------- */
const AuthError = FD.AuthError;
const call = (path, opts, allow401) => FD.call(path, opts, allow401);
const callJSON = (path, opts, allow401) => FD.callJSON(path, opts, allow401);
let APP_ROLE = '';

/* ---------------- state ---------------- */
let ME = null, DS = null, OVR = { contacts: {}, groupSeparations: [] };
let periods = {}, active = '', defaultPeriod = '';
let selectedClient = '', clientDetailView = 'matters', sortKey = 'rank', sortDir = 1;
let movementFilter = 'All', movementScope = 'over90';
const charts = {};
const bucketOrder = ['Current', '>1 Month', '>2 Months', '>3 Months', '>6 Months', '>1 Year', '>2 Years', '>3 Years', '>4 Years', '>5 Years'];
const OLD = new Set(['>1 Year', '>2 Years', '>3 Years', '>4 Years', '>5 Years']);
const bucket = (days) => days <= 30 ? 'Current' : days <= 60 ? '>1 Month' : days <= 90 ? '>2 Months' : days <= 180 ? '>3 Months' : days <= 365 ? '>6 Months' : days <= 730 ? '>1 Year' : days <= 1095 ? '>2 Years' : days <= 1460 ? '>3 Years' : days <= 1825 ? '>4 Years' : '>5 Years';
const debtorGroupLabels = { major: '01 - Major Clients', all90: '02 - All Over 90 Days', mixed90: '03 - Over 90 days', under14: '04 - Below 14 Days', under60: '05 - 14-60 Days', under90: '06 - 60-90 Days', other: '07 - Other Clients' };
const current = () => periods[active];
const sortedPeriods = () => Object.values(periods).sort((a, b) => a.asAt.localeCompare(b.asAt));

function expandDataset(ds) {
  periods = {};
  for (const p of ds.periods) {
    const asMs = Date.parse(p.asAt + 'T00:00:00Z');
    const records = p.records.map((a) => {
      const m = ds.matters[a[2]], type = a[0] ? 'credit' : 'invoice', date = a[5];
      let days = NaN, age = 'Credit';
      if (type === 'invoice') { if (date) { days = Math.round((asMs - Date.parse(date + 'T00:00:00Z')) / 864e5); age = bucket(days); } else age = 'Undated'; }
      return { type, staff: ds.staff[a[1]], matter: m[0], matterDescription: m[1], shortName: m[2], matterType: m[3], via: m[4], client: ds.clients[a[3]], invoice: a[4], date, amount: a[6], days, age };
    });
    periods[p.asAt] = { asAt: p.asAt, sourceName: p.sourceName, uploadedAt: p.uploadedAt, uploadedBy: p.uploadedBy, records };
  }
  const ps = sortedPeriods(), today = todayISO();
  defaultPeriod = ps.length ? (ps.filter((p) => p.asAt <= today).at(-1) || ps.at(-1)).asAt : '';
  if (!periods[active]) active = defaultPeriod;
  groupCache.clear();
}
const contactFor = (client) => {
  const base = (DS && DS.contacts[client]) || { name: '', email: '', telephone: '' };
  const o = OVR.contacts[client];
  return o ? { name: o.name || '', email: o.email || '', telephone: o.telephone || '', edited: true, by: o.by, at: o.at, conflict: false } : { ...base, edited: false };
};

/* ---------------- client groups & filters (as in the August build) ---------------- */
const groupCache = new Map();
function debtorGroups(period) {
  if (!period) return new Map();
  if (groupCache.has(period.asAt)) return groupCache.get(period.asAt);
  const byClient = new Map(), groups = new Map();
  for (const r of period.records) { if (!byClient.has(r.client)) byClient.set(r.client, []); byClient.get(r.client).push(r); }
  for (const [client, rows] of byClient) {
    const inv = rows.filter((r) => r.type === 'invoice'), cr = rows.filter((r) => r.type === 'credit');
    const net = inv.reduce((n, r) => n + r.amount, 0) - cr.reduce((n, r) => n + r.amount, 0);
    const days = inv.map((r) => r.days), valid = days.length > 0 && days.every((d) => Number.isFinite(d) && d >= 0);
    let code = 'other';
    if (net > 200000) code = 'major';
    else if (valid && days.every((d) => d > 90)) code = 'all90';
    else if (valid && days.some((d) => d > 90) && days.some((d) => d <= 90)) code = 'mixed90';
    else if (valid && days.every((d) => d < 14)) code = 'under14';
    else if (valid && days.every((d) => d < 60)) code = 'under60';
    else if (valid && days.every((d) => d <= 90)) code = 'under90';
    groups.set(client, code);
  }
  groupCache.set(period.asAt, groups);
  return groups;
}
function selectedCohort() {
  const code = $('#debtorGroupFilter').value;
  if (!code) return null;
  return new Set([...debtorGroups(current())].filter(([, v]) => v === code).map(([n]) => n));
}
function reportFilteredRecords(period, cohort = selectedCohort()) {
  if (!period) return [];
  const staff = $('#staffFilter').value, age = $('#ageFilter').value, mt = $('#matterTypeFilter').value, q = $('#search').value.trim().toLowerCase();
  return period.records.filter((r) => (!cohort || cohort.has(r.client)) && (!staff || r.staff === staff) && (!age || r.age === age) && (!mt || r.matterType === mt) &&
    (!q || [r.client, r.matter, r.invoice, r.matterDescription].join(' ').toLowerCase().includes(q)));
}
const visibleRecords = () => reportFilteredRecords(current());

function metrics(rows) {
  const inv = rows.filter((r) => r.type === 'invoice'), cr = rows.filter((r) => r.type === 'credit');
  const gross = inv.reduce((s, r) => s + r.amount, 0), credits = cr.reduce((s, r) => s + r.amount, 0);
  const over90 = inv.filter((r) => !['Current', '>1 Month', '>2 Months'].includes(r.age)).reduce((s, r) => s + r.amount, 0);
  return { gross, credits, net: gross - credits, over90, invoices: inv.length, credCount: cr.length, clients: new Set(rows.map((r) => r.client)).size, matters: new Set(rows.map((r) => r.matter)).size };
}
function aggregateClients(rows) {
  const map = new Map();
  for (const r of rows) {
    let x = map.get(r.client);
    if (!x) { x = { client: r.client, gross: 0, credits: 0, net: 0, under60: 0, days60to90: 0, over90: 0, invoices: 0, matset: new Set() }; map.set(r.client, x); }
    x.matset.add(r.matter);
    if (r.type === 'invoice') { x.gross += r.amount; x.net += r.amount; x.invoices++; if (r.days < 60) x.under60 += r.amount; else if (r.days <= 90) x.days60to90 += r.amount; else x.over90 += r.amount; }
    else { x.credits += r.amount; x.net -= r.amount; }
  }
  const a = [...map.values()];
  a.forEach((x) => { x.matters = x.matset.size; });
  a.sort((x, y) => y.net - x.net);
  const total = a.reduce((s, x) => s + x.net, 0); let running = 0;
  a.forEach((x, i) => { x.rank = i + 1; x.pctTotal = total ? (x.net / total) * 100 : 0; running += x.net; x.cumulativePct = total ? (running / total) * 100 : 0; });
  return a;
}
function aggregateMatters(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.matter || '').trim() || '[Matter not specified]';
    let x = map.get(key);
    if (!x) { x = { matter: key, descriptions: new Set(), staff: new Set(), types: new Set(), gross: 0, credits: 0, under60: 0, days60to90: 0, over90: 0, invoices: 0 }; map.set(key, x); }
    if (r.matterDescription) x.descriptions.add(r.matterDescription);
    if (r.staff) x.staff.add(r.staff);
    if (r.matterType) x.types.add(r.matterType);
    if (r.type === 'invoice') { x.gross += r.amount; x.invoices++; if (r.days < 60) x.under60 += r.amount; else if (r.days <= 90) x.days60to90 += r.amount; else x.over90 += r.amount; }
    else x.credits += r.amount;
  }
  return [...map.values()].map((x) => ({ ...x, net: x.gross - x.credits })).sort((a, b) => b.net - a.net);
}

/* ---------------- parameter options ---------------- */
function refreshOptions() {
  const p = current(), today = todayISO();
  $('#periodFilter').innerHTML = sortedPeriods().slice().reverse().map((x) => `<option value="${x.asAt}">${fmtDate(x.asAt)}${x.asAt > today ? ' · future-dated' : ''}${x.asAt === defaultPeriod ? ' · current' : ''}</option>`).join('');
  $('#periodFilter').value = active;
  const keep = (id, values, allLabel) => {
    const el = $('#' + id), old = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.value = values.includes(old) ? old : '';
  };
  const recs = p ? p.records : [];
  keep('staffFilter', [...new Set(recs.map((r) => r.staff).filter(Boolean))].sort((a, b) => a.localeCompare(b)), 'All staff');
  keep('matterTypeFilter', [...new Set(recs.map((r) => r.matterType).filter(Boolean))].sort((a, b) => a.localeCompare(b)), 'All matter types');
  if (!$('#ageFilter').options.length) $('#ageFilter').innerHTML = '<option value="">All ages</option>' + bucketOrder.map((b) => `<option>${b}</option>`).join('');
}

/* ---------------- main render ---------------- */
function renderAllReports() {
  if (!current()) { renderEmpty(); return; }
  render();
  if (selectedClient) showClient(selectedClient, false);
  renderMovement();
  drawStaff(visibleRecords());
  drawMatterTypes(visibleRecords());
  if ($('#directoryDialog').open) renderClientDirectory();
}
function renderEmpty() {
  $('#subtitle').textContent = 'No ledgers are held yet';
  $('#tiles').innerHTML = `<div class="tile" style="grid-column:1/-1"><div class="label">Getting started</div><div class="sub" style="font-size:var(--text-sm);margin-top:.4rem">${can('editor') ? 'Upload one or more weekly LEAP Aged Debtors exports with Upload ledgers. Administrators can add the Matter List and Client Details under Data sources.' : 'No ledgers have been uploaded yet. Ask an editor or administrator to upload the weekly LEAP Aged Debtors exports.'}</div></div>`;
  $('#clientTable tbody').innerHTML = `<tr><td colspan="12" class="empty">No data</td></tr>`;
}
function render() {
  const p = current(), rows = visibleRecords(), m = metrics(rows), clients = aggregateClients(rows), today = todayISO();
  $('#subtitle').innerHTML = `As at <b>${fmtDate(p.asAt)}</b> · ${esc(p.sourceName)}${p.asAt > today ? ` · <span class="warn">Future-dated export, not the balance as at ${fmtDate(today)}</span>` : ''}${p.asAt !== defaultPeriod && p.asAt <= today ? ' · <span class="warn">Earlier period selected</span>' : ''}`;
  const pct = m.gross ? (m.over90 / m.gross) * 100 : 0;
  $('#tiles').innerHTML = [
    ['Net debt', money(m.net), 'Including credits', ''],
    ['Gross invoices', money(m.gross), `${m.invoices.toLocaleString()} invoices · excluding credits`, ''],
    ['Credits', money(m.credits), `${m.credCount.toLocaleString()} credits · shown separately`, ''],
    ['Over 90 days', money(m.over90), `${pct.toFixed(1)}% of gross invoices`, 'accent'],
    ['Clients', m.clients.toLocaleString(), `${m.invoices.toLocaleString()} invoices · ${m.matters.toLocaleString()} matters`, ''],
  ].map((x) => `<div class="tile ${x[3]}"><div class="label">${x[0]}</div><div class="value">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
  drawAge(rows); drawConcentration(clients);
  const sorted = [...clients].sort((a, b) => { const av = a[sortKey], bv = b[sortKey]; return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDir; });
  $('#clientCount').textContent = `${clients.length.toLocaleString()} clients · ${$('#debtorGroupFilter').selectedOptions[0].textContent}`;
  $$('#clientTable th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === sortKey); th.classList.toggle('asc', th.dataset.sort === sortKey && sortDir === 1 && sortKey !== 'rank'); });
  $('#clientTable tbody').innerHTML = sorted.map((x) => `<tr class="client-row${x.client === selectedClient ? ' selected' : ''}" data-client="${esc(x.client)}" tabindex="0"><td class="num">${x.rank}</td><td><strong>${esc(x.client)}</strong>${markers(x.client)}</td><td class="num">${money(x.gross)}</td><td class="num">${money(x.credits)}</td><td class="num ${x.net < 0 ? 'neg' : ''}"><strong>${money(x.net)}</strong></td><td class="num">${x.pctTotal.toFixed(1)}%</td><td class="num">${x.cumulativePct.toFixed(1)}%</td><td class="num">${money(x.under60)}</td><td class="num">${money(x.days60to90)}</td><td class="num">${money(x.over90)}</td><td class="num">${x.matters}</td><td class="num">${x.invoices}</td></tr>`).join('') || `<tr><td colspan="12" class="empty">No clients match the reporting parameters.</td></tr>`;
}
function markers(client) {
  let out = '';
  const g = DS.groups[client];
  if (g && g.grouped) out += '<span class="marker" title="Combines more than one Client List record. Review in Client details directory.">Grouped</span>';
  if (/\[Unresolved/.test(client)) out += '<span class="marker danger" title="Client identity could not be confirmed from the Matter List or Client List">Unresolved</span>';
  return out;
}

/* ---------------- charts ---------------- */
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function chartBase() {
  Chart.defaults.font.family = "'Figtree', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssv('--color-text-muted');
  Chart.defaults.borderColor = cssv('--color-divider');
  Chart.defaults.animation = false;
}
function makeChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($('#' + id), cfg);
  return charts[id];
}
const barLabels = {
  id: 'barLabels',
  afterDatasetsDraw(chart, args, opts) {
    if (!opts || !opts.labels) return;
    const { ctx } = chart, meta = chart.getDatasetMeta(0);
    ctx.save(); ctx.font = "600 11px 'Figtree', system-ui, sans-serif"; ctx.fillStyle = cssv('--color-text');
    meta.data.forEach((el, i) => {
      const t = opts.labels[i]; if (!t) return;
      if (opts.horizontal) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, el.x + 6, el.y); }
      else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(t, el.x, el.y - 4); }
    });
    ctx.restore();
  },
};
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
function drawAge(rows) {
  const inv = rows.filter((r) => r.type === 'invoice');
  const vals = bucketOrder.map((b) => inv.filter((r) => r.age === b).reduce((s, r) => s + r.amount, 0));
  const counts = bucketOrder.map((b) => inv.filter((r) => r.age === b).length);
  const total = vals.reduce((s, v) => s + v, 0);
  makeChart('ageChart', {
    type: 'bar', plugins: [barLabels],
    data: { labels: bucketOrder, datasets: [{ data: vals, backgroundColor: bucketOrder.map((b, i) => (i < 3 ? cssv('--color-primary') : cssv('--color-danger'))), borderRadius: 3, maxBarThickness: 46 }] },
    options: {
      responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } },
      plugins: { legend: { display: false }, barLabels: { labels: vals.map((v) => (total ? ((v / total) * 100).toFixed(1) + '%' : '')) },
        tooltip: { callbacks: { label: (c) => `${money(c.raw)} · ${counts[c.dataIndex].toLocaleString()} invoice${counts[c.dataIndex] === 1 ? '' : 's'}` } } },
      scales: { x: { grid: { display: false } }, y: { grace: '8%', ticks: { callback: (v) => compactMoney(v) } } },
      onClick: (e, els) => { if (els.length) { $('#ageFilter').value = bucketOrder[els[0].index]; selectedClient = ''; renderAllReports(); } },
    },
  });
}
function drawConcentration(clients) {
  const pos = clients.filter((c) => c.net > 0), total = pos.reduce((s, c) => s + c.net, 0), top = pos.slice(0, 10);
  makeChart('concChart', {
    type: 'bar', plugins: [barLabels],
    data: { labels: top.map((c) => truncate(c.client, 30)), datasets: [{ data: top.map((c) => c.net), backgroundColor: cssv('--color-accent') || '#00A9DB', borderRadius: 3, barPercentage: 0.75 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 48 } },
      plugins: { legend: { display: false }, barLabels: { horizontal: true, labels: top.map((c) => (total ? ((c.net / total) * 100).toFixed(1) + '%' : '')) },
        tooltip: { callbacks: { title: (c) => top[c[0].dataIndex].client, label: (c) => `${money(c.raw)} · ${((c.raw / total) * 100).toFixed(1)}% of positive total` } } },
      scales: { x: { ticks: { callback: (v) => compactMoney(v) } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
      onClick: (e, els) => { if (els.length) showClient(top[els[0].index].client); },
    },
  });
}
const STAFF_COLORS = ['#00224A', '#2C61A0', '#00A9DB', '#4FCAEE', '#A6E3F5', '#F7B91A', '#E58B2B', '#C9573A', '#A8323F', '#6E1F33'];
function drawStaff(rows) {
  const sel = $('#staffAgeGroup').value || 'All', map = new Map();
  for (const r of rows) {
    if (r.type !== 'invoice' || (sel !== 'All' && r.age !== sel)) continue;
    const k = r.staff || 'Not specified';
    let e = map.get(k); if (!e) { e = { name: k, total: 0, amounts: bucketOrder.map(() => 0), counts: bucketOrder.map(() => 0) }; map.set(k, e); }
    const i = bucketOrder.indexOf(r.age); if (i < 0) continue;
    e.amounts[i] += r.amount; e.counts[i]++; e.total += r.amount;
  }
  const data = [...map.values()].sort((a, b) => b.total - a.total);
  const box = $('#staffBox'); box.style.height = Math.max(160, data.length * 24 + 90) + 'px';
  const idx = bucketOrder.map((b, i) => i).filter((i) => sel === 'All' || bucketOrder[i] === sel);
  makeChart('staffChart', {
    type: 'bar',
    data: { labels: data.map((d) => d.name), datasets: idx.map((i) => ({ label: bucketOrder[i], data: data.map((d) => d.amounts[i]), backgroundColor: STAFF_COLORS[i], barPercentage: 0.8, categoryPercentage: 0.9 })) },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: (c) => { const d = data[c.dataIndex], i = idx[c.datasetIndex]; return `${bucketOrder[i]}: ${money(d.amounts[i])} · ${d.counts[i]} invoice${d.counts[i] === 1 ? '' : 's'}`; }, footer: (c) => 'Staff total: ' + money(data[c[0].dataIndex].total) } } },
      scales: { x: { stacked: true, ticks: { callback: (v) => compactMoney(v) } }, y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false } } },
      onClick: (e, els) => { if (els.length) { $('#staffFilter').value = data[els[0].index].name === 'Not specified' ? '' : data[els[0].index].name; selectedClient = ''; renderAllReports(); } },
    },
  });
}
function drawMatterTypes(records) {
  const metric = $('#matterTypeMetric').value, matters = new Map();
  for (const r of records) { const k = String(r.matter), it = matters.get(k) || { kind: r.matterType || 'Not in Matter List', net: 0 }; it.net += (r.type === 'credit' ? -1 : 1) * r.amount; matters.set(k, it); }
  const grouped = new Map();
  for (const m of matters.values()) { if (m.net <= 0.005) continue; const it = grouped.get(m.kind) || { value: 0, count: 0 }; it.value += m.net; it.count++; grouped.set(m.kind, it); }
  const data = [...grouped].sort((a, b) => (metric === 'count' ? b[1].count - a[1].count : b[1].value - a[1].value));
  $('#matterTypeBox').style.height = Math.max(160, data.length * 26 + 60) + 'px';
  makeChart('matterTypeChart', {
    type: 'bar', plugins: [barLabels],
    data: { labels: data.map((d) => truncate(d[0], 42)), datasets: [{ data: data.map((d) => (metric === 'count' ? d[1].count : d[1].value)), backgroundColor: cssv('--color-accent') || '#00A9DB', borderRadius: 3, barPercentage: 0.78 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 90 } },
      plugins: { legend: { display: false }, barLabels: { horizontal: true, labels: data.map((d) => (metric === 'count' ? String(d[1].count) : compactMoney(d[1].value))) },
        tooltip: { callbacks: { title: (c) => data[c[0].dataIndex][0], label: (c) => { const d = data[c.dataIndex][1]; return `${money(d.value)} net outstanding · ${d.count.toLocaleString()} matter${d.count === 1 ? '' : 's'}`; } } } },
      scales: { x: { ticks: { callback: (v) => (metric === 'count' ? v : compactMoney(v)) } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
      onClick: (e, els) => { if (els.length) { $('#matterTypeFilter').value = data[els[0].index][0]; selectedClient = ''; renderAllReports(); } },
    },
  });
}

/* ---------------- client detail ---------------- */
function groupedClientRows() {
  const rows = visibleRecords(), by = new Map();
  for (const r of rows) { if (!by.has(r.client)) by.set(r.client, []); by.get(r.client).push(r); }
  const email = (contactFor(selectedClient).email || '').trim().toLowerCase();
  let names = [selectedClient];
  if (email) names = names.concat([...by.keys()].filter((c) => c !== selectedClient && (contactFor(c).email || '').trim().toLowerCase() === email).sort((a, b) => a.localeCompare(b)));
  return names.map((n) => ({ name: n, rows: by.get(n) || [] })).filter((g) => g.rows.length);
}
function showClient(name, scroll = true) {
  selectedClient = name;
  const groups = groupedClientRows();
  if (!groups.length) { selectedClient = ''; $('#detailSection').classList.add('hidden'); render(); return; }
  const all = groups.flatMap((g) => g.rows), m = metrics(all), c = contactFor(name);
  $('#detailTitle').innerHTML = esc(name) + markers(name);
  const others = groups.length - 1;
  $('#detailSub').textContent = [c.email ? 'Email ' + c.email : 'No email recorded', c.telephone ? 'Telephone ' + c.telephone : '', others ? `Includes ${others} other client${others === 1 ? '' : 's'} sharing this email address` : ''].filter(Boolean).join(' · ');
  $('#detailTiles').innerHTML = [['Net owed', money(m.net)], ['Gross invoices', money(m.gross)], ['Credits', money(m.credits)], ['Over 90 days', money(m.over90)], ['Matters · invoices', `${m.matters} · ${m.invoices}`]]
    .map((x) => `<div class="tile"><div class="label">${x[0]}</div><div class="value">${x[1]}</div></div>`).join('');
  $('#matterTable tbody').innerHTML = groups.map((g) => `<tr class="client-group"><th colspan="10" scope="rowgroup">${esc(g.name)}${g.name === selectedClient ? ' (selected)' : ''} · ${aggregateMatters(g.rows).length} matters</th></tr>` +
    aggregateMatters(g.rows).map((x) => `<tr class="matter-row" tabindex="0" role="button" aria-label="Open statement for ${esc(g.name)} matter ${esc(x.matter)}" data-client="${esc(g.name)}" data-matter="${esc(x.matter)}"><td><strong>${esc(x.matter)}</strong></td><td title="${esc([...x.descriptions].join(' | '))}">${esc(truncate([...x.descriptions].join(' | '), 80))}<div class="sub">${esc([...x.types].join(', '))}</div></td><td>${esc([...x.staff].join(', '))}</td><td class="num">${money(x.gross)}</td><td class="num">${money(x.credits)}</td><td class="num"><strong>${money(x.net)}</strong></td><td class="num">${money(x.under60)}</td><td class="num">${money(x.days60to90)}</td><td class="num">${money(x.over90)}</td><td class="num">${x.invoices}</td></tr>`).join('')).join('');
  $('#invoiceTable tbody').innerHTML = groups.map((g) => `<tr class="client-group"><th colspan="9" scope="rowgroup">${esc(g.name)}${g.name === selectedClient ? ' (selected)' : ''} · ${g.rows.length} entries</th></tr>` +
    [...g.rows].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((r) => `<tr class="matter-row" tabindex="0" data-client="${esc(g.name)}" data-matter="${esc(r.matter)}"><td>${esc(r.staff)}</td><td>${esc(r.matter)}</td><td title="${esc(r.matterDescription)}">${esc(truncate(r.matterDescription || '', 55))}</td><td>${fmtDate(r.date)}</td><td>${esc(r.invoice)}</td><td><span class="age ${OLD.has(r.age) ? 'old' : ''}">${esc(r.age)}</span></td><td class="num">${r.type === 'invoice' ? money(r.amount) : ''}</td><td class="num">${r.type === 'credit' ? money(r.amount) : ''}</td><td class="num">${money(r.type === 'credit' ? -r.amount : r.amount)}</td></tr>`).join('')).join('');
  setClientDetailView(clientDetailView);
  $('#detailSection').classList.remove('hidden');
  $$('#clientTable tr.client-row').forEach((tr) => tr.classList.toggle('selected', tr.dataset.client === selectedClient));
  if (scroll) $('#detailSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setClientDetailView(v) {
  clientDetailView = v;
  $('#matterWrap').classList.toggle('hidden', v !== 'matters'); $('#invoiceWrap').classList.toggle('hidden', v === 'matters');
  $('#matterViewBtn').classList.toggle('active', v === 'matters'); $('#invoiceViewBtn').classList.toggle('active', v !== 'matters');
  $('#matterViewBtn').setAttribute('aria-pressed', v === 'matters'); $('#invoiceViewBtn').setAttribute('aria-pressed', v !== 'matters');
}
const csvCell = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
const downloadCSV = (rows, name) => downloadBlob(new Blob(['\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }), name);
function exportClientCSV() {
  if (!selectedClient) return;
  const groups = groupedClientRows(); let out;
  if (clientDetailView === 'matters') {
    out = [['Client', 'Matter', 'Description', 'Matter type', 'Responsible staff', 'Gross invoices', 'Credits', 'Net owed including credits', '<60 days', '60-90 days', 'Over 90 days', 'Invoice count']];
    groups.forEach((g) => aggregateMatters(g.rows).forEach((x) => out.push([g.name, x.matter, [...x.descriptions].join(' | '), [...x.types].join(', '), [...x.staff].join(', '), x.gross.toFixed(2), x.credits.toFixed(2), x.net.toFixed(2), x.under60.toFixed(2), x.days60to90.toFixed(2), x.over90.toFixed(2), x.invoices])));
  } else {
    out = [['Client', 'Staff', 'Matter', 'Description', 'Date', 'Invoice', 'Ageing', 'Gross', 'Credit', 'Net']];
    groups.forEach((g) => g.rows.forEach((r) => out.push([g.name, r.staff, r.matter, r.matterDescription, r.date, r.invoice, r.age, r.type === 'invoice' ? r.amount.toFixed(2) : '', r.type === 'credit' ? r.amount.toFixed(2) : '', (r.type === 'credit' ? -r.amount : r.amount).toFixed(2)])));
  }
  downloadCSV(out, selectedClient.replace(/[^a-z0-9]+/gi, ' ').trim() + ' - ' + (clientDetailView === 'matters' ? 'Matter Summary' : 'Aged Debtors') + ' - ' + active + '.csv');
}
function exportClientsCSV() {
  const clients = aggregateClients(visibleRecords());
  const out = [['Rank', 'Client Name', 'Excl. credit', 'Credits', 'Incl. credits', '% of Total', 'Cumulative %', '<60 days', '60-90 days', 'Over 90 days', 'Matters', 'Invoices', 'Client group']];
  const g = debtorGroups(current());
  clients.forEach((x) => out.push([x.rank, x.client, x.gross.toFixed(2), x.credits.toFixed(2), x.net.toFixed(2), x.pctTotal.toFixed(2), x.cumulativePct.toFixed(2), x.under60.toFixed(2), x.days60to90.toFixed(2), x.over90.toFixed(2), x.matters, x.invoices, debtorGroupLabels[g.get(x.client)] || '']));
  downloadCSV(out, `Aged Debtors by Client - ${active}.csv`);
}

/* ---------------- matter statement ---------------- */
let statementMatter = '', statementClient = '';
const statementRows = () => (current()?.records || []).filter((r) => r.client === statementClient && String(r.matter || '').trim() === statementMatter);
const statementValues = () => statementRows().filter((r) => r.type === 'invoice').sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.invoice).localeCompare(String(b.invoice)));
const formatExact = (v) => moneyFmt.format(v || 0);
const statementDate = () => (active < todayISO() ? active : todayISO());
const statementSubject = () => `FIN - ${statementClient} - ${statementMatter} - Outstanding Balance as at ${fmtDate(statementDate())}`;
function statementAgeing(vals) { const a = { current: 0, over30: 0, over60: 0, over90: 0 }; for (const r of vals) { if (r.days <= 30) a.current += r.amount; else if (r.days <= 60) a.over30 += r.amount; else if (r.days <= 90) a.over60 += r.amount; else a.over90 += r.amount; } return a; }
const fieldContact = () => ({ name: $('#statementContact').value.trim(), email: $('#statementEmail').value.trim(), telephone: $('#statementTelephone').value.trim() });
function openMatterStatement(matter, client) {
  statementClient = client; statementMatter = matter;
  const c = contactFor(client);
  $('#statementContact').value = c.name || ''; $('#statementEmail').value = c.email || ''; $('#statementTelephone').value = c.telephone || '';
  ['statementContact', 'statementEmail', 'statementTelephone'].forEach((id) => { $('#' + id).readOnly = !can('editor'); });
  $('#contactSource').textContent = contactSourceText(c);
  $('#statementDialog').showModal(); renderStatement();
}
function contactSourceText(c) {
  if (c.edited) return `Contact details edited by ${c.by || 'a user'} on ${fmtStamp(c.at)} (shared with every user).`;
  if (c.conflict) return 'The Client List holds conflicting details for this client, so they have been withheld. Enter and save the correct details.';
  return c.email || c.telephone ? 'Contact details from the LEAP Client List.' : 'No contact details recorded in the Client List.';
}
function renderStatement() {
  const rows = statementRows(), vals = statementValues(), gross = vals.reduce((n, r) => n + r.amount, 0), credits = rows.filter((r) => r.type === 'credit').reduce((n, r) => n + r.amount, 0);
  const description = [...new Set(rows.map((r) => r.matterDescription).filter(Boolean))].join(' | '), staff = [...new Set(rows.map((r) => r.staff).filter(Boolean))].join(', '), a = statementAgeing(vals);
  $('#statementHeading').textContent = `${statementClient} · Matter ${statementMatter}`;
  $('#statementDescription').textContent = description || 'No matter description in ledger';
  $('#statementMeta').textContent = `Statement date ${fmtDate(statementDate())} · Ledger as at ${fmtDate(active)} · Prepared ${fmtDate(todayISO())} · Person responsible: ${staff || 'Not specified'}`;
  $('#statementRows').innerHTML = vals.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.invoice)}</td><td class="num">${formatExact(r.amount)}</td><td><span class="age ${OLD.has(r.age) ? 'old' : ''}">${esc(r.age)}</span></td></tr>`).join('') || '<tr><td colspan="4">No outstanding invoices for this matter in the selected ledger.</td></tr>';
  $('#statementTableTotal').textContent = formatExact(gross);
  $('#statementAgeRows').innerHTML = [['Current (0–30 days)', a.current], ['31–60 days', a.over30], ['61–90 days', a.over60], ['Over 90 days', a.over90], ['Gross outstanding invoices', gross, 1], ['Less credits', -credits], ['Total due (including credits)', gross - credits, 1]]
    .map(([l, v, b]) => `<tr><th scope="row" style="${b ? '' : 'font-weight:400'}">${l}</th><td class="num">${b ? '<strong>' : ''}${formatExact(v)}${b ? '</strong>' : ''}</td></tr>`).join('');
  $('#statementStatus').textContent = active > todayISO() ? 'Caution: the selected ledger is dated after the preparation date. The statement date uses the preparation date, but the balances come from the later-dated ledger; verify before sending.' : 'The ledger shows outstanding balances, not transaction history, trust balances or matter-specific payment references.';
}
async function saveStatementContact(quiet) {
  const c = fieldContact();
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) { alert('Enter a valid client email address.'); return false; }
  if (!can('editor')) return true; // viewers can prepare statements with the details shown, but not save them
  const before = contactFor(statementClient);
  if (quiet && before.name === c.name && before.email === c.email && before.telephone === c.telephone) return true;
  try {
    OVR = await callJSON('/api/debtors/contacts', { method: 'PUT', json: { client: statementClient, ...c } });
    $('#statementStatus').textContent = 'Contact details saved on the server for every user.';
    $('#contactSource').textContent = contactSourceText(contactFor(statementClient));
    if ($('#directoryDialog').open) renderClientDirectory();
    return true;
  } catch (e) { if (e instanceof AuthError) return sessionExpired(); alert('Could not save the contact: ' + e.message); return false; }
}
let FINN_LOGO = null; // Finn Roache logo for statement PDFs, loaded once from the app itself
(async () => { try { const b = await (await fetch('../brand/logo-lockup.png')).blob(); FINN_LOGO = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); }); } catch (e) { FINN_LOGO = null; } })();
const printable = (v) => String(v ?? '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[^\x20-\x7e]/g, '?');
function statementPDF() {
  if (!window.jspdf?.jsPDF) throw Error('PDF library unavailable');
  const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' }), rows = statementRows(), vals = statementValues(), person = fieldContact();
  const staff = [...new Set(rows.map((r) => r.staff).filter(Boolean))].join(', '), description = [...new Set(rows.map((r) => r.matterDescription).filter(Boolean))].join(' | ');
  const gross = vals.reduce((n, r) => n + r.amount, 0), credits = rows.filter((r) => r.type === 'credit').reduce((n, r) => n + r.amount, 0), a = statementAgeing(vals);
  const T = (t, x, y, w) => pdf.text(printable(t), x, y, w ? { maxWidth: w } : undefined);
  let y = 36;
  const head = () => { if (FINN_LOGO) { try { pdf.addImage(FINN_LOGO, 'PNG', 171, 7, 24, 15.2); } catch (e) {} } pdf.setTextColor(0, 34, 74); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(18); T('FINN ROACHE LAWYERS', 15, 17); pdf.setFontSize(9); pdf.setFont('helvetica', 'normal'); T('PO Box Q1885, Sydney NSW 2000  |  Ph. 02 8297 1100  |  ABN 32 139 892 595', 15, 24); pdf.setTextColor(0, 0, 0); pdf.setLineWidth(0.6); pdf.setDrawColor(79, 202, 238); pdf.line(15, 28, 195, 28); pdf.setLineWidth(0.2); y = 36; };
  const ensure = (space) => { if (y + space > 275) { pdf.addPage(); head(); pdf.setFontSize(9); T(`Statement of Account - ${statementMatter} (continued)`, 15, y); y += 8; } };
  const row = (label, value, bold) => { ensure(8); pdf.setFont('helvetica', bold ? 'bold' : 'normal'); T(label, 16, y, 125); T(value, 150, y, 43); y += 7; pdf.setDrawColor(211, 222, 232); pdf.line(15, y - 2, 195, y - 2); };
  head(); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); T('STATEMENT OF ACCOUNT', 15, y); y += 9; pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
  for (const line of [`Statement date: ${fmtDate(statementDate())}    Ledger as at: ${fmtDate(active)}    Prepared: ${fmtDate(todayISO())}`, `Client: ${statementClient}    Contact: ${person.name || 'Not recorded'}`, `Client telephone no.: ${person.telephone || 'Not recorded'}`, `Matter: ${statementMatter}    Person responsible: ${staff || 'Not specified'}`, `Description: ${description || 'Not specified'}`])
    for (const part of pdf.splitTextToSize(printable(line), 180)) { ensure(6); pdf.text(part, 15, y); y += 5.2; }
  y += 4;
  if (active > todayISO()) { pdf.setTextColor(170, 48, 36); for (const line of pdf.splitTextToSize('CAUTION: The ledger is later than the preparation date. Its balances must be verified before sending.', 180)) { ensure(6); T(line, 15, y); y += 5; } pdf.setTextColor(0, 0, 0); y += 3; }
  ensure(14); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); T('INVOICE DATE', 15, y); T('INVOICE NO.', 57, y); T('OUTSTANDING BALANCE', 117, y); T('AGEING', 167, y); y += 3; pdf.line(15, y, 195, y); y += 7; pdf.setFont('helvetica', 'normal');
  if (!vals.length) { T('No outstanding invoices in this matter.', 15, y); y += 8; }
  for (const r of vals) { ensure(9); T(fmtDate(r.date), 15, y); T(r.invoice, 57, y, 55); T(formatExact(r.amount), 117, y, 45); T(r.age, 167, y, 27); y += 7; }
  ensure(14); pdf.line(15, y, 195, y); y += 7; pdf.setFont('helvetica', 'bold'); T('TOTAL OUTSTANDING INVOICES', 15, y); T(formatExact(gross), 117, y); y += 12;
  ensure(18); pdf.setFontSize(10); T(`Ageing as at ${fmtDate(active)} (invoices only)`, 15, y); y += 8; pdf.setFontSize(9);
  for (const [l, v, b] of [['Current (0-30 days)', a.current], ['31-60 days', a.over30], ['61-90 days', a.over60], ['Over 90 days', a.over90], ['Gross outstanding invoices', gross, true], ['Less credits', -credits], ['Total due (including credits)', gross - credits, true]]) row(l, formatExact(v), b);
  y += 5; pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
  for (const line of pdf.splitTextToSize('This statement lists outstanding invoices from the selected aged-debtors export. The export does not establish transaction history, trust funds or a matter-specific payment reference. Verify these before issuing payment instructions.', 180)) { ensure(5); T(line, 15, y); y += 4; }
  return new Blob([pdf.output('arraybuffer')], { type: 'application/pdf' });
}
const statementFileName = () => ('Statement ' + statementClient + ' Matter ' + statementMatter).replace(/[^a-z0-9 ._-]+/gi, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
function b64bytes(buffer) { const bytes = new Uint8Array(buffer); let out = ''; for (let i = 0; i < bytes.length; i += 0x6000) out += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000))); return out.match(/.{1,76}/g)?.join('\r\n') || ''; }
async function downloadEmailDraft() {
  if (!(await saveStatementContact(true))) return;
  const c = fieldContact();
  if (!c.email) { alert('Add the client email address first.'); return; }
  const pdf = statementPDF(), filename = statementFileName(), boundary = 'finns-statement-' + Date.now(), subject = statementSubject();
  const body = `Dear ${c.name || statementClient},\r\n\r\nPlease find attached the statement of account for matter ${statementMatter}, based on the ledger as at ${fmtDate(active)}.\r\n\r\nPlease contact us if you have any queries.\r\n\r\nYours sincerely,\r\n[ATTORNEY NAME]`;
  const encSubject = '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(subject))) + '?=';
  const mime = `To: ${c.email}\r\nSubject: ${encSubject}\r\nX-Unsent: 1\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64bytes(new TextEncoder().encode(body).buffer)}\r\n--${boundary}\r\nContent-Type: application/pdf; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64bytes(await pdf.arrayBuffer())}\r\n--${boundary}--\r\n`;
  downloadBlob(new Blob([mime], { type: 'message/rfc822' }), filename.replace(/\.pdf$/i, '.eml'));
  $('#statementStatus').textContent = 'Downloaded an unsent .eml draft with the PDF attached. Open it in your mail client, review the statement and recipient, then send it yourself.';
}
async function openOutlookStatement() {
  if (!(await saveStatementContact(true))) return;
  const c = fieldContact(), body = `Dear ${c.name || statementClient},\n\nPlease find the statement of account for matter ${statementMatter}. The ledger is as at ${fmtDate(active)}.\n\nYours sincerely,\n[ATTORNEY NAME]`;
  const w = window.open('https://outlook.office.com/mail/deeplink/compose?' + new URLSearchParams({ to: c.email || '', subject: statementSubject(), body }).toString(), '_blank', 'noopener');
  $('#statementStatus').textContent = w === null ? 'Outlook web compose opened in a new tab (or was blocked — allow pop-ups for this site). Download the PDF and attach it before sending.' : 'Outlook web compose opened. Download the PDF and attach it manually before sending; this button cannot attach files or send the message.';
}

/* ---------------- client details directory ---------------- */
let editingClient = null;
function renderClientDirectory() {
  const p = current(); if (!p) return;
  const filter = $('#directoryFilter').value, term = $('#directorySearch').value.trim().toLowerCase();
  const byMatter = new Map();
  for (const r of p.records) { const k = r.client + '\u0001' + r.matter; byMatter.set(k, (byMatter.get(k) || 0) + (r.type === 'credit' ? -r.amount : r.amount)); }
  const balance = new Map();
  for (const [k, net] of byMatter) if (net > 0.005) { const cl = k.split('\u0001')[0]; balance.set(cl, (balance.get(cl) || 0) + net); }
  const clients = [...new Set(p.records.map((r) => r.client))].sort((a, b) => a.localeCompare(b));
  const found = clients.filter((cl) => {
    const c = contactFor(cl), has = !!(c.email || '').trim();
    if (!((balance.get(cl) || 0) > 0 && (filter === 'outstanding' || (filter === 'with' ? has : !has)))) return false;
    return !term || [cl, (DS.shortNames[cl] || []).join(' / '), c.name, c.email, c.telephone].some((v) => String(v || '').toLowerCase().includes(term));
  });
  $('#directoryCount').textContent = `${found.length.toLocaleString()} of ${clients.length.toLocaleString()} clients · ledger as at ${fmtDate(p.asAt)}`;
  $('#directoryRows').innerHTML = found.map((cl) => {
    const c = contactFor(cl), g = DS.groups[cl];
    const grp = g && g.grouped ? ` <button class="btn btn-ghost btn-sm" type="button" data-group="${esc(cl)}">Grouped records</button>` : '';
    const flag = c.edited ? '<span class="marker" title="Edited in this app">Edited</span>' : c.conflict ? '<span class="marker warn" title="Conflicting Client List values withheld">Conflict</span>' : '';
    return `<tr><td>${esc(cl)}${markers(cl)}${grp}</td><td>${esc((DS.shortNames[cl] || []).join(' / ') || '—')}</td><td>${esc(c.name || '—')}</td><td>${esc(c.email || '—')}${flag}</td><td>${esc(c.telephone || '—')}</td><td class="role-editor"><button class="btn btn-ghost btn-sm" type="button" data-edit="${esc(cl)}" aria-label="Edit contact details for ${esc(cl)}">Edit</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No clients match.</td></tr>';
}
function startEdit(cl) {
  editingClient = cl; const c = contactFor(cl);
  $('#directoryEditHeading').textContent = 'Edit contact: ' + cl;
  $('#directoryEditName').value = c.name || ''; $('#directoryEditEmail').value = c.email || ''; $('#directoryEditTelephone').value = c.telephone || '';
  $('#directoryRevert').disabled = !c.edited;
  $('#directoryEditForm').classList.remove('hidden'); $('#directoryEditName').focus();
}
function cancelEdit() { editingClient = null; $('#directoryEditForm').classList.add('hidden'); $('#directoryEditForm').reset(); }

/* ---------------- grouped records & unresolved identities ---------------- */
function openGroup(name) {
  const g = DS.groups[name];
  $('#groupHeading').textContent = 'Client grouping: ' + name;
  $('#groupNote').textContent = 'Each row is a unique LEAP Client List entry whose name is equivalent to this client (differences in titles, case, spacing, punctuation or "&"/"and"). Separating an entry shows its ledger matters as a separate client for every user; Restore groups it again. Matter List matches are never moved to a different client.';
  const editable = can('editor');
  $('#groupEntries').innerHTML = g ? `<table class="data"><thead><tr><th>Short Name</th><th>Client Name</th><th>Email</th><th>Telephone</th><th>In ledgers</th><th>Action</th></tr></thead><tbody>${g.entries.map((e) => {
    const act = !e.canSeparate ? '<span class="sub">Primary record</span>' : !e.inLedger ? '<span class="sub">No ledger matters</span>' : editable ? `<button class="btn btn-${e.separated ? 'primary' : 'ghost'} btn-sm" type="button" data-sep="${esc(e.name)}" data-on="${e.separated ? '0' : '1'}">${e.separated ? 'Restore grouping' : 'Separate'}</button>` : `<span class="sub">${e.separated ? 'Separated' : 'Grouped'}</span>`;
    return `<tr><td>${esc(e.short || '—')}</td><td>${esc(e.name)}</td><td>${esc(e.email || '—')}</td><td>${esc(e.phone || '—')}</td><td>${e.inLedger ? 'Yes' : 'No'}</td><td>${act}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="empty">No Client List source entries recorded for this client.</p>';
  $('#groupDialog').dataset.name = name;
  if (!$('#groupDialog').open) $('#groupDialog').showModal();
}
function openUnresolved() {
  const list = DS.unresolved || [];
  $('#groupHeading').textContent = 'Unresolved identity audit';
  $('#groupNote').textContent = `${list.length} ledger short-name / matter identit${list.length === 1 ? 'y' : 'ies'} could not be confirmed from the Matter List, a unique telephone match or the Client List Short Name. They are shown as "[Unresolved · matter X]" and are not allocated to a client without reliable evidence. Adding the matter to the LEAP Matter List and re-uploading it resolves them.`;
  $('#groupEntries').innerHTML = list.length ? `<table class="data"><thead><tr><th>Short Name</th><th>Matter</th><th>Description</th><th>Ledger telephone</th></tr></thead><tbody>${list.map((u) => `<tr><td>${esc(u.short)}</td><td>${esc(u.matter)}</td><td>${esc(u.description)}</td><td>${esc(u.phone || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Every ledger matter is resolved to a client.</p>';
  delete $('#groupDialog').dataset.name;
  $('#groupDialog').showModal();
}

/* ---------------- movement analysis (as in the August build) ---------------- */
function scopeConfig() {
  return {
    total: { label: 'Total invoice AR ledger', short: 'invoice AR', into: 'New into ledger', out: 'Fully paid / cleared*', part: 'Part paid / reduced*', other: 'Existing balance increase', agedOut: 'Aged out (next band)', paid: 'Paid / cleared total*' },
    under60: { label: '<60 days', short: '<60 days', into: 'Moved into <60 days', out: 'Fully paid / cleared*', part: 'Part paid / reduced*', other: 'Existing balance increase', agedOut: 'Aged out to 60+ days', paid: 'Paid / cleared total*' },
    '60to90': { label: '60–90 days', short: '60–90 days', into: 'Aged into 60–90 days', out: 'Fully paid / cleared*', part: 'Part paid / reduced*', other: 'Existing balance increase', agedOut: 'Aged out to 90+ days', paid: 'Paid / cleared total*' },
    over90: { label: '90+ days', short: '90+', into: 'Aged into 90+', out: 'Fully paid / cleared*', part: 'Part paid / reduced*', other: 'Existing balance increase', agedOut: 'Aged out (next band)', paid: 'Paid / cleared total*' },
  }[movementScope];
}
function categoryLabel(k) { const c = scopeConfig(); return k === 'Entered Scope' ? c.into : k === 'Exited Scope' ? c.out : k === 'Part Reduction' ? c.part : k === 'Aged Out' ? c.agedOut : k === 'Other Exit' ? 'Other exit / reclassification' : k === 'Existing Increase' ? c.other : k; }
function refreshMovementCategoryOptions() {
  const c = scopeConfig();
  $('#movementCategory').innerHTML = `<option value="All">All movements</option><option value="Entered Scope">${esc(c.into)}</option><option value="Exited Scope">${esc(c.out)}</option><option value="Part Reduction">${esc(c.part)}</option><option value="Paid Total">${esc(c.paid)}</option><option value="Aged Out">${esc(c.agedOut)}</option><option value="Other Exit">Other exit / reclassification</option><option value="Existing Increase">${esc(c.other)}</option><option value="No Change">No Change</option>`;
  $('#movementCategory').value = movementFilter;
}
function invoiceMap(period, cohort) { const m = new Map(); reportFilteredRecords(period, cohort).filter((r) => r.type === 'invoice').forEach((r) => m.set(`${r.matter}|${r.invoice}`, r)); return m; }
function scopeBalance(r) { if (!r) return 0; if (movementScope === 'total') return r.amount; if (movementScope === 'under60') return r.days < 60 ? r.amount : 0; if (movementScope === '60to90') return r.days >= 60 && r.days <= 90 ? r.amount : 0; return r.days > 90 ? r.amount : 0; }
function movementBetween(fromP, toP, cohort) {
  const a = invoiceMap(fromP, cohort), b = invoiceMap(toP, cohort), keys = new Set([...a.keys(), ...b.keys()]), details = [];
  let opening = 0, closing = 0;
  for (const r of a.values()) opening += scopeBalance(r);
  for (const r of b.values()) closing += scopeBalance(r);
  const add = (category, p, c, prior, cur) => { const r = c || p; details.push({ category, client: r.client, matter: r.matter, invoice: r.invoice, prior, current: cur, change: cur - prior }); };
  for (const key of keys) {
    const p = a.get(key), c = b.get(key), pv = scopeBalance(p), cv = scopeBalance(c);
    if (cv > 0 && pv === 0) add('Entered Scope', p, c, 0, cv);
    else if (pv > 0 && cv === 0) {
      if (c) { const reduction = Math.max(0, pv - c.amount), remaining = pv - reduction; if (reduction > 0) add('Part Reduction', p, c, pv, remaining); if (remaining > 0) add(c.days > p.days ? 'Aged Out' : 'Other Exit', p, c, remaining, 0); }
      else add('Exited Scope', p, c, pv, 0);
    } else if (pv > 0 && cv > 0 && cv < pv) add('Part Reduction', p, c, pv, cv);
    else if (pv > 0 && cv > pv) add('Existing Increase', p, c, pv, cv);
    else if (pv > 0 && cv === pv) add('No Change', p, c, pv, cv);
  }
  const sum = (cat, fn) => details.filter((x) => x.category === cat).reduce((v, x) => v + fn(x), 0);
  const aged = sum('Entered Scope', (x) => x.current), fully = sum('Exited Scope', (x) => x.prior), part = sum('Part Reduction', (x) => x.prior - x.current), agedOut = sum('Aged Out', (x) => x.prior), otherExit = sum('Other Exit', (x) => x.prior), other = sum('Existing Increase', (x) => x.change);
  return { from: fromP.asAt, to: toP.asAt, opening, closing, aged, fully, part, paid: fully + part, agedOut, otherExit, other, net: closing - opening, details };
}
function allMovementRows(cohort) { const ps = sortedPeriods(), out = []; for (let i = 1; i < ps.length; i++) out.push(movementBetween(ps[i - 1], ps[i], cohort)); return out; }
function initMovementControls(preserve) {
  const ps = sortedPeriods(), from = $('#movementFrom'), to = $('#movementTo'), oF = from.value, oT = to.value;
  from.innerHTML = ps.map((p) => `<option value="${p.asAt}">${fmtDate(p.asAt)}</option>`).join(''); to.innerHTML = from.innerHTML;
  if (preserve && periods[oF] && periods[oT]) { from.value = oF; to.value = oT; }
  else if (ps.length) { const ai = Math.max(0, ps.findIndex((p) => p.asAt === active)); to.value = ps[ai].asAt; from.value = ps[Math.max(0, ai - 1)].asAt; }
  movementScope = $('#movementScope').value || 'over90'; refreshMovementCategoryOptions();
}
function updateMovementLabels() {
  const c = scopeConfig();
  $('#movementSectionTitle').textContent = `Movement in and out of ${c.label}`;
  $('#movementChartTitle').textContent = `${c.label} movement trend`;
  $('#movementChartSubtitle').textContent = `Into ${c.short} above zero; paid / cleared and aged out below zero (left axis). Net Movement and a straight trend from the first opening to the latest closing balance (right axis).`;
  $('#mbOpen').textContent = `Opening ${c.short}`; $('#mbInto').textContent = c.into;
}
function renderMovement() {
  const from = periods[$('#movementFrom').value], to = periods[$('#movementTo').value], c = scopeConfig(), cohort = selectedCohort();
  updateMovementLabels();
  if (!from || !to) return;
  const rows = allMovementRows(cohort);
  movementTableRows(rows); drawMovementTrend(rows);
  if (from.asAt >= to.asAt) { $('#movementReconcile').textContent = 'Select an earlier From period and a later To period.'; $('#movementTiles').innerHTML = ''; $('#movementDetail tbody').innerHTML = ''; return; }
  const m = movementBetween(from, to, cohort), counts = (k) => m.details.filter((x) => x.category === k).length;
  const tiles = [[c.into, m.aged, counts('Entered Scope'), 'Entered Scope'], [c.out, m.fully, counts('Exited Scope'), 'Exited Scope'], [c.part, m.part, counts('Part Reduction'), 'Part Reduction'], [c.paid, m.paid, counts('Exited Scope') + counts('Part Reduction'), 'Paid Total'], [c.agedOut, m.agedOut, counts('Aged Out'), 'Aged Out'], [`Net change in ${c.short}`, m.net, m.details.length, 'All']];
  $('#movementTiles').innerHTML = tiles.map((x) => `<button type="button" class="tile movement-tile ${movementFilter === x[3] ? 'active' : ''}" data-cat="${x[3]}" style="text-align:left"><div class="label">${esc(x[0])}</div><div class="value ${x[3] === 'All' ? 'signed ' + (x[1] >= 0 ? 'positive' : 'negative') : ''}">${x[3] === 'All' ? signedMoney(x[1]) : money(x[1])}</div><div class="sub">${x[2].toLocaleString()} invoice${x[2] === 1 ? '' : 's'}</div></button>`).join('');
  const d = (movementFilter === 'All' ? m.details : m.details.filter((x) => (movementFilter === 'Paid Total' ? ['Exited Scope', 'Part Reduction'].includes(x.category) : x.category === movementFilter))).sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  $('#movementDetail tbody').innerHTML = d.slice(0, 1500).map((x) => `<tr><td><span class="age ${x.category === 'Entered Scope' ? 'old' : ''}">${esc(categoryLabel(x.category))}</span></td><td>${esc(x.client)}</td><td>${esc(x.matter)}</td><td>${esc(x.invoice)}</td><td class="num">${money(x.prior)}</td><td class="num">${money(x.current)}</td><td class="num signed ${x.change >= 0 ? 'positive' : 'negative'}">${signedMoney(x.change)}</td></tr>`).join('') + (d.length > 1500 ? `<tr><td colspan="7" class="empty">Showing the 1,500 largest of ${d.length.toLocaleString()} movements. Narrow the detail category or parameters to see more.</td></tr>` : '') || '<tr><td colspan="7" class="empty">No invoice movements in this category.</td></tr>';
  const calc = m.aged - m.paid - m.agedOut - m.otherExit + m.other;
  $('#movementReconcile').textContent = `${c.short}: Opening ${money(m.opening)} (${fmtDate(m.from)}) · Closing ${money(m.closing)} (${fmtDate(m.to)}) · ${Math.abs(calc - m.net) < 0.02 ? 'Reconciled' : 'Difference ' + money(calc - m.net)}`;
}
function movementTableRows(rows) {
  const f = $('#movementFrom').value, t = $('#movementTo').value;
  $('#movementBase tbody').innerHTML = rows.map((x) => `<tr data-from="${x.from}" data-to="${x.to}" tabindex="0" class="${x.from === f && x.to === t ? 'selected' : ''}"><td>${fmtDate(x.from)}</td><td>${fmtDate(x.to)}</td><td class="num">${money(x.opening)}</td><td class="num">${money(x.aged)}</td><td class="num">${money(x.fully)}</td><td class="num">${money(x.part)}</td><td class="num">${money(x.paid)}</td><td class="num">${money(x.agedOut)}</td><td class="num">${money(x.otherExit)}</td><td class="num">${money(x.other)}</td><td class="num signed ${x.net >= 0 ? 'positive' : 'negative'}">${signedMoney(x.net)}</td><td class="num">${money(x.closing)}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">Load at least two reporting periods.</td></tr>';
}
function drawMovementTrend(rows) {
  if (!rows.length) { makeChart('movementChart', { type: 'bar', data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Load at least two reporting periods' } } } }); return; }
  const c = scopeConfig(), n = rows.length;
  const trendStart = rows[0].opening, trendEnd = rows[n - 1].closing;
  const nets = rows.map((r) => r.net);
  const rawMin = Math.min(0, ...nets, trendStart, trendEnd), rawMax = Math.max(1, ...nets, trendStart, trendEnd), span = Math.max(1, rawMax - rawMin);
  const trend = rows.map((r, i) => (i === 0 ? trendStart : i === n - 1 ? trendEnd : null));
  if (n === 1) trend[0] = trendEnd;
  makeChart('movementChart', {
    data: {
      labels: rows.map((r) => fmtDate(r.to)),
      datasets: [
        { type: 'bar', label: `Into ${c.short}`, data: rows.map((r) => r.aged), backgroundColor: '#2C61A0', stack: 'in', yAxisID: 'y', order: 3, maxBarThickness: 26 },
        { type: 'bar', label: 'Paid / cleared*', data: rows.map((r) => -r.paid), backgroundColor: '#4FCAEE', stack: 'out', yAxisID: 'y', order: 3, maxBarThickness: 26 },
        { type: 'bar', label: 'Aged out', data: rows.map((r) => -r.agedOut), backgroundColor: '#F7B91A', stack: 'out', yAxisID: 'y', order: 3, maxBarThickness: 26 },
        { type: 'bar', label: 'Other exit', data: rows.map((r) => -r.otherExit), backgroundColor: '#ADB6BE', stack: 'out', yAxisID: 'y', order: 3, maxBarThickness: 26 },
        { type: 'line', label: 'Net Movement', data: nets, borderColor: cssv('--color-heading') || '#00224A', backgroundColor: cssv('--color-heading') || '#00224A', borderWidth: 2.5, pointRadius: 3.5, tension: 0, yAxisID: 'y1', order: 1 },
        { type: 'line', label: 'Trend', data: trend, borderColor: '#B42D3E', backgroundColor: '#B42D3E', borderWidth: 3, borderDash: [10, 7], pointRadius: (ctx) => (trend[ctx.dataIndex] === null ? 0 : 4.5), spanGaps: true, tension: 0, yAxisID: 'y1', order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { title: (it) => `${fmtDate(rows[it[0].dataIndex].from)} → ${fmtDate(rows[it[0].dataIndex].to)}`, label: (it) => (it.raw === null ? null : `${it.dataset.label}: ${it.dataset.label === 'Trend' ? money(it.raw) + (it.dataIndex === 0 ? ' (opening)' : ' (closing)') : signedMoney(it.raw)}`) } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 50, minRotation: 30 } },
        y: { stacked: true, title: { display: true, text: `Into / out of ${c.short}` }, ticks: { callback: (v) => compactMoney(v) } },
        y1: { position: 'right', min: rawMin - span * 0.12, max: rawMax + span * 0.12, grid: { display: false }, title: { display: true, text: 'Net movement / trend' }, ticks: { callback: (v) => compactMoney(v) } },
      },
      onClick: (e, els) => { if (!els.length) return; const r = rows[els[0].index]; $('#movementFrom').value = r.from; $('#movementTo').value = r.to; movementFilter = 'All'; refreshMovementCategoryOptions(); renderMovement(); },
    },
  });
}

/* ---------------- data sources ---------------- */
async function openSources() {
  $('#sourcesDialog').showModal();
  $('#periodsTable tbody').innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
  try { renderSources(await callJSON('/api/debtors/sources')); } catch (e) { if (e instanceof AuthError) return sessionExpired(); $('#periodsTable tbody').innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message)}</td></tr>`; }
}
function renderSources(s) {
  const L = s.lists || {}, src = DS.sources || {};
  const card = (kind, title, info, extra) => {
    const m = L[kind];
    return `<div class="list-card"><h4>${title}<span class="marker ${m ? '' : 'warn'}">${m ? 'Held' : 'Not uploaded'}</span></h4>
      <p class="meta">${m ? `${esc(m.name)} · ${Number(m.rows || 0).toLocaleString()} rows<br>Uploaded ${fmtStamp(m.uploadedAt)} by ${esc(m.uploadedBy || '—')}` : 'Upload the LEAP export to enable client identity matching.'}${extra ? '<br>' + extra : ''}</p>
      <p class="hint" style="margin:0">${info}</p>
      <div class="row-actions">${can('admin') ? `<label class="btn btn-primary btn-sm" for="list-${kind}" tabindex="0">Upload new ${title}</label><input type="file" accept=".xlsx" id="list-${kind}" data-kind="${kind}" hidden>` : ''}${m ? `<button class="btn btn-ghost btn-sm" type="button" data-dl-list="${kind}">Download</button>` : ''}</div></div>`;
  };
  const via = {}; DS.matters.forEach((m) => { via[m[4]] = (via[m[4]] || 0) + 1; });
  $('#listCards').innerHTML = card('matter-list', 'Matter List', 'Matter number → full client name and matter type. Used first for every ledger matter.', src.matterList ? `${Number(src.matterList.matters).toLocaleString()} unique matter numbers · ${via['matter-list'] || 0} ledger matters matched` : '') +
    card('client-details', 'Client Details', 'Client email and telephone, telephone-based matching and Short Name fallback.', `${(via.telephone || 0) + (via['short-name'] || 0)} matters matched by telephone or Short Name · ${via.unresolved || 0} unresolved`);
  $('#periodsTable tbody').innerHTML = s.periods.map((p) => `<tr><td><strong>${fmtDate(p.id)}</strong>${p.id === defaultPeriod ? ' <span class="marker">Current</span>' : ''}${p.id > todayISO() ? ' <span class="marker warn">Future-dated</span>' : ''}</td><td>${esc(p.name)}</td><td class="num">${(p.records || 0).toLocaleString()}</td><td>${fmtStamp(p.uploadedAt)}</td><td>${esc(p.uploadedBy || '—')}</td><td><div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" data-dl="${p.id}">Download</button>${can('admin') ? `<button class="btn btn-danger btn-sm" type="button" data-del="${p.id}">Delete</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No ledgers held yet.</td></tr>';
}
async function downloadFrom(path, fallback) {
  try {
    const r = await call(path); if (!r.ok) throw new Error('Download failed (' + r.status + ')');
    const cd = r.headers.get('content-disposition') || '', m = cd.match(/filename="([^"]+)"/);
    downloadBlob(await r.blob(), m ? m[1] : fallback);
  } catch (e) { if (e instanceof AuthError) return sessionExpired(); toast(e.message); }
}
async function uploadLedgers(files) {
  files = [...files].filter((f) => /\.xlsx$/i.test(f.name));
  if (!files.length) return;
  const done = [], failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    notice(`Uploading ${i + 1} of ${files.length}: ${f.name}…`);
    try {
      const j = await callJSON('/api/debtors/report', { method: 'PUT', body: await f.arrayBuffer(), headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' } });
      done.push(`${fmtDate(j.id)}${j.replaced ? ' (replaced)' : ''}`);
    } catch (e) { if (e instanceof AuthError) return sessionExpired(); failed.push(`${f.name}: ${e.message}`); }
  }
  await reloadData(true);
  notice((done.length ? `Stored ${done.length} ledger${done.length === 1 ? '' : 's'} on the server: ${done.join(', ')}. ` : '') + (failed.length ? `Not stored — ${failed.join('; ')}` : ''), failed.length ? 'error' : '');
  if ($('#sourcesDialog').open) openSources();
}
async function uploadList(kind, file) {
  const title = kind === 'matter-list' ? 'Matter List' : 'Client Details';
  notice(`Uploading ${title} (${file.name}) and re-matching client identities…`);
  try {
    await callJSON('/api/debtors/lists/' + kind, { method: 'PUT', body: await file.arrayBuffer(), headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' } });
    await reloadData(true);
    notice(`${title} updated. Client identities have been re-matched for every period.`);
  } catch (e) { if (e instanceof AuthError) return sessionExpired(); notice(`${title} not stored: ${e.message}`, 'error'); }
  if ($('#sourcesDialog').open) openSources();
}

const ROLE_LABEL = FD.ROLE_LABEL;

/* ---------------- shell helpers ---------------- */
const can = (role) => !!APP_ROLE && ['viewer', 'editor', 'admin'].indexOf(APP_ROLE) >= ['viewer', 'editor', 'admin'].indexOf(role);
function notice(msg, kind) { const n = $('#notice'); if (!msg) { n.hidden = true; return; } n.className = 'notice' + (kind ? ' ' + kind : ''); n.textContent = msg; n.hidden = false; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
function sessionExpired() { FD.expired('debtors'); return false; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t; store.set('fdash-theme', t);
  $('#themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  if (DS) { chartBase(); renderAllReports(); }
}
function setClientWidth(px, persist) {
  const w = Math.max(150, Math.min(700, Math.ceil(px)));
  document.documentElement.style.setProperty('--client-name-width', w + 'px');
  if (persist) store.set('fd-client-width', String(w));
}
function wireResize(handle, getCell) {
  let sx = 0, sw = 0;
  handle.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); sx = e.clientX; sw = getCell().getBoundingClientRect().width; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointermove', (e) => { if (handle.hasPointerCapture(e.pointerId)) setClientWidth(sw + e.clientX - sx); });
  handle.addEventListener('pointerup', (e) => { if (handle.hasPointerCapture(e.pointerId)) { setClientWidth(sw + e.clientX - sx, true); handle.releasePointerCapture(e.pointerId); } e.stopPropagation(); });
  handle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  handle.addEventListener('keydown', (e) => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); setClientWidth(getCell().getBoundingClientRect().width + (e.key === 'ArrowRight' ? 30 : -30), true); });
}

/* ---------------- data loading ---------------- */
async function reloadData(keepView) {
  const [ds, ov] = await Promise.all([callJSON('/api/debtors/dataset'), callJSON('/api/debtors/overrides')]);
  DS = ds; OVR = ov;
  const prev = active;
  expandDataset(ds);
  if (!keepView || !periods[prev]) active = defaultPeriod;
  refreshOptions();
  initMovementControls(!!keepView);
  if (selectedClient && !current()?.records.some((r) => r.client === selectedClient)) { selectedClient = ''; $('#detailSection').classList.add('hidden'); }
  renderAllReports();
}

/* ---------------- entering the app ---------------- */
async function enter(user, role) {
  ME = user; APP_ROLE = role;
  document.body.classList.toggle('can-edit', can('editor'));
  document.body.classList.toggle('can-admin', can('admin'));
  $('#accountName').textContent = user.displayName || user.username;
  $('#accountRole').textContent = ROLE_LABEL[role];
  $('#shell').hidden = false;
  $('#tiles').innerHTML = '<div class="skeleton" style="grid-column:1/-1;height:96px"></div>';
  chartBase();
  try { await reloadData(false); notice(''); }
  catch (e) { if (e instanceof AuthError) return sessionExpired(); notice('Could not load the data from the server: ' + e.message, 'error'); }
}

/* ---------------- wiring ---------------- */
function wire() {
  $('#accountBtn').addEventListener('click', () => { const m = $('#accountMenu'); m.hidden = !m.hidden; $('#accountBtn').setAttribute('aria-expanded', String(!m.hidden)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.account')) { $('#accountMenu').hidden = true; $('#accountBtn').setAttribute('aria-expanded', 'false'); } });
  $('#signOut').addEventListener('click', () => FD.signOut());
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog.dlg').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // parameters
  $('#periodFilter').addEventListener('change', (e) => { active = e.target.value; selectedClient = ''; $('#detailSection').classList.add('hidden'); refreshOptions(); initMovementControls(false); renderAllReports(); });
  $('#debtorGroupFilter').addEventListener('change', () => { selectedClient = ''; $('#detailSection').classList.add('hidden'); renderAllReports(); });
  ['staffFilter', 'ageFilter', 'matterTypeFilter'].forEach((id) => $('#' + id).addEventListener('change', renderAllReports));
  let st; $('#search').addEventListener('input', () => { clearTimeout(st); st = setTimeout(renderAllReports, 180); });
  $('#clearFilters').addEventListener('click', () => { ['staffFilter', 'ageFilter', 'search', 'debtorGroupFilter', 'matterTypeFilter'].forEach((id) => { $('#' + id).value = ''; }); $('#staffAgeGroup').value = 'All'; selectedClient = ''; $('#detailSection').classList.add('hidden'); renderAllReports(); });

  // client table
  $$('#clientTable th[data-sort]').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.sort; if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'client' || k === 'rank' ? 1 : -1; } render(); }));
  const openRow = (e) => { const tr = e.target.closest('tr.client-row'); if (tr) showClient(tr.dataset.client); };
  $('#clientTable tbody').addEventListener('click', openRow);
  $('#clientTable tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
  wireResize($('#clientNameResize'), () => $('#clientTable th:nth-child(2)'));
  $('#exportClients').addEventListener('click', exportClientsCSV);

  // detail
  $('#backBtn').addEventListener('click', () => { selectedClient = ''; $('#detailSection').classList.add('hidden'); render(); $('#clientsCard').scrollIntoView({ behavior: 'smooth' }); });
  $('#exportBtn').addEventListener('click', exportClientCSV);
  $('#matterViewBtn').addEventListener('click', () => setClientDetailView('matters'));
  $('#invoiceViewBtn').addEventListener('click', () => setClientDetailView('invoices'));
  for (const id of ['#matterTable tbody', '#invoiceTable tbody']) {
    $(id).addEventListener('click', (e) => { const r = e.target.closest('tr[data-matter]'); if (r) openMatterStatement(r.dataset.matter, r.dataset.client); });
    $(id).addEventListener('keydown', (e) => { const r = e.target.closest('tr[data-matter]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMatterStatement(r.dataset.matter, r.dataset.client); } });
  }

  // statement
  $('#statementSaveContact').addEventListener('click', () => saveStatementContact(false));
  $('#statementPDF').addEventListener('click', () => { try { downloadBlob(statementPDF(), statementFileName()); } catch (e) { alert('PDF could not be created: ' + e.message); } });
  $('#statementEmailDraft').addEventListener('click', () => downloadEmailDraft().catch((e) => alert('Email draft could not be created: ' + e.message)));
  $('#statementOutlook').addEventListener('click', openOutlookStatement);

  // directory
  $('#directoryOpen').addEventListener('click', () => { cancelEdit(); renderClientDirectory(); $('#directoryDialog').showModal(); });
  $('#directoryFilter').addEventListener('change', renderClientDirectory);
  $('#directorySearch').addEventListener('input', renderClientDirectory);
  $('#directoryRows').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.edit) startEdit(b.dataset.edit); if (b.dataset.group) openGroup(b.dataset.group); });
  $('#directoryEditCancel').addEventListener('click', cancelEdit);
  $('#directoryDialog').addEventListener('close', cancelEdit);
  $('#directoryEditForm').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!editingClient) return;
    const c = { name: $('#directoryEditName').value.trim(), email: $('#directoryEditEmail').value.trim(), telephone: $('#directoryEditTelephone').value.trim() };
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) { alert('Enter a valid client email address.'); return; }
    try { OVR = await callJSON('/api/debtors/contacts', { method: 'PUT', json: { client: editingClient, ...c } }); toast('Contact saved for every user.'); cancelEdit(); renderClientDirectory(); if (selectedClient) showClient(selectedClient, false); }
    catch (ex) { if (ex instanceof AuthError) return sessionExpired(); alert('Could not save: ' + ex.message); }
  });
  $('#directoryRevert').addEventListener('click', async () => {
    if (!editingClient || !confirm('Discard the edited details and use the LEAP Client List values for ' + editingClient + '?')) return;
    try { OVR = await callJSON('/api/debtors/contacts', { method: 'DELETE', json: { client: editingClient } }); toast('Reverted to the Client List.'); cancelEdit(); renderClientDirectory(); }
    catch (ex) { if (ex instanceof AuthError) return sessionExpired(); alert('Could not revert: ' + ex.message); }
  });
  $('#unresolvedOpen').addEventListener('click', openUnresolved);
  $('#groupEntries').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-sep]'); if (!b) return;
    const separate = b.dataset.on === '1', name = b.dataset.sep;
    if (!confirm(`${separate ? 'Separate' : 'Restore grouping for'} "${name}"? This changes the client list for every user.`)) return;
    b.disabled = true;
    try {
      await callJSON('/api/debtors/groups', { method: 'POST', json: { name, separate } });
      await reloadData(true);
      const group = $('#groupDialog').dataset.name;
      if (group && DS.groups[group]) openGroup(group); else $('#groupDialog').close();
      toast(separate ? `${name} is now shown as a separate client.` : `${name} is grouped again.`);
    } catch (ex) { if (ex instanceof AuthError) return sessionExpired(); alert('Could not change the grouping: ' + ex.message); b.disabled = false; }
  });

  // movement
  $('#movementScope').addEventListener('change', (e) => { movementScope = e.target.value; movementFilter = 'All'; refreshMovementCategoryOptions(); renderMovement(); });
  ['movementFrom', 'movementTo'].forEach((id) => $('#' + id).addEventListener('change', () => { movementFilter = 'All'; $('#movementCategory').value = 'All'; renderMovement(); }));
  $('#movementCategory').addEventListener('change', (e) => { movementFilter = e.target.value; renderMovement(); });
  $('#movementTiles').addEventListener('click', (e) => { const t = e.target.closest('.movement-tile'); if (!t) return; movementFilter = t.dataset.cat; $('#movementCategory').value = movementFilter; renderMovement(); });
  const pickWeek = (e) => { const tr = e.target.closest('tr[data-from]'); if (!tr) return; $('#movementFrom').value = tr.dataset.from; $('#movementTo').value = tr.dataset.to; movementFilter = 'All'; refreshMovementCategoryOptions(); renderMovement(); $('#movementTiles').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#movementBase tbody').addEventListener('click', pickWeek);
  $('#movementBase tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter') pickWeek(e); });

  // staff & matter types
  $('#staffAgeGroup').innerHTML = '<option value="All">All age groups</option>' + bucketOrder.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  $('#staffAgeGroup').addEventListener('change', () => drawStaff(visibleRecords()));
  $('#staffAgeReset').addEventListener('click', () => { $('#staffAgeGroup').value = 'All'; drawStaff(visibleRecords()); });
  $('#matterTypeMetric').addEventListener('change', () => drawMatterTypes(visibleRecords()));

  // uploads & sources
  for (const id of ['#fileInput', '#fileInput2']) $(id).addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; uploadLedgers(f); });
  $('#sourcesOpen').addEventListener('click', openSources);
  $('#listCards').addEventListener('change', (e) => { const inp = e.target.closest('input[data-kind]'); if (inp && inp.files[0]) { const f = inp.files[0]; inp.value = ''; uploadList(inp.dataset.kind, f); } });
  $('#listCards').addEventListener('click', (e) => { const b = e.target.closest('[data-dl-list]'); if (b) downloadFrom('/api/debtors/lists/' + b.dataset.dlList, b.dataset.dlList + '.xlsx'); });
  $('#periodsTable').addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]'), del = e.target.closest('[data-del]');
    if (dl) downloadFrom('/api/debtors/report/' + dl.dataset.dl, dl.dataset.dl + '.xlsx');
    if (del) {
      if (!confirm(`Delete the ledger aged at ${fmtDate(del.dataset.del)} from the server for every user? This cannot be undone.`)) return;
      try { renderSources({ periods: (await callJSON('/api/debtors/report/' + del.dataset.del, { method: 'DELETE' })).periods, lists: (await callJSON('/api/debtors/sources')).lists }); await reloadData(true); toast('Ledger deleted.'); }
      catch (ex) { if (ex instanceof AuthError) return sessionExpired(); alert('Could not delete: ' + ex.message); }
    }
  });

  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 150); });
}

/* ---------------- boot ---------------- */
(async function boot() {
  const theme = store.get('fdash-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  const w = Number(store.get('fd-client-width')); if (w >= 150 && w < 1000) setClientWidth(w);
  wire();
  try { const s = await FD.guard('debtors'); await enter(s.user, s.role); }
  catch (e) { $('#shell').hidden = false; notice('Could not reach the dashboard server: ' + e.message, 'error'); }
})();
