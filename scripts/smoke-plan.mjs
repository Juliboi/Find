// Temporary smoke test for plan-itinerary anchor-aware resolution + travel order.
// Run: node scripts/smoke-plan.mjs
import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const get = (k) => (env.match(new RegExp(`${k}=([^\\s]+)`)) || [])[1];
const URL = get('EXPO_PUBLIC_SUPABASE_URL');
const ANON = get('EXPO_PUBLIC_SUPABASE_ANON_KEY');
if (!URL || !ANON) throw new Error('missing supabase env');

const HOME = { label: 'Pekařova 859/12, Prague, Czechia', latitude: 50.1334340179313, longitude: 14.438005882025507 };

function haversine(a, b) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const body = {
  request:
    "I'm planning my day for 2026-06-12. I want to start at 09:00 and finish by 23:30.\n\n" +
    'Go to a maxfitness gym, deep work 2 hours at a caffee, language learning 1.5h, skincare, read before sleep. ' +
    'Also pick up toothpaste and mouthwash from a pharmacy.',
  date: '2026-06-12',
  now: '09:00',
  context: { home: HOME },
};

const t0 = Date.now();
const res = await fetch(`${URL}/functions/v1/plan-itinerary`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON}`, apikey: ANON },
  body: JSON.stringify(body),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`HTTP ${res.status} in ${elapsed}s`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
const plan = await res.json();
console.log(`\nTITLE: ${plan.title}\nSUMMARY: ${plan.summary}\n`);

let prev = HOME;
let prevName = 'HOME';
for (const section of plan.sections ?? []) {
  console.log(`\n=== ${section.title} (${section.period}) ===`);
  for (const it of section.items ?? []) {
    const p = it.place;
    const c = p?.coords;
    const fromHome = c ? (haversine(c, HOME) / 1000).toFixed(1) + 'km home' : '';
    const fromPrev = c ? (haversine(c, prev) / 1000).toFixed(1) + 'km prev(' + prevName + ')' : '';
    const venue = p ? `${p.name}${p.userNamed ? ' [userNamed]' : ''}${p.openStatus ? ' · ' + p.openStatus : ''}` : '(no place)';
    console.log(
      `  ${it.startTime}-${it.endTime} [${it.flexibility?.[0] ?? '?'}/${it.kind}] ${it.title}\n` +
        `      → ${venue}` + (c ? `  (${fromHome}, ${fromPrev})` : ''),
    );
    if (c) {
      prev = c;
      prevName = (p.name || it.title).slice(0, 14);
    }
  }
}
