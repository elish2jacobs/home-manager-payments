/* Home Manager Payments — אפליקציה (שלב 2: אשף, הגדרות חוזה, לוח תשלומים) */
(function () {
  'use strict';

  var C = window.HMCalc;
  var CFG = window.HM_CONFIG || {};
  var SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';
  var DRIVE = 'https://www.googleapis.com/drive/v3';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  var SCHEMA_VERSION = 1;

  var ROOT_NAME = 'פרויקט הבית שלי';
  var DATA_NAME = 'נתוני הבית';
  var SUBFOLDERS = ['01_קבלן', '02_הוצאות נוספות', '03_מסמכים כלליים', '04_תיעוד', '05_גיבויים'];

  var SHEETS_SCHEMA = {
    Settings: ['key', 'value', 'updatedAt'],
    ContractorStages: ['id', 'order', 'name', 'pct', 'month', 'plannedDate', 'indexExempt', 'linkedPct', 'notes', 'updatedAt'],
    PaymentRequests: ['id', 'stageId', 'number', 'receivedDate', 'dueDate', 'baseAmount', 'indexValue', 'indexMonth', 'indexSource', 'indexAdj', 'finalAmount', 'notes', 'updatedAt', 'contractorAmount'],
    Payments: ['id', 'type', 'stageId', 'requestId', 'expenseId', 'date', 'amount', 'method', 'fundingSource', 'reference', 'notes', 'updatedAt'],
    ExpenseCategories: ['id', 'order', 'name', 'budget', 'updatedAt'],
    Expenses: ['id', 'categoryId', 'name', 'supplier', 'estimate', 'commitment', 'status', 'startDate', 'endDate', 'notes', 'updatedAt'],
    Contacts: ['id', 'domain', 'company', 'role', 'name', 'phone', 'phone2', 'email', 'notes', 'updatedAt'],
    Documents: ['id', 'driveFileId', 'name', 'type', 'links', 'description', 'uploadedAt'],
    Journal: ['id', 'date', 'title', 'description', 'area', 'links', 'notes', 'updatedAt'],
    Tasks: ['id', 'title', 'description', 'area', 'dueDate', 'owner', 'priority', 'status', 'notes', 'updatedAt'],
    IndexHistory: ['year', 'month', 'value', 'publishedAt', 'source', 'updatedAt'],
    Scenarios: ['id', 'name', 'y1', 'y2', 'y3', 'updatedAt'],
    ActivityLog: ['at', 'user', 'action', 'entity', 'entityId', 'details']
  };

  // ---------- מצב ----------
  var state = {
    token: null, tokenExp: 0, user: null,
    rootId: null, rootLink: null, sheetId: null, sheetLink: null,
    settingsRows: {}, // key -> {value, row}
    s: {},            // key -> value
    stages: [],       // ContractorStages
    requests: [], payments: [], sheetGids: {},
    cbs: null,        // data/index.json
    scenarios: [], categories: [], expenses: []
  };
  var tokenClient = null;
  var pendingToken = null;   // {resolve,reject,promise}
  var draft = null;          // טיוטת אשף / הגדרות
  var wizardStep = 1;

  // ---------- עזרים ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nowIso() { return new Date().toISOString(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var p = function (n) { return ('0' + n).slice(-2); };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function show(screenId) {
    ['screen-loading', 'screen-login', 'screen-create', 'screen-config', 'screen-app'].forEach(function (id) {
      $(id).hidden = id !== screenId;
    });
  }
  function loading(text) { $('loading-text').textContent = text || 'טוען…'; show('screen-loading'); }
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'err' ? 6000 : 3000);
  }
  function setSync(kind, text) {
    var el = $('sync-state');
    if (!el) return;
    el.className = 'sync' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }
  function storeGet(k) { try { return localStorage.getItem('hmp.' + k); } catch (e) { return null; } }
  function storeSet(k, v) { try { if (v == null) localStorage.removeItem('hmp.' + k); else localStorage.setItem('hmp.' + k, v); } catch (e) { /* ignore */ } }
  function sessGet(k) { try { return sessionStorage.getItem('hmp.' + k); } catch (e) { return null; } }
  function sessSet(k, v) { try { if (v == null) sessionStorage.removeItem('hmp.' + k); else sessionStorage.setItem('hmp.' + k, v); } catch (e) { /* ignore */ } }

  // ---------- התחברות ----------
  function AuthError(msg) { this.name = 'AuthError'; this.message = msg; }
  AuthError.prototype = Object.create(Error.prototype);

  function tokenValid(marginMs) { return !!state.token && Date.now() < state.tokenExp - (marginMs == null ? 60000 : marginMs); }

  function restoreToken() {
    var raw = sessGet('token');
    if (!raw) return false;
    try {
      var t = JSON.parse(raw);
      if (t.exp > Date.now() + 60000) { state.token = t.v; state.tokenExp = t.exp; return true; }
    } catch (e) { /* ignore */ }
    sessSet('token', null);
    return false;
  }

  function initGis() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPES,
      callback: function (resp) {
        var p = pendingToken; pendingToken = null;
        if (!p) return;
        if (resp.error) { p.reject(new AuthError(resp.error_description || resp.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.file')) {
          p.reject(new AuthError('לא אושרה גישה ל-Google Drive. יש לסמן את תיבת הגישה לקבצים כדי שהאפליקציה תוכל לשמור את הנתונים שלך.'));
          return;
        }
        state.token = resp.access_token;
        state.tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        sessSet('token', JSON.stringify({ v: state.token, exp: state.tokenExp }));
        hideReconnect();
        p.resolve();
      },
      error_callback: function (err) {
        var p = pendingToken; pendingToken = null;
        if (!p) return;
        var msg = err && err.type === 'popup_closed' ? 'חלון ההתחברות נסגר.' :
          err && err.type === 'popup_failed_to_open' ? 'הדפדפן חסם את חלון ההתחברות. יש לאפשר חלונות קופצים לאתר.' :
            'ההתחברות נכשלה.';
        p.reject(new AuthError(msg));
      }
    });
  }

  // חייב להיקרא מתוך לחיצה של המשתמש
  function requestToken(forceSelect) {
    if (pendingToken) return pendingToken.promise;
    var holder = {};
    holder.promise = new Promise(function (resolve, reject) { holder.resolve = resolve; holder.reject = reject; });
    pendingToken = holder;
    var hint = storeGet('email');
    var opts = forceSelect ? { prompt: 'select_account' } : (hint ? { prompt: '', hint: hint } : { prompt: '' });
    tokenClient.requestAccessToken(opts);
    return holder.promise;
  }

  // התנתקות: יציאה מהאפליקציה בלבד. ההרשאה נשארת, ולכן בכניסה הבאה אין צורך לאשר שוב.
  function logout() {
    state.token = null; state.tokenExp = 0; state.user = null;
    sessSet('token', null);
    storeSet('forceSelect', '1');
    showLogin();
  }
  // ביטול הרשאות: מנתק את האפליקציה מחשבון Google לגמרי. הנתונים ב-Drive לא נמחקים.
  function revokeAccess() {
    if (!confirm('לבטל את הגישה של האפליקציה לחשבון Google שלך?\nהנתונים ב-Drive לא יימחקו. בכניסה הבאה תתבקש לאשר שוב.')) return;
    var tok = state.token;
    var done = function () {
      state.token = null; state.tokenExp = 0; state.user = null;
      sessSet('token', null); storeSet('email', null); storeSet('forceSelect', null);
      showLogin();
      toast('הגישה בוטלה', 'ok');
    };
    if (tok) { try { google.accounts.oauth2.revoke(tok, done); } catch (e) { done(); } } else done();
  }

  function showReconnect() { $('reconnect').hidden = false; setSync('err', 'החיבור פג'); }
  function hideReconnect() { var r = $('reconnect'); if (r) r.hidden = true; if (!$('screen-app').hidden) setSync('', 'מחובר'); }

  // ---------- קריאות API ----------
  function api(url, opts) {
    opts = opts || {};
    var go = function () {
      if (!tokenValid(0)) return Promise.reject(new AuthError('פג תוקף החיבור.'));
      var headers = { Authorization: 'Bearer ' + state.token };
      var body = opts.body;
      if (body && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      return fetch(url, { method: opts.method || 'GET', headers: headers, body: body }).then(function (r) {
        if (r.status === 401) { state.token = null; sessSet('token', null); throw new AuthError('פג תוקף החיבור.'); }
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error((j.error && j.error.message) || ('שגיאה ' + r.status));
          });
        }
        return r.status === 204 ? null : r.json();
      });
    };
    // אם חידוש חיבור באמצע — מחכים לו
    if (pendingToken) return pendingToken.promise.then(go);
    return go();
  }

  function driveList(q, fields) {
    var u = DRIVE + '/files?spaces=drive&pageSize=20&q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(' + (fields || 'id,name,webViewLink') + ')');
    return api(u).then(function (r) { return r.files || []; });
  }
  function driveCreate(meta) { return api(DRIVE + '/files?fields=id,name,webViewLink', { method: 'POST', body: meta }); }
  function rng(sheet, range) { return encodeURIComponent("'" + sheet + "'!" + range); }

  // ---------- Sheets: קריאה וכתיבה ----------
  function readRows(name) {
    return api(SHEETS + '/' + state.sheetId + '/values/' + rng(name, 'A1:Z')).then(function (r) {
      var vals = r.values || [];
      var head = vals[0] || SHEETS_SCHEMA[name];
      return vals.slice(1).map(function (row, i) {
        var o = { _row: i + 2 };
        head.forEach(function (h, j) { o[h] = row[j] == null ? '' : row[j]; });
        return o;
      });
    });
  }
  function replaceRows(name, objs) {
    var head = SHEETS_SCHEMA[name];
    var base = SHEETS + '/' + state.sheetId + '/values/';
    return api(base + rng(name, 'A2:Z') + ':clear', { method: 'POST', body: {} }).then(function () {
      if (!objs.length) return null;
      var values = objs.map(function (o) { return head.map(function (h) { return o[h] == null ? '' : String(o[h]); }); });
      return api(base + rng(name, 'A2') + '?valueInputOption=RAW', { method: 'PUT', body: { values: values } });
    });
  }
  function appendRows(name, rows) {
    return api(SHEETS + '/' + state.sheetId + '/values/' + rng(name, 'A:Z') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      { method: 'POST', body: { values: rows } });
  }
  function loadSettings() {
    return readRows('Settings').then(function (rows) {
      var map = {}, s = {};
      rows.forEach(function (r) { if (r.key) { map[r.key] = { value: r.value, updatedAt: r.updatedAt, row: r._row }; s[r.key] = r.value; } });
      state.settingsRows = map; state.s = s;
      return s;
    });
  }
  // שומר כמה מפתחות בבת אחת: קיימים מתעדכנים, חדשים מתווספים
  function saveSettings(obj) {
    var t = nowIso();
    return loadSettings().then(function () {
      var updates = [], appends = [];
      Object.keys(obj).forEach(function (k) {
        var v = obj[k] == null ? '' : String(obj[k]);
        var ex = state.settingsRows[k];
        if (ex) updates.push({ range: "'Settings'!A" + ex.row + ':C' + ex.row, values: [[k, v, t]] });
        else appends.push([k, v, t]);
      });
      var p = Promise.resolve();
      if (updates.length) p = p.then(function () { return api(SHEETS + '/' + state.sheetId + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: updates } }); });
      if (appends.length) p = p.then(function () { return appendRows('Settings', appends); });
      return p;
    }).then(loadSettings);
  }
  function loadStages() {
    return readRows('ContractorStages').then(function (rows) {
      rows.sort(function (a, b) { return C.num(a.order) - C.num(b.order); });
      state.stages = rows.map(function (r) {
        return { id: r.id, name: r.name, pct: r.pct, month: r.month, indexExempt: r.indexExempt || 'auto', notes: r.notes || '' };
      });
      return state.stages;
    });
  }
  function saveStages(list) {
    var t = nowIso();
    var objs = list.map(function (st, i) {
      return { id: st.id || uid(), order: i + 1, name: String(st.name).trim(), pct: C.num(st.pct), month: C.num(st.month), plannedDate: '', indexExempt: st.indexExempt || 'auto', linkedPct: '', notes: st.notes || '', updatedAt: t };
    });
    return replaceRows('ContractorStages', objs).then(loadStages);
  }
  function loadRequests() { return readRows('PaymentRequests').then(function (r) { state.requests = r.filter(function (x) { return x.id; }); return state.requests; }); }
  function loadPayments() { return readRows('Payments').then(function (r) { state.payments = r.filter(function (x) { return x.id; }); return state.payments; }); }
  function upsertRow(name, obj) {
    var head = SHEETS_SCHEMA[name];
    var row = head.map(function (h) { return obj[h] == null ? '' : String(obj[h]); });
    if (obj._row) return api(SHEETS + '/' + state.sheetId + '/values/' + rng(name, 'A' + obj._row) + '?valueInputOption=RAW', { method: 'PUT', body: { values: [row] } });
    return appendRows(name, [row]);
  }
  function loadCategories() {
    return readRows('ExpenseCategories').then(function (r) {
      var rows = r.filter(function (x) { return x.id; });
      if (!rows.length && !state.s.categoriesSeeded) {
        var t = nowIso();
        return appendRows('ExpenseCategories', C.DEFAULT_CATEGORIES.map(function (n, i) { return ['c' + (i + 1), String(i + 1), n, '0', t]; }))
          .then(function () { return saveSettings({ categoriesSeeded: 'true' }); }).then(loadCategories);
      }
      rows.sort(function (a, b) { return C.num(a.order) - C.num(b.order); });
      state.categories = rows;
      return rows;
    });
  }
  function loadExpenses() { return readRows('Expenses').then(function (r) { state.expenses = r.filter(function (x) { return x.id; }); return state.expenses; }); }
  function loadScenarios() {
    return readRows('Scenarios').then(function (r) {
      state.scenarios = r.filter(function (x) { return x.id; }).map(function (x) { return { id: x.id, name: x.name, y1: C.num(x.y1), y2: C.num(x.y2), y3: C.num(x.y3), _row: x._row }; });
      return state.scenarios;
    });
  }
  function loadGids() {
    return api(SHEETS + '/' + state.sheetId + '?fields=sheets.properties').then(function (ss) {
      var m = {}; (ss.sheets || []).forEach(function (x) { m[x.properties.title] = x.properties.sheetId; }); state.sheetGids = m; return m;
    });
  }
  function deleteRow(name, rowNum) {
    if (!rowNum) return Promise.reject(new Error('שורה לא נמצאה'));
    var p = state.sheetGids[name] != null ? Promise.resolve() : loadGids();
    return p.then(function () {
      return api(SHEETS + '/' + state.sheetId + ':batchUpdate', { method: 'POST', body: { requests: [{ deleteDimension: { range: { sheetId: state.sheetGids[name], dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum } } }] } });
    });
  }
  // ---------- מדד הלמ״ס ----------
  function loadCbs() {
    return fetch('data/index.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { state.cbs = j && j.series && j.series.length ? j : null; return state.cbs; })
      .catch(function () { state.cbs = null; return null; });
  }
  function cbsValue(y, m) {
    if (!state.cbs) return null;
    var f = state.cbs.series.filter(function (x) { return x.y === y && x.m === m; })[0];
    return f ? f.v : null;
  }
  function cbsLatest() { return state.cbs ? state.cbs.series[state.cbs.series.length - 1] : null; }
  // מקדם המרה מבסיס הלמ״ס הנוכחי לבסיס שבחוזה: מדד הבסיס בחוזה ÷ ערך הלמ״ס לחודש הבסיס
  function contractFactor(s) {
    s = s || state.s;
    var ym = C.ymKey(s.baseIndexMonth), bi = C.num(s.baseIndex);
    if (!ym || !(bi > 0)) return null;
    var raw = cbsValue(ym.y, ym.m);
    return raw ? bi / raw : null;
  }
  function toContract(raw, s) { var f = contractFactor(s); return f && raw != null ? Math.round(raw * f * 10000) / 10000 : null; }
  // המדד הידוע בתאריך: {y,m,raw,v} — v בבסיס החוזה (או null אם אין מקדם)
  function knownIndexAt(dateIso) {
    var km = C.knownMonthFor(dateIso); if (!km) return null;
    var raw = cbsValue(km.y, km.m);
    if (raw != null) return { y: km.y, m: km.m, raw: raw, v: toContract(raw) };
    var v = null;
    return { y: km.y, m: km.m, raw: null, v: v, pending: true };
  }
  // העתקת מדדים חדשים לגיליון IndexHistory של המשתמש (ברקע)
  function syncIndexHistory() {
    if (!state.cbs) return Promise.resolve();
    return readRows('IndexHistory').then(function (rows) {
      var have = {}; rows.forEach(function (r) { have[r.year + '-' + r.month] = 1; });
      var t = nowIso();
      var add = state.cbs.series.filter(function (x) { return !have[x.y + '-' + x.m]; }).map(function (x) { return [String(x.y), String(x.m), String(x.v), '', 'cbs', t]; });
      return add.length ? appendRows('IndexHistory', add) : null;
    }).catch(function (e) { console.warn('IndexHistory sync', e); });
  }
  // מוודא שכותרות הגיליונות מעודכנות (עמודות חדשות מתווספות בסוף)
  function ensureHeaders() {
    var data = Object.keys(SHEETS_SCHEMA).map(function (n) { return { range: "'" + n + "'!A1", values: [SHEETS_SCHEMA[n]] }; });
    return api(SHEETS + '/' + state.sheetId + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: data } });
  }
  function logActivity(action, entity, details) {
    if (!state.sheetId) return;
    appendRows('ActivityLog', [[nowIso(), (state.user && state.user.email) || '', action, entity, '', details || '']]).catch(function () { /* לא קריטי */ });
  }
  // שמירה עם חיווי מצב
  function withSync(p, okMsg) {
    setSync('busy', 'שומר…');
    return p.then(function (r) {
      setSync('', 'נשמר');
      if (okMsg) toast(okMsg, 'ok');
      return r;
    }, function (e) {
      setSync('err', 'שמירה נכשלה');
      throw e;
    });
  }

  // ---------- פרויקט ----------
  function findProject() {
    return driveList("appProperties has { key='hmRole' and value='root' } and mimeType='" + FOLDER_MIME + "' and trashed=false")
      .then(function (folders) {
        if (!folders.length) return null;
        var root = folders[0];
        return driveList("'" + root.id + "' in parents and appProperties has { key='hmRole' and value='data' } and trashed=false")
          .then(function (files) { return { root: root, sheet: files[0] || null }; });
      });
  }
  function createProject() {
    var root;
    return driveCreate({ name: ROOT_NAME, mimeType: FOLDER_MIME, appProperties: { hmApp: 'hmp', hmRole: 'root' } })
      .then(function (r) {
        root = r;
        return SUBFOLDERS.reduce(function (p, name, i) {
          return p.then(function () { return driveCreate({ name: name, mimeType: FOLDER_MIME, parents: [root.id], appProperties: { hmApp: 'hmp', hmRole: 'sub' + (i + 1) } }); });
        }, Promise.resolve());
      })
      .then(function () { return createDataSheet(root.id); })
      .then(function (sheet) { return { root: root, sheet: sheet }; });
  }
  function createDataSheet(rootId) {
    var file;
    return driveCreate({ name: DATA_NAME, mimeType: SHEET_MIME, parents: [rootId], appProperties: { hmApp: 'hmp', hmRole: 'data' } })
      .then(function (f) { file = f; return api(SHEETS + '/' + f.id + '?fields=sheets.properties'); })
      .then(function (ss) {
        var firstId = ss.sheets[0].properties.sheetId;
        var names = Object.keys(SHEETS_SCHEMA);
        var requests = [{ updateSheetProperties: { properties: { sheetId: firstId, title: names[0], rightToLeft: true, gridProperties: { frozenRowCount: 1 } }, fields: 'title,rightToLeft,gridProperties.frozenRowCount' } }];
        names.slice(1).forEach(function (n) { requests.push({ addSheet: { properties: { title: n, rightToLeft: true, gridProperties: { frozenRowCount: 1 } } } }); });
        return api(SHEETS + '/' + file.id + ':batchUpdate', { method: 'POST', body: { requests: requests } });
      })
      .then(function () {
        var t = nowIso();
        var data = Object.keys(SHEETS_SCHEMA).map(function (n) { return { range: "'" + n + "'!A1", values: [SHEETS_SCHEMA[n]] }; });
        data.push({ range: "'Settings'!A2", values: [['schemaVersion', String(SCHEMA_VERSION), t], ['createdAt', t, t], ['setupComplete', 'false', t]] });
        return api(SHEETS + '/' + file.id + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: data } });
      })
      .then(function () { return file; });
  }

  // ---------- זרימת כניסה ----------
  function showLogin() {
    var email = storeGet('email');
    var force = storeGet('forceSelect');
    $('btn-login').textContent = email && !force ? 'המשך' : 'התחבר עם Google';
    $('login-hint').textContent = email && !force ? 'כניסה בתור ' + email : '';
    show('screen-login');
  }
  function fetchUser() {
    return api('https://www.googleapis.com/oauth2/v3/userinfo').then(function (u) {
      state.user = u;
      if (u.email) storeSet('email', u.email);
      return u;
    });
  }
  function afterAuth() {
    loading('מחפש את הפרויקט שלך ב-Drive…');
    return fetchUser()
      .then(findProject)
      .then(function (proj) {
        if (!proj) {
          $('create-name').textContent = state.user && state.user.given_name ? ', ' + state.user.given_name : '';
          show('screen-create');
          return;
        }
        if (!proj.sheet) {
          loading('משחזר את קובץ הנתונים…');
          return createDataSheet(proj.root.id).then(function (sheet) { return openProject({ root: proj.root, sheet: sheet }); });
        }
        return openProject(proj);
      })
      .catch(handleError);
  }
  function openProject(proj, goSetup) {
    state.rootId = proj.root.id; state.rootLink = proj.root.webViewLink;
    state.sheetId = proj.sheet.id; state.sheetLink = proj.sheet.webViewLink;
    loading('טוען נתונים…');
    return ensureHeaders().then(function () { return Promise.all([loadSettings(), loadStages(), loadRequests(), loadPayments(), loadCbs(), loadScenarios(), loadExpenses()]); }).then(loadCategories).then(function () {
      syncIndexHistory();
      show('screen-app');
      renderUser();
      setSync('', 'מחובר');
      if (goSetup || !isSetup()) { startWizard(); location.hash = '#/setup'; }
      route();
    });
  }
  function isSetup() { return state.s.setupComplete === 'true'; }

  function handleError(e) {
    console.error('[HMP]', e);
    if (e instanceof AuthError) {
      if (!$('screen-app').hidden) { showReconnect(); return; }
      showLogin(); toast(e.message, 'err'); return;
    }
    if (!navigator.onLine) { toast('אין חיבור לאינטרנט. הנתונים לא נשמרו.', 'err'); return; }
    toast(e.message || 'אירעה שגיאה', 'err');
    if (!$('screen-loading').hidden) showLogin();
  }

  // ---------- ניווט ----------
  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    stages: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    pay: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    expenses: '<path d="M4 7h16v13H4z"/><path d="M9 7V4h6v3"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h2M14 12h2M8 16h2M14 16h2"/>',
    docs: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
    contacts: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="M20 6 9 17l-5-5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', right: '<path d="m9 18 6-6-6-6"/>',
    menu: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'
  };
  var ROUTES = [
    { id: 'dashboard', title: 'דשבורד', icon: 'home', mobile: true },
    { id: 'contractor', title: 'קבלן ואבני דרך', short: 'אבני דרך', icon: 'stages', mobile: true },
    { id: 'expenses', title: 'הוצאות נוספות', short: 'הוצאות', icon: 'expenses', mobile: true },
    { id: 'payments', title: 'מרכז תשלומים', short: 'תשלומים', icon: 'pay', mobile: true },
    { id: 'calculator', title: 'מחשבון מדד', icon: 'calc' },
    { id: 'documents', title: 'מסמכים', icon: 'docs' },
    { id: 'contacts', title: 'אנשי קשר', icon: 'contacts' },
    { id: 'settings', title: 'הגדרות', icon: 'settings' },
    { id: 'more', title: 'עוד', icon: 'menu', mobile: true, mobileOnly: true }
  ];
  var HIDDEN_ROUTES = [{ id: 'setup', title: 'הגדרת פרויקט', icon: 'settings' }, { id: 'stage', title: 'אבן דרך', icon: 'stages', nav: 'contractor' }, { id: 'category', title: 'קטגוריה', icon: 'expenses', nav: 'expenses' }];
  function icon(name, size) {
    size = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function buildNav() {
    $('nav').innerHTML = ROUTES.filter(function (r) { return !r.mobileOnly; }).map(function (r) {
      return '<a href="#/' + r.id + '" data-route="' + r.id + '">' + icon(r.icon) + '<span>' + r.title + '</span></a>';
    }).join('');
    $('bottomnav').innerHTML = ROUTES.filter(function (r) { return r.mobile; }).map(function (r) {
      return '<a href="#/' + r.id + '" data-route="' + r.id + '">' + icon(r.icon) + '<span>' + (r.short || r.title) + '</span></a>';
    }).join('');
  }
  function currentRoute() {
    var parts = (location.hash || '').replace(/^#\//, '').split('/');
    var id = parts[0];
    var r = ROUTES.concat(HIDDEN_ROUTES).filter(function (x) { return x.id === id; })[0] || ROUTES[0];
    routeParam = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : '';
    return r;
  }
  var lastRoute = null, routeParam = '';
  function route() {
    if ($('screen-app').hidden) return;
    var r = currentRoute();
    if (r.id !== lastRoute) {
      if (r.id === 'settings') draft = makeDraft();
      if (r.id === 'setup') startWizard();
      if (r.id === 'calculator') initCalcPage();
    }
    lastRoute = r.id;
    document.querySelectorAll('[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === (r.nav || r.id)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('view-title').textContent = r.title;
    $('view-sub').textContent = state.s.projectName || '';
    var view = $('view');
    if ($('modal').open) closeModal();
    view.innerHTML = (VIEWS[r.id] || placeholder)(r, routeParam);
    afterRender(r.id);
    view.focus({ preventScroll: true });
  }
  function rerender() { route(); }
  function renderUser() {
    var u = state.user || {};
    $('user-box').innerHTML = '<div><b>' + esc(u.name || '') + '</b></div><div>' + esc(u.email || '') + '</div>';
  }

  // ---------- טיוטה (אשף / הגדרות) ----------
  var KEYS = ['projectName', 'address', 'aptNo', 'contractor', 'signDate', 'deliveryDate', 'basePrice', 'track', 'fixSurcharge', 't3Surcharge',
    'baseIndex', 'baseIndexMonth', 'baseIndexLabel', 'exemptPct', 'linkedPct', 'indexRule', 'indexFloor', 'vatMode', 'vatRate'];
  function makeDraft() {
    var d = {};
    KEYS.forEach(function (k) { d[k] = state.s[k] != null && state.s[k] !== '' ? state.s[k] : (C.DEFAULT_SETTINGS[k] || ''); });
    d.stages = state.stages.length ? clone(state.stages) : clone(C.DEFAULT_STAGES).map(function (x) { x.indexExempt = 'auto'; return x; });
    var t3 = null;
    try { t3 = state.s.t3Schedule ? JSON.parse(state.s.t3Schedule) : null; } catch (e) { t3 = null; }
    d.t3 = t3 && t3.length ? t3 : clone(C.DEFAULT_T3);
    return d;
  }
  function draftList() { return String(draft.track) === '3' ? draft.t3 : draft.stages; }
  function startWizard() { draft = makeDraft(); wizardStep = 1; }

  // ---------- רכיבי טפסים ----------
  function field(key, label, opts) {
    opts = opts || {};
    var v = draft[key] == null ? '' : draft[key];
    var id = 'f-' + key;
    var req = opts.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
    var input;
    if (opts.type === 'select') {
      input = '<select id="' + id + '" data-k="' + key + '">' + opts.options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    } else {
      input = '<input id="' + id + '" data-k="' + key + '" type="' + (opts.type || 'text') + '" value="' + esc(v) + '"' +
        (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + (opts.step ? ' step="' + opts.step + '"' : '') +
        (opts.min != null ? ' min="' + opts.min + '"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
        (opts.required ? ' required aria-required="true"' : '') + (opts.money ? ' data-money="1"' : '') + '>';
    }
    var hint = opts.money ? '<div class="hint num" id="h-' + key + '">' + (v ? C.fmtMoney(C.num(v)) : '') + '</div>' :
      (opts.hint ? '<div class="hint">' + opts.hint + '</div>' : '');
    return '<div class="field' + (opts.wide ? ' wide' : '') + '"><label for="' + id + '">' + label + req + '</label>' + input + hint + '</div>';
  }
  function trackPicker() {
    return '<div class="tracks" role="radiogroup" aria-label="מסלול חוזה">' + [1, 2, 3].map(function (t) {
      var on = String(draft.track) === String(t);
      var desc = t === 1 ? 'הצמדה חלקית למדד תשומות הבנייה. ' + esc(draft.exemptPct) + '% ראשונים פטורים, ' + esc(draft.linkedPct) + '% מכל תשלום צמוד.' :
        t === 2 ? 'תוספת קבועה של ' + esc(draft.fixSurcharge) + '% למחיר, בלי מדד. אותו לוח אבני דרך.' :
          'תוספת של ' + esc(draft.t3Surcharge) + '% למחיר, בלי מדד. חלק בהתחלה והיתרה במסירה.';
      return '<button type="button" role="radio" aria-checked="' + on + '" class="track' + (on ? ' on' : '') + '" data-action="pick-track" data-track="' + t + '">' +
        '<span class="track-title">' + (on ? icon('check', 18) : '') + C.TRACKS[t].name + '</span><span class="track-desc">' + desc + '</span></button>';
    }).join('') + '</div>';
  }
  function trackParams() {
    var t = String(draft.track);
    if (t === '2') return '<div class="fields">' + field('fixSurcharge', 'תוספת קיבוע (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) + '</div>';
    if (t === '3') return '<div class="fields">' + field('t3Surcharge', 'תוספת למחיר (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) + '</div>';
    return '';
  }
  function indexFields() {
    return '<div class="fields">' +
      field('baseIndex', 'מדד בסיס', { type: 'number', step: 'any', inputmode: 'decimal', placeholder: 'לדוגמה 143.5545', hint: 'כפי שכתוב בחוזה. אפשר להשלים גם אחר כך.' }) +
      field('baseIndexMonth', 'חודש מדד הבסיס', { type: 'month', hint: '<span id="base-hint">' + baseIndexHint() + '</span>' + (state.cbs ? ' <button type="button" class="link-btn" data-action="fill-base">מלא מדד לפי הלמ״ס</button>' : '') }) +
      field('baseIndexLabel', 'בסיס המדד בחוזה (לתיעוד)', { placeholder: 'לדוגמה: יולי 2011 = 100', hint: 'לא משפיע על החישוב.' }) +
      field('exemptPct', 'חלק פטור ממדד בתחילת החוזה (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) +
      field('linkedPct', 'אחוז צמוד מכל תשלום (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) +
      field('indexRule', 'מדד קובע', { type: 'select', options: [['request', 'המדד הידוע במועד דרישת התשלום'], ['payment', 'המדד הידוע במועד התשלום בפועל']] }) +
      field('indexFloor', 'ירידת מדד', { type: 'select', options: [['true', 'לא יורד מתחת למדד הבסיס'], ['false', 'מחושב גם בירידה']] }) +
      '</div>';
  }
  function baseIndexHint() {
    if (!draft) return '';
    if (!state.cbs) return 'שירות המדד האוטומטי עדיין לא פעיל.';
    var ym = C.ymKey(draft.baseIndexMonth); if (!ym) return '';
    var v = cbsValue(ym.y, ym.m);
    if (v == null) return 'אין נתון בלמ״ס לחודש הזה.';
    var out = 'בלמ״ס: ' + v + (state.cbs.base ? ' (בסיס ' + esc(state.cbs.base) + ')' : '') + '.';
    var bi = C.num(draft.baseIndex);
    if (bi > 0) {
      var f = bi / v;
      out += Math.abs(f - 1) < 0.0005 ? ' החוזה באותו בסיס.' : ' מקדם המרה לבסיס החוזה: ' + f.toFixed(5) + '. מדדים מהלמ״ס יומרו אוטומטית.';
    }
    var lat = cbsLatest();
    if (lat) out += ' <span class="muted">· מדד אחרון במערכת: ' + C.monthName(lat.y, lat.m) + (state.cbs.updatedAt ? ', עודכן ' + fmtDateTime(state.cbs.updatedAt) : '') + '. בדיקה אוטומטית כל ערב.</span>';
    return out;
  }
  function stageEditor() {
    var t = String(draft.track);
    var list = draftList();
    var rows = list.map(function (st, i) {
      var exemptSel = t === '1' ? '<select data-se="indexExempt" data-i="' + i + '" aria-label="הצמדה בשורה ' + (i + 1) + '">' +
        [['auto', 'אוטומטי'], ['yes', 'פטור'], ['no', 'צמוד']].map(function (o) {
          return '<option value="' + o[0] + '"' + ((st.indexExempt || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select>' : '';
      return '<div class="se-row">' +
        '<span class="se-n">' + (i + 1) + '</span>' +
        '<input class="se-name" data-se="name" data-i="' + i + '" value="' + esc(st.name) + '" aria-label="שם שורה ' + (i + 1) + '" placeholder="שם התשלום">' +
        '<label class="se-pct"><input data-se="pct" data-i="' + i + '" type="number" step="any" inputmode="decimal" value="' + esc(st.pct) + '" aria-label="אחוז שורה ' + (i + 1) + '"><span>%</span></label>' +
        '<label class="se-month"><span>חודש</span><input data-se="month" data-i="' + i + '" type="number" step="1" min="0" inputmode="numeric" value="' + esc(st.month) + '" aria-label="חודש שורה ' + (i + 1) + '"></label>' +
        exemptSel +
        '<span class="se-amt num" id="se-amt-' + i + '"></span>' +
        '<span class="se-tools">' +
        '<button type="button" class="icon-btn" data-action="se-up" data-i="' + i + '" aria-label="הזז למעלה"' + (i === 0 ? ' disabled' : '') + '>' + icon('up', 18) + '</button>' +
        '<button type="button" class="icon-btn" data-action="se-down" data-i="' + i + '" aria-label="הזז למטה"' + (i === list.length - 1 ? ' disabled' : '') + '>' + icon('down', 18) + '</button>' +
        '<button type="button" class="icon-btn danger" data-action="se-del" data-i="' + i + '" aria-label="מחק שורה">' + icon('trash', 18) + '</button>' +
        '</span></div>';
    }).join('');
    return '<div class="se" id="stage-editor">' + rows + '</div>' +
      '<div class="se-foot"><button type="button" class="btn btn-secondary btn-sm" data-action="se-add">' + icon('plus', 18) + 'הוסף שורה</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="se-reset">טען ברירת מחדל</button>' +
      '<span class="se-sum" id="se-sum"></span></div>' +
      (t === '1' ? '<p class="hint">"אוטומטי" = פטור ממדד עד ' + esc(draft.exemptPct) + '% הראשונים של החוזה, וצמוד בשאר.</p>' : '');
  }
  function updateEditorSummary() {
    var list = draftList();
    var sched = C.schedule(draft, list);
    sched.forEach(function (r, i) {
      var el = $('se-amt-' + i);
      if (el) el.textContent = C.num(draft.basePrice) ? C.fmtMoney(r.base) : '';
    });
    var sum = C.sumPct(list);
    var el = $('se-sum');
    if (el) {
      var ok = Math.abs(sum - 100) < 0.001;
      el.className = 'se-sum ' + (ok ? 'ok' : 'bad');
      el.textContent = 'סה״כ ' + sum + '%' + (ok ? ' ✓' : ' — צריך 100%');
    }
    var eff = $('eff-price');
    if (eff) eff.textContent = C.num(draft.basePrice) ? C.fmtMoney(C.effectivePrice(draft)) : '—';
  }

  // ---------- אשף ----------
  var WIZ = [
    { t: 'פרטי הפרויקט', d: 'כל השדות כאן אופציונליים.' },
    { t: 'תאריכים', d: 'תאריך החתימה משמש לחישוב מועדי התשלומים.' },
    { t: 'מחיר ומסלול', d: 'בחר את המסלול שבחוזה שלך. אפשר לשנות אחר כך בהגדרות.' },
    { t: 'הצמדה למדד', d: 'רלוונטי רק למסלול אבני דרך עם הצמדה.' },
    { t: 'לוח תשלומים', d: 'נטען לוח ברירת מחדל. ערוך לפי החוזה שלך, או אשר כמו שהוא.' }
  ];
  function wizardView() {
    var n = wizardStep;
    var skipIndex = String(draft.track) !== '1';
    var steps = WIZ.map(function (w, i) {
      var cls = i + 1 === n ? 'on' : (i + 1 < n ? 'done' : '');
      if (i === 3 && skipIndex) cls += ' skip';
      return '<li class="' + cls + '"><span>' + (i + 1) + '</span><b>' + w.t + '</b></li>';
    }).join('');
    var body = '';
    if (n === 1) body = '<div class="fields">' + field('projectName', 'שם הפרויקט', { placeholder: 'לדוגמה: הדירה ברחובות' }) +
      field('contractor', 'קבלן / חברה יזמית') + field('address', 'כתובת') + field('aptNo', 'מספר דירה') + '</div>';
    if (n === 2) body = '<div class="fields">' + field('signDate', 'תאריך חתימת החוזה', { type: 'date', required: true }) +
      field('deliveryDate', 'מסירה משוערת', { type: 'date' }) + '</div>';
    if (n === 3) body = '<div class="fields">' + field('basePrice', 'מחיר הבסיס בחוזה (₪)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0, required: true, money: true }) + '</div>' +
      '<div class="label">מסלול החוזה <span class="req">*</span></div>' + trackPicker() + trackParams() +
      '<div class="kv"><span class="k">מחיר אפקטיבי</span><b class="num" id="eff-price"></b></div>';
    if (n === 4) body = indexFields();
    if (n === 5) body = stageEditor() + '<div class="kv"><span class="k">מחיר אפקטיבי</span><b class="num" id="eff-price"></b></div>';
    var last = n === 5;
    return '<section class="card wizard">' +
      '<ol class="steps">' + steps + '</ol>' +
      '<div><h2>' + WIZ[n - 1].t + '</h2><p class="muted small" style="margin:4px 0 0">' + WIZ[n - 1].d + '</p></div>' +
      body +
      '<div class="error-box" id="wiz-err" hidden></div>' +
      '<div class="wiz-nav">' +
      (n > 1 ? '<button type="button" class="btn btn-ghost" data-action="wiz-back">הקודם</button>' : '<span></span>') +
      '<button type="button" class="btn btn-primary" data-action="' + (last ? 'wiz-finish' : 'wiz-next') + '">' + (last ? 'סיום ושמירה' : 'הבא') + '</button>' +
      '</div></section>';
  }
  function wizValidate(n) {
    var errs = [];
    if (n === 2 && !draft.signDate) errs.push('יש להזין תאריך חתימה');
    if (n === 2 && draft.signDate && draft.deliveryDate && draft.deliveryDate < draft.signDate) errs.push('תאריך המסירה לפני תאריך החתימה');
    if (n === 3 && !(C.num(draft.basePrice) > 0)) errs.push('יש להזין מחיר בסיס');
    if (n === 4) {
      var ex = C.num(draft.exemptPct, -1), lk = C.num(draft.linkedPct, -1);
      if (ex < 0 || ex > 100) errs.push('החלק הפטור צריך להיות בין 0 ל-100');
      if (lk < 0 || lk > 100) errs.push('האחוז הצמוד צריך להיות בין 0 ל-100');
      if (draft.baseIndex && !(C.num(draft.baseIndex) > 0)) errs.push('מדד הבסיס לא תקין');
    }
    if (n === 5) errs = errs.concat(C.validateStages(draftList()).errors);
    return errs;
  }
  function showErrors(boxId, errs) {
    var b = $(boxId);
    if (!b) return;
    b.hidden = !errs.length;
    b.innerHTML = errs.map(esc).join('<br>');
    if (errs.length) b.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function draftSettingsPayload() {
    var o = {};
    KEYS.forEach(function (k) { o[k] = draft[k]; });
    o.t3Schedule = JSON.stringify(draft.t3.map(function (x) { return { name: x.name, pct: C.num(x.pct), month: C.num(x.month) }; }));
    return o;
  }
  function finishWizard(btn) {
    var errs = wizValidate(5).concat(wizValidate(2)).concat(wizValidate(3));
    if (errs.length) { showErrors('wiz-err', errs); return; }
    btn.disabled = true;
    var payload = draftSettingsPayload();
    payload.setupComplete = 'true';
    withSync(saveStages(draft.stages).then(function () { return saveSettings(payload); }), 'ההגדרות נשמרו')
      .then(function () {
        logActivity('setup', 'Settings', 'track=' + draft.track);
        draft = null;
        location.hash = '#/dashboard';
        rerender();
      })
      .catch(handleError)
      .then(function () { btn.disabled = false; });
  }

  // ---------- הגדרות ----------
  function settingsView() {
    var t = String(draft.track);
    var cloud = '<section class="card" id="sec-cloud"><h2>ענן וחשבון</h2>' +
      kv('חשבון', esc(state.user && state.user.email)) +
      kv('תיקייה ב-Drive', '<a href="' + esc(state.rootLink) + '" target="_blank" rel="noopener">' + esc(ROOT_NAME) + '</a>') +
      kv('קובץ נתונים', '<a href="' + esc(state.sheetLink) + '" target="_blank" rel="noopener">' + esc(DATA_NAME) + '</a>') +
      kv('בדיקת שמירה אחרונה', '<span class="num" id="last-test">' + fmtDateTime(state.s.lastTest) + '</span>') +
      '<div class="row"><button type="button" class="btn btn-secondary btn-sm" data-action="test-save">בדיקת שמירה</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-action="logout">התנתקות</button>' +
      '<button type="button" class="btn btn-ghost btn-sm danger-text" data-action="revoke">ביטול הרשאות</button></div>' +
      '<p class="hint">התנתקות יוצאת מהאפליקציה בלבד. ביטול הרשאות מנתק את האפליקציה מחשבון Google שלך. הנתונים ב-Drive נשארים בשני המקרים.</p></section>';
    return (isSetup() ? '' : '<div class="banner"><span>ההגדרה הראשונית לא הושלמה.</span><a class="btn btn-sm btn-primary" href="#/setup">לאשף ההגדרה</a></div>') +
      '<section class="card" id="sec-project"><h2>פרטי פרויקט</h2><div class="fields">' +
      field('projectName', 'שם הפרויקט') + field('contractor', 'קבלן / חברה יזמית') + field('address', 'כתובת') + field('aptNo', 'מספר דירה') +
      field('signDate', 'תאריך חתימת החוזה', { type: 'date', required: true }) + field('deliveryDate', 'מסירה משוערת', { type: 'date' }) +
      '</div><div class="error-box" id="err-project" hidden></div>' +
      '<div class="row end"><button type="button" class="btn btn-primary" data-action="save-project">שמירה</button></div></section>' +

      '<section class="card" id="sec-contract"><h2>מחיר ומסלול</h2><div class="fields">' +
      field('basePrice', 'מחיר הבסיס בחוזה (₪)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0, required: true, money: true }) + '</div>' +
      trackPicker() + trackParams() +
      '<div class="kv"><span class="k">מחיר אפקטיבי</span><b class="num" id="eff-price"></b></div>' +
      (t === '1' ? '<h3 class="sub">הצמדה למדד</h3>' + indexFields() : '') +
      '<div class="error-box" id="err-contract" hidden></div>' +
      '<div class="row end"><button type="button" class="btn btn-primary" data-action="save-contract">שמירה</button></div></section>' +

      '<section class="card" id="sec-display"><h2>תצוגת סכומים</h2><p class="hint">כל הסכומים מוזנים ונשמרים כולל מע״מ. כאן בוחרים רק איך להציג אותם.</p><div class="fields">' +
      field('vatMode', 'הצגת סכומים', { type: 'select', options: [['incl', 'כולל מע״מ'], ['excl', 'ללא מע״מ']] }) +
      field('vatRate', 'שיעור מע״מ (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) +
      '</div><div class="row end"><button type="button" class="btn btn-primary" data-action="save-display">שמירה</button></div></section>' +
      '<section class="card" id="sec-stages"><h2>לוח תשלומים' + (t === '3' ? ' — מסלול מוקדם / במסירה' : '') + '</h2>' +
      stageEditor() +
      '<div class="error-box" id="err-stages" hidden></div>' +
      '<div class="row end"><button type="button" class="btn btn-primary" data-action="save-stages">שמירת הלוח</button></div></section>' +
      cloud;
  }
  function saveProject(btn) {
    var errs = [];
    if (!draft.signDate) errs.push('יש להזין תאריך חתימה');
    if (draft.signDate && draft.deliveryDate && draft.deliveryDate < draft.signDate) errs.push('תאריך המסירה לפני תאריך החתימה');
    showErrors('err-project', errs);
    if (errs.length) return;
    btn.disabled = true;
    var o = {};
    ['projectName', 'contractor', 'address', 'aptNo', 'signDate', 'deliveryDate'].forEach(function (k) { o[k] = draft[k]; });
    withSync(saveSettings(o), 'פרטי הפרויקט נשמרו').then(function () { logActivity('update', 'Settings', 'project'); $('view-sub').textContent = state.s.projectName || ''; })
      .catch(handleError).then(function () { btn.disabled = false; });
  }
  function saveContract(btn) {
    var errs = [];
    if (!(C.num(draft.basePrice) > 0)) errs.push('יש להזין מחיר בסיס');
    if (String(draft.track) === '1') errs = errs.concat(wizValidate(4));
    showErrors('err-contract', errs);
    if (errs.length) return;
    var changed = state.s.track && String(state.s.track) !== String(draft.track);
    if (changed && !confirm('לשנות את מסלול החוזה ל"' + C.TRACKS[draft.track].name + '"?\nהסכומים בלוח התשלומים יחושבו מחדש.')) return;
    btn.disabled = true;
    var o = {};
    ['basePrice', 'track', 'fixSurcharge', 't3Surcharge', 'baseIndex', 'baseIndexMonth', 'baseIndexLabel', 'exemptPct', 'linkedPct', 'indexRule', 'indexFloor'].forEach(function (k) { o[k] = draft[k]; });
    withSync(saveSettings(o), 'החוזה נשמר').then(function () { logActivity('update', 'Settings', 'contract track=' + draft.track); return recalcRequests(); })
      .catch(handleError).then(function () { btn.disabled = false; });
  }
  // אחרי שינוי בחוזה/בלוח: חישוב מחדש של דרישות קיימות (תשלומים בפועל לא משתנים)
  function recalcRequests() {
    if (!state.requests.length) return Promise.resolve();
    var changes = [];
    state.requests.forEach(function (q) {
      var row = findStage(q.stageId); if (!row) return;
      var idx = q.indexValue, src = q.indexSource;
      if (src === 'cbs') { var k = knownIndexAt(q.receivedDate); if (k && k.v != null) idx = String(k.v); }
      var c = C.requestCalc(state.s, row, q.baseAmount, idx);
      if (String(idx) !== String(q.indexValue) || Math.abs(c.adj - C.num(q.indexAdj)) >= 0.01 || Math.abs(c.final - C.num(q.finalAmount)) >= 0.01) {
        var n = clone(q); n._row = q._row; n.indexValue = idx; n.indexAdj = c.adj; n.finalAmount = c.final; n.updatedAt = nowIso();
        changes.push({ q: q, n: n });
      }
    });
    if (!changes.length) return Promise.resolve();
    var diff = changes.reduce(function (a, x) { return a + (x.n.finalAmount - C.num(x.q.finalAmount)); }, 0);
    if (!confirm('השינוי משפיע על ' + changes.length + ' דרישות תשלום קיימות (הפרש כולל ' + C.fmtMoney(diff) + ').\nלעדכן אותן לפי ההגדרות החדשות?\nתשלומים שכבר בוצעו לא ישתנו.')) return Promise.resolve();
    var data = changes.map(function (x) {
      return { range: "'PaymentRequests'!A" + x.n._row, values: [SHEETS_SCHEMA.PaymentRequests.map(function (h) { return x.n[h] == null ? '' : String(x.n[h]); })] };
    });
    return withSync(api(SHEETS + '/' + state.sheetId + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: data } }).then(loadRequests), changes.length + ' דרישות עודכנו')
      .then(function () { logActivity('recalc', 'PaymentRequests', changes.length + ' rows'); });
  }
  function saveStagesAction(btn) {
    var errs = C.validateStages(draftList()).errors;
    showErrors('err-stages', errs);
    if (errs.length) return;
    btn.disabled = true;
    var p = String(draft.track) === '3' ? saveSettings({ t3Schedule: draftSettingsPayload().t3Schedule }) : saveStages(draft.stages);
    withSync(p, 'לוח התשלומים נשמר').then(function () { logActivity('update', 'ContractorStages', ''); return recalcRequests(); })
      .catch(handleError).then(function () { btn.disabled = false; });
  }

  // ---------- נתונים מחושבים ----------
  function currentSchedule() {
    var s = state.s;
    var list, t3 = String(s.track) === '3';
    if (t3) {
      try { list = JSON.parse(s.t3Schedule || '[]'); } catch (e) { list = []; }
      if (!list.length) list = C.DEFAULT_T3;
    } else list = state.stages;
    var rows = C.schedule(s, list);
    rows.forEach(function (r, i) { r.stageId = t3 ? 't3-' + i : (list[i].id || 'st-' + i); });
    return rows;
  }
  function todayIso() { return C.isoDate(new Date()); }
  function reqsOf(stageId) { return state.requests.filter(function (r) { return r.stageId === stageId; }); }
  function paysOf(stageId) { return state.payments.filter(function (p) { return p.type === 'contractor' && p.stageId === stageId; }); }
  // לוח + מצב לכל אבן דרך
  function scenarioList() { return state.scenarios.length ? state.scenarios : C.DEFAULT_SCENARIOS; }
  // תשלומים עתידיים מוערכים לפי המדד האחרון שפורסם (ללא תחזית אינפלציה)
  var CURRENT_INDEX = { id: 'current', name: 'המדד האחרון שפורסם', y1: 0, y2: 0, y3: 0 };
  function activeScenario() { return CURRENT_INDEX; }
  function estBasisLabel() {
    var lat = cbsLatest();
    return lat && contractFactor() ? 'לפי המדד האחרון שפורסם (' + C.monthName(lat.y, lat.m) + ')' : 'לפי מדד הבסיס (ללא שינוי)';
  }
  // מדד משוער (בבסיס החוזה) לתאריך: אמיתי אם פורסם, אחרת תחזית לפי תרחיש
  function estIndexAt(dateIso, sc, s) {
    s = s || state.s;
    var km = C.knownMonthFor(dateIso); if (!km) return null;
    var f = contractFactor(s);
    if (state.cbs && f) {
      var raw = cbsValue(km.y, km.m);
      if (raw != null) return { v: raw * f, actual: true };
      var lat = cbsLatest();
      if ((lat.y * 100 + lat.m) > (km.y * 100 + km.m)) return null;
      return { v: C.forecastIndex(lat.v * f, lat.y, lat.m, km.y, km.m, sc, s.signDate), actual: false };
    }
    var bi = C.num(s.baseIndex), ym = C.ymKey(s.baseIndexMonth) || C.knownMonthFor(s.signDate);
    if (!(bi > 0) || !ym) return null;
    if ((ym.y * 100 + ym.m) >= (km.y * 100 + km.m)) return { v: bi, actual: false };
    return { v: C.forecastIndex(bi, ym.y, ym.m, km.y, km.m, sc, s.signDate), actual: false };
  }
  // הצמדה משוערת לחלק של אבן הדרך שעוד אין לו מדד בפועל
  function estAdjFor(row, sc, s, reqs) {
    s = s || state.s;
    if (String(s.track) !== '1' || !(row.linkedBase > 0) || !row.date) return 0;
    var covered = (reqs || []).filter(function (q) { return q.indexValue !== ''; }).reduce(function (a, q) { return a + C.num(q.baseAmount); }, 0);
    var remain = Math.max(0, row.base - covered);
    if (remain <= 0.5) return 0;
    var bi = C.num(s.baseIndex); if (!(bi > 0)) return 0;
    var e = estIndexAt(row.date, sc, s); if (!e || !e.v) return 0;
    var rate = e.v / bi - 1;
    if (String(s.indexFloor) !== 'false' && rate < 0) rate = 0;
    return C.round2(row.linkedBase * (remain / row.base) * rate);
  }
  function ledger() {
    var today = todayIso(), sc = activeScenario();
    return currentSchedule().map(function (r) {
      var reqs = reqsOf(r.stageId);
      r.st = C.stageStatus(r, reqs, paysOf(r.stageId), today);
      r.est = r.st.status === 'paid' ? 0 : estAdjFor(r, sc, state.s, reqs);
      r.st.forecast = C.round2(r.st.expected + r.est);
      return r;
    });
  }
  // סך ההצמדה הצפויה במסלול 1 לפי תרחיש (להשוואת מסלולים) — מתעלם מהמסלול הנוכחי
  function track1AdjTotal(sc) {
    var s1 = clone(state.s); s1.track = '1';
    var list = state.stages.length ? state.stages : C.DEFAULT_STAGES;
    var actual = String(state.s.track) === '1';
    return C.schedule(s1, list).reduce(function (a, r, i) {
      var sid = list[i].id;
      var reqs = actual && sid ? reqsOf(sid) : [];
      var act = reqs.reduce(function (x, q) { return x + C.num(q.indexAdj); }, 0);
      return a + act + estAdjFor(r, sc, s1, reqs);
    }, 0);
  }
  function findStage(id) { return ledger().filter(function (r) { return r.stageId === id; })[0]; }

  // ---------- מע״מ ----------
  function vatExcl() { return state.s.vatMode === 'excl'; }
  function vatRate() { return C.num(state.s.vatRate, 18) / 100; }
  function M(n) { return C.fmtMoney(vatExcl() ? n / (1 + vatRate()) : n); }

  // ---------- מסכים ----------
  function placeholder(r) {
    return '<section class="card"><div class="empty">' + icon(r.icon, 28) +
      '<b>' + esc(r.title) + '</b><span>המסך הזה ייבנה בשלבים הבאים.</span></div></section>';
  }
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }
  function indexBadge(r) {
    if (r.indexMode === 'none') return '<span class="badge muted-b">ללא מדד</span>';
    if (r.indexMode === 'exempt') return '<span class="badge muted-b">פטור ממדד</span>';
    if (r.indexMode === 'partial') return '<span class="badge muted-b">צמוד חלקית · ' + M(r.linkedBase) + '</span>';
    return '<span class="badge muted-b">צמוד · ' + M(r.linkedBase) + '</span>';
  }
  function statusBadge(st) {
    if (st.overdue && st.status !== 'partial') return '<span class="badge warn">באיחור</span>';
    var cls = { planned: 'muted-b', requested: 'info', partial: 'warn', paid: 'ok' }[st.status];
    return '<span class="badge ' + cls + '">' + C.STATUS_LABEL[st.status] + (st.overdue && st.status === 'partial' ? ' · באיחור' : '') + '</span>';
  }
  function statusClass(st) { return st.status === 'paid' ? 's-paid' : (st.status === 'partial' || st.overdue ? 's-warn' : (st.status === 'requested' ? 's-req' : '')); }
  function needSetupCard() {
    return '<section class="card"><div class="empty">' + icon('settings', 28) + '<b>עוד לא הוגדר חוזה</b>' +
      '<span>כמה צעדים קצרים: מחיר, מסלול ולוח תשלומים.</span>' +
      '<a class="btn btn-primary" href="#/setup">להגדרת הפרויקט</a></div></section>';
  }
  function vatNote() { return vatExcl() ? '<span class="badge muted-b">הסכומים מוצגים ללא מע״מ</span>' : ''; }
  function stat(label, value) { return '<div class="stat"><span class="muted small">' + label + '</span><b>' + value + '</b></div>'; }
  var METHODS = [['transfer', 'העברה בנקאית'], ['check', 'צ׳ק'], ['card', 'כרטיס אשראי'], ['cash', 'מזומן'], ['other', 'אחר']];
  function methodLabel(m) { var f = METHODS.filter(function (x) { return x[0] === m; })[0]; return f ? f[1] : (m || ''); }
  function stageName(id) { var r = currentSchedule().filter(function (x) { return x.stageId === id; })[0]; return r ? r.name : '(אבן דרך שנמחקה)'; }

  var VIEWS = {
    setup: function () { return wizardView(); },
    settings: function () { return settingsView(); },

    contractor: function () {
      if (!isSetup()) return needSetupCard();
      var s = state.s;
      var rows = ledger();
      var eff = C.effectivePrice(s);
      var head = '<section class="card"><div class="stats">' +
        stat('מחיר אפקטיבי', M(eff)) +
        stat('מסלול', esc(C.TRACKS[s.track] ? C.TRACKS[s.track].name : '—')) +
        (String(s.track) === '1' ? stat('מדד בסיס', s.baseIndex ? '<span class="num">' + esc(s.baseIndex) + '</span>' + (s.baseIndexMonth ? ' <span class="muted small">(' + esc(s.baseIndexMonth.split('-').reverse().join('/')) + ')</span>' : '') : '<a href="#/settings">להזנה</a>') : stat('תוספת', M(eff - C.num(s.basePrice)))) +
        stat('שולם', M(rows.reduce(function (a, r) { return a + r.st.paid; }, 0))) +
        '</div>' + vatNote() + '</section>';
      var list = rows.map(function (r, i) {
        return '<li><a class="stage ' + statusClass(r.st) + '" href="#/stage/' + encodeURIComponent(r.stageId) + '">' +
          '<div class="stage-main"><span class="stage-n">' + (i + 1) + '</span><div><b>' + esc(r.name) + '</b>' +
          '<div class="muted small">' + C.fmtPct(r.pct) + ' · ' + (r.date ? C.fmtDate(r.date) : 'חודש ' + r.month) + '</div>' +
          '<div class="badges">' + statusBadge(r.st) + indexBadge(r) + '</div></div></div>' +
          '<div class="stage-side"><b class="num">' + M(r.base) + '</b>' +
          (r.st.adj ? '<span class="muted small">הצמדה בפועל ' + M(r.st.adj) + '</span>' : '') +
          (r.est ? '<span class="muted small">הצמדה נכון להיום ' + M(r.est) + '</span>' : '') +
          (r.st.paid > 0 && r.st.forecast - r.st.paid > 0.5 ? '<span class="muted small">יתרה ' + M(r.st.forecast - r.st.paid) + '</span>' : '') +
          '</div></a></li>';
      }).join('');
      return head + '<section class="card"><div class="row between"><h2>לוח התשלומים</h2><a class="btn btn-ghost btn-sm" href="#/settings">עריכת הלוח</a></div>' +
        '<ul class="stages">' + list + '</ul>' +
        '<p class="hint">לחיצה על אבן דרך פותחת את הדרישות והתשלומים שלה.</p></section>';
    },

    stage: function (r, param) {
      if (!isSetup()) return needSetupCard();
      var row = findStage(param);
      if (!row) return '<section class="card"><div class="empty"><b>אבן הדרך לא נמצאה</b><a class="btn btn-secondary" href="#/contractor">חזרה ללוח</a></div></section>';
      var st = row.st;
      var reqs = reqsOf(row.stageId), pays = paysOf(row.stageId);
      var t1 = String(state.s.track) === '1';
      var reqList = reqs.length ? reqs.map(function (q) {
        var diff = q.contractorAmount !== '' && Math.abs(C.num(q.contractorAmount) - C.num(q.finalAmount)) >= 1;
        return '<li class="item"><div><b>דרישה' + (q.number ? ' ' + esc(q.number) : '') + '</b> · <span class="muted small">' + C.fmtDate(q.receivedDate) + '</span>' +
          (t1 && q.indexValue ? '<div class="muted small">מדד ' + esc(q.indexValue) + (q.indexMonth ? ' (' + esc(q.indexMonth.split('-').reverse().join('/')) + ')' : '') + (q.indexSource === 'manual' ? ' · ידני' : (q.indexSource === 'cbs' ? ' · למ״ס' : '')) + ' · הצמדה ' + M(C.num(q.indexAdj)) + '</div>' : '') +
          (t1 && !q.indexValue && C.num(q.baseAmount) && row.linkedBase ? '<div class="muted small">טרם הוזן מדד</div>' : '') +
          (diff ? '<div class="warn-text small">בדרישת הקבלן: ' + M(C.num(q.contractorAmount)) + ' · הפרש ' + M(C.num(q.contractorAmount) - C.num(q.finalAmount)) + '</div>' : '') +
          '</div><div class="item-side"><b class="num">' + M(C.num(q.finalAmount)) + '</b><span class="tools">' +
          '<button type="button" class="icon-btn" data-action="edit-req" data-id="' + esc(q.id) + '" aria-label="עריכת דרישה">' + icon('edit', 18) + '</button>' +
          '<button type="button" class="icon-btn danger" data-action="del-req" data-id="' + esc(q.id) + '" aria-label="מחיקת דרישה">' + icon('trash', 18) + '</button></span></div></li>';
      }).join('') : '<li class="muted small">עדיין לא הוזנה דרישה.</li>';
      var payList = pays.length ? pays.map(function (p) {
        return '<li class="item"><div><b>' + C.fmtDate(p.date) + '</b> · <span class="muted small">' + esc(methodLabel(p.method)) + (p.fundingSource ? ' · ' + esc(p.fundingSource) : '') + '</span>' +
          (p.reference ? '<div class="muted small">אסמכתא ' + esc(p.reference) + '</div>' : '') + '</div>' +
          '<div class="item-side"><b class="num">' + M(C.num(p.amount)) + '</b><span class="tools">' +
          '<button type="button" class="icon-btn" data-action="edit-pay" data-id="' + esc(p.id) + '" aria-label="עריכת תשלום">' + icon('edit', 18) + '</button>' +
          '<button type="button" class="icon-btn danger" data-action="del-pay" data-id="' + esc(p.id) + '" aria-label="מחיקת תשלום">' + icon('trash', 18) + '</button></span></div></li>';
      }).join('') : '<li class="muted small">עדיין לא נרשם תשלום.</li>';
      $('view-title').textContent = row.name;
      return '<a class="back" href="#/contractor">' + icon('right', 18) + 'לוח התשלומים</a>' +
        '<section class="card"><div class="row between"><div class="muted small">' + C.fmtPct(row.pct) + ' מהחוזה · ' + (row.date ? 'צפוי ב-' + C.fmtDate(row.date) : '') + '</div>' + statusBadge(st) + '</div>' +
        '<div class="stats">' + stat('סכום בסיס', M(row.base)) +
        (t1 ? stat('חלק צמוד', row.linkedBase ? M(row.linkedBase) : 'פטור') : '') +
        (t1 && row.linkedBase ? stat('הצמדה', M(st.adj) + (row.est ? '<span class="muted small"> + ' + M(row.est) + ' נכון להיום</span>' : '')) : '') +
        stat('סכום צפוי', M(st.forecast)) + stat('שולם', M(st.paid)) + stat('יתרה', M(Math.max(0, st.forecast - st.paid))) + '</div>' +
        (row.est ? '<p class="hint">הצמדה נכון להיום — ' + estBasisLabel() + '. תוחלף בהצמדה בפועל כשתוזן דרישה עם מדד.</p>' : '') + vatNote() +
        '<div class="row"><button type="button" class="btn btn-secondary" data-action="new-req" data-stage="' + esc(row.stageId) + '">דרישת תשלום</button>' +
        '<button type="button" class="btn btn-primary" data-action="new-pay" data-stage="' + esc(row.stageId) + '">רישום תשלום</button></div></section>' +
        '<section class="card"><h2>דרישות תשלום</h2><ul class="items">' + reqList + '</ul></section>' +
        '<section class="card"><h2>תשלומים</h2><ul class="items">' + payList + '</ul></section>';
    },

    calculator: function () {
      if (!isSetup()) return needSetupCard();
      var cf = calcForm;
      var calc = '<section class="card"><h2>מחשבון הצמדה</h2><p class="hint">חישוב עצמאי — לא משנה נתונים במערכת. מדד היעד ממולא מהלמ״ס ומומר לבסיס החוזה; אפשר גם להזין ידנית.</p><div class="fields">' +
        '<div class="field wide"><label for="cf-stage">אבן דרך (אופציונלי)</label><select id="cf-stage" data-cf="stage"><option value="">ללא — סכום חופשי</option>' +
        ledger().map(function (r, i) { return '<option value="' + esc(r.stageId) + '"' + (cf.stage === r.stageId ? ' selected' : '') + '>' + (i + 1) + '. ' + esc(r.name) + ' · ' + C.fmtMoney(r.base) + '</option>'; }).join('') + '</select></div>' +
        cfield('amount', 'סכום (₪)', 'number') + cfield('baseIdx', 'מדד בסיס', 'number') +
        cfield('targetDate', 'תאריך קובע', 'date') + cfield('targetMonth', 'חודש מדד יעד', 'month') + cfield('targetIdx', 'מדד יעד', 'number') +
        cfield('linked', 'חלק צמוד (%)', 'number') +
        '<div class="field"><label for="cf-floor">ירידת מדד</label><select id="cf-floor" data-cf="floor"><option value="true"' + (cf.floor ? ' selected' : '') + '>לא מתחת לבסיס</option><option value="false"' + (!cf.floor ? ' selected' : '') + '>מחושב גם בירידה</option></select></div>' +
        '</div><div class="calc-box" id="calc-out"></div></section>';
      return calc;
    },
    expenses: function () { if (!isSetup()) return needSetupCard(); return expensesView(); },
    category: function (r, param) { if (!isSetup()) return needSetupCard(); return categoryView(param); },
    more: function () {
      return '<section class="card"><ul class="more-list">' + ROUTES.filter(function (r) { return !r.mobile; }).map(function (r) {
        return '<li><a href="#/' + r.id + '">' + icon(r.icon) + '<span>' + r.title + '</span>' + icon('right', 16) + '</a></li>';
      }).join('') + '</ul></section>' +
        '<section class="card"><div class="muted small">' + esc(state.user && state.user.email) + '</div><div class="row"><button type="button" class="btn btn-secondary btn-sm" data-action="logout">התנתקות</button></div></section>';
    },
    payments: function () {
      if (!isSetup()) return needSetupCard();
      var rows = ledger();
      var pays = state.payments.filter(function (p) { return p.type === 'contractor'; }).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      var total = pays.reduce(function (a, p) { return a + C.num(p.amount); }, 0);
      var epays = state.payments.filter(function (p) { return p.type === 'expense'; }).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      var etotal = epays.reduce(function (a, p) { return a + C.num(p.amount); }, 0);
      var elist = epays.length ? epays.map(function (p) {
        var e = expById(p.expenseId), c = e ? catById(e.categoryId) : null;
        return '<li><a class="item link" href="' + (c ? '#/category/' + encodeURIComponent(c.id) : '#/expenses') + '"><div><b>' + esc(e ? e.name : '(נמחק)') + '</b>' +
          '<div class="muted small">' + (c ? esc(c.name) + ' · ' : '') + C.fmtDate(p.date) + ' · ' + esc(methodLabel(p.method)) + '</div></div>' +
          '<div class="item-side"><b class="num">' + M(C.num(p.amount)) + '</b></div></a></li>';
      }).join('') : '<li class="muted small">עדיין לא נרשמו תשלומים להוצאות.</li>';
      var open = rows.filter(function (r) { return (r.st.status === 'requested' || r.st.status === 'partial'); });
      var openList = open.length ? open.map(function (r) {
        return '<li><a class="item link" href="#/stage/' + encodeURIComponent(r.stageId) + '"><div><b>' + esc(r.name) + '</b><div class="badges">' + statusBadge(r.st) + '</div></div>' +
          '<div class="item-side"><span class="muted small">לתשלום</span><b class="num">' + M(r.st.remaining) + '</b></div></a></li>';
      }).join('') : '<li class="muted small">אין דרישות פתוחות.</li>';
      var list = pays.length ? pays.map(function (p) {
        return '<li><a class="item link" href="#/stage/' + encodeURIComponent(p.stageId) + '"><div><b>' + esc(stageName(p.stageId)) + '</b>' +
          '<div class="muted small">' + C.fmtDate(p.date) + ' · ' + esc(methodLabel(p.method)) + (p.fundingSource ? ' · ' + esc(p.fundingSource) : '') + '</div></div>' +
          '<div class="item-side"><b class="num">' + M(C.num(p.amount)) + '</b></div></a></li>';
      }).join('') : '<li class="muted small">עדיין לא נרשמו תשלומים.</li>';
      return '<section class="card"><div class="stats">' + stat('שולם לקבלן', M(total)) + stat('שולם להוצאות', M(etotal)) + stat('סה״כ שולם', M(total + etotal)) + stat('דרישות פתוחות', open.length) + '</div>' + vatNote() +
        '<div class="row"><button type="button" class="btn btn-secondary" data-action="new-req">דרישת תשלום</button>' +
        '<button type="button" class="btn btn-primary" data-action="new-pay">רישום תשלום</button></div></section>' +
        '<section class="card"><h2>דרישות פתוחות</h2><ul class="items">' + openList + '</ul></section>' +
        '<section class="card"><h2>תשלומים לקבלן</h2><ul class="items">' + list + '</ul></section>' +
        '<section class="card"><h2>תשלומים להוצאות נוספות</h2><ul class="items">' + elist + '</ul></section>';
    },

    dashboard: function () {
      if (!isSetup()) return needSetupCard();
      var s = state.s;
      var rows = ledger();
      var commitment = rows.reduce(function (a, r) { return a + r.st.forecast; }, 0);
      var estTotal = rows.reduce(function (a, r) { return a + r.est; }, 0);
      var paid = rows.reduce(function (a, r) { return a + r.st.paid; }, 0);
      var adj = rows.reduce(function (a, r) { return a + r.st.adj; }, 0);
      var eff = C.effectivePrice(s);
      var next = rows.filter(function (r) { return r.st.status !== 'paid'; })[0];
      var overdue = rows.filter(function (r) { return r.st.overdue; });
      var openReqs = rows.filter(function (r) { return r.st.status === 'requested' || r.st.status === 'partial'; });
      var sign = C.parseDate(s.signDate);
      var deliv = C.parseDate(s.deliveryDate) || (rows.length && rows[rows.length - 1].date ? C.parseDate(rows[rows.length - 1].date) : null);
      var timeline = '';
      if (sign && deliv && deliv > sign) {
        var now = new Date();
        var pct = Math.max(0, Math.min(100, (now - sign) / (deliv - sign) * 100));
        var monthsTotal = Math.round((deliv - sign) / (30.44 * 864e5));
        var monthsDone = Math.max(0, Math.round((now - sign) / (30.44 * 864e5)));
        timeline = '<section class="card"><h2>ציר זמן</h2>' +
          '<div class="row between small muted"><span>חתימה ' + C.fmtDate(sign) + '</span><span>מסירה ' + C.fmtDate(deliv) + '</span></div>' +
          '<div class="bar"><div style="width:' + pct.toFixed(1) + '%;background:var(--accent)"></div></div>' +
          '<div class="muted small">חלפו ' + Math.min(monthsDone, monthsTotal) + ' חודשים מתוך ' + monthsTotal + ' · ' + Math.round(pct) + '% מהזמן</div></section>';
      }
      var paidPct = commitment > 0 ? Math.min(100, paid / commitment * 100) : 0;
      var t1 = String(s.track) === '1';
      var hero = '<section class="card hero"><div class="row between"><span class="muted">התחייבות לקבלן</span><span class="badge info">' + esc(C.TRACKS[s.track].short) + '</span></div>' +
        '<div class="hero-num num">' + M(commitment) + '</div>' +
        '<div class="bar" role="img" aria-label="שולם ' + Math.round(paidPct) + ' אחוז"><div style="width:' + paidPct.toFixed(1) + '%"></div></div>' +
        '<div class="muted small">' + Math.round(paidPct) + '% שולם</div>' +
        '<div class="stats">' + stat('שולם בפועל', M(paid)) + stat('יתרה לתשלום', M(commitment - paid)) +
        (t1 ? stat('הצמדה בפועל', M(adj)) + stat('הצמדה נכון להיום', M(estTotal)) : stat('תוספת חוזית', M(eff - C.num(s.basePrice)))) + '</div>' +
        (t1 ? '<p class="hint">"הצמדה נכון להיום" — לתשלומים שעוד לא התקבלה עליהם דרישה, ' + estBasisLabel() + '.</p>' : '') + vatNote() + '</section>';
      var nextCard = next ? '<section class="card"><div class="row between"><h2>התשלום הבא</h2>' + statusBadge(next.st) + '</div>' +
        '<div><b style="font-size:18px">' + esc(next.name) + '</b><div class="muted small">' + (next.date ? 'צפוי ב-' + C.fmtDate(next.date) + ' · ' : '') + 'חודש ' + next.month + ' לפרויקט</div></div>' +
        kv('סכום בסיס', '<b class="num">' + M(next.base) + '</b>') +
        (next.st.adj ? kv('הצמדה לפי דרישה', '<b class="num">' + M(next.st.adj) + '</b>') : (next.est ? kv('הצמדה נכון להיום', '<b class="num">' + M(next.est) + '</b>') : kv('הצמדה', indexBadge(next)))) +
        kv('נותר לתשלום', '<b class="num">' + M(next.st.forecast - next.st.paid) + '</b>') +
        '<div class="row"><a class="btn btn-secondary btn-sm" href="#/stage/' + encodeURIComponent(next.stageId) + '">לפרטים</a></div></section>' :
        '<section class="card"><div class="empty">' + icon('check', 28) + '<b>כל התשלומים לקבלן שולמו</b></div></section>';
      var alerts = [];
      overdue.forEach(function (r) { alerts.push('<li><a href="#/stage/' + encodeURIComponent(r.stageId) + '"><span class="badge warn">באיחור</span> ' + esc(r.name) + ' · צפוי היה ב-' + C.fmtDate(r.date) + '</a></li>'); });
      openReqs.filter(function (r) { return !r.st.overdue; }).forEach(function (r) { alerts.push('<li><a href="#/stage/' + encodeURIComponent(r.stageId) + '"><span class="badge info">דרישה פתוחה</span> ' + esc(r.name) + ' · ' + M(r.st.remaining) + '</a></li>'); });
      state.categories.forEach(function (c) { var a = catAgg(c); if (a.over) alerts.push('<li><a href="#/category/' + encodeURIComponent(c.id) + '"><span class="badge warn">חריגה</span> ' + esc(c.name) + ' · ' + M(a.value - a.budget) + ' מעל התקציב</a></li>'); });
      if (t1 && !s.baseIndex) alerts.push('<li><a href="#/settings"><span class="badge warn">חסר</span> מדד הבסיס לא הוזן</a></li>');
      else if (t1 && state.cbs && !contractFactor()) alerts.push('<li><a href="#/settings"><span class="badge warn">חסר</span> חודש מדד הבסיס — נדרש להמרת מדדי הלמ״ס לבסיס החוזה</a></li>');
      var indexCard = '';
      if (t1) {
        var lat = cbsLatest();
        if (lat) {
          var nx = C.nextPublication(lat);
          var bi = C.num(s.baseIndex);
          var latC = toContract(lat.v);
          var ch = bi > 0 && latC ? (latC / bi - 1) * 100 : null;
          var fresh = (function () { var k = C.knownMonthFor(todayIso()); return k && (lat.y * 100 + lat.m) >= (k.y * 100 + k.m); })();
          indexCard = '<section class="card"><div class="row between"><h2>מדד תשומות הבנייה</h2>' + (fresh ? '<span class="badge ok">עדכני</span>' : '<span class="badge warn">ממתין לפרסום</span>') + '</div>' +
            '<div class="stats">' + stat('מדד ' + C.monthName(lat.y, lat.m), latC ? '<span class="num">' + latC.toFixed(2) + '</span> <span class="muted small">(' + lat.v + ' בלמ״ס)</span>' : '<span class="num">' + lat.v + '</span>') +
            stat('מדד בסיס', bi ? '<span class="num">' + esc(s.baseIndex) + '</span>' : '<a href="#/settings">להזנה</a>') +
            stat('שינוי מהבסיס', ch == null ? (bi ? '<a href="#/settings">חסר חודש הבסיס</a>' : '—') : '<span class="num">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%</span>') + '</div>' +
            '<p class="hint">' + (nx ? 'המדד הבא (' + C.monthName(nx.m === 1 ? nx.y - 1 : nx.y, nx.m === 1 ? 12 : nx.m - 1) + ') צפוי בסביבות 15/' + ('0' + nx.m).slice(-2) + '/' + nx.y + '. ' : '') + 'מקור: הלמ״ס' + (state.cbs.base ? ' · בסיס ' + esc(state.cbs.base) : '') + '.</p></section>';
        } else {
          indexCard = '<section class="card"><h2>מדד תשומות הבנייה</h2><p class="hint">שירות המדד האוטומטי עדיין לא הופעל. בינתיים אפשר להזין את המדד ידנית בכל דרישת תשלום.</p></section>';
        }
      }
      var alertCard = alerts.length ? '<section class="card"><h2>התראות</h2><ul class="alerts">' + alerts.join('') + '</ul></section>' : '';
      var et = expTotals();
      var ePct = et.value > 0 ? Math.min(100, et.paid / et.value * 100) : 0;
      var expHero = '<section class="card hero"><div class="row between"><span class="muted">התחייבות להוצאות נוספות</span><a class="btn btn-ghost btn-sm" href="#/expenses">להוצאות</a></div>' +
        '<div class="hero-num num">' + M(et.value) + '</div>' +
        '<div class="bar" role="img" aria-label="שולם ' + Math.round(ePct) + ' אחוז"><div style="width:' + ePct.toFixed(1) + '%"></div></div>' +
        '<div class="muted small">' + Math.round(ePct) + '% שולם</div>' +
        '<div class="stats">' + stat('שולם בפועל', M(et.paid)) + stat('יתרה לתשלום', M(et.value - et.paid)) +
        stat(et.value > et.budget && et.budget > 0 ? 'חריגה מהתקציב' : 'יתרת תקציב', et.budget ? '<span class="' + (et.value > et.budget ? 'warn-text' : '') + '">' + M(Math.abs(et.budget - et.value)) + '</span>' : '<a href="#/expenses">להגדרה</a>') + '</div>' +
        '<p class="hint">תקציב ' + (et.budget ? M(et.budget) : 'לא הוגדר') + ' · "התחייבות" = סכום ההתחייבות, ואם אין — ההערכה. סה״כ צפוי לבית: ' + M(commitment + et.value) + ', שולם הכול: ' + M(paid + et.paid) + '.</p>' + vatNote() + '</section>';
      return '<div class="grid">' + hero + expHero + '</div>' + '<div class="grid">' + nextCard + (alertCard || '') + '</div>' + '<div class="grid">' + donutCard(commitment) + indexCard + '</div>' + timeline;
    }
  };

  function afterRender(id) {
    if (id === 'setup' || id === 'settings') updateEditorSummary();
    if (id === 'calculator') updateCalcOut();
  }

  // ---------- תחזית ומחשבון ----------
  var scDraft = [], scEditOpen = false;
  var calcForm = { amount: '', baseIdx: '', targetMonth: '', targetIdx: '', linked: '', floor: true, manual: false };
  function initCalcPage() {
    scDraft = clone(scenarioList()).map(function (x) { delete x._row; return x; });
    calcForm = { stage: '', amount: '', baseIdx: state.s.baseIndex || '', targetDate: todayIso(), targetMonth: '', targetIdx: '', linked: state.s.linkedPct || '100', floor: state.s.indexFloor !== 'false', manual: false };
    var km0 = C.knownMonthFor(calcForm.targetDate);
    if (km0) { calcForm.targetMonth = km0.y + '-' + ('0' + km0.m).slice(-2); fillCalcTarget(); return; }
    var lat = cbsLatest();
    if (lat) { calcForm.targetMonth = lat.y + '-' + ('0' + lat.m).slice(-2); fillCalcTarget(); }
  }
  function fillCalcTarget() {
    var ym = C.ymKey(calcForm.targetMonth); if (!ym) return;
    var raw = cbsValue(ym.y, ym.m);
    var v = raw != null ? toContract(raw) : null;
    calcForm.targetIdx = v != null ? String(v) : (raw != null ? String(raw) : '');
    calcForm.manual = false;
  }
  function cfield(k, label, type) {
    return '<div class="field"><label for="cf-' + k + '">' + label + '</label><input id="cf-' + k + '" data-cf="' + k + '" type="' + type + '"' +
      (type === 'number' ? ' step="any" inputmode="decimal"' : '') + ' value="' + esc(calcForm[k]) + '">' +
      (k === 'targetIdx' ? '<div class="hint" id="cf-hint"></div>' : '') + '</div>';
  }
  function updateCalcOut() {
    var out = $('calc-out'); if (!out) return;
    var cf = calcForm, A = C.num(cf.amount), bi = C.num(cf.baseIdx), ti = C.num(cf.targetIdx), lk = C.num(cf.linked) / 100;
    var h = $('cf-hint');
    if (h) {
      var ym = C.ymKey(cf.targetMonth), raw = ym ? cbsValue(ym.y, ym.m) : null;
      h.textContent = cf.manual ? 'הוזן ידנית' : (cf.targetDate && ym ? 'המדד הידוע ב-' + C.fmtDate(cf.targetDate) + ' הוא מדד ' + C.monthName(ym.y, ym.m) + '. ' : '') +  (raw != null ? (contractFactor() ? 'לפי הלמ״ס, מומר לבסיס החוזה (' + raw + ' בלמ״ס)' : 'לפי הלמ״ס, בבסיס הנוכחי') : (ym ? 'אין נתון בלמ״ס לחודש הזה' : ''));
    }
    if (!(A > 0) || !(bi > 0) || !(ti > 0)) { out.innerHTML = '<p class="muted small">יש להזין סכום, מדד בסיס ומדד יעד.</p>'; return; }
    var rate = ti / bi - 1;
    if (cf.floor && rate < 0) rate = 0;
    var linked = A * lk, adj = linked * rate;
    out.innerHTML = kv('חלק לא צמוד', C.fmtMoney(A - linked)) + kv('חלק צמוד', C.fmtMoney(linked)) +
      kv('שינוי במדד', (rate * 100).toFixed(3) + '%') + kv('הצמדה', C.fmtMoney(adj)) +
      '<div class="kv total"><span class="k">סה״כ</span><b class="num">' + C.fmtMoney(A + adj) + '</b></div>';
  }

  // ---------- הוצאות נוספות ----------
  function catById(id) { return state.categories.filter(function (c) { return c.id === id; })[0]; }
  function expById(id) { return state.expenses.filter(function (e) { return e.id === id; })[0]; }
  function expPays(id) { return state.payments.filter(function (p) { return p.type === 'expense' && p.expenseId === id; }); }
  function expRows(catId) {
    return state.expenses.filter(function (e) { return !catId || e.categoryId === catId; }).map(function (e) {
      return { e: e, x: C.expenseCalc(e, expPays(e.id)) };
    });
  }
  function catAgg(c) {
    var rows = expRows(c.id);
    var a = { budget: C.num(c.budget), commit: 0, est: 0, value: 0, paid: 0, count: rows.length };
    rows.forEach(function (r) { a.commit += r.x.commit; a.est += r.x.commit > 0 ? 0 : r.x.value; a.value += r.x.value; a.paid += r.x.paid; });
    a.over = a.budget > 0 && a.value > a.budget + 0.5;
    a.left = a.budget - a.value;
    return a;
  }
  function expStatusBadge(st) {
    var cls = { planning: 'muted-b', quote: 'muted-b', committed: 'info', partial: 'warn', paid: 'ok', cancelled: 'muted-b' }[st];
    return '<span class="badge ' + cls + '">' + C.EXP_STATUS[st] + '</span>';
  }
  function expTotals() {
    var t = { budget: 0, commit: 0, value: 0, paid: 0 };
    state.categories.forEach(function (c) { var a = catAgg(c); t.budget += a.budget; t.commit += a.commit; t.value += a.value; t.paid += a.paid; });
    return t;
  }

  function expensesView() {
    var t = expTotals();
    var list = state.categories.map(function (c) {
      var a = catAgg(c);
      var pct = a.budget > 0 ? Math.min(100, a.value / a.budget * 100) : (a.value > 0 ? 100 : 0);
      return '<li><a class="cat" href="#/category/' + encodeURIComponent(c.id) + '">' +
        '<div class="row between"><b>' + esc(c.name) + '</b><span class="num">' + M(a.value) + (a.budget ? ' <span class="muted small">מתוך ' + M(a.budget) + '</span>' : '') + '</span></div>' +
        '<div class="bar thin"><div style="width:' + pct.toFixed(1) + '%' + (a.over ? ';background:var(--accent)' : '') + '"></div></div>' +
        '<div class="row between small muted"><span>' + a.count + ' פריטים' + (a.paid ? ' · שולם ' + M(a.paid) : '') + '</span>' +
        (a.over ? '<span class="badge warn">חריגה ' + M(-a.left) + '</span>' : (a.budget ? '<span>יתרה ' + M(a.left) + '</span>' : '<span>ללא תקציב</span>')) + '</div></a></li>';
    }).join('');
    return '<section class="card"><div class="stats">' + stat('תקציב', M(t.budget)) + stat('צפי הוצאות', M(t.value)) + stat('התחייבויות', M(t.commit)) + stat('שולם', M(t.paid)) + '</div>' + vatNote() +
      '<p class="hint">"צפי הוצאות" = סכום ההתחייבות, ואם אין — ההערכה.</p>' +
      '<div class="row"><button type="button" class="btn btn-primary" data-action="new-exp">הוצאה חדשה</button>' +
      '<button type="button" class="btn btn-secondary" data-action="new-pay" data-type="expense">רישום תשלום</button>' +
      '<button type="button" class="btn btn-ghost" data-action="new-cat">קטגוריה חדשה</button></div></section>' +
      '<section class="card"><h2>קטגוריות</h2><ul class="cats">' + list + '</ul></section>';
  }

  function categoryView(param) {
    var c = catById(param);
    if (!c) return '<section class="card"><div class="empty"><b>הקטגוריה לא נמצאה</b><a class="btn btn-secondary" href="#/expenses">חזרה</a></div></section>';
    $('view-title').textContent = c.name;
    var a = catAgg(c);
    var items = expRows(c.id).map(function (r) {
      var e = r.e, x = r.x;
      return '<li class="item"><div><b>' + esc(e.name) + '</b>' + (e.supplier ? ' · <span class="muted small">' + esc(e.supplier) + '</span>' : '') +
        '<div class="badges">' + expStatusBadge(x.status) + '</div>' +
        '<div class="muted small">' + (x.commit ? 'התחייבות ' + M(x.commit) : (x.est ? 'הערכה ' + M(x.est) : '')) + (x.paid ? ' · שולם ' + M(x.paid) : '') + (x.remaining ? ' · יתרה ' + M(x.remaining) : '') + '</div>' +
        (e.notes ? '<div class="muted small">' + esc(e.notes) + '</div>' : '') + '</div>' +
        '<div class="item-side"><b class="num">' + M(x.value) + '</b><span class="tools">' +
        (x.status !== 'cancelled' ? '<button type="button" class="icon-btn" data-action="new-pay" data-type="expense" data-exp="' + esc(e.id) + '" aria-label="רישום תשלום">' + icon('pay', 18) + '</button>' : '') +
        '<button type="button" class="icon-btn" data-action="edit-exp" data-id="' + esc(e.id) + '" aria-label="עריכה">' + icon('edit', 18) + '</button>' +
        '<button type="button" class="icon-btn danger" data-action="del-exp" data-id="' + esc(e.id) + '" aria-label="מחיקה">' + icon('trash', 18) + '</button></span></div></li>';
    }).join('') || '<li class="muted small">אין עדיין פריטים בקטגוריה.</li>';
    var pays = state.payments.filter(function (p) { return p.type === 'expense' && expById(p.expenseId) && expById(p.expenseId).categoryId === c.id; })
      .sort(function (x, y) { return x.date < y.date ? 1 : -1; });
    var payList = pays.map(function (p) {
      return '<li class="item"><div><b>' + esc(expById(p.expenseId).name) + '</b><div class="muted small">' + C.fmtDate(p.date) + ' · ' + esc(methodLabel(p.method)) + '</div></div>' +
        '<div class="item-side"><b class="num">' + M(C.num(p.amount)) + '</b><span class="tools">' +
        '<button type="button" class="icon-btn" data-action="edit-pay" data-id="' + esc(p.id) + '" aria-label="עריכת תשלום">' + icon('edit', 18) + '</button>' +
        '<button type="button" class="icon-btn danger" data-action="del-pay" data-id="' + esc(p.id) + '" aria-label="מחיקת תשלום">' + icon('trash', 18) + '</button></span></div></li>';
    }).join('') || '<li class="muted small">עדיין לא נרשמו תשלומים.</li>';
    return '<a class="back" href="#/expenses">' + icon('right', 18) + 'הוצאות נוספות</a>' +
      '<section class="card"><div class="stats">' + stat('תקציב', a.budget ? M(a.budget) : '<a href="#" data-action="edit-cat" data-id="' + esc(c.id) + '">להגדרה</a>') +
      stat('צפי הוצאות', M(a.value)) + stat('שולם', M(a.paid)) + stat(a.over ? 'חריגה' : 'יתרת תקציב', a.budget ? M(Math.abs(a.left)) : '—') + '</div>' + vatNote() +
      '<div class="row"><button type="button" class="btn btn-primary" data-action="new-exp" data-cat="' + esc(c.id) + '">הוצאה חדשה</button>' +
      '<button type="button" class="btn btn-secondary" data-action="edit-cat" data-id="' + esc(c.id) + '">עריכת קטגוריה</button>' +
      '<button type="button" class="btn btn-ghost danger-text" data-action="del-cat" data-id="' + esc(c.id) + '">מחיקה</button></div></section>' +
      '<section class="card"><h2>פריטים</h2><ul class="items">' + items + '</ul></section>' +
      '<section class="card"><h2>תשלומים</h2><ul class="items">' + payList + '</ul></section>';
  }

  // חלונות: קטגוריה והוצאה
  function openCategory(id) {
    var c = id ? catById(id) : null;
    form = { kind: 'cat', data: c ? clone(c) : { name: '', budget: '' } };
    openModal(c ? 'עריכת קטגוריה' : 'קטגוריה חדשה', '<div class="fields">' +
      ff('name', 'שם הקטגוריה', { required: true }) + ff('budget', 'תקציב מתוכנן (₪, כולל מע״מ)', { type: 'number', step: 'any', inputmode: 'decimal' }) +
      '</div><div class="error-box" id="m-err" hidden></div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="modal-close">ביטול</button><button type="button" class="btn btn-primary" data-action="save-cat">שמירה</button></div>');
  }
  function saveCategory(btn) {
    var d = form.data;
    if (!String(d.name).trim()) { showErrors('m-err', ['יש להזין שם']); return; }
    var obj = { id: d.id || uid(), order: d.order || (state.categories.length + 1), name: String(d.name).trim(), budget: C.num(d.budget), updatedAt: nowIso(), _row: d._row };
    btn.disabled = true;
    withSync(upsertRow('ExpenseCategories', obj).then(loadCategories), 'הקטגוריה נשמרה').then(function () { closeModal(); rerender(); })
      .catch(handleError).then(function () { btn.disabled = false; });
  }
  function deleteCategory(id) {
    var c = catById(id); if (!c) return;
    if (state.expenses.some(function (e) { return e.categoryId === id; })) { toast('יש פריטים בקטגוריה. יש למחוק או להעביר אותם קודם.', 'err'); return; }
    if (!confirm('למחוק את הקטגוריה "' + c.name + '"?')) return;
    withSync(deleteRow('ExpenseCategories', c._row).then(loadCategories), 'הקטגוריה נמחקה').then(function () { location.hash = '#/expenses'; rerender(); }).catch(handleError);
  }
  var EXP_MANUAL = [['planning', 'בתכנון'], ['quote', 'הצעת מחיר'], ['committed', 'התחייבות'], ['cancelled', 'בוטל']];
  function openExpense(catId, id) {
    var e = id ? expById(id) : null;
    form = { kind: 'exp', data: e ? clone(e) : { categoryId: catId || (state.categories[0] || {}).id, name: '', supplier: '', estimate: '', commitment: '', status: 'planning', startDate: '', endDate: '', notes: '' } };
    if (['partial', 'paid'].indexOf(form.data.status) >= 0) form.data.status = 'committed';
    openModal(e ? 'עריכת הוצאה' : 'הוצאה חדשה', '<div class="fields">' +
      ff('categoryId', 'קטגוריה', { type: 'select', options: state.categories.map(function (c) { return [c.id, c.name]; }), required: true }) +
      ff('name', 'תיאור', { required: true, placeholder: 'לדוגמה: ארון מטבח' }) +
      ff('supplier', 'ספק') +
      ff('status', 'סטטוס', { type: 'select', options: EXP_MANUAL, hint: '"שולם חלקית" ו"שולם" מתעדכנים לבד לפי התשלומים.' }) +
      ff('estimate', 'הערכה / הצעת מחיר (₪)', { type: 'number', step: 'any', inputmode: 'decimal' }) +
      ff('commitment', 'סכום התחייבות (₪)', { type: 'number', step: 'any', inputmode: 'decimal', hint: 'הסכום שסוכם עם הספק.' }) +
      ff('startDate', 'תאריך הזמנה', { type: 'date' }) + ff('endDate', 'תאריך אספקה', { type: 'date' }) +
      ff('notes', 'הערות', { wide: true }) +
      '</div><div class="error-box" id="m-err" hidden></div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="modal-close">ביטול</button><button type="button" class="btn btn-primary" data-action="save-exp">שמירה</button></div>');
  }
  function saveExpense(btn) {
    var d = form.data, errs = [];
    if (!catById(d.categoryId)) errs.push('יש לבחור קטגוריה');
    if (!String(d.name).trim()) errs.push('יש להזין תיאור');
    showErrors('m-err', errs); if (errs.length) return;
    var obj = { id: d.id || uid(), categoryId: d.categoryId, name: String(d.name).trim(), supplier: d.supplier, estimate: d.estimate === '' ? '' : C.num(d.estimate),
      commitment: d.commitment === '' ? '' : C.num(d.commitment), status: d.status, startDate: d.startDate, endDate: d.endDate, notes: d.notes, updatedAt: nowIso(), _row: d._row };
    btn.disabled = true;
    withSync(upsertRow('Expenses', obj).then(loadExpenses), 'ההוצאה נשמרה').then(function () {
      logActivity(d.id ? 'update' : 'create', 'Expenses', obj.name); closeModal(); rerender();
    }).catch(handleError).then(function () { btn.disabled = false; });
  }
  function deleteExpense(id) {
    var e = expById(id); if (!e) return;
    if (expPays(id).length) { toast('יש תשלומים לפריט הזה. יש למחוק אותם קודם.', 'err'); return; }
    if (!confirm('למחוק את "' + e.name + '"?')) return;
    withSync(deleteRow('Expenses', e._row).then(loadExpenses), 'נמחק').then(rerender).catch(handleError);
  }
  function expOptions() {
    var opts = [];
    state.categories.forEach(function (c) {
      expRows(c.id).forEach(function (r) { if (r.x.status !== 'cancelled') opts.push([r.e.id, c.name + ' — ' + r.e.name]); });
    });
    return opts;
  }

  // תרשים טבעת: התחייבויות לפי קטגוריה (כולל קבלן)
  var hiddenSlices = { __c: true }; // הקבלן מוסתר כברירת מחדל
  var SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  function donutCard(contractorTotal) {
    var items = [{ id: '__c', name: 'קבלן', v: contractorTotal }];
    state.categories.forEach(function (c) { var a = catAgg(c); if (a.value > 0) items.push({ id: c.id, name: c.name, v: a.value }); });
    var main = items.slice(0, 1).concat(items.slice(1).sort(function (a, b) { return b.v - a.v; }));
    // עד 7 פלחים + "אחר"
    if (main.length > 8) {
      var rest = main.slice(7);
      main = main.slice(0, 7).concat([{ id: '__o', name: 'אחר (' + rest.length + ')', v: rest.reduce(function (a, x) { return a + x.v; }, 0), gray: true }]);
    }
    main.forEach(function (x, i) { x.color = x.gray ? '#8a8984' : SERIES[i]; });
    var shown = main.filter(function (x) { return !hiddenSlices[x.id]; });
    var total = shown.reduce(function (a, x) { return a + x.v; }, 0);
    var R = 70, r = 46, cx = 90, cy = 90, ang = -Math.PI / 2, gap = shown.length > 1 ? 0.02 : 0;
    var paths = shown.map(function (x) {
      var frac = total ? x.v / total : 0, a0 = ang + gap / 2, a1 = ang + frac * 2 * Math.PI - gap / 2;
      ang += frac * 2 * Math.PI;
      if (frac >= 0.999) return '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none" stroke="' + x.color + '" stroke-width="' + (R - r) + '"><title>' + esc(x.name) + ': ' + M(x.v) + '</title></circle>';
      if (a1 <= a0) return '';
      var large = a1 - a0 > Math.PI ? 1 : 0;
      var p = function (rad, a) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
      return '<path d="M' + p(R, a0) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + p(R, a1) + ' L' + p(r, a1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + p(r, a0) + 'Z" fill="' + x.color + '"><title>' + esc(x.name) + ': ' + M(x.v) + ' (' + Math.round(x.v / total * 100) + '%)</title></path>';
    }).join('');
    var legend = main.map(function (x) {
      var off = !!hiddenSlices[x.id];
      return '<li><button type="button" class="leg' + (off ? ' off' : '') + '" data-action="toggle-slice" data-id="' + esc(x.id) + '" aria-pressed="' + !off + '">' +
        '<span class="sw" style="background:' + x.color + '"></span><span class="leg-name">' + esc(x.name) + '</span>' +
        '<span class="num">' + M(x.v) + '</span><span class="muted small num">' + (off || !total ? '' : Math.round(x.v / total * 100) + '%') + '</span></button></li>';
    }).join('');
    return '<section class="card"><h2>התחייבויות לפי תחום</h2><div class="donut-wrap">' +
      '<svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="תרשים התחייבויות לפי תחום">' + paths +
      '<text x="90" y="86" text-anchor="middle" class="donut-k">סה״כ</text><text x="90" y="106" text-anchor="middle" class="donut-v">' + esc(M(total)) + '</text></svg>' +
      '<ul class="legend">' + legend + '</ul></div><p class="hint">לחיצה על שורה מסתירה או מחזירה אותה לתרשים.</p></section>';
  }

  // ---------- טפסי דרישה ותשלום (חלון) ----------
  var form = null; // {kind:'req'|'pay', data:{...}}
  function openModal(title, html) {
    var d = $('modal');
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
    var first = d.querySelector('input,select'); if (first) first.focus();
  }
  function closeModal() { var d = $('modal'); if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); } form = null; }
  function ff(key, label, opts) {
    opts = opts || {};
    var v = form.data[key] == null ? '' : form.data[key];
    var id = 'm-' + key;
    var req = opts.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
    var input;
    if (opts.type === 'select') {
      input = '<select id="' + id + '" data-mf="' + key + '">' + opts.options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    } else {
      input = '<input id="' + id + '" data-mf="' + key + '" type="' + (opts.type || 'text') + '" value="' + esc(v) + '"' +
        (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') + (opts.step ? ' step="' + opts.step + '"' : '') +
        (opts.list ? ' list="' + opts.list + '"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
        (opts.required ? ' required aria-required="true"' : '') + '>';
    }
    return '<div class="field' + (opts.wide ? ' wide' : '') + '"><label for="' + id + '">' + label + req + '</label>' + input +
      (opts.hint ? '<div class="hint" id="mh-' + key + '">' + opts.hint + '</div>' : '') + '</div>';
  }
  function stageOptions() { return ledger().map(function (r, i) { return [r.stageId, (i + 1) + '. ' + r.name]; }); }

  function openRequest(stageId, reqId) {
    var rows = ledger();
    var existing = reqId ? state.requests.filter(function (q) { return q.id === reqId; })[0] : null;
    var sid = existing ? existing.stageId : (stageId || ((rows.filter(function (r) { return r.st.status !== 'paid'; })[0] || rows[0]) || {}).stageId);
    form = { kind: 'req', data: existing ? clone(existing) : { stageId: sid, number: '', receivedDate: todayIso(), dueDate: '', baseAmount: '', indexValue: '', indexMonth: '', contractorAmount: '', notes: '' } };
    if (!existing) { form.data.baseAmount = defaultReqBase(sid); autofillIndex(); }
    renderRequestForm(existing ? 'עריכת דרישת תשלום' : 'דרישת תשלום חדשה');
  }
  function autofillIndex() {
    if (String(state.s.track) !== '1' || !form || form.kind !== 'req') return;
    if (form.data.indexSource === 'manual') return;
    var k = knownIndexAt(form.data.receivedDate);
    if (k && k.v != null) {
      form.data.indexValue = String(k.v);
      form.data.indexMonth = k.y + '-' + ('0' + k.m).slice(-2);
      form.data.indexSource = 'cbs';
    } else {
      form.data.indexValue = ''; form.data.indexMonth = k ? k.y + '-' + ('0' + k.m).slice(-2) : ''; form.data.indexSource = '';
    }
    var iv = $('m-indexValue'), im = $('m-indexMonth');
    if (iv) iv.value = form.data.indexValue;
    if (im) im.value = form.data.indexMonth;
  }
  function indexHintHtml() {
    var d = form.data, k = knownIndexAt(d.receivedDate);
    var parts = [];
    if (!state.cbs) parts.push('שירות המדד עדיין לא פעיל — יש להזין את המדד ידנית.');
    else if (k && k.v != null) parts.push('לפי הלמ״ס: מדד ' + C.monthName(k.y, k.m) + ' = ' + k.v + ' בבסיס החוזה (' + k.raw + ' בבסיס ' + (state.cbs.base || 'הלמ״ס') + ')' + (d.indexSource === 'manual' ? '' : ' · מולא אוטומטית'));
    else if (k && k.raw != null) parts.push('מדד ' + C.monthName(k.y, k.m) + ' בלמ״ס: ' + k.raw + '. כדי להמיר לבסיס החוזה יש להזין בהגדרות את מדד הבסיס ואת החודש שלו.');
    else if (k) parts.push('מדד ' + C.monthName(k.y, k.m) + ' עוד לא פורסם או לא נמשך. אפשר להזין ידנית.');
    parts.push('מדד בסיס בחוזה: ' + esc(state.s.baseIndex || 'לא הוזן') + '.');
    var html = esc(parts[0]) + ' ' + parts.slice(1).join(' ');
    if (d.indexSource === 'manual' && k && k.v != null) html += ' <button type="button" class="link-btn" data-action="index-revert">חזור למדד הלמ״ס</button>';
    if (d.indexSource === 'manual') html += ' <span class="badge warn">ידני</span>';
    return html;
  }
  var lastIndexHint = '';
  function refreshIndexHint() { var h = $('mh-indexValue'); if (!h) return; var x = indexHintHtml(); if (x !== lastIndexHint || !h.innerHTML.trim()) { h.innerHTML = x; lastIndexHint = x; } }
  function defaultReqBase(sid) {
    var row = findStage(sid); if (!row) return '';
    var used = reqsOf(sid).reduce(function (a, q) { return a + C.num(q.baseAmount); }, 0);
    return String(C.round2(Math.max(0, row.base - used)));
  }
  function renderRequestForm(title) {
    var t1 = String(state.s.track) === '1';
    var html = '<div class="fields">' +
      ff('stageId', 'אבן דרך', { type: 'select', options: stageOptions(), required: true, wide: true }) +
      ff('receivedDate', 'תאריך הדרישה', { type: 'date', required: true }) +
      ff('dueDate', 'לתשלום עד', { type: 'date' }) +
      ff('number', 'מספר דרישה') +
      ff('baseAmount', 'סכום בסיס (₪, כולל מע״מ)', { type: 'number', step: 'any', inputmode: 'decimal', required: true, hint: 'ברירת המחדל: יתרת הבסיס של אבן הדרך.' }) +
      (t1 ? ff('indexValue', 'מדד קובע', { type: 'number', step: 'any', inputmode: 'decimal', hint: ' ' }) +
        ff('indexMonth', 'חודש המדד', { type: 'month' }) : '') +
      ff('contractorAmount', 'הסכום בדרישת הקבלן (לבדיקה)', { type: 'number', step: 'any', inputmode: 'decimal', hint: 'אופציונלי. אם יש הפרש מהחישוב — תוצג התראה.' }) +
      ff('notes', 'הערות', { wide: true }) +
      '</div><div class="calc-box" id="req-calc"></div><div class="error-box" id="m-err" hidden></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="modal-close">ביטול</button><button type="button" class="btn btn-primary" data-action="save-req">שמירה</button></div>';
    openModal(title, html);
    refreshIndexHint();
    updateRequestCalc();
  }
  function updateRequestCalc() {
    if (!form || form.kind !== 'req') return;
    var d = form.data, row = findStage(d.stageId), box = $('req-calc');
    if (!row || !box) return;
    var c = C.requestCalc(state.s, row, d.baseAmount, d.indexValue);
    var t1 = String(state.s.track) === '1';
    var lines = kv('סכום בסיס', M(c.base));
    if (t1) {
      lines += kv('חלק צמוד', c.linked ? M(c.linked) : 'פטור ממדד');
      if (c.linked) lines += kv('שינוי במדד', c.rate == null ? '—' : (c.rate * 100).toFixed(2) + '%') + kv('הצמדה', M(c.adj));
    }
    lines += '<div class="kv total"><span class="k">סה״כ לתשלום</span><b class="num">' + M(c.final) + '</b></div>';
    if (d.contractorAmount !== '' && Math.abs(C.num(d.contractorAmount) - c.final) >= 1) lines += '<div class="warn-text small">הפרש מדרישת הקבלן: ' + M(C.num(d.contractorAmount) - c.final) + '</div>';
    box.innerHTML = lines;
  }
  function saveRequest(btn) {
    var d = form.data, errs = [];
    var row = findStage(d.stageId);
    if (!row) errs.push('יש לבחור אבן דרך');
    if (!d.receivedDate) errs.push('יש להזין תאריך דרישה');
    if (!(C.num(d.baseAmount) > 0)) errs.push('יש להזין סכום בסיס');
    if (d.indexValue !== '' && !(C.num(d.indexValue) > 0)) errs.push('המדד לא תקין');
    showErrors('m-err', errs); if (errs.length) return;
    var c = C.requestCalc(state.s, row, d.baseAmount, d.indexValue);
    var obj = {
      id: d.id || uid(), stageId: d.stageId, number: d.number, receivedDate: d.receivedDate, dueDate: d.dueDate,
      baseAmount: c.base, indexValue: d.indexValue, indexMonth: d.indexMonth, indexSource: d.indexValue ? (d.indexSource || 'manual') : '',
      indexAdj: c.adj, finalAmount: c.final, notes: d.notes, updatedAt: nowIso(), contractorAmount: d.contractorAmount, _row: d._row
    };
    btn.disabled = true;
    withSync(upsertRow('PaymentRequests', obj).then(loadRequests), 'הדרישה נשמרה').then(function () {
      logActivity(d.id ? 'update' : 'create', 'PaymentRequests', stageName(obj.stageId) + ' ' + obj.finalAmount);
      closeModal(); rerender();
    }).catch(handleError).then(function () { btn.disabled = false; });
  }

  function openPayment(stageId, payId, type, expId) {
    var rows = ledger();
    var existing = payId ? state.payments.filter(function (p) { return p.id === payId; })[0] : null;
    if ((existing && existing.type === 'expense') || (!existing && type === 'expense')) {
      form = { kind: 'pay', data: existing ? clone(existing) : { type: 'expense', stageId: '', requestId: '', expenseId: expId || '', date: todayIso(), amount: '', method: 'transfer', fundingSource: '', reference: '', notes: '' } };
      if (!existing) { if (!form.data.expenseId) { var o = expOptions()[0]; form.data.expenseId = o ? o[0] : ''; } prefillExpAmount(); }
      renderPaymentForm(existing ? 'עריכת תשלום' : 'רישום תשלום');
      return;
    }
    var sid = existing ? existing.stageId : (stageId || ((rows.filter(function (r) { return r.st.status !== 'paid'; })[0] || rows[0]) || {}).stageId);
    form = { kind: 'pay', data: existing ? clone(existing) : { type: 'contractor', stageId: sid, requestId: '', date: todayIso(), amount: '', method: 'transfer', fundingSource: '', reference: '', notes: '' } };
    if (!existing) {
      var open = reqsOf(sid);
      if (open.length) form.data.requestId = open[open.length - 1].id;
      var row = findStage(sid); if (row && row.st.remaining > 0) form.data.amount = String(C.round2(row.st.remaining));
    }
    renderPaymentForm(existing ? 'עריכת תשלום' : 'רישום תשלום');
  }
  function prefillExpAmount() {
    var e = expById(form.data.expenseId); if (!e) return;
    var x = C.expenseCalc(e, expPays(e.id));
    form.data.amount = x.remaining > 0 ? String(x.remaining) : '';
  }
  function renderPaymentForm(title) {
    var typeSw = form.data.id ? '' : '<div class="seg" role="radiogroup" aria-label="סוג תשלום">' +
      '<button type="button" role="radio" aria-checked="' + (form.data.type === 'contractor') + '" data-action="pay-type" data-type="contractor">קבלן</button>' +
      '<button type="button" role="radio" aria-checked="' + (form.data.type === 'expense') + '" data-action="pay-type" data-type="expense">הוצאה נוספת</button></div>';
    if (form.data.type === 'expense') {
      var e = expById(form.data.expenseId), x = e ? C.expenseCalc(e, expPays(e.id)) : null;
      var eo = expOptions();
      openModal(title, typeSw + (eo.length ? '<div class="fields">' +
        ff('expenseId', 'הוצאה', { type: 'select', options: eo, required: true, wide: true }) +
        ff('date', 'תאריך התשלום', { type: 'date', required: true }) +
        ff('amount', 'סכום ששולם (₪, כולל מע״מ)', { type: 'number', step: 'any', inputmode: 'decimal', required: true, hint: x && x.commit ? 'יתרה להתחייבות: ' + C.fmtMoney(x.remaining) : '' }) +
        ff('method', 'אמצעי תשלום', { type: 'select', options: METHODS }) +
        ff('fundingSource', 'מקור מימון', { list: 'funding-list', placeholder: 'הון עצמי / משכנתא…' }) +
        ff('reference', 'אסמכתא') + ff('notes', 'הערות', { wide: true }) +
        '</div><datalist id="funding-list"><option value="הון עצמי"><option value="משכנתא"><option value="הלוואה"></datalist>' +
        '<div class="error-box" id="m-err" hidden></div>' +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="modal-close">ביטול</button><button type="button" class="btn btn-primary" data-action="save-pay">שמירה</button></div>'
        : '<p class="muted">עדיין אין הוצאות. קודם צריך להוסיף הוצאה, ואז לרשום לה תשלום.</p><div class="modal-actions"><button type="button" class="btn btn-primary" data-action="new-exp">הוצאה חדשה</button></div>'));
      return;
    }
    var reqOpts = [['', 'ללא שיוך לדרישה']].concat(reqsOf(form.data.stageId).map(function (q) {
      return [q.id, 'דרישה' + (q.number ? ' ' + q.number : '') + ' · ' + C.fmtDate(q.receivedDate) + ' · ' + C.fmtMoney(C.num(q.finalAmount))];
    }));
    var row = findStage(form.data.stageId);
    var html = typeSw + '<div class="fields">' +
      ff('stageId', 'אבן דרך', { type: 'select', options: stageOptions(), required: true, wide: true }) +
      ff('requestId', 'שיוך לדרישה', { type: 'select', options: reqOpts }) +
      ff('date', 'תאריך התשלום', { type: 'date', required: true }) +
      ff('amount', 'סכום ששולם (₪, כולל מע״מ)', { type: 'number', step: 'any', inputmode: 'decimal', required: true, hint: row ? 'יתרה באבן הדרך: ' + C.fmtMoney(Math.max(0, row.st.remaining)) : '' }) +
      ff('method', 'אמצעי תשלום', { type: 'select', options: METHODS }) +
      ff('fundingSource', 'מקור מימון', { list: 'funding-list', placeholder: 'הון עצמי / משכנתא…' }) +
      ff('reference', 'אסמכתא') +
      ff('notes', 'הערות', { wide: true }) +
      '</div><datalist id="funding-list"><option value="הון עצמי"><option value="משכנתא"><option value="הלוואה"></datalist>' +
      '<div class="error-box" id="m-err" hidden></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="modal-close">ביטול</button><button type="button" class="btn btn-primary" data-action="save-pay">שמירה</button></div>';
    openModal(title, html);
  }
  function savePayment(btn) {
    var d = form.data, errs = [];
    if (d.type === 'expense') {
      if (!expById(d.expenseId)) errs.push('יש לבחור הוצאה');
      if (!d.date) errs.push('יש להזין תאריך תשלום');
      if (!(C.num(d.amount) > 0)) errs.push('יש להזין סכום');
      showErrors('m-err', errs); if (errs.length) return;
      var eo = { id: d.id || uid(), type: 'expense', stageId: '', requestId: '', expenseId: d.expenseId, date: d.date, amount: C.round2(C.num(d.amount)),
        method: d.method, fundingSource: d.fundingSource, reference: d.reference, notes: d.notes, updatedAt: nowIso(), _row: d._row };
      btn.disabled = true;
      withSync(upsertRow('Payments', eo).then(loadPayments), 'התשלום נשמר').then(function () {
        logActivity(d.id ? 'update' : 'create', 'Payments', 'expense ' + eo.amount); closeModal(); rerender();
      }).catch(handleError).then(function () { btn.disabled = false; });
      return;
    }
    if (!findStage(d.stageId)) errs.push('יש לבחור אבן דרך');
    if (!d.date) errs.push('יש להזין תאריך תשלום');
    if (!(C.num(d.amount) > 0)) errs.push('יש להזין סכום');
    showErrors('m-err', errs); if (errs.length) return;
    var prow = findStage(d.stageId);
    if (!d.id && prow && prow.linkedBase > 0 && !reqsOf(d.stageId).length && C.num(d.amount) > prow.base + 1) {
      if (confirm('התשלום (' + C.fmtMoney(C.num(d.amount)) + ') גבוה מסכום הבסיס (' + C.fmtMoney(prow.base) + '), ואין דרישת תשלום לאבן הדרך.\nכנראה שהוא כולל הצמדה.\n\nאישור = להזין קודם דרישת תשלום (כדי שההצמדה תירשם)\nביטול = לשמור את התשלום כמו שהוא')) { openRequest(d.stageId); return; }
    }
    var obj = { id: d.id || uid(), type: 'contractor', stageId: d.stageId, requestId: d.requestId, expenseId: '', date: d.date, amount: C.round2(C.num(d.amount)),
      method: d.method, fundingSource: d.fundingSource, reference: d.reference, notes: d.notes, updatedAt: nowIso(), _row: d._row };
    btn.disabled = true;
    withSync(upsertRow('Payments', obj).then(loadPayments), 'התשלום נשמר').then(function () {
      logActivity(d.id ? 'update' : 'create', 'Payments', stageName(obj.stageId) + ' ' + obj.amount);
      closeModal(); rerender();
    }).catch(handleError).then(function () { btn.disabled = false; });
  }
  function deleteRequest(id) {
    var q = state.requests.filter(function (x) { return x.id === id; })[0]; if (!q) return;
    if (state.payments.some(function (p) { return p.requestId === id; })) { toast('יש תשלומים ששויכו לדרישה הזו. יש לערוך או למחוק אותם קודם.', 'err'); return; }
    if (!confirm('למחוק את הדרישה?')) return;
    withSync(deleteRow('PaymentRequests', q._row).then(loadRequests), 'הדרישה נמחקה').then(function () { logActivity('delete', 'PaymentRequests', id); rerender(); }).catch(handleError);
  }
  function deletePayment(id) {
    var p = state.payments.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    if (!confirm('למחוק את התשלום על סך ' + C.fmtMoney(C.num(p.amount)) + '?')) return;
    withSync(deleteRow('Payments', p._row).then(loadPayments), 'התשלום נמחק').then(function () { logActivity('delete', 'Payments', id); rerender(); }).catch(handleError);
  }
  function onModalInput(t) {
    var k = t.getAttribute('data-mf');
    form.data[k] = t.value;
    if (form.kind === 'req') {
      if (k === 'stageId' && !form.data.id) { form.data.baseAmount = defaultReqBase(t.value); var b = $('m-baseAmount'); if (b) b.value = form.data.baseAmount; }
      if (k === 'indexValue' || k === 'indexMonth') form.data.indexSource = 'manual';
      if (k === 'receivedDate') autofillIndex();
      refreshIndexHint();
      updateRequestCalc();
    } else if (form.kind === 'pay' && k === 'expenseId') {
      prefillExpAmount(); var am = $('m-amount'); if (am) am.value = form.data.amount;
      var e = expById(form.data.expenseId), x = e ? C.expenseCalc(e, expPays(e.id)) : null, h = $('mh-amount'); if (h) h.textContent = x && x.commit ? 'יתרה להתחייבות: ' + C.fmtMoney(x.remaining) : '';
    } else if (form.kind === 'pay' && k === 'stageId') {
      form.data.requestId = ''; var row = findStage(t.value);
      form.data.amount = row && row.st.remaining > 0 ? String(C.round2(row.st.remaining)) : '';
      var keep = clone(form.data); renderPaymentForm($('modal-title').textContent); form.data = keep;
    }
  }

  // ---------- אירועים ----------
  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute('data-mf')) { if (form) onModalInput(t); return; }
    if (t.hasAttribute('data-cf')) {
      var ck = t.getAttribute('data-cf');
      calcForm[ck] = ck === 'floor' ? t.value === 'true' : t.value;
      if (ck === 'targetDate') { var km = C.knownMonthFor(calcForm.targetDate); if (km) { calcForm.targetMonth = km.y + '-' + ('0' + km.m).slice(-2); var tm = $('cf-targetMonth'); if (tm) tm.value = calcForm.targetMonth; } ck = 'targetMonth'; }
      if (ck === 'targetMonth') { fillCalcTarget(); var ti = $('cf-targetIdx'); if (ti) ti.value = calcForm.targetIdx; }
      if (ck === 'stage') {
        var sr = calcForm.stage ? findStage(calcForm.stage) : null;
        if (sr) {
          calcForm.amount = String(sr.base); calcForm.linked = sr.base ? String(C.round2(sr.linkedBase / sr.base * 100)) : '0';
          if (sr.date) { calcForm.targetDate = sr.date < todayIso() ? sr.date : todayIso(); var td = $('cf-targetDate'); if (td) td.value = calcForm.targetDate; var km2 = C.knownMonthFor(calcForm.targetDate); if (km2) { calcForm.targetMonth = km2.y + '-' + ('0' + km2.m).slice(-2); var tm2 = $('cf-targetMonth'); if (tm2) tm2.value = calcForm.targetMonth; fillCalcTarget(); var ti2 = $('cf-targetIdx'); if (ti2) ti2.value = calcForm.targetIdx; } }
          ['amount', 'linked'].forEach(function (k) { var el = $('cf-' + k); if (el) el.value = calcForm[k]; });
        }
      }
      if (ck === 'targetIdx') calcForm.manual = true;
      updateCalcOut(); return;
    }
    if (t.hasAttribute('data-sc')) { scDraft[+t.getAttribute('data-i')][t.getAttribute('data-sc')] = t.getAttribute('data-sc') === 'name' ? t.value : t.value; return; }
    if (!draft) return;
    if (t.hasAttribute('data-k')) {
      var k = t.getAttribute('data-k');
      draft[k] = t.value;
      if (t.hasAttribute('data-money')) { var h = $('h-' + k); if (h) h.textContent = t.value ? C.fmtMoney(C.num(t.value)) : ''; }
      if (['fixSurcharge', 't3Surcharge', 'exemptPct', 'linkedPct'].indexOf(k) >= 0) refreshTrackDescs();
      if (k === 'baseIndexMonth' || k === 'baseIndex') { var bh = $('base-hint'); if (bh) bh.innerHTML = baseIndexHint(); }
      updateEditorSummary();
    } else if (t.hasAttribute('data-se')) {
      var i = +t.getAttribute('data-i');
      draftList()[i][t.getAttribute('data-se')] = t.value;
      updateEditorSummary();
    }
  }
  function refreshTrackDescs() {
    // עדכון התיאורים בלי לאבד פוקוס
    var tr = document.querySelector('.tracks');
    if (!tr) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = trackPicker();
    tr.replaceWith(tmp.firstChild);
  }
  // רינדור מחדש של המסך הנוכחי עם שמירת מיקום הגלילה
  function softRerender() { var y = window.scrollY; rerender(); window.scrollTo(0, y); }

  function onAction(name, btn) {
    var i = +btn.getAttribute('data-i');
    switch (name) {
      case 'logout': logout(); return;
      case 'revoke': revokeAccess(); return;
      case 'reconnect':
        requestToken().then(function () { toast('החיבור חודש', 'ok'); }).catch(handleError); return;
      case 'test-save': {
        btn.disabled = true;
        var stamp = nowIso();
        withSync(saveSettings({ lastTest: stamp })).then(function () {
          if (state.s.lastTest === stamp) { $('last-test').textContent = fmtDateTime(stamp); toast('נשמר ונקרא בהצלחה מהגיליון', 'ok'); }
          else toast('הערך שנקרא לא תואם למה שנשמר', 'err');
        }).catch(handleError).then(function () { btn.disabled = false; });
        return;
      }
      case 'pick-track': draft.track = btn.getAttribute('data-track'); softRerender(); return;
      case 'se-add': draftList().push({ name: '', pct: '', month: '', indexExempt: 'auto' }); softRerender(); focusLast(); return;
      case 'se-del': draftList().splice(i, 1); softRerender(); return;
      case 'se-up': if (i > 0) { var L = draftList(); L.splice(i - 1, 0, L.splice(i, 1)[0]); softRerender(); } return;
      case 'se-down': { var L2 = draftList(); if (i < L2.length - 1) { L2.splice(i + 1, 0, L2.splice(i, 1)[0]); softRerender(); } return; }
      case 'se-reset':
        if (!confirm('לטעון את לוח ברירת המחדל? השינויים בלוח יימחקו.')) return;
        if (String(draft.track) === '3') draft.t3 = clone(C.DEFAULT_T3);
        else draft.stages = clone(C.DEFAULT_STAGES).map(function (x) { x.indexExempt = 'auto'; return x; });
        softRerender(); return;
      case 'wiz-next': {
        var errs = wizValidate(wizardStep);
        if (errs.length) { showErrors('wiz-err', errs); return; }
        wizardStep++;
        if (wizardStep === 4 && String(draft.track) !== '1') wizardStep = 5;
        rerender(); window.scrollTo(0, 0); return;
      }
      case 'wiz-back':
        wizardStep--;
        if (wizardStep === 4 && String(draft.track) !== '1') wizardStep = 3;
        rerender(); window.scrollTo(0, 0); return;
      case 'wiz-finish': finishWizard(btn); return;
      case 'save-project': saveProject(btn); return;
      case 'save-contract': saveContract(btn); return;
      case 'save-stages': saveStagesAction(btn); return;
      case 'new-req': openRequest(btn.getAttribute('data-stage')); return;
      case 'edit-req': openRequest(null, btn.getAttribute('data-id')); return;
      case 'del-req': deleteRequest(btn.getAttribute('data-id')); return;
      case 'save-req': saveRequest(btn); return;
      case 'new-pay': openPayment(btn.getAttribute('data-stage'), null, btn.getAttribute('data-type'), btn.getAttribute('data-exp')); return;
      case 'pay-type': {
        var keep = form ? { date: form.data.date, method: form.data.method, fundingSource: form.data.fundingSource } : {};
        openPayment(null, null, btn.getAttribute('data-type'));
        Object.keys(keep).forEach(function (k) { form.data[k] = keep[k]; });
        renderPaymentForm('רישום תשלום'); return;
      }
      case 'new-exp': openExpense(btn.getAttribute('data-cat')); return;
      case 'edit-exp': openExpense(null, btn.getAttribute('data-id')); return;
      case 'del-exp': deleteExpense(btn.getAttribute('data-id')); return;
      case 'save-exp': saveExpense(btn); return;
      case 'new-cat': openCategory(); return;
      case 'edit-cat': openCategory(btn.getAttribute('data-id')); return;
      case 'del-cat': deleteCategory(btn.getAttribute('data-id')); return;
      case 'save-cat': saveCategory(btn); return;
      case 'toggle-slice': { var sid = btn.getAttribute('data-id'); hiddenSlices[sid] = !hiddenSlices[sid]; softRerender(); return; }
      case 'edit-pay': openPayment(null, btn.getAttribute('data-id')); return;
      case 'del-pay': deletePayment(btn.getAttribute('data-id')); return;
      case 'save-pay': savePayment(btn); return;
      case 'modal-close': closeModal(); return;
      case 'pick-sc':
        withSync(saveSettings({ scenarioId: btn.getAttribute('data-id') }), 'התרחיש נבחר').then(softRerender).catch(handleError); return;
      case 'sc-add': scDraft.push({ id: uid(), name: 'תרחיש חדש', y1: 3, y2: 3, y3: 3 }); scEditOpen = true; softRerender(); return;
      case 'sc-del': if (scDraft.length > 1) { scDraft.splice(+btn.getAttribute('data-i'), 1); scEditOpen = true; softRerender(); } return;
      case 'sc-reset': if (confirm('לטעון את תרחישי ברירת המחדל?')) { scDraft = clone(C.DEFAULT_SCENARIOS); scEditOpen = true; softRerender(); } return;
      case 'sc-save': {
        var bad = scDraft.some(function (x) { return !String(x.name).trim() || ['y1', 'y2', 'y3'].some(function (k) { var v = parseFloat(x[k]); return !isFinite(v) || v < -20 || v > 50; }); });
        if (bad) { toast('יש לבדוק שמות ושיעורים (בין ‎-20 ל-50)', 'err'); return; }
        btn.disabled = true;
        var t = nowIso();
        withSync(replaceRows('Scenarios', scDraft.map(function (x) { return { id: x.id, name: String(x.name).trim(), y1: C.num(x.y1), y2: C.num(x.y2), y3: C.num(x.y3), updatedAt: t }; })).then(loadScenarios), 'התרחישים נשמרו')
          .then(function () {
            if (!scenarioList().some(function (x) { return x.id === state.s.scenarioId; })) return saveSettings({ scenarioId: scenarioList()[0].id });
          }).then(function () { scEditOpen = false; scDraft = clone(scenarioList()).map(function (x) { delete x._row; return x; }); softRerender(); })
          .catch(handleError).then(function () { btn.disabled = false; });
        return;
      }
      case 'fill-base': {
        var ym = C.ymKey(draft.baseIndexMonth), raw = ym ? cbsValue(ym.y, ym.m) : null;
        if (raw == null) { toast('אין נתון בלמ״ס לחודש הזה', 'err'); return; }
        draft.baseIndex = String(raw);
        if (!draft.baseIndexLabel && state.cbs && state.cbs.base) draft.baseIndexLabel = state.cbs.base;
        softRerender(); toast('מדד הבסיס מולא לפי הלמ״ס (בסיס נוכחי). יש לוודא מול החוזה ולשמור.'); return;
      }
      case 'index-revert': if (form) { form.data.indexSource = ''; autofillIndex(); refreshIndexHint(); updateRequestCalc(); } return;
      case 'save-display': {
        var r = C.num(draft.vatRate, -1);
        if (r < 0 || r > 50) { toast('שיעור מע״מ לא תקין', 'err'); return; }
        btn.disabled = true;
        withSync(saveSettings({ vatMode: draft.vatMode, vatRate: draft.vatRate }), 'הגדרות התצוגה נשמרו').catch(handleError).then(function () { btn.disabled = false; });
        return;
      }
    }
  }
  function focusLast() {
    var names = document.querySelectorAll('.se-name');
    if (names.length) names[names.length - 1].focus();
  }

  // חידוש חיבור "שקוף": אם החיבור עומד לפוג, הלחיצה הבאה מחדשת אותו
  function maybeRenewOnGesture() {
    if ($('screen-app').hidden || pendingToken || !state.user) return;
    if (!tokenValid(5 * 60000)) requestToken().catch(function () { showReconnect(); });
  }

  // ---------- אתחול ----------
  function waitForGis(cb, tries) {
    tries = tries || 0;
    if (window.google && google.accounts && google.accounts.oauth2) return cb();
    if (tries > 100) { toast('לא ניתן לטעון את שירות ההתחברות של Google. בדוק את החיבור לאינטרנט.', 'err'); showLogin(); return; }
    setTimeout(function () { waitForGis(cb, tries + 1); }, 100);
  }
  function boot() {
    if (!C) { document.body.innerHTML = '<p style="padding:24px">קובץ calc.js חסר.</p>'; return; }
    if (!CFG.CLIENT_ID || /PASTE_YOUR_CLIENT_ID/.test(CFG.CLIENT_ID)) { show('screen-config'); return; }
    buildNav();
    window.addEventListener('hashchange', route);
    document.addEventListener('pointerdown', maybeRenewOnGesture, true);
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action]');
      if (b && !b.disabled) { e.preventDefault(); onAction(b.getAttribute('data-action'), b); }
    });
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    window.addEventListener('offline', function () { setSync('err', 'אין חיבור'); toast('החיבור לאינטרנט נותק', 'err'); });
    window.addEventListener('online', function () { setSync('', 'מחובר'); });

    $('btn-login').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      var force = !!storeGet('forceSelect');
      requestToken(force).then(function () { storeSet('forceSelect', null); return afterAuth(); }).catch(handleError).then(function () { btn.disabled = false; });
    });
    $('btn-create').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      loading('יוצר את התיקייה והגיליון ב-Drive…');
      createProject().then(function (proj) {
        toast('הפרויקט נוצר ב-Google Drive שלך', 'ok');
        return openProject(proj, true);
      }).catch(handleError).then(function () { btn.disabled = false; });
    });

    loading('טוען…');
    waitForGis(function () {
      initGis();
      if (restoreToken()) afterAuth(); else showLogin();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
