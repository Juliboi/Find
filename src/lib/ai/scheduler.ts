import { Plan, PlanStatus, SubTask } from '@/types/plan';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  assignTimes,
  enrichPlanLocally,
  localDaySummary,
  orderPlansLocally,
} from './heuristics';
import { currentHHMM } from '@/utils/time';
import { uid } from '@/utils/id';
import type { LocationPin } from '@/store/useHomeStore';

export interface SchedulerContext {
  home?: LocationPin | null;
  /**
   * User's work / office anchor. Used by the LLM to set the `location`
   * on plans the user phrases as "at office" / "with colleagues at
   * work", and by the client to resolve those labels to real coords
   * for travel-time rendering.
   */
  work?: LocationPin | null;
  endOfDay?: LocationPin | null;
  currentLocation?: { latitude: number; longitude: number } | null;
}

export interface SchedulerDebug {
  request: unknown;
  response: unknown;
}

export interface ScheduleResult {
  plans: Plan[];
  summary: string;
  /** True when at least one plan still needs information from the user. */
  needsClarification: boolean;
  /** True when an LLM successfully produced the schedule. */
  usedAi: boolean;
  /** Populated only when `options.debug` was set on the call site. */
  debug?: SchedulerDebug;
}

interface ScheduleOptions {
  startTime?: string;
  context?: SchedulerContext;
  /** When true, the call site receives the raw AI request/response payload. */
  debug?: boolean;
}

/**
 * Shape sent to the `schedule-day` edge function. The function accepts either
 * raw strings (legacy) or these structured inputs. Sending structured input
 * lets the model preserve IDs, locations, and durations the user has already
 * confirmed.
 */
interface PlanInput {
  id: string;
  rawText: string;
  title?: string;
  description?: string | null;
  location?: string | null;
  placeSearchQueries?: string[] | null;
  /** @deprecated kept so older persisted plans don't lose data on migration. */
  placeSearchQuery?: string | null;
  durationMinutes?: number;
  startTime?: string;
  subtasks?: { id?: string; title: string; durationMinutes: number }[];
  status?: PlanStatus;
  resolvedClarification?: { question: string; answer: string };
}

function planToInput(p: Plan): PlanInput {
  // Migrate the legacy singular field into the new array form on the
  // wire. The edge function accepts both, but normalizing here means
  // the LLM sees a uniform shape regardless of where the plan was
  // created (new = array, old persisted plan = string).
  const queries: string[] | null = p.placeSearchQueries?.length
    ? p.placeSearchQueries
    : p.placeSearchQuery
    ? [p.placeSearchQuery]
    : null;
  return {
    id: p.id,
    rawText: p.rawText,
    title: p.title,
    description: p.description ?? null,
    location: p.location ?? null,
    placeSearchQueries: queries,
    durationMinutes: p.durationMinutes,
    startTime: p.startTime,
    subtasks: p.subtasks?.map((s) => ({
      id: s.id,
      title: s.title,
      durationMinutes: s.durationMinutes,
    })),
    status: p.status,
    resolvedClarification: p.resolvedClarification,
  };
}

function rawTextToInput(text: string): PlanInput {
  return { id: uid('plan'), rawText: text.trim() };
}

/**
 * Coerces a single plan returned by the model into a fully-typed `Plan`,
 * filling in IDs and defaults so the rest of the app can rely on the shape.
 */
