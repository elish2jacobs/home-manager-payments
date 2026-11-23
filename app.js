/* Home Manager Payments — שלב 1: התחברות, Drive, Sheets ושלד ניווט */
(function () {
  'use strict';

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

  // מבנה הגיליונות: שם → כותרות עמודות
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
    settings: {}
  };
  var tokenClient = null;
  var pendingToken = null;

  // ---------- עזרים ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nowIso() { return new Date().toISOString(); }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
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

  function tokenValid() { return state.token && Date.now() < state.tokenExp - 60000; }

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
          p.reject(new AuthError('לא אושרה גישה ל-Google Drive. יש לאשר את ההרשאה כדי שהאפליקציה תוכל לשמור את הנתונים שלך.'));
          return;
        }
        state.token = resp.access_token;
        state.tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        sessSet('token', JSON.stringify({ v: state.token, exp: state.tokenExp }));
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

  // חייב להיקרא מתוך לחיצה של המשתמש (אחרת הדפדפן חוסם את החלון)
  function requestToken() {
    return new Promise(function (resolve, reject) {
      pendingToken = { resolve: resolve, reject: reject };
      var hint = storeGet('email');
      tokenClient.requestAccessToken(hint ? { prompt: '', hint: hint } : { prompt: 'consent' });
    });
  }

  function logout() {
    if (state.token && window.google && google.accounts) {
      try { google.accounts.oauth2.revoke(state.token, function () {}); } catch (e) { /* ignore */ }
    }
    state.token = null; state.tokenExp = 0; state.user = null;
    sessSet('token', null);
    storeSet('email', null);
    storeSet('rootId', null);
    showLogin();
  }

  // ---------- קריאות API ----------
  function api(url, opts) {
    opts = opts || {};
    if (!tokenValid()) return Promise.reject(new AuthError('פג תוקף החיבור. יש להתחבר מחדש.'));
    var headers = { Authorization: 'Bearer ' + state.token };
    if (opts.body && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    return fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body }).then(function (r) {
      if (r.status === 401) { state.token = null; sessSet('token', null); throw new AuthError('פג תוקף החיבור. יש להתחבר מחדש.'); }
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var m = (j.error && j.error.message) || ('שגיאה ' + r.status);
          throw new Error(m);
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  function driveList(q, fields) {
    var u = DRIVE + '/files?spaces=drive&pageSize=20&q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(' + (fields || 'id,name,webViewLink') + ')');
    return api(u).then(function (r) { return r.files || []; });
  }
  function driveCreate(meta) {
    return api(DRIVE + '/files?fields=id,name,webViewLink', { method: 'POST', body: meta });
  }

  function a1(sheet, range) { return encodeURIComponent("'" + sheet + "'!" + range); }

  // ---------- פרויקט ----------
  function findProject() {
    return driveList("appProperties has { key='hmRole' and value='root' } and mimeType='" + FOLDER_MIME + "' and trashed=false")
      .then(function (folders) {
        if (!folders.length) return null;
        var root = folders[0];
        return driveList("'" + root.id + "' in parents and appProperties has { key='hmRole' and value='data' } and trashed=false")
          .then(function (files) {
            return { root: root, sheet: files[0] || null };
          });
      });
  }

  function createProject() {
    var root;
    return driveCreate({ name: ROOT_NAME, mimeType: FOLDER_MIME, appProperties: { hmApp: 'hmp', hmRole: 'root' } })
      .then(function (r) {
        root = r;
        return SUBFOLDERS.reduce(function (p, name, i) {
          return p.then(function () {
            return driveCreate({ name: name, mimeType: FOLDER_MIME, parents: [root.id], appProperties: { hmApp: 'hmp', hmRole: 'sub' + (i + 1) } });
          });
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
        var requests = [{
          updateSheetProperties: {
            properties: { sheetId: firstId, title: names[0], rightToLeft: true, gridProperties: { frozenRowCount: 1 } },
            fields: 'title,rightToLeft,gridProperties.frozenRowCount'
          }
        }];
        names.slice(1).forEach(function (n) {
          requests.push({ addSheet: { properties: { title: n, rightToLeft: true, gridProperties: { frozenRowCount: 1 } } } });
        });
        return api(SHEETS + '/' + file.id + ':batchUpdate', { method: 'POST', body: { requests: requests } });
      })
      .then(function () {
        var t = nowIso();
        var data = Object.keys(SHEETS_SCHEMA).map(function (n) {
          return { range: "'" + n + "'!A1", values: [SHEETS_SCHEMA[n]] };
        });
        data.push({
          range: "'Settings'!A2",
          values: [['schemaVersion', String(SCHEMA_VERSION), t], ['createdAt', t, t], ['setupComplete', 'false', t]]
        });
        return api(SHEETS + '/' + file.id + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: data } });
      })
      .then(function () { return file; });
  }

  function loadSettings() {
    return api(SHEETS + '/' + state.sheetId + '/values/' + a1('Settings', 'A2:C')).then(function (r) {
      var s = {};
      (r.values || []).forEach(function (row, i) { if (row[0]) s[row[0]] = { value: row[1], updatedAt: row[2], row: i + 2 }; });
      state.settings = s;
      return s;
    });
  }

  function setSetting(key, value) {
    var t = nowIso();
    setSync('busy', 'שומר…');
    return loadSettings().then(function (s) {
      var row = [key, String(value), t];
      if (s[key]) {
        return api(SHEETS + '/' + state.sheetId + '/values/' + a1('Settings', 'A' + s[key].row + ':C' + s[key].row) + '?valueInputOption=RAW',
          { method: 'PUT', body: { values: [row] } });
      }
      return api(SHEETS + '/' + state.sheetId + '/values/' + a1('Settings', 'A:C') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { method: 'POST', body: { values: [row] } });
    }).then(function () {
      return loadSettings();
    }).then(function (s) {
      setSync('', 'נשמר');
      return s[key];
    }, function (e) {
      setSync('err', 'שמירה נכשלה');
      throw e;
    });
  }

  // ---------- זרימת כניסה ----------
  function showLogin() {
    var email = storeGet('email');
    $('btn-login').textContent = email ? 'המשך' : 'התחבר עם Google';
    $('login-hint').textContent = email ? 'כניסה בתור ' + email : '';
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

  function openProject(proj) {
    state.rootId = proj.root.id; state.rootLink = proj.root.webViewLink;
    state.sheetId = proj.sheet.id; state.sheetLink = proj.sheet.webViewLink;
    storeSet('rootId', state.rootId);
    loading('טוען נתונים…');
    return loadSettings().then(function () {
      show('screen-app');
      renderUser();
      setSync('', 'מחובר');
      route();
    });
  }

  function handleError(e) {
    console.error('[HMP]', e);
    if (e instanceof AuthError) { showLogin(); toast(e.message, 'err'); return; }
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
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'
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
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
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
    return ROUTES.filter(function (r) { return r.id === id; })[0] || ROUTES[0];
  }
  function route() {
    if ($('screen-app').hidden) return;
    var r = currentRoute();
    document.querySelectorAll('[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === r.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('view-title').textContent = r.title;
    $('view-sub').textContent = '';
    var view = $('view');
    view.innerHTML = (VIEWS[r.id] || placeholder)(r);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function renderUser() {
    var u = state.user || {};
    $('user-box').innerHTML = '<div><b>' + esc(u.name || '') + '</b></div><div>' + esc(u.email || '') + '</div>';
  }

  // ---------- מסכים ----------
  function placeholder(r) {
    return '<section class="card"><div class="empty">' + icon(r.icon) +
      '<b>' + esc(r.title) + '</b><span>המסך הזה ייבנה בשלבים הבאים.</span></div></section>';
  }

  var VIEWS = {
    dashboard: function () {
      var setup = state.settings.setupComplete && state.settings.setupComplete.value === 'true';
      var test = state.settings.lastTest;
      return (setup ? '' :
        '<div class="banner"><span>השלם את הגדרת הפרויקט: מחיר, מסלול חוזה ולוח תשלומים.</span>' +
        '<a class="btn btn-sm btn-primary" href="#/settings">להגדרות</a></div>') +
        '<div class="grid">' +
        '<section class="card"><h2>חיבור לענן</h2>' +
        kv('חשבון', esc(state.user && state.user.email)) +
        kv('תיקייה ב-Drive', '<a href="' + esc(state.rootLink) + '" target="_blank" rel="noopener">' + esc(ROOT_NAME) + '</a>') +
        kv('קובץ נתונים', '<a href="' + esc(state.sheetLink) + '" target="_blank" rel="noopener">' + esc(DATA_NAME) + '</a>') +
        kv('מצב', '<span class="badge ok">מחובר</span>') +
        '</section>' +
        '<section class="card"><h2>בדיקת שמירה</h2>' +
        '<p class="muted small" style="margin:0">כותב ערך לגיליון וקורא אותו בחזרה, כדי לוודא שהשמירה עובדת.</p>' +
        kv('בדיקה אחרונה', '<span class="num" id="last-test">' + fmtDateTime(test && test.value) + '</span>') +
        '<div class="row"><button type="button" class="btn btn-secondary" data-action="test-save">בצע בדיקה</button></div>' +
        '</section>' +
        '</div>';
    }
  };
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }

  // ---------- פעולות ----------
  function onAction(name, btn) {
    if (name === 'logout') { logout(); return; }
    if (name === 'test-save') {
      btn.disabled = true;
      var stamp = nowIso();
      setSetting('lastTest', stamp).then(function (saved) {
        if (saved && saved.value === stamp) {
          $('last-test').textContent = fmtDateTime(saved.value);
          toast('נשמר ונקרא בהצלחה מהגיליון', 'ok');
        } else {
          toast('הערך שנקרא לא תואם למה שנשמר', 'err');
        }
      }).catch(handleError).then(function () { btn.disabled = false; });
    }
  }

  // ---------- אתחול ----------
  function waitForGis(cb, tries) {
    tries = tries || 0;
    if (window.google && google.accounts && google.accounts.oauth2) return cb();
    if (tries > 100) { toast('לא ניתן לטעון את שירות ההתחברות של Google. בדוק את החיבור לאינטרנט.', 'err'); showLogin(); return; }
    setTimeout(function () { waitForGis(cb, tries + 1); }, 100);
  }

  function boot() {
    if (!CFG.CLIENT_ID || /PASTE_YOUR_CLIENT_ID/.test(CFG.CLIENT_ID)) { show('screen-config'); return; }
    buildNav();
    window.addEventListener('hashchange', route);
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action]');
      if (b) { e.preventDefault(); onAction(b.getAttribute('data-action'), b); }
    });
    window.addEventListener('offline', function () { setSync('err', 'אין חיבור'); toast('החיבור לאינטרנט נותק', 'err'); });
    window.addEventListener('online', function () { setSync('', 'מחובר'); });

    $('btn-login').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      requestToken().then(afterAuth).catch(handleError).then(function () { btn.disabled = false; });
    });
    $('btn-create').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      loading('יוצר את התיקייה והגיליון ב-Drive…');
      createProject().then(function (proj) {
        toast('הפרויקט נוצר ב-Google Drive שלך', 'ok');
        return openProject(proj);
      }).catch(handleError).then(function () { btn.disabled = false; });
    });

    loading('טוען…');
    waitForGis(function () {
      initGis();
      // כניסה חוזרת באותה לשונית, בתוך שעה: בלי לחיצה
      if (restoreToken()) afterAuth(); else showLogin();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
