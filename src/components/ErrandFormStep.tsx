import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { useHomeStore } from '@/store/useHomeStore';
import { useProfileStore } from '@/store/useProfileStore';
import { usePeopleStore } from '@/store/usePeopleStore';
import { Text } from './Text';
import { Button } from './Button';
import { ErrandAddressField, type AddressValue } from './ErrandAddressField';
import { TravelModeToggle } from './TravelModeToggle';
import { ENTER, EXIT } from './errandDrawerAnim';
import { suggestPeople, type PersonSuggestion } from '@/lib/people/suggest';
import type { ErrandDraft } from '@/lib/ai/parseErrand';
import { useErrandsStore } from '@/store/useErrandsStore';
import type { Errand, ErrandInput, TravelPref } from '@/store/useErrandsStore';
import { useRecurringErrandsStore } from '@/store/useRecurringErrandsStore';
import { skipRecurringOccurrence } from '@/lib/recurring';
import {
  findErrandConflicts,
  suggestDays,
  suggestSlotForErrand,
  collectDayErrands,
  errandLengthMin,
  minToHHMM,
  type ConflictDraft,
  type ConflictHit,
  type DaySuggestion,
} from '@/lib/planning/conflicts';
import { usableDayWindow } from '@/lib/planning/dayWindow';
import {
  scoreDay,
  levelLabel,
  formatLeftover,
  type DayScore,
  type MindfulnessLevel,
} from '@/lib/planning/mindfulness';
import {
  formatTime,
  formatDuration,
  minutesOfDay,
  addMinutes,
  errandTimeMode,
  todayISO,
  type TimeMode,
} from '@/utils/time';
import { upcomingWeek, describeDay, roundedNowHHMM } from '@/utils/days';

interface Props {
  /** Whether the hosting drawer is open — gates the (re)seed effects. */
  open: boolean;
  /** The current seed values (a basic seed while parsing, full once parsed). */
  draft: ErrandDraft;
  /** The original text the user typed (kept on the saved errand). */
  rawText: string;
  /** True while the AI is still extracting — the form skips seeding then. */
  parsing: boolean;
  /** Bumped by the parent whenever `draft` should be (re)applied to the form. */
  seedKey: string;
  mode: 'create' | 'edit';
  /** The id of the errand being edited, so "at an existing errand" excludes it. */
  currentErrandId?: string | null;
  onSave: (input: ErrandInput) => void;
  onDelete?: () => void;
  /**
   * Ask the hosting drawer to flip to the place-discovery step, seeded from the
   * form's current fields (so edits survive the round-trip). Omit to hide the
   * "Discover" location option.
   */
  onRequestDiscover?: (snapshot: ErrandDraft) => void;
}

/** How the user is setting the errand's location. Every method resolves to a
 *  concrete pin (`addr` with coords) before the errand can be saved. */
type LocMethod = 'existing' | 'home' | 'specific' | 'discover';

const DAY_CHOICES = 14;

// Duration presets (minutes) offered as chips under the start time. An errand
// edited to a duration outside this set keeps its exact value via an injected
// chip (see `durationOptions`).
const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180];
const DEFAULT_DURATION = 30;
// Default span of a fresh "Between" availability window (start … start + 2h).
const DEFAULT_WINDOW_SPAN = 120;
const DAY_END_MIN = 23 * 60 + 55;

/**
 * Minutes between a start and (optional) end "HH:MM", defaulting when the end is
 * absent or non-positive. Wraps across midnight so a late start still reads as a
 * sensible positive length.
 */
function durationFromDraft(start: string, end: string | null | undefined): number {
  if (!end) return DEFAULT_DURATION;
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s == null || e == null) return DEFAULT_DURATION;
  const diff = (((e - s) % 1440) + 1440) % 1440;
  return diff > 0 ? diff : DEFAULT_DURATION;
}