function sanitizePlan(raw: any, fallbackIndex: number): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawText =
    typeof raw.rawText === 'string' && raw.rawText.length > 0
      ? raw.rawText
      : typeof raw.title === 'string'
      ? raw.title
      : null;
  if (!rawText) return null;

  const title =
    typeof raw.title === 'string' && raw.title.trim().length > 0
      ? raw.title.trim()
      : rawText.charAt(0).toUpperCase() + rawText.slice(1);

  const subtasks: SubTask[] = Array.isArray(raw.subtasks)
    ? raw.subtasks
        .map((s: any) => {
          if (!s || typeof s !== 'object') return null;
          const sTitle = typeof s.title === 'string' ? s.title.trim() : '';
          const sDur = Number(s.durationMinutes);
          if (!sTitle || !Number.isFinite(sDur) || sDur <= 0) return null;
          return {
            id: typeof s.id === 'string' && s.id.length > 0 ? s.id : uid('sub'),
            title: sTitle,
            durationMinutes: Math.round(sDur),
          } as SubTask;
        })
        .filter(Boolean)
    : [];

  const durRaw = Number(raw.durationMinutes);
  const duration =
    Number.isFinite(durRaw) && durRaw > 0
      ? Math.round(durRaw)
      : subtasks.reduce((a, s) => a + s.durationMinutes, 0) || 45;

  const statusRaw: string = typeof raw.status === 'string' ? raw.status : '';
  const declaredStatus: PlanStatus =
    statusRaw === 'needs_clarification' || statusRaw === 'scheduled' || statusRaw === 'done' || statusRaw === 'draft'
      ? (statusRaw as PlanStatus)
      : 'scheduled';

  const clarificationQuestion =
    typeof raw.clarificationQuestion === 'string' &&
    raw.clarificationQuestion.length > 0
      ? raw.clarificationQuestion
      : undefined;

  const clarificationSuggestions = Array.isArray(raw.clarificationSuggestions)
    ? raw.clarificationSuggestions.filter((x: unknown) => typeof x === 'string' && x.length > 0)
    : undefined;

  // Enforce invariant: a non-empty question implies needs_clarification, and
  // scheduled implies no pending question.
  const status: PlanStatus = clarificationQuestion
    ? 'needs_clarification'
    : declaredStatus === 'needs_clarification'
    ? 'scheduled'
    : declaredStatus;

  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : uid('plan'),
    title,
    rawText,
    description:
      typeof raw.description === 'string' && raw.description.length > 0
        ? raw.description
        : undefined,
    location:
      typeof raw.location === 'string' && raw.location.length > 0
        ? raw.location
        : undefined,
    placeSearchQueries: (() => {
      if (!Array.isArray(raw.placeSearchQueries)) return undefined;
      const cleaned = raw.placeSearchQueries
        .filter((q: unknown) => typeof q === 'string' && q.trim().length > 0)
        .map((q: string) => q.trim())
        .slice(0, 4) as string[];
      return cleaned.length > 0 ? cleaned : undefined;
    })(),
    // Back-compat: if the model still emitted the legacy single field
    // (older deployments or future regressions), preserve it so the
    // client can fall back to it. New code reads `placeSearchQueries`.
    placeSearchQuery:
      typeof raw.placeSearchQuery === 'string' &&
      raw.placeSearchQuery.trim().length > 0
        ? raw.placeSearchQuery.trim()
        : undefined,
    subtasks,
    durationMinutes: duration,
    startTime: typeof raw.startTime === 'string' ? raw.startTime : undefined,
    clarificationQuestion: status === 'needs_clarification' ? clarificationQuestion : undefined,
    clarificationSuggestions:
      status === 'needs_clarification' &&
      clarificationSuggestions &&
      clarificationSuggestions.length > 0
        ? clarificationSuggestions
        : undefined,
    status,
    orderIndex:
      typeof raw.orderIndex === 'number' ? raw.orderIndex : fallbackIndex,
  };
}

function sanitizeResponse(data: any): { plans: Plan[]; summary: string } | null {
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.plans)) return null;
  const plans = (data.plans as any[])
    .map((p, i) => sanitizePlan(p, i))
    .filter(Boolean) as Plan[];
  if (plans.length === 0) return null;
  plans.sort((a, b) => a.orderIndex - b.orderIndex);
  plans.forEach((p, i) => {
    p.orderIndex = i;
  });
  const summary =
    typeof data.summary === 'string' && data.summary.length > 0
      ? data.summary
      : localDaySummary(plans);
  return { plans, summary };
}

