// node tools-restore.js backup.json — writes a downloaded /api/admin/backup into portal-data/ (server must be stopped).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = process.env.FD_DATA_DIR || path.join(__dirname, 'portal-data');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.rmSync(ROOT, { recursive: true, force: true });
for (const [rel, data] of Object.entries(b.files)) { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(data, 'base64')); }
console.log('restored', Object.keys(b.files).length, 'files from', b.at);