function hhmmToDate(hhmm: string): Date {
  const mins = minutesOfDay(hhmm) ?? 9 * 60;
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** A "to" time `spanMin` after `start`, clamped so a window never wraps midnight. */
function windowEndDate(start: Date, spanMin: number): Date {
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = Math.min(startMin + spanMin, DAY_END_MIN);
  const d = new Date(start);
  d.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  return d;
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Loose coordinate equality so a re-seeded pin still reads as the same place. */
function samePin(
  a: { latitude?: number | null; longitude?: number | null } | null | undefined,
  b: { latitude: number; longitude: number } | null | undefined,
): boolean {
  if (!a || !b || a.latitude == null || a.longitude == null) return false;
  return (
    Math.abs(a.latitude - b.latitude) < 1e-6 &&
    Math.abs(a.longitude - b.longitude) < 1e-6
  );
}

/** Build the home pin as a place selection. */
function homeValue(home: {
  label?: string;
  latitude: number;
  longitude: number;
}): AddressValue {
  return {
    label: home.label?.trim() || 'Home',
    latitude: home.latitude,
    longitude: home.longitude,
  };
}

/** Copy a located errand's place into a selection ("at an existing errand"). */
function errandToLocValue(e: Errand): AddressValue {
  return {
    label: e.address ?? e.title,
    latitude: e.latitude,
    longitude: e.longitude,
    placeId: e.placeId ?? null,
    photoUrl: e.photoUrl ?? null,
    rating: e.rating ?? null,
    ratingCount: e.ratingCount ?? null,
    priceLevel: e.priceLevel ?? null,
    openingHours: e.openingHours ?? null,
  };
}

/**
 * The errand confirm form — the drawer's default step. Seeds from whatever the
 * parser pulled out and lets the user tweak each slot before saving; every slot
 * is optional and falls back to "Any day" / "Anytime" / "Anywhere". Renders the
 * scroll body plus the pinned save footer (and the Android time picker modal).
 */
export function ErrandFormStep({
  open,
  draft,
  rawText,
  parsing,
  seedKey,
  mode,
  currentErrandId,
  onSave,
  onDelete,
  onRequestDiscover,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const home = useHomeStore((s) => s.home);
  const hasCar = useProfileStore((s) => s.hasCar);
  const people = usePeopleStore((s) => s.items);
  const allErrands = useErrandsStore((s) => s.items);
  const updateErrand = useErrandsStore((s) => s.update);
  const removeErrand = useErrandsStore((s) => s.remove);
  const recurringTemplates = useRecurringErrandsStore((s) => s.items);
  const wakeTime = useProfileStore((s) => s.wakeTime);
  const bedTime = useProfileStore((s) => s.bedTime);
  const windDownTime = useProfileStore((s) => s.windDownTime);
  const wakeUpDurationMin = useProfileStore((s) => s.wakeUpDurationMin);
  // Stable bias object so the address field's search effect doesn't re-fire on
  // every render (it keys off the lat/lng, not object identity).
  const center = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  const [title, setTitle] = useState('');
  const [date, setDate] = useState<string | undefined>(undefined);
  // 'anytime' (no clock), 'at' (fixed start), or 'between' (an availability
  // window the planner schedules inside).
  const [timeMode, setTimeMode] = useState<TimeMode>('anytime');
  const [startD, setStartD] = useState<Date>(() => hhmmToDate(roundedNowHHMM()));
  // The "to" edge of a Between window. Only meaningful in 'between' mode.
  const [endD, setEndD] = useState<Date>(() =>
    windowEndDate(hhmmToDate(roundedNowHHMM()), DEFAULT_WINDOW_SPAN),
  );
  // How long the errand takes — always required now (every errand reserves a
  // real block of time), so there's no "Any length"; it defaults to 30 min.
  const [durationMin, setDurationMin] = useState<number>(DEFAULT_DURATION);
  const [addr, setAddr] = useState<AddressValue | null>(null);
  // Which of the four location methods is active (Existing / Home / Specific /
  // Discover). Every method resolves to a concrete `addr` before saving.
  const [locMethod, setLocMethod] = useState<LocMethod | null>(null);
  // Bumped to pop the "Specific location" search open imperatively.
  const [searchToken, setSearchToken] = useState(0);
  // Explicit travel preference, or undefined to follow the profile default.
  const [travelMode, setTravelMode] = useState<TravelPref | undefined>(undefined);
  const [notes, setNotes] = useState('');
  // false, or which edge's Android time dialog is open ('start' | 'end').
  const [androidPicker, setAndroidPicker] = useState<false | 'start' | 'end'>(
    false,
  );
  // The horizontal day list + a map of each day chip's x-offset, so a (re)seed
  // can scroll the selected day into view — a parsed "the 15th" otherwise stays
  // selected but off-screen.
  const dateScrollRef = useRef<ScrollView>(null);
  const dateOffsetsRef = useRef<Map<string, number>>(new Map());

  // (Re)seed the form from the draft whenever the drawer opens, a parse
  // finishes, or a different errand is opened. We skip seeding mid-parse (the
  // form is hidden behind the reading state then), so user edits are never
  // clobbered by a late-arriving parse.
  useEffect(() => {
    if (!open || parsing) return;
    setTitle(draft.title ?? '');
    setDate(draft.date ?? undefined);
    const located = draft.latitude != null && draft.longitude != null;
    const seededAddr: AddressValue | null = draft.address
      ? {
          label: draft.address,
          latitude: draft.latitude ?? undefined,
          longitude: draft.longitude ?? undefined,
          placeId: draft.placeId ?? undefined,
          photoUrl: draft.photoUrl ?? undefined,
          rating: draft.rating ?? undefined,
          ratingCount: draft.ratingCount ?? undefined,
          priceLevel: draft.priceLevel ?? undefined,
          openingHours: draft.openingHours ?? undefined,
        }
      : null;
    setAddr(located ? seededAddr : null);
    // Pick the method that matches what we seeded with, so the right control is
    // already showing. A pinned home → Home; any other pinned place → Specific;
    // a parsed (unconfirmed) address → Specific (its search auto-runs); nothing
    // chosen yet → no method (the user must pick one).
    if (located) {
      setLocMethod(samePin(seededAddr, home) ? 'home' : 'specific');
    } else if (draft.address) {
      setLocMethod('specific');
    } else {
      setLocMethod(null);
    }
    setTravelMode(draft.travelMode ?? undefined);
    setNotes(draft.notes ?? '');
    const seededMode = errandTimeMode(
      draft.startTime,
      draft.endTime,
      draft.durationMin,
    );
    setTimeMode(seededMode);
    if (seededMode === 'between') {
      const start = draft.startTime as string;
      const end = draft.endTime as string;
      setStartD(hhmmToDate(start));
      setEndD(hhmmToDate(end));
      // Between needs a concrete length to reserve inside the window.
      setDurationMin(draft.durationMin ?? DEFAULT_DURATION);
    } else if (seededMode === 'at') {
      const start = draft.startTime as string;
      const sd = hhmmToDate(start);
      setStartD(sd);
      setEndD(windowEndDate(sd, DEFAULT_WINDOW_SPAN));
      // Prefer a stored duration; else derive it from the AI's start/end window.
      setDurationMin(draft.durationMin ?? durationFromDraft(start, draft.endTime));
    } else {
      // Anytime still reserves a concrete block — default the length when none.
      const sd = hhmmToDate(roundedNowHHMM());
      setStartD(sd);
      setEndD(windowEndDate(sd, DEFAULT_WINDOW_SPAN));
      setDurationMin(draft.durationMin ?? DEFAULT_DURATION);
    }
    setAndroidPicker(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parsing, seedKey]);

  // Bring the selected day chip into view after a (re)seed or a tap. A parsed
  // date like "the 15th" can land far down the horizontal list; without this the
  // chip reads as selected but is scrolled off-screen. We defer a beat so the
  // chip offsets (captured via onLayout) are measured first.
  useEffect(() => {
    if (!open || parsing) return;
    if (!date) {
      dateScrollRef.current?.scrollTo({ x: 0, animated: false });
      return;
    }
    const id = setTimeout(() => {
      const x = dateOffsetsRef.current.get(date);
      if (x != null) {
        dateScrollRef.current?.scrollTo({ x: Math.max(0, x - 12), animated: true });
      }
    }, 120);
    return () => clearTimeout(id);
  }, [open, parsing, seedKey, date]);

  const startTime = dateToHHMM(startD);
  const windowEnd = dateToHHMM(endD);
  // The errand's "end" we persist: the window's "to" for Between, else
  // start+duration for a fixed time. Used for the venue open-hours hint too.
  const endTime =
    timeMode === 'between'
      ? windowEnd
      : durationMin != null
      ? addMinutes(startTime, durationMin)
      : undefined;

  // ----------------------------------------------------- conflict detection
  // The day's USABLE window: starts after the morning ramp (wake + wake-up
  // duration) so a slot isn't offered the instant you're meant to be up, and
  // ends at wind-down (the soft "go calm" cap) rather than bedtime. The slot
  // engine layers "skip the past on today" on top via its own `nowMin`.
  const dayWindow = useMemo(() => {
    const { startMin, endMin } = usableDayWindow({
      wakeTime,
      bedTime,
      windDownTime,
      wakeUpDurationMin,
    });
    return { start: startMin, end: endMin };
  }, [wakeTime, bedTime, windDownTime, wakeUpDurationMin]);

  // The form's current timing as the engine sees it (only a fixed "At a time"
  // pick on a concrete day can clash; windows/anytime flex around everything).
  const conflictDraft: ConflictDraft = useMemo(
    () => ({
      id: currentErrandId ?? null,
      date,
      startTime: timeMode === 'at' ? startTime : null,
      endTime: timeMode === 'at' ? endTime ?? null : null,
      durationMin,
    }),
    [currentErrandId, date, timeMode, startTime, endTime, durationMin],
  );

  const conflicts = useMemo(
    () => findErrandConflicts(conflictDraft, allErrands, recurringTemplates),
    [conflictDraft, allErrands, recurringTemplates],
  );

  // Open days for THIS errand — the one-tap "move it here" fixes. We pull a
  // wide set (next 3 weeks) so the drawer can offer the soonest few up front
  // and, behind "More dates", the rest ranked by availability.
  const conflictSuggestions = useMemo<DaySuggestion[]>(() => {
    if (conflicts.length === 0) return [];
    return suggestDays(durationMin ?? DEFAULT_DURATION, allErrands, recurringTemplates, {
      windowStart: dayWindow.start,
      windowEnd: dayWindow.end,
      nowMin: minutesOfDay(roundedNowHHMM()) ?? undefined,
      todayIso: todayISO(),
      excludeDates: date ? [date] : [],
      count: 12,
      horizonDays: 21,
    });
  }, [conflicts.length, durationMin, allErrands, recurringTemplates, dayWindow, date]);

  // Where the primary clashing errand could move to — null when it's recurring
  // (a routine isn't reschedulable from here) or nothing fits. Drives whether
  // the "Move <other>" action shows, and labels it with the concrete target.
  const primaryConflict = conflicts[0] ?? null;
  const primaryMoveTarget = useMemo<DaySuggestion | null>(() => {
    if (!primaryConflict || primaryConflict.errand.recurringId) return null;
    return suggestSlotForErrand(
      primaryConflict.errand,
      conflictDraft,
      allErrands,
      recurringTemplates,
      {
        windowStart: dayWindow.start,
        windowEnd: dayWindow.end,
        nowMin: minutesOfDay(roundedNowHHMM()) ?? undefined,
        todayIso: todayISO(),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryConflict, conflictDraft, allErrands, recurringTemplates, dayWindow]);

  // Move THIS errand onto a suggested open day + slot (clears the clash).
  const applyConflictSuggestion = (s: DaySuggestion) => {
    Haptics.selectionAsync().catch(() => undefined);
    setDate(s.date);
    setTimeMode('at');
    const sd = hhmmToDate(minToHHMM(s.slotStart));
    setStartD(sd);
    setEndD(windowEndDate(sd, DEFAULT_WINDOW_SPAN));
  };

  // Reschedule the OTHER (clashing) errand to a free slot — keeps both, moves it
  // out of the way. Recurring occurrences aren't reschedulable here (see UI).
  const moveOtherErrand = (hit: ConflictHit) => {
    const slot = suggestSlotForErrand(hit.errand, conflictDraft, allErrands, recurringTemplates, {
      windowStart: dayWindow.start,
      windowEnd: dayWindow.end,
      nowMin: minutesOfDay(roundedNowHHMM()) ?? undefined,
      todayIso: todayISO(),
    });
    if (!slot) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    const len = errandLengthMin(hit.errand);
    updateErrand(hit.errand.id, {
      date: slot.date,
      startTime: slot.slotStartLabel,
      endTime: minToHHMM(slot.slotStart + len),
    });
  };

  // Drop the OTHER errand to free its slot — for a recurring occurrence this
  // skips just that day; a one-off is removed outright.
  const removeOtherErrand = (hit: ConflictHit) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    if (hit.errand.recurringId && hit.errand.date) {
      skipRecurringOccurrence(hit.errand.recurringId, hit.errand.date);
    } else {
      removeErrand(hit.errand.id);
    }
  };

  // ----------------------------------------------------- mindful day balance
  // The day's other errands (one-off + recurring), without the one being
  // created/edited, so we can score the day with vs. without it.
  const baseDayErrands = useMemo<Errand[]>(
    () =>
      date
        ? collectDayErrands(date, allErrands, recurringTemplates, currentErrandId ?? null)
        : [],
    [date, allErrands, recurringTemplates, currentErrandId],
  );

  // The form's current state as a scorable errand (carries its block + place so
  // its length and any travel land in the projected score). The title plays no
  // part in scoring, so it's a constant — typing it never re-runs the score.
  const draftErrand = useMemo<Errand>(
    () => ({
      id: currentErrandId ?? '__draft__',
      title: 'New errand',
      startTime: timeMode !== 'anytime' ? startTime : undefined,
      endTime: timeMode !== 'anytime' ? endTime : undefined,
      durationMin: durationMin ?? DEFAULT_DURATION,
      date: date ?? undefined,
      latitude: addr?.latitude ?? undefined,
      longitude: addr?.longitude ?? undefined,
      done: false,
      createdAt: 0,
      updatedAt: 0,
      rawText: '',
    }),
    [currentErrandId, timeMode, startTime, endTime, durationMin, date, addr],
  );

  // Score the day as-is vs. with this errand added — only when a concrete day is
  // chosen ("Any day" has no single day to balance).
  const dayBalance = useMemo<{ base: DayScore; projected: DayScore } | null>(() => {
    if (!date) return null;
    const startHHMM = minToHHMM(dayWindow.start);
    const endHHMM = minToHHMM(dayWindow.end);
    const base = scoreDay({
      startTime: startHHMM,
      endTime: endHHMM,
      errands: baseDayErrands,
      startAnchor: center,
      endAnchor: center,
    });
    const projected = scoreDay({
      startTime: startHHMM,
      endTime: endHHMM,
      errands: [...baseDayErrands, draftErrand],
      startAnchor: center,
      endAnchor: center,
    });
    return { base, projected };
  }, [date, dayWindow, baseDayErrands, draftErrand, center]);

  // Keep an exact (edited) duration selectable even when it isn't a preset.
  const durationOptions = useMemo(
    () =>
      durationMin == null || DURATION_CHOICES.includes(durationMin)
        ? DURATION_CHOICES
        : [...DURATION_CHOICES, durationMin].sort((a, b) => a - b),
    [durationMin],
  );

  // Saved-people suggestions: when what the user typed is close to a saved
  // person's name ("doctors visit" → the person "doctor") or to their place's
  // label ("Váš Praktik at Ladvi" → the saved "Váš praktika kobylisy"), offer a
  // one-tap chip that pins that place — catching the cases the parser's stricter
  // possessive matching misses. Already-chosen place is excluded so it never
  // suggests what's set. Matching is diacritic- and typo-tolerant.
  const peopleSuggestions = useMemo(
    () =>
      suggestPeople({
        people,
        nameText: `${title} ${rawText}`,
        placeText: `${addr?.label ?? ''} ${rawText}`,
        skipPlaceLabel: addr?.label ?? null,
      }),
    [people, title, rawText, addr?.label],
  );

  const applySuggestion = (s: PersonSuggestion) => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('specific');
    setAddr({
      label: s.place.label,
      latitude: s.place.latitude,
      longitude: s.place.longitude,
      placeId: s.place.placeId ?? null,
    });
  };

  // The day's other located errands, for the "at an existing errand" picker.
  // Scoped to the chosen day when there is one (colocating "on that date"),
  // else any located errand; the errand being edited is always excluded.
  const existingLocated = useMemo(() => {
    const seen = new Set<string>();
    const out: Errand[] = [];
    for (const e of allErrands) {
      if (e.id === currentErrandId) continue;
      if (e.latitude == null || e.longitude == null) continue;
      if (date && e.date !== date) continue;
      const key = `${e.latitude.toFixed(5)},${e.longitude.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= 8) break;
    }
    return out;
  }, [allErrands, currentErrandId, date]);

  const chooseExisting = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('existing');
    setAddr(null);
  };
  const chooseHome = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('home');
    setAddr(home ? homeValue(home) : null);
  };
  const chooseSpecific = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('specific');
    setAddr(null);
    setSearchToken((n) => n + 1);
  };
  const chooseDiscover = () => {
    if (!onRequestDiscover) return;
    Haptics.selectionAsync().catch(() => undefined);
    setLocMethod('discover');
    setAddr(null);
    onRequestDiscover(buildDiscoverSnapshot());
  };

  const onSelectMode = (next: TimeMode) => {
    if (next === timeMode) return;
    Haptics.selectionAsync().catch(() => undefined);
    // When leaving Anytime, seed a real start (the AI's guess or "now").
    const startSeed =
      timeMode === 'anytime'
        ? hhmmToDate(draft.startTime ?? roundedNowHHMM())
        : startD;
    if (timeMode === 'anytime' && next !== 'anytime') setStartD(startSeed);
    // A timed/between errand needs a concrete length (so it has an end); coerce
    // away "Any length" but keep an estimate the user already picked.
    if (next !== 'anytime') {
      setDurationMin(
        (cur) => cur ?? draft.durationMin ?? DEFAULT_DURATION,
      );
    }
    // Entering Between: make sure the "to" sits after the "from".
    if (next === 'between' && minutesOf(endD) <= minutesOf(startSeed)) {
      setEndD(windowEndDate(startSeed, DEFAULT_WINDOW_SPAN));
    }
    setTimeMode(next);
    setAndroidPicker(false);
  };

  const onStartChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (!picked) return;
    Haptics.selectionAsync().catch(() => undefined);
    setStartD(picked);
    // Keep the window's "to" after its "from".
    if (timeMode === 'between' && minutesOf(endD) <= minutesOf(picked)) {
      setEndD(windowEndDate(picked, DEFAULT_WINDOW_SPAN));
    }
  };

  const onEndChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(false);
    if (!picked) return;
    Haptics.selectionAsync().catch(() => undefined);
    setEndD(picked);
  };

  // A snapshot of the form's current fields, handed to the discover step so a
  // place picked there folds back in WITHOUT losing edits made here first.
  const buildDiscoverSnapshot = (): ErrandDraft => {
    const isTimed = timeMode !== 'anytime';
    return {
      title: title.trim(),
      date: date ?? null,
      startTime: isTimed ? startTime : null,
      endTime: isTimed ? endTime ?? null : null,
      durationMin: durationMin ?? null,
      address: null,
      latitude: null,
      longitude: null,
      placeId: null,
      photoUrl: null,
      rating: null,
      ratingCount: null,
      priceLevel: null,
      openingHours: null,
      travelMode: travelMode ?? null,
      notes: notes.trim() || null,
    };
  };

  // Save is gated on the three things the planner now always needs: a title, a
  // concrete length, and a real, located place (lat/lng resolved).
  const hasLocation = addr?.latitude != null && addr?.longitude != null;
  const canSave =
    title.trim().length > 0 && durationMin != null && durationMin > 0 && hasLocation;

  // A place pinned to the user's saved home needs no "how you'll get there":
  // travel mode is about getting TO an errand, which is moot when the errand is
  // home itself (it's the day's start/end). Matches ErrandAddressField's own
  // home check, so the toggle hides the moment "Home" is picked.
  const isHomeLocation =
    !!home &&
    addr?.latitude != null &&
    addr?.longitude != null &&
    Math.abs(addr.latitude - home.latitude) < 1e-6 &&
    Math.abs(addr.longitude - home.longitude) < 1e-6;

  const save = () => {
    if (!canSave) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    const isTimed = timeMode !== 'anytime';
    onSave({
      title: title.trim(),
      date,
      startTime: isTimed ? startTime : undefined,
      // 'between' → the window's "to"; 'at' → start+duration; 'anytime' → none.
      endTime: isTimed ? endTime : undefined,
      // The length is always concrete now and the planner reserves a block of it.
      durationMin: durationMin ?? undefined,
      address: addr?.label,
      latitude: addr?.latitude ?? undefined,
      longitude: addr?.longitude ?? undefined,
      placeId: addr?.placeId ?? undefined,
      photoUrl: addr?.photoUrl ?? undefined,
      rating: addr?.rating ?? undefined,
      ratingCount: addr?.ratingCount ?? undefined,
      priceLevel: addr?.priceLevel ?? undefined,
      openingHours: addr?.openingHours ?? undefined,
      // Only carry the mode for a real, located place that isn't home (you don't
      // commute to your own home).
      travelMode: !isHomeLocation ? travelMode : undefined,
      notes: notes.trim() || undefined,
      rawText,
    });
  };

  // Date chips: "Any day" + the next two weeks, plus the parsed date itself if
  // it falls outside that window (so a far-off pick still shows + stays
  // selected).
  const dayOptions = upcomingWeek(DAY_CHOICES);
  const extraDay =
    date && !dayOptions.some((d) => d.iso === date) ? describeDay(date) : null;

  return (
    <>
      <BottomSheetScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Title */}
        <Field icon="checkmark-circle-outline" label="What" index={1}>
          <BottomSheetTextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Call mom"
            placeholderTextColor={t.colors.textTertiary}
            style={[
              styles.input,
              styles.titleInput,
              {
                backgroundColor: t.colors.fill1,
                borderColor: t.colors.separator,
                color: t.colors.textPrimary,
              },
            ]}
          />
        </Field>

        {/* Date */}
        <Field icon="calendar-outline" label="When" index={2}>
          <ScrollView
            ref={dateScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipRow}
          >
            <SelectChip
              label="Any day"
              active={!date}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setDate(undefined);
              }}
            />
            {extraDay ? (
              <SelectChip
                label={`${extraDay.title} · ${extraDay.dateLabel}`}
                active
                onPress={() => undefined}
                onLayout={(e) => {
                  if (date) {
                    dateOffsetsRef.current.set(date, e.nativeEvent.layout.x);
                  }
                }}
              />
            ) : null}
            {dayOptions.map((d) => (
              <SelectChip
                key={d.iso}
                label={
                  d.isToday
                    ? 'Today'
                    : d.isTomorrow
                    ? 'Tomorrow'
                    : `${d.weekdayShort} ${d.dayNum}`
                }
                active={date === d.iso}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setDate(d.iso);
                }}
                onLayout={(e) =>
                  dateOffsetsRef.current.set(d.iso, e.nativeEvent.layout.x)
                }
              />
            ))}
          </ScrollView>
        </Field>

        {/* Mindful day balance — a minimal read on how full the chosen day is
            and how this errand shifts it (only when a concrete day is picked). */}
        {dayBalance ? <MindfulScore base={dayBalance.base} projected={dayBalance.projected} /> : null}

        {/* Time */}
        <Field icon="time-outline" label="Time" index={3}>
          <View style={styles.segment}>
            <SelectChip
              label="Anytime"
              active={timeMode === 'anytime'}
              onPress={() => onSelectMode('anytime')}
            />
            <SelectChip
              label="At a time"
              active={timeMode === 'at'}
              onPress={() => onSelectMode('at')}
            />
            <SelectChip
              label="Between"
              active={timeMode === 'between'}
              onPress={() => onSelectMode('between')}
            />
          </View>
          {/* The "At a time" start row OR the Between window (From/To). "How
              long" shows in every mode — for Anytime it's an optional estimate
              the planner uses to reserve a slot. */}
          <View style={styles.timeRows}>
            {timeMode === 'at' ? (
              <TimeRow
                label="Starts"
                value={startD}
                display={formatTime(startTime)}
                onChange={onStartChange}
                onAndroidOpen={() => setAndroidPicker('start')}
              />
            ) : null}
            {timeMode === 'between' ? (
              <>
                <TimeRow
                  label="From"
                  value={startD}
                  display={formatTime(startTime)}
                  onChange={onStartChange}
                  onAndroidOpen={() => setAndroidPicker('start')}
                />
                <TimeRow
                  label="To"
                  value={endD}
                  display={formatTime(windowEnd)}
                  onChange={onEndChange}
                  onAndroidOpen={() => setAndroidPicker('end')}
                />
              </>
            ) : null}
            <View
              style={[
                styles.durationHead,
                { borderTopColor: t.colors.separator },
              ]}
            >
              <Text variant="body" weight="semibold">
                How long
              </Text>
              {timeMode === 'at' && endTime ? (
                <Text variant="bodySm" tone="secondary">
                  Ends {formatTime(endTime)}
                </Text>
              ) : null}
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.chipRow}
            >
              {durationOptions.map((min) => (
                <SelectChip
                  key={min}
                  label={formatDuration(min)}
                  active={durationMin === min}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => undefined);
                    setDurationMin(min);
                  }}
                />
              ))}
            </ScrollView>
            {timeMode === 'anytime' ? (
              <Text
                variant="caption"
                tone="tertiary"
                style={styles.durationHint}
              >
                Diem reserves this much time for the errand.
              </Text>
            ) : timeMode === 'between' ? (
              <Text
                variant="caption"
                tone="tertiary"
                style={styles.durationHint}
              >
                Diem fits this in anywhere between {formatTime(startTime)} and{' '}
                {formatTime(windowEnd)}.
              </Text>
            ) : null}
          </View>
        </Field>

        {/* Conflict helper — only when a fixed time lands on another fixed
            errand. Surfaces the clash, offers one-tap "move this here" days, and
            lets the user bump or drop the other errand. */}
        {conflicts.length > 0 ? (
          <ConflictNotice
            conflicts={conflicts}
            suggestions={conflictSuggestions}
            moveTarget={primaryMoveTarget}
            onPickDay={applyConflictSuggestion}
            onMoveOther={moveOtherErrand}
            onRemoveOther={removeOtherErrand}
          />
        ) : null}

        {/* Address — a live place picker, not a plain text box. On a
            fresh parse it auto-searches the AI's guess so the user can
            confirm/correct it; an already-pinned errand just rests. */}
        <Field icon="location-outline" label="Where" index={4}>
          {peopleSuggestions.length > 0 ? (
            <View style={styles.suggestBlock}>
              <Text variant="caption" tone="tertiary" weight="semibold">
                Did you mean
              </Text>
              <View style={styles.suggestRow}>
                {peopleSuggestions.map((s) => (
                  <Pressable
                    key={s.person.id}
                    onPress={() => applySuggestion(s)}
                    hitSlop={6}
                    style={({ pressed }) => [
                      styles.suggestChip,
                      {
                        backgroundColor: t.colors.accentSoft,
                        borderColor: t.colors.accent,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${s.person.name}'s place: ${s.place.label}`}
                  >
                    <Ionicons name="location" size={13} color={t.colors.accentText} />
                    <Text
                      variant="bodySm"
                      weight="semibold"
                      tone="accent"
                      numberOfLines={1}
                    >
                      {s.person.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {/* Four ways to set a concrete location — one is required to save. */}
          <View style={styles.locMethods}>
            <LocMethodChip
              label="At an errand"
              icon="git-merge-outline"
              active={locMethod === 'existing'}
              onPress={chooseExisting}
            />
            <LocMethodChip
              label="Home"
              icon="home-outline"
              active={locMethod === 'home'}
              disabled={!home}
              onPress={chooseHome}
            />
            <LocMethodChip
              label="Specific"
              icon="search-outline"
              active={locMethod === 'specific'}
              onPress={chooseSpecific}
            />
            {onRequestDiscover ? (
              <LocMethodChip
                label="Discover"
                icon="sparkles-outline"
                active={locMethod === 'discover'}
                onPress={chooseDiscover}
              />
            ) : null}
          </View>

          {addr || locMethod === 'specific' ? (
            <ErrandAddressField
              value={addr}
              center={center}
              home={home}
              seedKey={seedKey}
              autoOpenToken={searchToken}
              hideHomeShortcut
              allowUnpinned={false}
              emptyLabel="Tap to search a place"
              seedQuery={
                mode === 'create' && draft.latitude == null ? draft.address : null
              }
              dateISO={date}
              startTime={timeMode !== 'anytime' ? startTime : undefined}
              endTime={timeMode !== 'anytime' ? endTime : undefined}
              suggestSavedPlaces
              onChange={(next) => {
                setAddr(next);
                if (next) setLocMethod(samePin(next, home) ? 'home' : 'specific');
              }}
            />
          ) : locMethod === 'existing' ? (
            <ExistingErrandPicker
              errands={existingLocated}
              onPick={(v) => setAddr(v)}
            />
          ) : locMethod === 'home' ? (
            <LocationHint
              icon="home-outline"
              text="Set your home address in Settings to drop an errand here."
            />
          ) : locMethod === 'discover' ? (
            <LocationHint
              icon="sparkles-outline"
              text="Pick a place from Discover to set this errand's location."
            />
          ) : (
            <LocationHint
              icon="location-outline"
              text="Choose where this happens — a location is required so the planner can route your day."
            />
          )}

          {/* Travel mode — only meaningful once there's a real place to route
              to, and never for a home-pinned errand (you don't commute to your
              own home). Defaults to the user's car ownership. */}
          {addr?.latitude != null &&
          addr?.longitude != null &&
          !isHomeLocation ? (
            <View style={styles.travelBlock}>
              <Text variant="caption" tone="tertiary" weight="semibold">
                How you&apos;ll get there
              </Text>
              <TravelModeToggle
                value={travelMode}
                hasCar={hasCar}
                onChange={setTravelMode}
              />
            </View>
          ) : null}
        </Field>

        {/* Notes — also handed to the planner when this errand is folded
            into a day, so we call out the impact below the field. */}
        <Field icon="document-text-outline" label="Note" index={5}>
          <BottomSheetTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional — e.g. bring documents, flexible timing"
            placeholderTextColor={t.colors.textTertiary}
            style={[
              styles.input,
              {
                backgroundColor: t.colors.fill1,
                borderColor: t.colors.separator,
                color: t.colors.textPrimary,
              },
            ]}
          />
          <View style={styles.noteHint}>
            <Ionicons
              name="sparkles-outline"
              size={12}
              color={t.colors.textTertiary}
            />
            <Text variant="caption" tone="tertiary" style={styles.noteHintText}>
              The assistant reads this when you add the errand to a plan —
              mention timing, priorities, or anything that should shape your day.
            </Text>
          </View>
        </Field>

        {mode === 'edit' && onDelete ? (
          <Animated.View entering={ENTER(6)} exiting={EXIT(6)}>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
                  () => undefined,
                );
                onDelete();
              }}
              style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="trash-outline" size={18} color={t.colors.danger} />
              <Text variant="body" weight="semibold" style={{ color: t.colors.danger }}>
                Delete errand
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </BottomSheetScrollView>

      <Animated.View
        entering={ENTER(6)}
        exiting={EXIT(6)}
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + 8,
            borderTopColor: t.colors.separator,
          },
        ]}
      >
        <Button
          title={mode === 'edit' ? 'Save changes' : 'Save errand'}
          onPress={save}
          disabled={!canSave}
          fullWidth
          size="lg"
        />
      </Animated.View>

      {androidPicker && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={androidPicker === 'end' ? endD : startD}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={androidPicker === 'end' ? onEndChange : onStartChange}
        />
      ) : null}
    </>
  );
}

/** Calm → over: green for serene/balanced, amber for busy/packed, red for over. */
function levelColor(t: ReturnType<typeof useTheme>, level: MindfulnessLevel): string {
  switch (level) {
    case 'serene':
    case 'balanced':
      return t.colors.success;
    case 'busy':
    case 'packed':
      return t.colors.warning;
    case 'overloaded':
      return t.colors.danger;
    default:
      return t.colors.textSecondary;
  }
}

/**
 * A minimal read on the chosen day's mindfulness: a coloured dot + level, the
 * resulting score (with `before → after` when this errand shifts it), and the
 * leftover free time. Lets the user feel an errand's impact before saving.
 */
function MindfulScore({ base, projected }: { base: DayScore; projected: DayScore }) {
  const t = useTheme();
  const color = levelColor(t, projected.level);
  const changed = projected.score !== base.score;
  return (
    <Animated.View
      entering={ENTER(2)}
      exiting={EXIT(2)}
      layout={LinearTransition.duration(220)}
      style={[
        styles.balanceCard,
        { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
      ]}
    >
      <View style={styles.balanceRow}>
        <View style={styles.balanceLabel}>
          <View style={[styles.balanceDot, { backgroundColor: color }]} />
          <Text variant="caption" tone="secondary" weight="semibold">
            Day balance
          </Text>
        </View>
        <View style={styles.balanceScore}>
          {changed ? (
            <>
              <Text variant="caption" tone="tertiary">
                {base.score}
              </Text>
              <Ionicons name="arrow-forward" size={11} color={t.colors.textTertiary} />
            </>
          ) : null}
          <Text variant="bodySm" weight="bold" style={{ color }}>
            {projected.score}
          </Text>
          <Text variant="caption" weight="semibold" style={{ color }}>
            {levelLabel(projected.level)}
          </Text>
        </View>
      </View>
      <Text variant="caption" tone="tertiary">
        {formatLeftover(projected.freeMin)}
        {projected.tightTransitions > 0
          ? ` · ${projected.tightTransitions} tight ${
              projected.tightTransitions === 1 ? 'gap' : 'gaps'
            }`
          : ''}
      </Text>
    </Animated.View>
  );
}

/**
 * The in-drawer scheduling-conflict helper. Appears only when a fixed time lands
 * on another fixed errand: it names the clash, offers one-tap "move this errand
 * to <open day>" fixes (the heavy lifting — soonest days that actually fit), and
 * lets the user bump or drop the other errand instead.
 */
function ConflictNotice({
  conflicts,
  suggestions,
  moveTarget,
  onPickDay,
  onMoveOther,
  onRemoveOther,
}: {
  conflicts: ConflictHit[];
  suggestions: DaySuggestion[];
  moveTarget: DaySuggestion | null;
  onPickDay: (s: DaySuggestion) => void;
  onMoveOther: (hit: ConflictHit) => void;
  onRemoveOther: (hit: ConflictHit) => void;
}) {
  const t = useTheme();
  const [showMore, setShowMore] = useState(false);
  const primary = conflicts[0];
  if (!primary) return null;
  const extra = conflicts.length - 1;
  const range = `${formatTime(minToHHMM(primary.interval.start))} – ${formatTime(
    minToHHMM(primary.interval.end),
  )}`;
  const isRecurring = !!primary.errand.recurringId;

  // The soonest few get one-tap chips; the rest sit behind "More dates" so the
  // user can pick any open day, ranked by how free it is.
  const QUICK = 3;
  const quickDays = suggestions.slice(0, QUICK);
  const moreDays = suggestions.slice(QUICK);

  const dayChipLabel = (iso: string) => {
    const d = describeDay(iso);
    return d.isToday ? 'Today' : d.isTomorrow ? 'Tomorrow' : `${d.weekdayShort} ${d.dayNum}`;
  };
  const fullDayLabel = (iso: string) => {
    const d = describeDay(iso);
    if (d.isToday) return 'Today';
    if (d.isTomorrow) return 'Tomorrow';
    return `${d.weekdayShort}, ${d.monthShort} ${d.dayNum}`;
  };

  return (
    <Animated.View
      entering={ENTER(0)}
      exiting={EXIT(0)}
      layout={LinearTransition.duration(220)}
      style={[
        styles.conflictCard,
        { backgroundColor: t.colors.warningSoft, borderColor: t.colors.warning },
      ]}
    >
      <View style={styles.conflictHead}>
        <Ionicons name="alert-circle" size={17} color={t.colors.warning} />
        <Text variant="bodySm" weight="bold" style={{ color: t.colors.warning }}>
          Time clash
        </Text>
      </View>
      <Text variant="bodySm" tone="secondary">
        Overlaps{' '}
        <Text variant="bodySm" weight="semibold">
          {primary.errand.title}
        </Text>{' '}
        ({range}){extra > 0 ? ` and ${extra} more` : ''}.
      </Text>

      {suggestions.length > 0 ? (
        <>
          <Text
            variant="caption"
            tone="tertiary"
            weight="semibold"
            style={styles.conflictLabel}
          >
            Move this errand to
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipRow}
          >
            {quickDays.map((s) => (
              <Pressable
                key={s.date}
                onPress={() => onPickDay(s)}
                style={({ pressed }) => [
                  styles.suggestDayChip,
                  { backgroundColor: t.colors.accentSoft, borderColor: t.colors.accent },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Move to ${dayChipLabel(s.date)} at ${formatTime(
                  s.slotStartLabel,
                )}`}
              >
                <Text variant="bodySm" weight="bold" tone="accent">
                  {dayChipLabel(s.date)} · {formatTime(s.slotStartLabel)}
                </Text>
                <Text variant="caption" tone="accent" style={{ opacity: 0.85 }}>
                  {formatDuration(s.freeMin)} free
                </Text>
              </Pressable>
            ))}
            {moreDays.length > 0 ? (
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setShowMore((v) => !v);
                }}
                style={({ pressed }) => [
                  styles.suggestDayChip,
                  styles.moreDatesChip,
                  { borderColor: t.colors.accent },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityRole="button"
                accessibilityState={{ expanded: showMore }}
                accessibilityLabel={
                  showMore ? 'Hide other dates' : `Choose another date, ${moreDays.length} more available`
                }
              >
                <Ionicons
                  name={showMore ? 'chevron-up' : 'calendar-outline'}
                  size={14}
                  color={t.colors.accent}
                />
                <Text variant="bodySm" weight="bold" tone="accent">
                  {showMore ? 'Less' : 'Other dates'}
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>

          {/* The fuller availability picker — every open day in the next few
              weeks, ranked soonest-first, with how free each one is. */}
          {showMore && moreDays.length > 0 ? (
            <Animated.View
              entering={ENTER(0)}
              exiting={EXIT(0)}
              layout={LinearTransition.duration(220)}
              style={[styles.moreDates, { borderColor: t.colors.separator }]}
            >
              {moreDays.map((s) => (
                <Pressable
                  key={s.date}
                  onPress={() => onPickDay(s)}
                  style={({ pressed }) => [
                    styles.moreDateRow,
                    pressed && { backgroundColor: t.colors.fill1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Move to ${fullDayLabel(s.date)} at ${formatTime(
                    s.slotStartLabel,
                  )}, ${formatDuration(s.freeMin)} free`}
                >
                  <Ionicons name="calendar-outline" size={16} color={t.colors.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                      {fullDayLabel(s.date)} · {formatTime(s.slotStartLabel)}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {formatDuration(s.freeMin)} free
                    </Text>
                  </View>
                  <Ionicons name="arrow-forward" size={15} color={t.colors.accent} />
                </Pressable>
              ))}
            </Animated.View>
          ) : null}
        </>
      ) : null}

      <View style={styles.conflictActions}>
        {moveTarget ? (
          <Pressable
            onPress={() => onMoveOther(primary)}
            style={({ pressed }) => [
              styles.conflictAction,
              { borderColor: t.colors.separator, backgroundColor: t.colors.fill1 },
              pressed && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Move ${primary.errand.title} to ${dayChipLabel(
              moveTarget.date,
            )} ${formatTime(moveTarget.slotStartLabel)}`}
          >
            <Ionicons name="swap-horizontal" size={15} color={t.colors.textSecondary} />
            <Text variant="caption" weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              Move {primary.errand.title} → {dayChipLabel(moveTarget.date)}{' '}
              {formatTime(moveTarget.slotStartLabel)}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onRemoveOther(primary)}
          style={({ pressed }) => [
            styles.conflictAction,
            { borderColor: t.colors.separator, backgroundColor: t.colors.fill1 },
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${isRecurring ? 'Skip' : 'Remove'} ${primary.errand.title}`}
        >
          <Ionicons
            name={isRecurring ? 'play-skip-forward-outline' : 'trash-outline'}
            size={15}
            color={t.colors.danger}
          />
          <Text
            variant="caption"
            weight="semibold"
            numberOfLines={1}
            style={{ color: t.colors.danger, flexShrink: 1 }}
          >
            {isRecurring ? 'Skip' : 'Remove'} {primary.errand.title}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

/**
 * A labelled section: small icon + caption header above its control. `index`
 * drives its place in the staggered intro; `layout` smooths the reflow when a
 * field grows (e.g. the Time section expanding) so the fields below glide.
 */
function Field({
  icon,
  label,
  index,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  index: number;
  children: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <Animated.View
      entering={ENTER(index)}
      exiting={EXIT(index)}
      layout={LinearTransition.duration(220)}
      style={styles.field}
    >
      <View style={styles.fieldHead}>
        <Ionicons name={icon} size={15} color={t.colors.textSecondary} />
        <Text variant="caption" tone="secondary" weight="semibold">
          {label}
        </Text>
      </View>
      {children}
    </Animated.View>
  );
}

/** A selectable pill (date / time mode). */
function SelectChip({
  label,
  active,
  onPress,
  onLayout,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLayout={onLayout}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? t.colors.accent : t.colors.fill1,
          borderColor: active ? t.colors.accent : t.colors.separator,
        },
        pressed && !active && { opacity: 0.7 },
      ]}
    >
      <Text
        variant="bodySm"
        weight="semibold"
        style={{ color: active ? t.colors.textOnAccent : t.colors.textSecondary }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A start/end time row: label on the left, inline (iOS) / pill (Android) picker. */
function TimeRow({
  label,
  value,
  display,
  onChange,
  onAndroidOpen,
}: {
  label: string;
  value: Date;
  display: string;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidOpen: () => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.timeRow, { borderTopColor: t.colors.separator }]}>
      <Text variant="body" weight="semibold">
        {label}
      </Text>
      {Platform.OS === 'ios' ? (
        <DateTimePicker
          value={value}
          mode="time"
          display="compact"
          minuteInterval={5}
          onChange={onChange}
          themeVariant={t.isDark ? 'dark' : 'light'}
        />
      ) : (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onAndroidOpen();
          }}
          style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
        >
          <Text variant="body" weight="bold" tone="accent">
            {display}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** A pill for choosing how the errand's location is set (the "Where" methods). */
function LocMethodChip({
  label,
  icon,
  active,
  disabled,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = active ? t.colors.textOnAccent : t.colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.locChip,
        {
          backgroundColor: active ? t.colors.accent : t.colors.fill1,
          borderColor: active ? t.colors.accent : t.colors.separator,
        },
        disabled && { opacity: 0.4 },
        pressed && !active && { opacity: 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text variant="bodySm" weight="semibold" style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A small inline hint shown under the location methods (no place chosen yet). */
function LocationHint({
  icon,
  text,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.locHint,
        { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
      ]}
    >
      <Ionicons name={icon} size={15} color={t.colors.textTertiary} />
      <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/** The "at an existing errand" picker: the day's other located errands. */
function ExistingErrandPicker({
  errands,
  onPick,
}: {
  errands: Errand[];
  onPick: (value: AddressValue) => void;
}) {
  const t = useTheme();
  if (errands.length === 0) {
    return (
      <LocationHint
        icon="git-merge-outline"
        text="No other located errands on this day yet — use Home, Specific, or Discover."
      />
    );
  }
  return (
    <View style={[styles.existingList, { borderColor: t.colors.separator }]}>
      {errands.map((e, i) => (
        <Pressable
          key={e.id}
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            onPick(errandToLocValue(e));
          }}
          style={({ pressed }) => [
            styles.existingRow,
            i > 0 && {
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: t.colors.separator,
            },
            pressed && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Use ${e.title}'s location`}
        >
          <Ionicons
            name="location"
            size={16}
            color={t.colors.accentText}
            style={styles.existingIcon}
          />
          <View style={{ flex: 1 }}>
            <Text variant="bodySm" weight="semibold" numberOfLines={1}>
              {e.title}
            </Text>
            {e.address ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {e.address}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  body: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 18,
  },
  field: {
    gap: 8,
  },
  fieldHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  locMethods: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 4,
  },
  locChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  locHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  existingList: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  existingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  existingIcon: {
    width: 18,
    textAlign: 'center',
  },
  suggestBlock: {
    gap: 8,
    paddingBottom: 10,
  },
  suggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
  },
  balanceCard: {
    gap: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  balanceLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  balanceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  balanceScore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  conflictCard: {
    gap: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  conflictHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  conflictLabel: {
    paddingTop: 2,
  },
  suggestDayChip: {
    gap: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  moreDatesChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: 'transparent',
  },
  moreDates: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  moreDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  conflictActions: {
    gap: 8,
    paddingTop: 2,
  },
  conflictAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  travelBlock: {
    gap: 8,
    paddingTop: 10,
  },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  titleInput: {
    fontSize: 17,
    fontWeight: '600',
  },
  chipRow: {
    gap: 8,
    paddingRight: 8,
  },
  segment: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  timeRows: {
    marginTop: 4,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  durationHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  durationHint: {
    paddingHorizontal: 2,
    paddingTop: 10,
  },
  noteHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 2,
  },
  noteHintText: {
    flex: 1,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 4,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
