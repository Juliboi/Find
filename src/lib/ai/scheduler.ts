import { Plan } from '@/types/plan';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  assignTimes,
  enrichPlanLocally,
  localDaySummary,
  orderPlansLocally,
} from './heuristics';
import { currentHHMM } from '@/utils/time';

export interface ScheduleResult {
  plans: Plan[];
  summary: string;
  /** True when the AI still needs information from the user on some plans. */
  needsClarification: boolean;
  /** True when an LLM was used; false when only local heuristics ran. */
  usedAi: boolean;
}

interface ScheduleOptions {
  startTime?: string;
}

/**
 * Top-level "plan my day" call. Tries the Supabase Edge Function first and
 * falls back to local heuristics so the app is always usable offline / before
 * any keys are configured.
 */
export async function scheduleDay(
  rawPlans: string[],
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  const clean = rawPlans.map((p) => p.trim()).filter(Boolean);
  const startTime = options.startTime ?? currentHHMM();

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('schedule-day', {
        body: { plans: clean, startTime },
      });
      if (!error && data && Array.isArray(data.plans)) {
        return {
          plans: data.plans as Plan[],
          summary: typeof data.summary === 'string' ? data.summary : localDaySummary(data.plans),
          needsClarification: data.plans.some(
            (p: Plan) => p.status === 'needs_clarification',
          ),
          usedAi: true,
        };
      }
    } catch {
      // Fall through to local heuristics.
    }
  }

  const enriched = clean.map((text, i) => enrichPlanLocally(text, i));
  const ordered = orderPlansLocally(enriched);
  const timed = assignTimes(ordered, startTime);
  return {
    plans: timed,
    summary: localDaySummary(timed),
    needsClarification: timed.some((p) => p.status === 'needs_clarification'),
    usedAi: false,
  };
}

/**
 * Re-schedules an existing list of plans after the user resolved some
 * clarifications or removed/added items.
 */
export async function rescheduleDay(
  plans: Plan[],
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  const startTime = options.startTime ?? plans[0]?.startTime ?? currentHHMM();
  const reordered = orderPlansLocally(plans);
  const timed = assignTimes(reordered, startTime);
  return {
    plans: timed,
    summary: localDaySummary(timed),
    needsClarification: timed.some((p) => p.status === 'needs_clarification'),
    usedAi: false,
  };
}
