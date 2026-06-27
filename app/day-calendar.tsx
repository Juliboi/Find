import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { GlassSurface } from '@/components/Glass';
import { DayEditor } from '@/components/DayEditor';
import { WeekHeader, WeekGrid, type WeekDay } from '@/components/WeekTimeline';
import { ErrandDrawer } from '@/components/ErrandDrawer';
import {
  useErrandsStore,
  type Errand,
  type ErrandInput,
} from '@/store/useErrandsStore';
import {
  useSavedItineraries,
  activePlanForDate,
  plansForDate,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import { useRecurringErrandsStore } from '@/store/useRecurringErrandsStore';
import { materializeRecurringForDate, skipRecurringOccurrence } from '@/lib/recurring';
import { buildDayCalendar, dayWindow } from '@/lib/calendar/dayCalendar';
import { type ErrandDraft } from '@/lib/ai/parseErrand';
import { currentHHMM, formatDuration, minutesOfDay, todayISO } from '@/utils/time';
import {
  dateFromISO,
  describeDay,
  startOfWeek,
  upcomingWeek,
  type DayOption,
} from '@/utils/days';

const HOUR_HEIGHT = 64;
const WEEK_HOUR_HEIGHT = 52;
const WEEK_GUTTER = 44;
const H_PAD_DAY = 16;
const H_PAD_WEEK = 10;

const EMPTY_DRAFT: ErrandDraft = {
  title: '',
  date: null,
  startTime: null,
  endTime: null,
  address: null,
  notes: null,
};

function errandToDraft(e: Errand): ErrandDraft {
  return {
    title: e.title,
    date: e.date ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    durationMin: e.durationMin ?? null,
    address: e.address ?? null,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    placeId: e.placeId ?? null,
    photoUrl: e.photoUrl ?? null,
    rating: e.rating ?? null,
    ratingCount: e.ratingCount ?? null,
    priceLevel: e.priceLevel ?? null,
    openingHours: e.openingHours ?? null,
    travelMode: e.travelMode ?? null,
    notes: e.notes ?? null,
  };
}

function shiftISO(iso: string, deltaDays: number): string {
  const d = dateFromISO(iso);
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatLongDate(iso: string): string {
  return dateFromISO(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** "Jun 22 – 28" (or "Jun 30 – Jul 6" across a month boundary). */
function weekRange(opts: DayOption[]): string {
  if (opts.length === 0) return '';
  const a = opts[0];
  const b = opts[opts.length - 1];
  return a.monthShort === b.monthShort
    ? `${a.monthShort} ${a.dayNum} \u2013 ${b.dayNum}`
    : `${a.monthShort} ${a.dayNum} \u2013 ${b.monthShort} ${b.dayNum}`;
}

function planSubtitle(trip: SavedItinerary): string {
  const parts: string[] = [];
  if (trip.stopCount > 0) {
    parts.push(`${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}`);
  }
  const place = trip.city ?? trip.origin;
  if (place) parts.push(place.split(',')[0]);
  return parts.join(' · ');
}

/**
 * The full day, drawn as a calendar. Timed errands become positioned blocks on
 * the timeline; the day's other plans — its saved itinerary and any untimed
 * reminders — sit in a fixed "Also today" tray above it so nothing is hidden.
 * A Day/Week toggle (the overview button by the back arrow) swaps the single-day
 * timeline for a seven-column week grid. Tapping a block opens it for editing.
 */
export default function DayCalendarScreen() {
  const router = useRouter();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ date?: string }>();
  const today = todayISO();

  const [date, setDate] = useState(
    typeof params.date === 'string' && params.date ? params.date : today,
  );
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [editing, setEditing] = useState(false);
  const isWeek = viewMode === 'week';
  const isToday = date === today;
  const day = useMemo(() => describeDay(date), [date]);

  const recurringTemplates = useRecurringErrandsStore((s) => s.items);
  const errands = useErrandsStore((s) => s.items);
  const updateErrand = useErrandsStore((s) => s.update);
  const removeErrand = useErrandsStore((s) => s.remove);
  const savedTrips = useSavedItineraries((s) => s.items);

  // The Monday-start week containing `date`, for the week view + its nav.
  const weekOptions = useMemo(() => upcomingWeek(7, startOfWeek(date)), [date]);
  const isThisWeek = useMemo(
    () => weekOptions.some((o) => o.iso === today),
    [weekOptions, today],
  );
  const todayIndex = useMemo(
    () => weekOptions.findIndex((o) => o.iso === today),
    [weekOptions, today],
  );

  // Materialize recurring occurrences for whatever days are on screen
  // (idempotent — never duplicates or clobbers an edited occurrence).
  useEffect(() => {
    if (isWeek) weekOptions.forEach((o) => materializeRecurringForDate(o.iso));
    else materializeRecurringForDate(date);
  }, [isWeek, date, weekOptions, recurringTemplates]);

  const { timed, untimed } = useMemo(
    () => buildDayCalendar(errands, date),
    [errands, date],
  );
  const weekDays = useMemo<WeekDay[]>(
    () =>
      weekOptions.map((o) => ({
        iso: o.iso,
        weekdayShort: o.weekdayShort,
        dayNum: o.dayNum,
        isToday: o.iso === today,
        events: buildDayCalendar(errands, o.iso).timed,
      })),
    [weekOptions, errands, today],
  );
  const weekTimed = useMemo(() => weekDays.flatMap((d) => d.events), [weekDays]);

  const plan = useMemo(() => activePlanForDate(savedTrips, date), [savedTrips, date]);
  const planCount = useMemo(
    () => plansForDate(savedTrips, date).length,
    [savedTrips, date],
  );

  // A minute tick keeps the "now" line live while the screen stays open.
  const [nowMin, setNowMin] = useState(() => minutesOfDay(currentHHMM()) ?? 0);
  useEffect(() => {
    if (isWeek ? !isThisWeek : !isToday) return;
    const id = setInterval(() => setNowMin(minutesOfDay(currentHHMM()) ?? 0), 60 * 1000);
    return () => clearInterval(id);
  }, [isWeek, isThisWeek, isToday]);

  const liveNow = isToday ? nowMin : null;
  const weekNow = isThisWeek ? nowMin : null;
  const dayWin = useMemo(() => dayWindow(timed, { nowMin: liveNow }), [timed, liveNow]);
  const weekWin = useMemo(
    () => dayWindow(weekTimed, { nowMin: weekNow }),
    [weekTimed, weekNow],
  );
  const win = isWeek ? weekWin : dayWin;

  const hPad = isWeek ? H_PAD_WEEK : H_PAD_DAY;
  const colW = (width - hPad * 2 - WEEK_GUTTER) / 7;

  // Open the timeline at the most relevant point: now (when on screen), else the
  // first event, else the top of the window.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    const evs = isWeek ? weekTimed : timed;
    const nowForMode = isWeek ? weekNow : liveNow;
    const hh = isWeek ? WEEK_HOUR_HEIGHT : HOUR_HEIGHT;
    let anchor = win.startMin;
    if (nowForMode != null && nowForMode >= win.startMin && nowForMode <= win.endMin) {
      anchor = nowForMode;
    } else if (evs.length > 0) {
      anchor = evs.reduce((m, e) => Math.min(m, e.startMin), 24 * 60);
    }
    const y = Math.max(0, ((anchor - win.startMin) * hh) / 60 - 90);
    const id = setTimeout(() => scrollRef.current?.scrollTo({ y, animated: false }), 60);
    return () => clearTimeout(id);
    // Re-anchor when the day/mode changes; not on every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, isWeek, win.startMin]);

  // ----- Edit drawer (reused from the home composer) -----
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [seed, setSeed] = useState<ErrandDraft>(EMPTY_DRAFT);
  const [seedRaw, setSeedRaw] = useState('');
  const [seedKey, setSeedKey] = useState('seed-0');

  const openEdit = useCallback((errand: Errand) => {
    Haptics.selectionAsync().catch(() => undefined);
    setEditId(errand.id);
    setSeed(errandToDraft(errand));
    setSeedRaw(errand.rawText);
    setSeedKey(`edit-${errand.id}-${errand.updatedAt}`);
    setDrawerOpen(true);
  }, []);

  // Stable so a held card's gesture keeps a steady callback into edit mode.
  const beginEditFromHold = useCallback(() => setEditing(true), []);
  const exitEdit = useCallback(() => setEditing(false), []);

  const onSave = (input: ErrandInput) => {
    if (editId) updateErrand(editId, input);
    setDrawerOpen(false);
  };

  const onDelete = () => {
    if (editId) {
      const e = errands.find((x) => x.id === editId);
      // Deleting a recurring occurrence skips just this one (mirrors home).
      if (e?.recurringId && e.date) skipRecurringOccurrence(e.recurringId, e.date);
      else removeErrand(editId);
    }
    setDrawerOpen(false);
  };

  const atToday = isWeek ? isThisWeek : isToday;
  const goToday = () => {
    if (atToday) return;
    Haptics.selectionAsync().catch(() => undefined);
    setDate(today);
  };
  const stepBy = (deltaDays: number) => {
    Haptics.selectionAsync().catch(() => undefined);
    setDate((d) => shiftISO(d, deltaDays));
  };
  const toggleView = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setViewMode((m) => (m === 'week' ? 'day' : 'week'));
  };
  const openDay = (iso: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setDate(iso);
    setViewMode('day');
  };
  const enterEdit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setViewMode('day');
    setEditing(true);
  };

  const navTitle = isWeek ? (isThisWeek ? 'This week' : 'Week') : day.title;
  // Compact subtitle ("Jun 24") so the whole nav fits on one row beside the
  // controls; the full date is kept for the screen-reader label below.
  const navSubtitle = isWeek ? weekRange(weekOptions) : day.dateLabel;
  const navA11y = isWeek ? `${navTitle}, ${weekRange(weekOptions)}` : formatLongDate(date);
  const showTodayBtn = !atToday;
  // Kept visible in both view + edit so the day canvas never shifts vertically
  // when a held card flips us into edit mode (the drag would otherwise jump).
  const hasTray = !isWeek && (Boolean(plan) || untimed.length > 0);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      {/* Header — one row: back + day/week (left), date nav + today (right) */}
      <View style={styles.header}>
        <GlassSurface
          variant="regular"
          radius={t.radii.pill}
          style={styles.pill}
          innerStyle={styles.pillInner}
        >
          <HeaderButton
            icon="chevron-back"
            label="Back"
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              if (editing) setEditing(false);
              else router.back();
            }}
          />
          {!editing ? (
            <>
              <View style={[styles.pillDivider, { backgroundColor: t.colors.separator }]} />
              <HeaderButton
                icon="grid-outline"
                label={isWeek ? 'Switch to day view' : 'Switch to week overview'}
                onPress={toggleView}
                active={isWeek}
              />
              <View style={[styles.pillDivider, { backgroundColor: t.colors.separator }]} />
              <HeaderButton
                icon="create-outline"
                label="Edit schedule"
                onPress={enterEdit}
              />
            </>
          ) : null}
        </GlassSurface>

        {editing ? (
          <View style={[styles.dayNav, styles.editNav]}>
            <Text variant="subhead" weight="bold" tight numberOfLines={1}>
              Edit schedule
            </Text>
            <Text variant="micro" tone="secondary" numberOfLines={1}>
              {day.dateLabel}
            </Text>
          </View>
        ) : (
          <View style={styles.dayNav}>
            <Pressable
              onPress={() => stepBy(isWeek ? -7 : -1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={isWeek ? 'Previous week' : 'Previous day'}
              style={({ pressed }) => [
                styles.navBtn,
                { backgroundColor: t.colors.fill1 },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons name="chevron-back" size={18} color={t.colors.textSecondary} />
            </Pressable>

            <Pressable
              onPress={goToday}
              disabled={atToday}
              style={styles.dayNavCenter}
              accessibilityRole="button"
              accessibilityLabel={
                atToday
                  ? navA11y
                  : `${navA11y}. Tap to jump to ${isWeek ? 'this week' : 'today'}`
              }
            >
              <Text variant="subhead" weight="bold" tight numberOfLines={1}>
                {navTitle}
              </Text>
              <Text variant="micro" tone="secondary" numberOfLines={1}>
                {navSubtitle}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => stepBy(isWeek ? 7 : 1)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={isWeek ? 'Next week' : 'Next day'}
              style={({ pressed }) => [
                styles.navBtn,
                { backgroundColor: t.colors.fill1 },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons name="chevron-forward" size={18} color={t.colors.textSecondary} />
            </Pressable>
          </View>
        )}

        {/* {showTodayBtn ? (
          <GlassSurface
            variant="regular"
            radius={t.radii.pill}
            style={styles.pill}
            innerStyle={styles.pillInner}
          >
            <HeaderButton
              icon="today-outline"
              label={isWeek ? 'Jump to this week' : 'Jump to today'}
              onPress={goToday}
            />
          </GlassSurface>
        ) : null} */}
      </View>

      {/* "Also today" tray — the day's other plans, always visible (day view) */}
      {hasTray ? (
        <View style={[styles.tray, { borderBottomColor: t.colors.separator }]}>
          {plan ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                router.push({ pathname: '/itinerary', params: { id: plan.id } });
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open plan ${plan.title}`}
              style={({ pressed }) => (pressed ? { opacity: 0.85 } : undefined)}
            >
              <GlassSurface
                variant="regular"
                radius={t.radii.lg}
                style={styles.planCard}
                innerStyle={styles.planCardInner}
              >
                <View style={[styles.planThumb, { backgroundColor: t.colors.fill1 }]}>
                  {plan.thumbUrl ? (
                    <Image source={{ uri: plan.thumbUrl }} style={styles.planThumbImg} />
                  ) : (
                    <Ionicons name="map-outline" size={18} color={t.colors.textSecondary} />
                  )}
                </View>
                <View style={styles.planText}>
                  <Text variant="micro" uppercase weight="bold" tone="accent">
                    {planCount > 1 ? `Plan · +${planCount - 1} more` : 'Day plan'}
                  </Text>
                  <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                    {plan.title}
                  </Text>
                  {planSubtitle(plan) ? (
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {planSubtitle(plan)}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={16} color={t.colors.textTertiary} />
              </GlassSurface>
            </Pressable>
          ) : null}

          {untimed.length > 0 ? (
            <View style={styles.unscheduled}>
              <Text
                variant="micro"
                uppercase
                weight="bold"
                tone="secondary"
                style={styles.unscheduledHead}
              >
                {`Unscheduled · ${untimed.length}`}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chips}
              >
                {untimed.map((errand) => (
                  <UnscheduledChip
                    key={errand.id}
                    errand={errand}
                    onPress={() => openEdit(errand)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}

      {isWeek ? (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingHorizontal: hPad }]}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={[0]}
        >
          <WeekHeader
            days={weekDays}
            gutter={WEEK_GUTTER}
            colW={colW}
            selectedDate={date}
            onPressDay={openDay}
          />
          <WeekGrid
            days={weekDays}
            gutter={WEEK_GUTTER}
            colW={colW}
            startMin={weekWin.startMin}
            endMin={weekWin.endMin}
            hourHeight={WEEK_HOUR_HEIGHT}
            nowMin={weekNow}
            todayIndex={todayIndex}
            onPressEvent={openEdit}
          />
        </ScrollView>
      ) : (
        // The day is always the editor: in `view` it reads like the timeline, but
        // holding a card flips it to `edit` and the same press keeps dragging.
        <DayEditor
          key={date}
          date={date}
          errands={errands}
          mode={editing ? 'edit' : 'view'}
          nowMin={liveNow}
          onPressEvent={openEdit}
          onRequestEdit={beginEditFromHold}
          onClose={exitEdit}
        />
      )}

      <ErrandDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        draft={seed}
        rawText={seedRaw}
        parsing={false}
        seedKey={seedKey}
        mode="edit"
        currentErrandId={editId}
        onSave={onSave}
        onDelete={onDelete}
      />
    </SafeAreaView>
  );
}

function HeaderButton({
  icon,
  onPress,
  label,
  active,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  label: string;
  active?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.headerBtn,
        active && { backgroundColor: t.colors.accent },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Ionicons
        name={icon}
        size={18}
        color={active ? t.colors.textOnAccent : t.colors.textPrimary}
      />
    </Pressable>
  );
}

/**
 * An untimed reminder in the tray — a tappable pill that opens the editor (the
 * current way to give it a time). A small glyph hints at its place state.
 */
function UnscheduledChip({
  errand,
  onPress,
}: {
  errand: Errand;
  onPress: () => void;
}) {
  const t = useTheme();
  const located = errand.latitude != null && errand.longitude != null;
  const photo = errand.photoUrl;
  const icon: keyof typeof Ionicons.glyphMap = errand.recurringId
    ? 'repeat'
    : located
      ? 'location'
      : 'ellipse-outline';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Edit ${errand.title}`}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: t.colors.fill1, borderColor: t.colors.separator },
        pressed && { opacity: 0.6 },
      ]}
    >
      {photo ? (
        <Image source={{ uri: photo }} style={[styles.chipThumb, { backgroundColor: t.colors.fill2 }]} />
      ) : (
        <Ionicons name={icon} size={12} color={t.colors.textSecondary} />
      )}
      <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.chipText}>
        {errand.title}
      </Text>
      {errand.durationMin ? (
        <Text variant="micro" tone="tertiary">
          {`~${formatDuration(errand.durationMin)}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    minHeight: 40,
  },
  pill: {
    height: 40,
  },
  pillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingHorizontal: 4,
  },
  pillDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    marginHorizontal: 2,
  },
  headerBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  dayNav: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNavCenter: {
    flexShrink: 1,
    alignItems: 'center',
    gap: 1,
    paddingHorizontal: 16,
  },
  editNav: {
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 1,
  },
  tray: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  planCard: {
    overflow: 'hidden',
  },
  planCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
  },
  planThumb: {
    width: 40,
    height: 40,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  planThumbImg: {
    width: '100%',
    height: '100%',
  },
  planText: {
    flex: 1,
    gap: 1,
  },
  unscheduled: {
    gap: 8,
  },
  unscheduledHead: {
    letterSpacing: 1.2,
    paddingHorizontal: 2,
  },
  chips: {
    gap: 8,
    paddingRight: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 220,
  },
  chipThumb: {
    width: 22,
    height: 22,
    borderRadius: 7,
    marginLeft: -4,
  },
  chipText: {
    flexShrink: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 8,
    paddingBottom: 48,
  },
  emptyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingBottom: 12,
  },
  timeline: {
    width: '100%',
  },
});
