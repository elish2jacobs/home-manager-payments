/* Home Manager Payments — חישובי חוזה (ללא תלות בממשק) */
(function (root) {
  'use strict';

  var TRACKS = {
    1: { id: 1, name: 'אבני דרך + הצמדה', short: 'הצמדה למדד' },
    2: { id: 2, name: 'אבני דרך + קיבוע', short: 'קיבוע' },
    3: { id: 3, name: 'תשלום מוקדם / במסירה', short: 'מוקדם / במסירה' }
  };

  // לוח ברירת מחדל (מסלולים 1–2)
  var DEFAULT_STAGES = [
    { name: 'מעמד החתימה', pct: 7, month: 0 },
    { name: 'תוך 60 יום', pct: 13, month: 2 },
    { name: 'גמר רצפה', pct: 11, month: 10 },
    { name: 'גמר שלד קומות מתחת', pct: 25, month: 12 },
    { name: 'גמר שלד כל הבניין', pct: 5, month: 15 },
    { name: 'גמר חיפוי חוץ', pct: 6, month: 18 },
    { name: 'גמר טיח וריצוף', pct: 10, month: 30 },
    { name: 'גמר חיפוי פנים', pct: 13, month: 32 },
    { name: 'גמר מערכות משותפות', pct: 5, month: 34 },
    { name: 'מסירת המפתח', pct: 5, month: 40 }
  ];
  // לוח ברירת מחדל (מסלול 3)
  var DEFAULT_T3 = [
    { name: 'מעמד החתימה', pct: 7, month: 0 },
    { name: 'תוך 60 יום', pct: 13, month: 2 },
    { name: 'מסירת המפתח', pct: 80, month: 40 }
  ];

  var DEFAULT_SETTINGS = {
    vatMode: 'incl', vatRate: '18', scenarioId: 'g',
    track: '1', exemptPct: '20', linkedPct: '50', fixSurcharge: '4', t3Surcharge: '7',
    indexRule: 'request', indexFloor: 'true'
  };

  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], 12);
  }
  function isoDate(d) {
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function addMonths(d, m) {
    var r = new Date(d.getTime());
    var day = r.getDate();
    r.setDate(1);
    r.setMonth(r.getMonth() + m);
    var last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(day, last));
    return r;
  }
  function fmtDate(s) {
    var d = typeof s === 'string' ? parseDate(s) : s;
    if (!d) return '—';
    var p = function (n) { return ('0' + n).slice(-2); };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US') + ' ₪';
  }
  function fmtPct(n) {
    return (Math.round(n * 100) / 100).toString() + '%';
  }

  function effectivePrice(s) {
    var P = num(s.basePrice);
    var t = String(s.track || '1');
    if (t === '2') return round2(P * (1 + num(s.fixSurcharge) / 100));
    if (t === '3') return round2(P * (1 + num(s.t3Surcharge) / 100));
    return round2(P);
  }

  /**
   * מחשב את לוח התשלומים.
   * s: הגדרות (מחרוזות), stages: [{name,pct,month,indexExempt:'auto'|'yes'|'no'}]
   * מחזיר שורות עם סכום בסיס, חלק פטור, חלק צמוד ותאריך משוער.
   */
  function schedule(s, stages) {
    var t = String(s.track || '1');
    var eff = effectivePrice(s);
    var sign = parseDate(s.signDate);
    var exemptLimit = num(s.exemptPct, 20);
    var linkedPct = num(s.linkedPct, 50) / 100;
    var cum = 0;
    return (stages || []).map(function (st, i) {
      var pct = num(st.pct);
      var base = round2(eff * pct / 100);
      var exemptPctPart = 0;
      if (t === '1') {
        var mode = st.indexExempt || 'auto';
        if (mode === 'yes') exemptPctPart = pct;
        else if (mode === 'no') exemptPctPart = 0;
        else exemptPctPart = Math.max(0, Math.min(pct, exemptLimit - cum));
      } else {
        exemptPctPart = pct;
      }
      cum += pct;
      var exemptBase = round2(eff * exemptPctPart / 100);
      var indexableBase = round2(base - exemptBase);
      var linkedBase = t === '1' ? round2(indexableBase * linkedPct) : 0;
      var date = sign ? addMonths(sign, num(st.month)) : null;
      return {
        i: i, name: st.name, pct: pct, month: num(st.month), date: date ? isoDate(date) : '',
        base: base, exemptBase: exemptBase, linkedBase: linkedBase,
        indexMode: t !== '1' ? 'none' : (exemptPctPart >= pct ? 'exempt' : (exemptPctPart > 0 ? 'partial' : 'linked'))
      };
    });
  }

  function validateStages(stages) {
    var errs = [];
    if (!stages || !stages.length) errs.push('יש להזין לפחות תשלום אחד');
    var sum = 0;
    (stages || []).forEach(function (st, i) {
      if (!String(st.name || '').trim()) errs.push('שורה ' + (i + 1) + ': חסר שם');
      var p = parseFloat(st.pct);
      if (!isFinite(p) || p <= 0) errs.push('שורה ' + (i + 1) + ': אחוז לא תקין');
      var m = parseFloat(st.month);
      if (!isFinite(m) || m < 0) errs.push('שורה ' + (i + 1) + ': חודש לא תקין');
      sum += isFinite(p) ? p : 0;
    });
    if (Math.abs(sum - 100) > 0.001) errs.push('סכום האחוזים הוא ' + round2(sum) + '% — צריך להיות 100%');
    return { ok: !errs.length, errors: errs, sum: round2(sum) };
  }

  function sumPct(stages) {
    return round2((stages || []).reduce(function (a, st) { return a + num(st.pct); }, 0));
  }


  /**
   * חישוב דרישת תשלום (מסלול 1).
   * row: שורת לוח מ-schedule; reqBase: סכום הבסיס של הדרישה; idx: המדד הקובע
   * החלק הצמוד של הדרישה יחסי לחלקה מסכום הבסיס של אבן הדרך.
   */
  function requestCalc(s, row, reqBase, idx) {
    reqBase = num(reqBase);
    var res = { base: round2(reqBase), linked: 0, rate: null, adj: 0, final: round2(reqBase) };
    if (String(s.track || '1') !== '1' || !row || !(row.base > 0)) return res;
    res.linked = round2(row.linkedBase * (reqBase / row.base));
    var bi = num(s.baseIndex), ci = num(idx);
    if (!(bi > 0) || !(ci > 0)) { res.rate = null; return res; }
    var rate = ci / bi - 1;
    if (String(s.indexFloor) !== 'false' && rate < 0) rate = 0;
    res.rate = rate;
    res.adj = round2(res.linked * rate);
    res.final = round2(res.base + res.adj);
    return res;
  }

  /**
   * מצב אבן דרך לפי דרישות ותשלומים.
   * מחזיר: expected (סכום צפוי), requested, paid, remaining, status, overdue
   */
  function stageStatus(row, reqs, pays, today) {
    var reqBase = 0, reqFinal = 0, adj = 0;
    reqs.forEach(function (r) { reqBase += num(r.baseAmount); reqFinal += num(r.finalAmount); adj += num(r.indexAdj); });
    var paid = pays.reduce(function (a, p) { return a + num(p.amount); }, 0);
    var notRequested = Math.max(0, row.base - reqBase);
    var expected = round2(reqFinal + notRequested);
    var remaining = round2(expected - paid);
    var status;
    if (paid > 0 && remaining <= 0.5) status = 'paid';
    else if (paid > 0) status = 'partial';
    else if (reqs.length) status = 'requested';
    else status = 'planned';
    var overdue = status !== 'paid' && !!row.date && !!today && row.date < today;
    return { expected: expected, requested: round2(reqFinal), adj: round2(adj), paid: round2(paid), remaining: remaining, status: status, overdue: overdue };
  }
  var STATUS_LABEL = { planned: 'מתוכנן', requested: 'התקבלה דרישה', partial: 'שולם חלקית', paid: 'שולם' };

  var HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  function monthName(y, m) { return HE_MONTHS[m - 1] + ' ' + y; }
  // המדד של חודש M מתפרסם בערב ה-15 בחודש M+1. לכן החל מה-16 הוא "ידוע".
  function knownMonthFor(dateIso) {
    var d = parseDate(dateIso); if (!d) return null;
    var y = d.getFullYear(), m = d.getMonth() + 1 - (d.getDate() >= 16 ? 1 : 2);
    while (m < 1) { m += 12; y -= 1; }
    return { y: y, m: m };
  }
  function nextPublication(latest) {
    if (!latest) return null;
    var y = latest.y, m = latest.m + 2; // מדד החודש הבא מתפרסם ב-15 לחודש שאחריו
    while (m > 12) { m -= 12; y += 1; }
    return { y: y, m: m, day: 15 };
  }
  function ymKey(s) { var p = String(s || '').split('-'); return p.length === 2 ? { y: +p[0], m: +p[1] } : null; }

  // תרחישי אינפלציה (שיעור שנתי לשנה 1/2/3 של הפרויקט) — ברירות מחדל מהאקסל
  var DEFAULT_SCENARIOS = [
    { id: 'boi', name: 'בנק ישראל — ריאלי', y1: 1.8, y2: 1.8, y3: 1.8 },
    { id: 'a', name: 'א — גבוה ממוצע', y1: 4.4, y2: 5.0, y3: 3.0 },
    { id: 'b', name: 'ב — שיא בהתחלה', y1: 5.0, y2: 4.4, y3: 3.0 },
    { id: 'c', name: 'ג — שיא באמצע', y1: 3.0, y2: 5.0, y3: 4.4 },
    { id: 'd', name: 'ד — מתון־גבוה', y1: 1.8, y2: 4.5, y3: 3.5 },
    { id: 'e', name: 'ה — שיא בשלד', y1: 2.5, y2: 6.0, y3: 2.0 },
    { id: 'f', name: 'ו — שיא בסוף', y1: 2.0, y2: 2.5, y3: 6.5 },
    { id: 'g', name: 'ז — אחיד', y1: 3.0, y2: 3.0, y3: 3.0 }
  ];
  // שנת פרויקט (1–3) של חודש מסוים, לפי תאריך החתימה. אחרי שנה 3 — נשאר 3.
  function projectYear(y, m, signIso) {
    var sd = parseDate(signIso); if (!sd) return 1;
    var months = (y - sd.getFullYear()) * 12 + (m - (sd.getMonth() + 1));
    return months < 12 ? 1 : (months < 24 ? 2 : 3);
  }
  /**
   * תחזית מדד: מתחילים מערך ידוע (fromY/fromM) ומתקדמים חודש-חודש עד החודש המבוקש,
   * בריבית חודשית שנגזרת מהשיעור השנתי של שנת הפרויקט.
   */
  function forecastIndex(fromVal, fromY, fromM, toY, toM, sc, signIso) {
    var v = num(fromVal), y = fromY, m = fromM;
    if (!(v > 0)) return null;
    var guard = 0;
    while ((y * 100 + m) < (toY * 100 + toM) && guard++ < 600) {
      m++; if (m > 12) { m = 1; y++; }
      var py = projectYear(y, m, signIso);
      var annual = num(py === 1 ? sc.y1 : (py === 2 ? sc.y2 : sc.y3)) / 100;
      v = v * Math.pow(1 + annual, 1 / 12);
    }
    return v;
  }

  var DEFAULT_CATEGORIES = ['מטבח', 'גינה ופיתוח חוץ', 'נגרות', 'שינויי דיירים', 'הוצאות משפטיות', 'הוצאות רכישה ומימון', 'ריהוט', 'תאורה', 'מוצרי חשמל', 'מיזוג אוויר', 'תקשורת ובית חכם', 'אלומיניום ותריסים', 'שונות'];
  var EXP_STATUS = { planning: 'בתכנון', quote: 'הצעת מחיר', committed: 'התחייבות', partial: 'שולם חלקית', paid: 'שולם', cancelled: 'בוטל' };
  // מצב הוצאה: בוטל ידני גובר; אחרת לפי תשלומים מול ההתחייבות; אחרת המצב הידני
  function expenseCalc(e, pays) {
    var paid = round2((pays || []).reduce(function (a, p) { return a + num(p.amount); }, 0));
    var commit = num(e.commitment), est = num(e.estimate);
    var status = e.status || 'planning';
    if (status !== 'cancelled') {
      if (commit > 0 && paid >= commit - 0.5) status = 'paid';
      else if (paid > 0) status = 'partial';
      else if (commit > 0 && (status === 'planning' || status === 'quote')) status = 'committed';
    }
    var value = status === 'cancelled' ? 0 : (commit > 0 ? commit : est);
    return { paid: paid, commit: status === 'cancelled' ? 0 : commit, est: est, value: value, remaining: round2(Math.max(0, (commit > 0 ? commit : 0) - paid)), status: status };
  }

  var api = {
    TRACKS: TRACKS, DEFAULT_STAGES: DEFAULT_STAGES, DEFAULT_T3: DEFAULT_T3, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    num: num, round2: round2, parseDate: parseDate, isoDate: isoDate, addMonths: addMonths,
    fmtDate: fmtDate, fmtMoney: fmtMoney, fmtPct: fmtPct,
    effectivePrice: effectivePrice, schedule: schedule, requestCalc: requestCalc, stageStatus: stageStatus, STATUS_LABEL: STATUS_LABEL, HE_MONTHS: HE_MONTHS, DEFAULT_CATEGORIES: DEFAULT_CATEGORIES, EXP_STATUS: EXP_STATUS, expenseCalc: expenseCalc, DEFAULT_SCENARIOS: DEFAULT_SCENARIOS, projectYear: projectYear, forecastIndex: forecastIndex, monthName: monthName, knownMonthFor: knownMonthFor, nextPublication: nextPublication, ymKey: ymKey, validateStages: validateStages, sumPct: sumPct
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HMCalc = api;
})(this);