function buildContextPayload(ctx?: SchedulerContext): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  if (ctx.home) {
    out.home = {
      label: ctx.home.label,
      latitude: ctx.home.latitude,
      longitude: ctx.home.longitude,
    };
  }
  if (ctx.work) {
    out.work = {
      label: ctx.work.label,
      latitude: ctx.work.latitude,
      longitude: ctx.work.longitude,
    };
  }
  if (ctx.endOfDay) {
    out.endOfDay = {
      label: ctx.endOfDay.label,
      latitude: ctx.endOfDay.latitude,
      longitude: ctx.endOfDay.longitude,
    };
  }
  if (ctx.currentLocation) {
    out.currentLocation = {
      latitude: ctx.currentLocation.latitude,
      longitude: ctx.currentLocation.longitude,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface CallAiOptions {
  plans: PlanInput[];
  startTime: string;
  mode: 'fresh' | 'reschedule';
  context?: SchedulerContext;
  /** Mutated to record the wire payload when debug is requested. */
  debugSink?: { request: unknown; response: unknown };
}

async function callAi(
  opts: CallAiOptions,
): Promise<{ plans: Plan[]; summary: string } | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const body: Record<string, unknown> = {
    plans: opts.plans,
    startTime: opts.startTime,
    mode: opts.mode,
  };
  const ctx = buildContextPayload(opts.context);
  if (ctx) body.context = ctx;
  if (opts.debugSink) opts.debugSink.request = body;
  try {
    const { data, error } = await supabase.functions.invoke('schedule-day', {
      body,
    });
    if (opts.debugSink) opts.debugSink.response = error ?? data;
    if (error) return null;
    return sanitizeResponse(data);
  } catch (e) {
    if (opts.debugSink) opts.debugSink.response = { error: String(e) };
    return null;
  }
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
  if (clean.length === 0) {
    return { plans: [], summary: '', needsClarification: false, usedAi: false };
  }

  const inputs = clean.map(rawTextToInput);
  const debugSink: SchedulerDebug | undefined = options.debug
    ? { request: null, response: null }
    : undefined;
  const ai = await callAi({
    plans: inputs,
    startTime,
    mode: 'fresh',
    context: options.context,
    debugSink,
  });
  if (ai) {
    return {
      plans: ai.plans,
      summary: ai.summary,
      needsClarification: ai.plans.some((p) => p.status === 'needs_clarification'),
      usedAi: true,
      debug: debugSink,
    };
  }

  const enriched = clean.map((text, i) => enrichPlanLocally(text, i));
  const ordered = orderPlansLocally(enriched);
  const timed = assignTimes(ordered, startTime);
  return {
    plans: timed,
    summary: localDaySummary(timed),
    needsClarification: timed.some((p) => p.status === 'needs_clarification'),
    usedAi: false,
    debug: debugSink,
  };
}

/**
 * Re-schedules an existing list of plans after the user resolved some
 * clarifications, added items, or removed items. Goes through the AI when
 * configured so resolved fields are preserved and follow-up questions can be
 * asked.
 */
export async function rescheduleDay(
  plans: Plan[],
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  if (plans.length === 0) {
    return { plans: [], summary: '', needsClarification: false, usedAi: false };
  }
  const startTime = options.startTime ?? plans[0]?.startTime ?? currentHHMM();
  const inputs = plans.map(planToInput);
  const debugSink: SchedulerDebug | undefined = options.debug
    ? { request: null, response: null }
    : undefined;

  const ai = await callAi({
    plans: inputs,
    startTime,
    mode: 'reschedule',
    context: options.context,
    debugSink,
  });
  if (ai) {
    return {
      plans: ai.plans,
      summary: ai.summary,
      needsClarification: ai.plans.some((p) => p.status === 'needs_clarification'),
      usedAi: true,
      debug: debugSink,
    };
  }

  const reordered = orderPlansLocally(plans);
  const timed = assignTimes(reordered, startTime);
  return {
    plans: timed,
    summary: localDaySummary(timed),
    needsClarification: timed.some((p) => p.status === 'needs_clarification'),
    usedAi: false,
    debug: debugSink,
  };
}
