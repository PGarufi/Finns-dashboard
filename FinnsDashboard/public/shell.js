/* Finns Dashboard — shared session helper used by the portal and every app page.
   Load with <script src="../shell.js" data-root="../"> from an app folder,
   or <script src="shell.js" data-root=""> from the portal. */
(function () {
  'use strict';
  var script = document.currentScript;
  var ROOT = (script && script.dataset.root) || '';
  var RAW = 'port/5000';
  var PORT = RAW.indexOf('__') === 0 ? '' : RAW;
  // The hosting proxy strips Set-Cookie, so the session token is kept in a
  // first-party cookie here and replayed in a header on every request.
  var TOK = 'fdash_tok';
  var memTok = '';

  function url(p) { return ROOT + (PORT ? PORT + p : p.replace(/^\//, '')); }
  function readTok() {
    var c = ''; try { c = document.cookie || ''; } catch (e) { return memTok; }
    var m = ('; ' + c).match(new RegExp('; ' + TOK + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : memTok;
  }
  function writeTok(t, seconds) {
    memTok = t;
    try { document.cookie = TOK + '=' + encodeURIComponent(t) + '; Path=/; Max-Age=' + seconds + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) { /* preview frame */ }
  }
  function AuthError(msg) { this.name = 'AuthError'; this.message = msg || 'unauthorised'; }
  AuthError.prototype = Object.create(Error.prototype);

  var MESSAGES = {
    too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
    invalid_credentials: 'That username and password combination was not recognised.',
    account_disabled: 'This account has been disabled. Contact an administrator.',
    forbidden: 'Your role does not allow this action.',
    no_access: 'You do not have access to this app.',
    too_large: 'That file is too large (limit 9.5 MB).',
    invite_invalid: 'This link is invalid, already used or expired. Ask an administrator for a new one.',
    too_many_writes: 'Too many changes in a short time. Try again shortly.',
  };

  function call(path, opts, allow401) {
    opts = opts || {};
    var o = { credentials: 'same-origin', method: opts.method || 'GET', headers: Object.assign({}, opts.headers || {}), cache: 'no-store' };
    var t = readTok();
    if (t) o.headers['x-session'] = t;
    if (opts.json !== undefined) { o.body = JSON.stringify(opts.json); o.headers['content-type'] = 'application/json'; }
    else if (opts.body !== undefined) o.body = opts.body;
    return fetch(url(path), o).then(function (r) {
      if (r.status === 401 && !allow401) { writeTok('', 0); throw new AuthError(); }
      return r;
    });
  }
  function callJSON(path, opts, allow401) {
    return call(path, opts, allow401).then(function (r) {
      return r.text().then(function (txt) {
        var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = {}; }
        if (!r.ok) { var e = new Error(j.message || MESSAGES[j.error] || ('Request failed (' + r.status + ').')); e.status = r.status; e.code = j.error; throw e; }
        return j;
      });
    });
  }

  var home = ROOT + 'index.html';
  function toPortal(reason, app) {
    var q = reason ? '?' + reason + '=' + encodeURIComponent(app || '1') : '';
    location.replace(home + q);
  }
  /* Called by each app page before it shows anything: resolves with
     { user, role } or sends the browser to the portal sign-in. */
  function guard(appId) {
    if (!readTok()) { toPortal('next', appId); return new Promise(function () {}); }
    return callJSON('/api/session', {}, true).then(function (j) {
      var app = (j.apps || []).filter(function (a) { return a.id === appId; })[0];
      if (!app || !app.role) { toPortal('denied', appId); return new Promise(function () {}); }
      document.documentElement.classList.add('fd-ready');
      return { user: j.user, role: app.role, apps: j.apps };
    }, function (e) {
      if (e.status === 401) { writeTok('', 0); toPortal('next', appId); return new Promise(function () {}); }
      throw e;
    });
  }
  function signOut() {
    return call('/api/logout', { method: 'POST' }, true).catch(function () {}).then(function () { writeTok('', 0); location.replace(home); });
  }
  function expired(appId) { writeTok('', 0); toPortal('expired', appId); }
  function prefGet(k) { var c = ''; try { c = document.cookie || ''; } catch (e) { return null; } var m = ('; ' + c).match(new RegExp('; ' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
  function prefSet(k, v) { try { document.cookie = k + '=' + encodeURIComponent(v) + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch (e) { /* */ } }
  var ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', admin: 'Administrator' };

  window.FD = { url: url, call: call, callJSON: callJSON, guard: guard, signOut: signOut, expired: expired, readTok: readTok, writeTok: writeTok, AuthError: AuthError, home: home, root: ROOT, prefGet: prefGet, prefSet: prefSet, ROLE_LABEL: ROLE_LABEL, MESSAGES: MESSAGES };
})();
