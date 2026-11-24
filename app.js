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
    PaymentRequests: ['id', 'stageId', 'number', 'receivedDate', 'dueDate', 'baseAmount', 'indexValue', 'indexMonth', 'indexSource', 'indexAdj', 'finalAmount', 'notes', 'updatedAt'],
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
    stages: []        // ContractorStages
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
    return Promise.all([loadSettings(), loadStages()]).then(function () {
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
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="M20 6 9 17l-5-5"/>'
  };
  var ROUTES = [
    { id: 'dashboard', title: 'דשבורד', icon: 'home', mobile: true },
    { id: 'contractor', title: 'קבלן ואבני דרך', short: 'אבני דרך', icon: 'stages', mobile: true },
    { id: 'payments', title: 'מרכז תשלומים', short: 'תשלומים', icon: 'pay', mobile: true },
    { id: 'expenses', title: 'הוצאות נוספות', icon: 'expenses' },
    { id: 'calculator', title: 'מחשבון מדד', icon: 'calc' },
    { id: 'documents', title: 'מסמכים', icon: 'docs' },
    { id: 'contacts', title: 'אנשי קשר', icon: 'contacts' },
    { id: 'settings', title: 'הגדרות', icon: 'settings', mobile: true }
  ];
  var HIDDEN_ROUTES = [{ id: 'setup', title: 'הגדרת פרויקט', icon: 'settings' }];
  function icon(name, size) {
    size = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function buildNav() {
    $('nav').innerHTML = ROUTES.map(function (r) {
      return '<a href="#/' + r.id + '" data-route="' + r.id + '">' + icon(r.icon) + '<span>' + r.title + '</span></a>';
    }).join('');
    $('bottomnav').innerHTML = ROUTES.filter(function (r) { return r.mobile; }).map(function (r) {
      return '<a href="#/' + r.id + '" data-route="' + r.id + '">' + icon(r.icon) + '<span>' + (r.short || r.title) + '</span></a>';
    }).join('');
  }
  function currentRoute() {
    var id = (location.hash || '').replace(/^#\//, '');
    return ROUTES.concat(HIDDEN_ROUTES).filter(function (r) { return r.id === id; })[0] || ROUTES[0];
  }
  var lastRoute = null;
  function route() {
    if ($('screen-app').hidden) return;
    var r = currentRoute();
    if (r.id !== lastRoute) {
      if (r.id === 'settings') draft = makeDraft();
      if (r.id === 'setup') startWizard();
    }
    lastRoute = r.id;
    document.querySelectorAll('[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === r.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('view-title').textContent = r.title;
    $('view-sub').textContent = state.s.projectName || '';
    var view = $('view');
    view.innerHTML = (VIEWS[r.id] || placeholder)(r);
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
    'baseIndex', 'baseIndexMonth', 'exemptPct', 'linkedPct', 'indexRule', 'indexFloor'];
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
      field('baseIndexMonth', 'חודש מדד הבסיס', { type: 'month' }) +
      field('exemptPct', 'חלק פטור ממדד בתחילת החוזה (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) +
      field('linkedPct', 'אחוז צמוד מכל תשלום (%)', { type: 'number', step: 'any', inputmode: 'decimal', min: 0 }) +
      field('indexRule', 'מדד קובע', { type: 'select', options: [['request', 'המדד הידוע במועד דרישת התשלום'], ['payment', 'המדד הידוע במועד התשלום בפועל']] }) +
      field('indexFloor', 'ירידת מדד', { type: 'select', options: [['true', 'לא יורד מתחת למדד הבסיס'], ['false', 'מחושב גם בירידה']] }) +
      '</div>';
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
    ['basePrice', 'track', 'fixSurcharge', 't3Surcharge', 'baseIndex', 'baseIndexMonth', 'exemptPct', 'linkedPct', 'indexRule', 'indexFloor'].forEach(function (k) { o[k] = draft[k]; });
    withSync(saveSettings(o), 'החוזה נשמר').then(function () { logActivity('update', 'Settings', 'contract track=' + draft.track); })
      .catch(handleError).then(function () { btn.disabled = false; });
  }
  function saveStagesAction(btn) {
    var errs = C.validateStages(draftList()).errors;
    showErrors('err-stages', errs);
    if (errs.length) return;
    btn.disabled = true;
    var p = String(draft.track) === '3' ? saveSettings({ t3Schedule: draftSettingsPayload().t3Schedule }) : saveStages(draft.stages);
    withSync(p, 'לוח התשלומים נשמר').then(function () { logActivity('update', 'ContractorStages', ''); })
      .catch(handleError).then(function () { btn.disabled = false; });
  }

  // ---------- נתונים מחושבים ----------
  function currentSchedule() {
    var s = state.s;
    var list;
    if (String(s.track) === '3') {
      try { list = JSON.parse(s.t3Schedule || '[]'); } catch (e) { list = []; }
      if (!list.length) list = C.DEFAULT_T3;
    } else list = state.stages;
    return C.schedule(s, list);
  }
  function todayIso() { return C.isoDate(new Date()); }

  // ---------- מסכים ----------
  function placeholder(r) {
    return '<section class="card"><div class="empty">' + icon(r.icon, 28) +
      '<b>' + esc(r.title) + '</b><span>המסך הזה ייבנה בשלבים הבאים.</span></div></section>';
  }
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }
  function indexBadge(r) {
    if (r.indexMode === 'none') return '<span class="badge muted-b">ללא מדד</span>';
    if (r.indexMode === 'exempt') return '<span class="badge muted-b">פטור ממדד</span>';
    if (r.indexMode === 'partial') return '<span class="badge warn">צמוד חלקית · ' + C.fmtMoney(r.linkedBase) + '</span>';
    return '<span class="badge info">צמוד · ' + C.fmtMoney(r.linkedBase) + '</span>';
  }
  function needSetupCard() {
    return '<section class="card"><div class="empty">' + icon('settings', 28) + '<b>עוד לא הוגדר חוזה</b>' +
      '<span>כמה צעדים קצרים: מחיר, מסלול ולוח תשלומים.</span>' +
      '<a class="btn btn-primary" href="#/setup">להגדרת הפרויקט</a></div></section>';
  }

  var VIEWS = {
    setup: function () { return wizardView(); },
    settings: function () { return settingsView(); },

    contractor: function () {
      if (!isSetup()) return needSetupCard();
      var s = state.s;
      var rows = currentSchedule();
      var today = todayIso();
      var eff = C.effectivePrice(s);
      var head = '<section class="card"><div class="stats">' +
        stat('מחיר אפקטיבי', C.fmtMoney(eff)) +
        stat('מסלול', esc(C.TRACKS[s.track] ? C.TRACKS[s.track].name : '—')) +
        (String(s.track) === '1' ? stat('מדד בסיס', s.baseIndex ? '<span class="num">' + esc(s.baseIndex) + '</span>' + (s.baseIndexMonth ? ' <span class="muted small">(' + esc(s.baseIndexMonth.split('-').reverse().join('/')) + ')</span>' : '') : '<a href="#/settings">להזנה</a>') : stat('תוספת', C.fmtMoney(eff - C.num(s.basePrice)))) +
        stat('תשלומים', rows.length) +
        '</div></section>';
      var list = rows.map(function (r, i) {
        var past = r.date && r.date < today;
        return '<li class="stage' + (past ? ' past' : '') + '">' +
          '<div class="stage-main"><span class="stage-n">' + (i + 1) + '</span><div><b>' + esc(r.name) + '</b>' +
          '<div class="muted small">' + C.fmtPct(r.pct) + ' · חודש ' + r.month + (r.date ? ' · ' + C.fmtDate(r.date) : '') + '</div></div></div>' +
          '<div class="stage-side"><b class="num">' + C.fmtMoney(r.base) + '</b>' + indexBadge(r) + '</div></li>';
      }).join('');
      return head + '<section class="card"><div class="row between"><h2>לוח התשלומים</h2><a class="btn btn-ghost btn-sm" href="#/settings">עריכה</a></div>' +
        '<ul class="stages">' + list + '</ul>' +
        '<p class="hint">הסכומים הם סכומי בסיס. ההצמדה בפועל תחושב לפי דרישות התשלום והמדד (שלב הבא).</p></section>';
    },

    dashboard: function () {
      if (!isSetup()) return needSetupCard();
      var s = state.s;
      var rows = currentSchedule();
      var eff = C.effectivePrice(s);
      var today = todayIso();
      var next = rows.filter(function (r) { return r.date && r.date >= today; })[0];
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
      var hero = '<section class="card hero"><div class="row between"><span class="muted">התחייבות לקבלן (לפני הצמדה)</span><span class="badge info">' + esc(C.TRACKS[s.track].short) + '</span></div>' +
        '<div class="hero-num num">' + C.fmtMoney(eff) + '</div>' +
        '<div class="bar"><div style="width:0%"></div></div>' +
        '<div class="stats">' + stat('שולם בפועל', C.fmtMoney(0)) + stat('יתרה לתשלום', C.fmtMoney(eff)) +
        stat(String(s.track) === '1' ? 'חלק צמוד בסה״כ' : 'תוספת חוזית', C.fmtMoney(String(s.track) === '1' ? rows.reduce(function (a, r) { return a + r.linkedBase; }, 0) : eff - C.num(s.basePrice))) + '</div>' +
        '<p class="hint">רישום תשלומים ודרישות ייפתח בשלב הבא.</p></section>';
      var nextCard = next ? '<section class="card"><div class="row between"><h2>התשלום הבא</h2><span class="badge muted-b">מתוכנן</span></div>' +
        '<div><b style="font-size:18px">' + esc(next.name) + '</b><div class="muted small">צפוי ב-' + C.fmtDate(next.date) + ' · חודש ' + next.month + ' לפרויקט</div></div>' +
        kv('סכום בסיס', '<b class="num">' + C.fmtMoney(next.base) + '</b>') + kv('הצמדה', indexBadge(next)) + '</section>' : '';
      return '<div class="grid">' + hero + nextCard + '</div>' + timeline;
    }
  };
  function stat(label, value) { return '<div class="stat"><span class="muted small">' + label + '</span><b>' + value + '</b></div>'; }

  function afterRender(id) {
    if (id === 'setup' || id === 'settings') updateEditorSummary();
  }

  // ---------- אירועים ----------
  function onInput(e) {
    var t = e.target;
    if (!draft) return;
    if (t.hasAttribute('data-k')) {
      var k = t.getAttribute('data-k');
      draft[k] = t.value;
      if (t.hasAttribute('data-money')) { var h = $('h-' + k); if (h) h.textContent = t.value ? C.fmtMoney(C.num(t.value)) : ''; }
      if (['fixSurcharge', 't3Surcharge', 'exemptPct', 'linkedPct'].indexOf(k) >= 0) refreshTrackDescs();
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
