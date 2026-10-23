// One-off initial load: node seed.js <project files dir>
// Loads the weekly ledgers, the LEAP lists, the Staff Performance backup and the WIP period,
// and creates the first administrator (prints a one-time temporary password).
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const F = process.argv[2];
const A = require('./lib/auth'), D = require('./lib/debtors'), ST = require('./lib/staff'), W = require('./lib/wip');
const rd = (...p) => fs.readFileSync(path.join(F, ...p));

D.storeList('matter-list', rd('LEAPClients', 'Matter List (4).xlsx'), 'Matter List (4).xlsx', 'Initial load');
D.storeList('client-details', rd('LEAPClients', 'Client Details (3).xlsx'), 'Client Details (3).xlsx', 'Initial load');
for (const f of fs.readdirSync(path.join(F, 'ARWeeklyUpdate')).filter((x) => /\.xlsx$/i.test(x)).sort()) {
  const r = D.storeLedger(rd('ARWeeklyUpdate', f), f, 'Initial load'); console.log('ledger', r.id, r.records);
}
const bk = JSON.parse(rd('StaffPerformance', 'staff-performance-data-backup-2026-10-11.json'));
ST.importRaw(bk); console.log('staff months', Object.keys(bk.months).length);
W.resetLeap();
const ds = W.seedPeriod(rd('WIPReview', 'Aged WIP & Disbursements Report.xlsx'), rd('WIPReview', 'Aged WIP Report.xlsx'), { wipd: 'Aged WIP & Disbursements Report.xlsx', wip: 'Aged WIP Report.xlsx' });
console.log('wip', ds.period, ds.clients.length, 'clients', ds.matters.length, 'matters', JSON.stringify({ ...ds.recon, wipOnly: undefined, draftLines: ds.recon.draftLines.length, draftMatters: ds.recon.draftMatters.length, wipStaffTotals: undefined }));
const d = D.build(); console.log('debtors', d.periods.length, 'periods', d.clients.length, 'clients', d.unresolved.length, 'unresolved', Object.keys(d.groups).length, 'groups');
console.log('stats', JSON.stringify(D.stats()), JSON.stringify(ST.stats()), JSON.stringify(W.stats()));
const inv = A.bootstrap('FinnDebtors', 'Finn Debtors');
if (inv) { const pw = crypto.randomBytes(9).toString('base64url'); A.setPassword('FinnDebtors', pw); console.log('ADMIN FinnDebtors temporary password:', pw); }
