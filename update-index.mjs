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
function findCodes(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => findCodes(n, out));
  else if (node && typeof node === 'object') {
    if (node.codeId != null && node.codeName) out.push({ code: Number(node.codeId), name: String(node.codeName) });
    Object.values(node).forEach(v => findCodes(v, out));
  }
  return out;
}
async function discoverCode() {
  const data = await getJson(`${API}/catalog/chapter?id=${CHAPTER}&format=json&download=false&lang=he`);
  const codes = findCodes(data);
  console.log('Codes found in chapter', CHAPTER, ':');
  codes.slice(0, 40).forEach(c => console.log('  ', c.code, c.name));
  if (!codes.length) throw new Error('No index codes found in chapter ' + CHAPTER);
  const pick = codes.find(c => /כללי|סך הכל|סה"כ|כולל/.test(c.name)) || codes[0];
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
