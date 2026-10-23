// Finns Dashboard — file-backed storage. Every write is atomic (write temp file, then rename).
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = process.env.FD_DATA_DIR || path.join(__dirname, '..', 'portal-data');
fs.mkdirSync(ROOT, { recursive: true });

function p(...parts) { const f = path.join(ROOT, ...parts); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; }
function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}
function readJSON(rel, dflt) { try { return JSON.parse(fs.readFileSync(p(rel), 'utf8')); } catch (e) { return dflt; } }
function writeJSON(rel, obj) { writeAtomic(p(rel), JSON.stringify(obj)); }
function readBuf(rel) { try { return fs.readFileSync(p(rel)); } catch (e) { return null; } }
function writeBuf(rel, buf) { writeAtomic(p(rel), buf); }
function remove(rel) { try { fs.unlinkSync(p(rel)); return true; } catch (e) { return false; } }
function list(relDir) { const d = path.join(ROOT, relDir); fs.mkdirSync(d, { recursive: true }); return fs.readdirSync(d).filter((f) => !f.endsWith('.tmp')); }
function appendLine(rel, line) { fs.appendFileSync(p(rel), line + '\n'); }

module.exports = { ROOT, p, readJSON, writeJSON, readBuf, writeBuf, remove, list, appendLine };
