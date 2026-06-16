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

// ─────────────────────────────────────────────────────────────────────────────
// Refine smoke (v3 second pass). Hands the refine-itinerary function a synthetic
// GROUNDED day with three planted problems and prints what it does:
//   • a CLOSED venue at its slot (bakery closes 10:00, scheduled 15:00),
//   • a big IDLE GAP (12:00–14:30) to fill,
//   • a long errand ("Language learning" 90m) that should SPLIT into sessions.
// Validates the deployed function end-to-end without the RN client. Best-effort.
// ─────────────────────────────────────────────────────────────────────────────
async function refineSmoke() {
  const refineBody = {
    intent: 'Make the day flow better; fix anything closed and use the dead time.',
    date: '2026-06-12',
    now: '09:00',
    dayStart: { time: '09:00', label: 'Home' },
    dayEnd: { time: '21:30', label: 'Home' },
    context: {
      home: HOME,
      wakeTime: '07:30',
      bedTime: '23:30',
      windDownTime: '21:30',
      meals: { lunch: { start: '12:00', end: '13:30' } },
      car: { owns: false, useToday: false },
    },
    anchors: [],
    tasks: [
      { id: 't-lang', title: 'Language learning', durationMin: 90 },
      { id: 't-skin', title: 'Skincare' },
    ],
    currentPlan: [
      { index: 0, start: '09:00', end: '10:30', title: 'Deep work', kind: 'work', venue: { name: 'Quiet Café' }, travel: { mode: 'walk', minutes: 8 } },
      { index: 1, start: '10:30', end: '12:00', title: 'Language learning', kind: 'activity', durationMin: 90, taskId: 't-lang' },
      { index: 2, start: '12:00', end: '14:30', title: 'Free time', kind: 'gap', isGap: true },
      { index: 3, start: '15:00', end: '15:30', title: 'Pick up sourdough', kind: 'errand', venue: { name: 'Morning Bakery', userNamed: true }, hours: { status: 'closed', closeHHMM: '10:00' } },
      { index: 4, start: '21:00', end: '21:30', title: 'Skincare', kind: 'break', taskId: 't-skin' },
    ],
  };

  const r0 = Date.now();
  const rRes = await fetch(`${URL}/functions/v1/refine-itinerary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: JSON.stringify(refineBody),
  });
  const rElapsed = ((Date.now() - r0) / 1000).toFixed(1);
  console.log(`\n\n########## REFINE-ITINERARY ##########\nHTTP ${rRes.status} in ${rElapsed}s`);
  if (!rRes.ok) {
    console.log(await rRes.text());
    return;
  }
  const refined = await rRes.json();
  console.log(`changed=${refined.changed}  notes=${JSON.stringify(refined.notes)}`);
  const langCount = (refined.blocks ?? []).filter((b) => b.taskId === 't-lang').length;
  console.log(`language sessions after refine: ${langCount} (expect ≥2 if split)`);
  for (const b of refined.blocks ?? []) {
    const ref = b.anchorId ? ` {a:${b.anchorId}}` : b.taskId ? ` {t:${b.taskId}}` : '';
    const where =
      b.placement === 'find' ? ` find="${b.findQuery}"` : b.placement === 'venue' ? ` venue="${b.userQuery}"` : ` (${b.placement})`;
    console.log(
      `  ${b.startTime ?? '--:--'} [${b.flexibility?.[0] ?? '?'}/${b.kind}] ${b.title}` +
        `${b.durationMin ? ` ~${b.durationMin}m` : ''}${where}${ref}`,
    );
  }
}

try {
  await refineSmoke();
} catch (e) {
  console.log(`\n[refine smoke] skipped: ${String(e?.message ?? e)}`);
}
