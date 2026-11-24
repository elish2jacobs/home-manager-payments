// Home Manager Payments — עדכון מדד תשומות הבנייה למגורים מהלמ"ס
// רץ ב-GitHub Actions. כותב את data/index.json רק כשיש מדד חדש.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = 'data/index.json';
const API = 'https://api.cbs.gov.il/index';
const CHAPTER = 'c'; // פרק "מדד מחירי תשומה בבנייה למגורים"
const FORCE = process.env.FORCE === 'true';

function israelToday() {
  const s = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Jerusalem', hour12: false });
  const [d] = s.split(',');
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}
// המדד של חודש M מתפרסם בסביבות ה-15 בחודש M+1
function expectedLatest() {
  const t = israelToday();
  let y = t.y, m = t.m - (t.day >= 15 ? 1 : 2);
  while (m < 1) { m += 12; y -= 1; }
  return { y, m };
}
const key = (y, m) => y * 100 + m;

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'home-manager-payments' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
// מחפש בעץ JSON כל אובייקט שנראה כמו "מדד": מזהה מספרי (5–6 ספרות) + שם
function findCodes(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => findCodes(n, out));
  else if (node && typeof node === 'object') {
    let code = null, name = null;
    for (const [k, v] of Object.entries(node)) {
      const val = Array.isArray(v) && v.length === 1 && typeof v[0] !== 'object' ? v[0] : v;
      if (code == null && /code|id/i.test(k) && /^\d{5,6}$/.test(String(val))) code = Number(val);
      if (name == null && /name|desc|title/i.test(k) && typeof val === 'string' && val.trim()) name = val.trim();
    }
    if (code != null && name) out.push({ code, name });
    Object.values(node).forEach(v => { if (v && typeof v === 'object') findCodes(v, out); });
  }
  return out;
}
const dedupe = list => list.filter((c, i) => list.findIndex(x => x.code === c.code) === i);
function choose(codes, label) {
  console.log(`Candidates from ${label}:`);
  codes.slice(0, 40).forEach(c => console.log('  ', c.code, c.name));
  const rel = codes.filter(c => /תשומ/.test(c.name) && /מגורים/.test(c.name));
  return rel.find(c => /כללי|סך הכל|סה"כ/.test(c.name)) || rel[0] ||
    codes.find(c => /כללי|סך הכל|סה"כ/.test(c.name)) || null;
}
async function discoverCode() {
  // 1) הפרק של תשומות הבנייה למגורים
  const ch = await getJson(`${API}/catalog/chapter?id=${CHAPTER}&format=json&download=false&lang=he`);
  console.log('Chapter response (start):', JSON.stringify(ch).slice(0, 1500));
  let codes = dedupe(findCodes(ch));
  let pick = codes.length ? choose(codes, 'chapter ' + CHAPTER) : null;
  // 2) כל קודי הנושאים בפרק
  if (!pick) {
    const subjIds = [];
    (function walk(n) {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) {
          const val = Array.isArray(v) && v.length === 1 && typeof v[0] !== 'object' ? v[0] : v;
          if (/subject.*id|^id$/i.test(k) && /^\d+$/.test(String(val))) subjIds.push(String(val));
        }
        Object.values(n).forEach(v => { if (v && typeof v === 'object') walk(v); });
      }
    })(ch);
    console.log('Subject ids found:', [...new Set(subjIds)].join(', ') || '(none)');
    for (const sid of [...new Set(subjIds)].slice(0, 10)) {
      try {
        const sub = await getJson(`${API}/catalog/subject?id=${sid}&format=json&download=false&lang=he`);
        console.log(`Subject ${sid} (start):`, JSON.stringify(sub).slice(0, 600));
        codes = dedupe(codes.concat(findCodes(sub)));
      } catch (e) { console.log('subject', sid, e.message); }
    }
    pick = codes.length ? choose(codes, 'subjects') : null;
  }
  // 3) עץ המדדים המלא
  if (!pick) {
    const tree = await getJson(`${API}/catalog/tree?format=json&download=false&lang=he`);
    console.log('Tree response (start):', JSON.stringify(tree).slice(0, 800));
    codes = dedupe(findCodes(tree));
    pick = choose(codes, 'tree');
  }
  if (!pick) throw new Error('Could not identify the index code automatically. Set INDEX_CODE (see log above for candidates).');
  console.log('Selected code:', pick.code, pick.name);
  return pick;
}

async function main() {
  let current = null;
  try { current = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* קובץ ראשון */ }

  const exp = expectedLatest();
  const last = current?.series?.at(-1);
  if (!FORCE && last && key(last.y, last.m) >= key(exp.y, exp.m)) {
    console.log(`Up to date: latest ${last.m}/${last.y}, expected ${exp.m}/${exp.y}. Nothing to do.`);
    return;
  }

  let code = Number(process.env.INDEX_CODE || current?.code || 0);
  let name = current?.name || '';
  if (!code) { const p = await discoverCode(); code = p.code; name = p.name; }

  const now = israelToday();
  const start = `01-${now.y - 6}`;
  const url = `${API}/data/price?id=${code}&format=json&download=false&lang=he&startPeriod=${start}&endPeriod=12-${now.y}`;
  console.log('Fetching', url);
  const data = await getJson(url);
  console.log('Price response (start):', JSON.stringify(data).slice(0, 800));
  const block = data?.month?.[0];
  if (!block?.date?.length) throw new Error('No monthly data returned: ' + JSON.stringify(data).slice(0, 300));
  name = block.name || name;
  const base = block.date[0]?.currBase?.baseDesc || '';
  const series = block.date
    .map(d => ({ y: Number(d.year), m: Number(d.month), v: Number(d.currBase?.value), pct: d.percent == null ? null : Number(d.percent), base: d.currBase?.baseDesc || '' }))
    .filter(d => d.y && d.m && Number.isFinite(d.v))
    .sort((a, b) => key(a.y, a.m) - key(b.y, b.m));
  if (!series.length) throw new Error('Parsed series is empty');

  const newest = series.at(-1);
  if (!FORCE && last && key(newest.y, newest.m) <= key(last.y, last.m)) {
    console.log(`CBS has not published ${exp.m}/${exp.y} yet (latest ${newest.m}/${newest.y}). Will retry next run.`);
    return;
  }
  const out = {
    source: 'הלשכה המרכזית לסטטיסטיקה',
    code, name, base: newest.base || base,
    updatedAt: new Date().toISOString(),
    latest: { y: newest.y, m: newest.m, v: newest.v },
    series: series.map(({ y, m, v, pct }) => ({ y, m, v, pct }))
  };
  await mkdir('data', { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Saved ${series.length} months. Latest: ${newest.m}/${newest.y} = ${newest.v} (${out.base})`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
