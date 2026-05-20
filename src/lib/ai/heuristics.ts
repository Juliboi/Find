import { Plan, SubTask } from '@/types/plan';
import { uid } from '@/utils/id';

/**
 * Pattern definitions used to enrich free-form user input when no LLM is
 * available. Each pattern provides default duration, sensible sub-steps and
 * the kind of clarification we expect from the user.
 *
 * The order here matters - earlier entries win when text matches multiple.
 */
interface PlanPattern {
  test: RegExp;
  category:
    | 'gym'
    | 'cook'
    | 'eat-out'
    | 'shop'
    | 'work'
    | 'study'
    | 'walk'
    | 'meeting'
    | 'errand'
    | 'relax'
    | 'commute'
    | 'generic';
  defaultDuration: number;
  subtasks?: Omit<SubTask, 'id'>[];
  /** A location-style clarification (where do you want to do this?). */
  locationQuestion?: string;
  locationSuggestions?: string[];
  /** A softer clarification (what / details), used only when no location is needed. */
  detailQuestion?: string;
  detailSuggestions?: string[];
}

const PATTERNS: PlanPattern[] = [
  {
    test: /\b(gym|workout|lift|crossfit|yoga|pilates|spin class)\b/i,
    category: 'gym',
    defaultDuration: 75,
    subtasks: [
      { title: 'Warm up', durationMinutes: 10 },
      { title: 'Main workout', durationMinutes: 45 },
      { title: 'Cooldown & shower', durationMinutes: 20 },
    ],
    locationQuestion: 'Which gym are you heading to?',
    locationSuggestions: ['My usual gym', 'Closest gym', 'Find a new one nearby'],
  },
  {
    test: /\b(run|jog|running)\b/i,
    category: 'walk',
    defaultDuration: 45,
    subtasks: [
      { title: 'Warm up & stretch', durationMinutes: 5 },
      { title: 'Run', durationMinutes: 30 },
      { title: 'Cooldown', durationMinutes: 10 },
    ],
    locationQuestion: 'Where do you want to run?',
    locationSuggestions: ['Nearby park', 'Riverside path', 'Around the block'],
  },
  {
    test: /\b(cook|cooking|make dinner|make lunch|make breakfast|meal prep)\b/i,
    category: 'cook',
    defaultDuration: 75,
    subtasks: [
      { title: 'Plan recipe & prep ingredients', durationMinutes: 15 },
      { title: 'Cook', durationMinutes: 40 },
      { title: 'Eat', durationMinutes: 15 },
      { title: 'Clean up kitchen', durationMinutes: 15 },
    ],
    detailQuestion: 'Anything specific you want to cook? (optional)',
    detailSuggestions: ['Something quick', 'Use what I have', "I'll decide later"],
  },
  {
    test: /\b(grocery|groceries|supermarket|shopping)\b/i,
    category: 'shop',
    defaultDuration: 45,
    subtasks: [
      { title: 'Make a list', durationMinutes: 5 },
      { title: 'Travel to store', durationMinutes: 10 },
      { title: 'Shop', durationMinutes: 25 },
      { title: 'Put things away', durationMinutes: 5 },
    ],
    locationQuestion: 'Which store?',
    locationSuggestions: ['Closest grocery', 'Usual supermarket', "I'll decide on the way"],
  },
  {
    test: /\b(lunch|dinner|breakfast|brunch|coffee|cafe|restaurant)\b/i,
    category: 'eat-out',
    defaultDuration: 60,
    locationQuestion: 'Where would you like to go?',
    locationSuggestions: ['Closest highly-rated spot', 'My favorite place', 'Somewhere new'],
  },
  {
    test: /\b(meeting|standup|stand-up|call|interview|1:1|one on one)\b/i,
    category: 'meeting',
    defaultDuration: 30,
    detailQuestion: 'Do you have a specific time for this meeting?',
    detailSuggestions: ['Flexible', "I'll set the time", 'Already on my calendar'],
  },
  {
    test: /\b(work|emails?|deep work|focus|coding|design)\b/i,
    category: 'work',
    defaultDuration: 90,
    subtasks: [
      { title: 'Plan what to tackle', durationMinutes: 10 },
      { title: 'Focused work', durationMinutes: 70 },
      { title: 'Wrap up & notes', durationMinutes: 10 },
    ],
  },
  {
    test: /\b(study|read|reading|review)\b/i,
    category: 'study',
    defaultDuration: 60,
    detailQuestion: 'What do you want to study or read?',
    detailSuggestions: ['Continue current topic', 'Something light', "I'll pick on the spot"],
  },
  {
    test: /\b(walk|stroll|hike)\b/i,
    category: 'walk',
    defaultDuration: 40,
    locationQuestion: 'Where do you want to walk?',
    locationSuggestions: ['Nearby park', 'Scenic route', 'Just around'],
  },
  {
    test: /\b(relax|nap|chill|rest|break|meditate)\b/i,
    category: 'relax',
    defaultDuration: 30,
  },
  {
    test: /\b(drive|commute|travel|uber|metro|train)\b/i,
    category: 'commute',
    defaultDuration: 30,
  },
  {
    test: /\b(pharmacy|bank|post office|errand|errands|pick up|drop off|dry cleaning)\b/i,
    category: 'errand',
    defaultDuration: 30,
    locationQuestion: 'Where do you need to go for this errand?',
    locationSuggestions: ['Closest option', 'Usual spot', 'Not sure yet'],
  },
];

