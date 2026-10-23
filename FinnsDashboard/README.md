# Finns Dashboard portal (rebuilt 12/10/2026)

One shared sign-in for three dashboards: Aged Debtors, Staff Performance and Aged WIP.

- `server.js` — Node server, no dependencies (`node server.js`, port 5000). Serves `public/` from an allow-list and the API under `/api`.
- `lib/auth.js` — users, scrypt password hashes, 12-hour sessions, invitations/resets, rate limits, activity log. Roles per app: viewer / editor / admin; portal administrators get admin everywhere.
- `lib/debtors.js` — Aged Debtors ledgers, LEAP Matter List and Client Details (shared with WIP), client identity (Matter List → unique telephone → unique short name → Unresolved), name groupings and contact overrides.
- `lib/staff.js` — Staff Performance months, settings, name mappings, backup restore.
- `lib/wip.js` + `public/wip/parser.js` — Aged WIP periods.
- `seed.js <project files dir>` — initial load from ARWeeklyUpdate, LEAPClients, StaffPerformance backup and WIPReview; creates the FinnDebtors administrator with a temporary password.
- Aged WIP reports by client, aged break, responsible staff, staff billed by, matter type (from the LEAP Matter List; matters not on it shown as "Not on the Matter List") and period ended.
- Data is kept in `portal-data/` (not stored here; rebuild with seed.js).

## Aged WIP rules
- The Aged WIP & Disbursements Report is the master record.
- Fee lines on it that are not on the Aged WIP Report are WIP on draft invoices and are excluded (12/10/2026: 2,693 lines, $436,739.02).
- Lines only on the Aged WIP Report are ignored (12/10/2026: 42 lines, $5,891.50).
- The Aged WIP Report is otherwise used only for Staff Billed By. Both reports are required for each period.
- On-costs cannot be matched (the Aged WIP Report has fees only), so all cost recoveries and anticipated payments stay in.
- 12/10/2026: WIP reported $5,712,175.76 = fees $4,975,854.58 + on-costs $736,321.18.

## Trust balances (added 13/10/2026)
- Upload the LEAP "Trust Trial Balance" report in the WIP dashboard upload dialog (editor or above). It is saved straight away, keyed by its At Date.
- Each WIP week uses the latest trust report dated on or before the WIP Aged at date, within 7 days.
- Trust available is shown in every grouped view (client, responsible staff, staff billed by, matter type), in the client matter table and as a tile on the matter page.
- Colours: green = trust more than the WIP shown, orange = some trust but less than the WIP shown, red = nil. With "Professional services" selected the comparison is against fees.
- The "Trust, no time" view lists matters holding trust money with no unbilled professional-fee time in that week, with Active/Archived status from the Matter List and an Active | Archived | All selector. It fits the screen width without sideways scrolling.

## Carrying live data across a republish
- Administrators can download a full data backup: GET /api/admin/backup (signed in as a portal admin; includes users and password hashes, so treat it as confidential).
- Before republishing: download the backup from the live site, stop the local server, run `node tools-restore.js backup.json`, then publish. This keeps passwords, uploads and settings made on the live site.
- Matter status (13/10/2026): a "Matter status" filter in Reporting parameters applies to every view, tile, chart and export: All matters, Active (not archived), Archived, any individual LEAP status, or Not on the Matter List. The Active | Archived | All buttons in the "Trust, no time" view use the same filter.

## Running on your own server
1. Install Node.js 18 or later. There are no npm dependencies (no `npm install` needed).
2. Copy this folder to the server and run `node server.js`. Environment variables:
   - `PORT` — listening port (default 5000).
   - `FD_DATA_DIR` — where user accounts, sessions and uploads are stored (default `./portal-data`). Keep this directory outside the web root and back it up.
3. Put the app behind HTTPS (e.g. nginx, IIS or Caddy as a reverse proxy to the port above). Session cookies should only travel over HTTPS.
4. Load data, either:
   - Carry over the live site: sign in to finnsdashboard.pplx.app as a portal administrator, download GET /api/admin/backup, then run `node tools-restore.js backup.json` with the server stopped. This keeps users, passwords, uploads and settings. The backup contains password hashes, so treat it as confidential.
   - Or start fresh: `node seed.js <folder containing ARWeeklyUpdate, LEAPClients, StaffPerformance, WIPReview>` creates the FinnDebtors administrator with a temporary password.
5. Run it as a service (systemd, pm2 or Windows Service) so it restarts automatically.
