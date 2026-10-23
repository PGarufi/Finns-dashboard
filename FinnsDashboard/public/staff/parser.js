/* Spreadsheet parsing for the Finn Roache staff performance dashboard.
   Shared by the browser app and the Node test harness. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/xlsx.full.min.js'));
  else root.FRLParser = factory(root.XLSX);
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';
  /* ---------- spreadsheet parsing ---------- */
function cellStr(v) { return v == null ? '' : String(v).replace(/\u00a0/g, ' ').trim(); }
function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function parseDMY(s) {
  var m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return { y: +m[3], m: +m[2] };
}
function monthKeyFrom(s) { var d = parseDMY(s); return d ? d.y + '-' + String(d.m).padStart(2, '0') : null; }

function findPeriod(rowsArr) {
  for (var i = 0; i < rowsArr.length && i < 40; i++) {
    for (var j = 0; j < (rowsArr[i] || []).length; j++) {
      var v = cellStr(rowsArr[i][j]);
      if (/date range|report period/i.test(v)) {
        var k = monthKeyFrom(v);
        if (k) return k;
        var nxt = cellStr(rowsArr[i][j + 1]); k = monthKeyFrom(nxt);
        if (k) return k;
      }
    }
  }
  return null;
}

function sheetRows(wb, name) { return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }); }

function parseWorkbook(wb, fname) {
  var res = { type: null, month: null, rows: [], warn: [] };
  var names = wb.SheetNames;

  // Pay categories
  var payName = names.filter(function (n) {
    var r = sheetRows(wb, n);
    return r.length && (r[0] || []).some(function (c) { return /^pay category$/i.test(cellStr(c)); });
  })[0];
  if (payName) {
    var pr = sheetRows(wb, payName), hdr = pr[0].map(cellStr);
    function col(re) { for (var i = 0; i < hdr.length; i++) if (re.test(hdr[i])) return i; return -1; }
    var cCat = col(/^pay category$/i), cF = col(/^first ?name$/i), cS = col(/^surname|last ?name$/i),
      cL = col(/^location$/i), cA = col(/^amount$/i), cSup = col(/super/i);
    var out = [];
    for (var i = 1; i < pr.length; i++) {
      var row = pr[i] || [], cat = cellStr(row[cCat]);
      if (!cat || /^totals?$/i.test(cat)) continue;
      var nm = (cellStr(row[cF]) + ' ' + cellStr(row[cS])).trim();
      if (!nm) continue;
      out.push({ name: nm, loc: cellStr(row[cL]), cat: cat, amt: num(row[cA]), sup: num(row[cSup]) });
    }
    var mk = null;
    names.forEach(function (n) { if (!mk) mk = findPeriod(sheetRows(wb, n)); });
    res.type = 'pay'; res.rows = out; res.month = mk;
    if (cSup < 0) res.warn.push('No SG Super column found');
    return res;
  }

  // Receipts / invoiced — locate a sheet with a Contribution column
  for (var si = 0; si < names.length; si++) {
    var rr = sheetRows(wb, names[si]);
    var hRow = -1, cName = -1, cContrib = -1, kind = null;
    for (var r2 = 0; r2 < Math.min(rr.length, 40); r2++) {
      var row2 = (rr[r2] || []).map(cellStr);
      var ci = row2.findIndex(function (c) { return /^contribution$/i.test(c); });
      if (ci < 0) continue;
      var ni = row2.findIndex(function (c) { return /^staff (name|member)$/i.test(c); });
      if (ni < 0) continue;
      hRow = r2; cContrib = ci; cName = ni;
      kind = /receipt/i.test(names[si]) || /receipt/i.test(cellStr(rr[0] && rr[0][2]) + cellStr(rr[1] && rr[1][1])) ? 'receipts' : 'invoiced';
      break;
    }
    if (hRow < 0) continue;
    if (/receipt/i.test(names[si])) kind = 'receipts';
    else if (/invoice/i.test(names[si])) kind = 'invoiced';
    var out2 = [];
    for (var r3 = hRow + 1; r3 < rr.length; r3++) {
      var row3 = rr[r3] || [], nm2 = cellStr(row3[cName]);
      if (!nm2) continue;
      if (/^[A-Za-z]{3}-\d{4}$/.test(nm2)) continue;         // month grouping label
      if (/^totals?$/i.test(nm2) || /^grand total/i.test(nm2)) continue;
      if (row3[cContrib] == null || cellStr(row3[cContrib]) === '') continue;
      out2.push({ name: nm2.replace(/\s+/g, ' '), amt: num(row3[cContrib]) });
    }
    res.type = kind; res.rows = out2; res.month = findPeriod(rr);
    return res;
  }
  return res;
}


  return { parseWorkbook: parseWorkbook, findPeriod: findPeriod, num: num, cellStr: cellStr, monthKeyFrom: monthKeyFrom };
}));