function matchPattern(text: string): PlanPattern {
  const t = text.toLowerCase();
  for (const p of PATTERNS) {
    if (p.test.test(t)) return p;
  }
  return {
    test: /.*/,
    category: 'generic',
    defaultDuration: 45,
  };
}

/**
 * Heuristic enrichment when no LLM is configured. Adds subtasks, a default
 * duration, and may attach a clarification question (for example asking which
 * gym the user means).
 */
export function enrichPlanLocally(rawText: string, orderIndex: number): Plan {
  const pattern = matchPattern(rawText);
  const title = rawText.trim().charAt(0).toUpperCase() + rawText.trim().slice(1);

  const subtasks: SubTask[] = (pattern.subtasks ?? []).map((s) => ({
    id: uid('sub'),
    title: s.title,
    durationMinutes: s.durationMinutes,
  }));

  const subtaskTotal = subtasks.reduce((acc, s) => acc + s.durationMinutes, 0);
  const duration = subtaskTotal > 0 ? subtaskTotal : pattern.defaultDuration;

  const needsClarification = Boolean(pattern.locationQuestion || pattern.detailQuestion);

  return {
    id: uid('plan'),
    title,
    rawText,
    subtasks,
    durationMinutes: duration,
    orderIndex,
    status: needsClarification ? 'needs_clarification' : 'draft',
    clarificationQuestion: pattern.locationQuestion ?? pattern.detailQuestion,
    clarificationSuggestions:
      pattern.locationSuggestions ?? pattern.detailSuggestions,
  };
}

/**
 * Heuristic ordering. We use coarse priorities so the day flows roughly as:
 * morning routine -> errands/shopping -> workouts (before meals) -> meals ->
 * focused work -> relaxation. Items keep the user's original relative order
 * inside a category.
 */
const CATEGORY_PRIORITY: Record<string, number> = {
  errand: 10,
  shop: 20,
  commute: 25,
  gym: 30,
  walk: 35,
  'eat-out': 50,
  cook: 50,
  meeting: 55,
  work: 60,
  study: 65,
  relax: 90,
  generic: 70,
};

export function orderPlansLocally(plans: Plan[]): Plan[] {
  const decorated = plans.map((p, i) => {
    const pattern = matchPattern(p.rawText);
    return { plan: p, priority: CATEGORY_PRIORITY[pattern.category] ?? 70, original: i };
  });
  decorated.sort((a, b) =>
    a.priority === b.priority ? a.original - b.original : a.priority - b.priority,
  );
  return decorated.map((d, idx) => ({ ...d.plan, orderIndex: idx }));
}

/**
 * Assigns clock times starting from `start` (HH:MM), leaving a 10-minute
 * buffer between plans for transitions.
 */
export function assignTimes(plans: Plan[], start: string): Plan[] {
  const [hStr, mStr] = start.split(':');
  let cursor = Number(hStr) * 60 + Number(mStr);
  const BUFFER = 10;
  return plans.map((p) => {
    const h = Math.floor(cursor / 60) % 24;
    const m = cursor % 60;
    const startTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    cursor += p.durationMinutes + BUFFER;
    return { ...p, startTime };
  });
}

export function localDaySummary(plans: Plan[]): string {
  if (plans.length === 0) return 'Add a plan to get started.';
  const totalMin = plans.reduce((acc, p) => acc + p.durationMinutes, 0);
  const hours = Math.round((totalMin / 60) * 10) / 10;
  return `${plans.length} plan${plans.length === 1 ? '' : 's'} • about ${hours}h of activity.`;
}
