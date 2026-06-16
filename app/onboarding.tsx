import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Input } from '@/components/Input';
import { HomePicker } from '@/components/HomePicker';
import { PeopleManager } from '@/components/PeopleManager';
import { RecurringErrandManager } from '@/components/RecurringErrandManager';
import { useHomeStore } from '@/store/useHomeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useProfileStore } from '@/store/useProfileStore';
import { useNotificationStore } from '@/store/useNotificationStore';
import {
  ensureNotificationPermission,
  type PlanRemindersMode,
} from '@/lib/notifications';
import { formatTime } from '@/utils/time';

const STEP_COUNT = 10;

/**
 * Maps a settings "edit" deep-link to the onboarding step that owns that
 * preference, so Settings can drop the user straight onto the same screen they
 * filled out during onboarding to tweak a single answer. `rhythm` is kept as a
 * back-compat alias for the old combined wake/bed step (now "morning").
 */
const EDIT_STEPS: Record<string, number> = {
  name: 0,
  home: 1,
  morning: 2,
  rhythm: 2,
  meals: 3,
  winddown: 4,
  car: 5,
  diet: 6,
  people: 7,
  recurring: 8,
};

/** Dietary tags offered as chips in onboarding (kept short + recognisable). */
const DIET_OPTIONS = [
  'Vegetarian',
  'Vegan',
  'Pescatarian',
  'Halal',
  'Kosher',
  'Gluten-free',
  'Dairy-free',
  'Nut allergy',
];

/** How long the user takes to fully wake up, mapped to representative minutes. */
const WAKE_RAMP_OPTIONS: { label: string; minutes: number }[] = [
  { label: 'Up instantly', minutes: 10 },
  { label: '~30 min', minutes: 30 },
  { label: '~45 min', minutes: 45 },
  { label: '~1 hour', minutes: 60 },
  { label: 'Slow starter', minutes: 90 },
];

/** The set of wall-clock answers collected across the rhythm-related steps. */
type TimeKey =
  | 'wake'
  | 'bed'
  | 'windDown'
  | 'breakfastStart'
  | 'breakfastEnd'
  | 'lunchStart'
  | 'lunchEnd'
  | 'dinnerStart'
  | 'dinnerEnd';

function makeTime(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Seed a time picker from a stored "HH:MM", falling back to a sensible time. */
function hhmmToTime(
  hhmm: string | null,
  fallbackHour: number,
  fallbackMinute = 0,
): Date {
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    return makeTime(h, m);
  }
  return makeTime(fallbackHour, fallbackMinute);
}

function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** A copy of `d` shifted by `minutes` (used to derive smart defaults). */
function addMinutesToDate(d: Date, minutes: number): Date {
  const r = new Date(d);
  r.setMinutes(r.getMinutes() + minutes);
  return r;
}

/** "7:30 AM" style label for a Date. */
function formatClock(d: Date): string {
  return formatTime(toHHMM(d));
}

export default function OnboardingScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const home = useHomeStore((s) => s.home);
  const saveOnboarding = useAuthStore((s) => s.saveOnboarding);
  const user = useAuthStore((s) => s.user);
  const planRemindersMode = useNotificationStore((s) => s.planRemindersMode);
  const setPlanRemindersMode = useNotificationStore(
    (s) => s.setPlanRemindersMode,
  );
  const storedName = useProfileStore((s) => s.fullName);
  const storedWake = useProfileStore((s) => s.wakeTime);
  const storedBed = useProfileStore((s) => s.bedTime);
  const storedWakeRamp = useProfileStore((s) => s.wakeUpDurationMin);
  const storedBreakfastStart = useProfileStore((s) => s.breakfastStart);
  const storedBreakfastEnd = useProfileStore((s) => s.breakfastEnd);
  const storedLunchStart = useProfileStore((s) => s.lunchStart);
  const storedLunchEnd = useProfileStore((s) => s.lunchEnd);
  const storedDinnerStart = useProfileStore((s) => s.dinnerStart);
  const storedDinnerEnd = useProfileStore((s) => s.dinnerEnd);
  const storedWindDown = useProfileStore((s) => s.windDownTime);
  const storedAllowScreen = useProfileStore((s) => s.allowScreenWindDown);
  const storedHasCar = useProfileStore((s) => s.hasCar);
  const storedDietary = useProfileStore((s) => s.dietary);
  const storedDietaryNotes = useProfileStore((s) => s.dietaryNotes);

  // When launched from Settings with `?edit=<key>`, we open on that single
  // step in "edit one preference" mode: jump to its step, seed the existing
  // answers, and swap the wizard footer for Cancel / Save instead of advancing
  // through the rest of onboarding.
  const params = useLocalSearchParams<{ edit?: string }>();
  const editKey = typeof params.edit === 'string' ? params.edit : null;
  const editStep = editKey != null ? EDIT_STEPS[editKey] : undefined;
  const editing = editStep != null;

  const initialName =
    storedName ??
    (typeof user?.user_metadata?.full_name === 'string'
      ? (user.user_metadata.full_name as string)
      : '');

  const [step, setStep] = useState(editStep ?? 0);
  const [name, setName] = useState(initialName ?? '');

  // All wall-clock answers live in one record so the Android picker (a single
  // shared dialog) and the smart "wind-down before bed" / "breakfast after
  // wake" defaults stay simple to manage.
  const [times, setTimes] = useState<Record<TimeKey, Date>>(() => {
    const wake = hhmmToTime(storedWake, 7);
    const bed = hhmmToTime(storedBed, 23);
    return {
      wake,
      bed,
      windDown: storedWindDown
        ? hhmmToTime(storedWindDown, 21, 30)
        : addMinutesToDate(bed, -90),
      breakfastStart: storedBreakfastStart
        ? hhmmToTime(storedBreakfastStart, 7, 30)
        : addMinutesToDate(wake, 30),
      breakfastEnd: storedBreakfastEnd
        ? hhmmToTime(storedBreakfastEnd, 8, 30)
        : addMinutesToDate(wake, 90),
      lunchStart: hhmmToTime(storedLunchStart, 12, 0),
      lunchEnd: hhmmToTime(storedLunchEnd, 13, 0),
      dinnerStart: hhmmToTime(storedDinnerStart, 18, 30),
      dinnerEnd: hhmmToTime(storedDinnerEnd, 19, 30),
    };
  });
  const [wakeRamp, setWakeRamp] = useState<number>(storedWakeRamp ?? 30);
  const [allowScreen, setAllowScreen] = useState<boolean>(
    storedAllowScreen ?? false,
  );

  // Seed the choice steps from the saved profile when editing so the current
  // answer shows as selected; first-run keeps them unset to force a choice.
  const [hasCar, setHasCar] = useState<boolean | null>(
    editing ? storedHasCar : null,
  );
  const [dietary, setDietary] = useState<string[]>(
    editing ? storedDietary : [],
  );
  const [dietaryNotes, setDietaryNotes] = useState(
    editing ? (storedDietaryNotes ?? '') : '',
  );
  const [androidPicker, setAndroidPicker] = useState<TimeKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue =
    step === 0
      ? name.trim().length > 0
      : step === 1
        ? home != null
        : step === 5
          ? hasCar != null
          : true;

  const setTime = (key: TimeKey, d: Date) =>
    setTimes((prev) => ({ ...prev, [key]: d }));

  /** A picker-change handler bound to one time slot. */
  const onTimeChange =
    (key: TimeKey) => (_: DateTimePickerEvent, picked?: Date) => {
      if (Platform.OS !== 'ios') setAndroidPicker(null);
      if (picked) setTime(key, picked);
    };

  const toggleDiet = (opt: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setDietary((prev) =>
      prev.includes(opt) ? prev.filter((d) => d !== opt) : [...prev, opt],
    );
  };

  // Plan reminders live in the (local-first) notification store, not the synced
  // profile, so we write the choice straight through on tap. Picking a notifying
  // mode prompts for permission; the root effect schedules the reminders once a
  // plan exists. Permission being refused is fine here — the choice still sticks
  // and starts working the moment notifications are enabled.
  const choosePlanReminders = (mode: PlanRemindersMode) => {
    Haptics.selectionAsync().catch(() => undefined);
    void setPlanRemindersMode(mode);
  };

  const goNext = () => {
    if (!canContinue) return;
    Haptics.selectionAsync().catch(() => undefined);
    if (step < STEP_COUNT - 1) {
      setStep((s) => s + 1);
    } else {
      void finish();
    }
  };

  const goBack = () => {
    Haptics.selectionAsync().catch(() => undefined);
    setStep((s) => Math.max(0, s - 1));
  };

  /** Upsert the whole profile from the current answers. Returns success. */
  const persist = async (): Promise<boolean> => {
    setError(null);
    setSaving(true);
    try {
      await saveOnboarding({
        fullName: name.trim() || null,
        homeLabel: home?.label ?? null,
        homeLatitude: home?.latitude ?? null,
        homeLongitude: home?.longitude ?? null,
        wakeTime: toHHMM(times.wake),
        bedTime: toHHMM(times.bed),
        wakeUpDurationMin: wakeRamp,
        breakfastStart: toHHMM(times.breakfastStart),
        breakfastEnd: toHHMM(times.breakfastEnd),
        lunchStart: toHHMM(times.lunchStart),
        lunchEnd: toHHMM(times.lunchEnd),
        dinnerStart: toHHMM(times.dinnerStart),
        dinnerEnd: toHHMM(times.dinnerEnd),
        windDownTime: toHHMM(times.windDown),
        allowScreenWindDown: allowScreen,
        hasCar: hasCar ?? false,
        dietary,
        dietaryNotes: dietaryNotes.trim() ? dietaryNotes.trim() : null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save your profile. Please try again.',
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  // First-run: the auth gate sees needsOnboarding flip to false and routes home.
  const finish = () => {
    // The reminders step defaults to a notifying mode, so a user can finish
    // without ever tapping it. Ask for permission as we wrap up (best-effort,
    // non-blocking, and a no-op once already decided) so the default actually
    // fires — the root effect schedules reminders once a plan exists.
    if (planRemindersMode !== 'none') {
      void ensureNotificationPermission();
    }
    void persist();
  };

  // Editing a single preference from Settings: save, then return to Settings
  // rather than walking the rest of the onboarding wizard.
  const saveEdit = async () => {
    if (!canContinue) return;
    Haptics.selectionAsync().catch(() => undefined);
    const ok = await persist();
    if (ok) router.back();
  };

  const cancelEdit = () => {
    Haptics.selectionAsync().catch(() => undefined);
    router.back();
  };

  const productiveStart = addMinutesToDate(times.wake, wakeRamp);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top', 'bottom']}
    >
      <View style={[styles.header, { paddingHorizontal: t.spacing.xl }]}>
        {editing ? (
          <View style={styles.editHeader}>
            <Pressable
              onPress={cancelEdit}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => [
                styles.editClose,
                { backgroundColor: t.colors.fill1 },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="close" size={20} color={t.colors.textPrimary} />
            </Pressable>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Edit preference
            </Text>
            <View style={styles.editClose} />
          </View>
        ) : (
          <>
            <View style={styles.progressRow}>
              {Array.from({ length: STEP_COUNT }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressSeg,
                    {
                      backgroundColor:
                        i <= step ? t.colors.accent : t.colors.fill2,
                    },
                  ]}
                />
              ))}
            </View>
            <Text variant="micro" tone="tertiary" uppercase weight="bold">
              Step {step + 1} of {STEP_COUNT}
            </Text>
          </>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: t.spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 0 ? (
          <StepIntro
            title="What should we call you?"
            subtitle="We'll use your name to make your plans feel like yours."
          />
        ) : null}
        {step === 1 ? (
          <StepIntro
            title="Where's home?"
            subtitle="Diem plans your day around it — travel times, your first stop, and the trip back home."
          />
        ) : null}
        {step === 2 ? (
          <StepIntro
            title="Your mornings"
            subtitle="When do you wake, and how long until you're firing on all cylinders? We'll ease you in and protect your focus."
          />
        ) : null}
        {step === 3 ? (
          <StepIntro
            title="Meal times"
            subtitle="When are you comfortable eating? Diem slots meals into these windows around the rest of your day."
          />
        ) : null}
        {step === 4 ? (
          <StepIntro
            title="Winding down"
            subtitle="When should the evening get calm? We'll stop adding high-energy plans and help protect your sleep."
          />
        ) : null}
        {step === 5 ? (
          <StepIntro
            title="Do you have a car?"
            subtitle="Optional. When you do, Diem only drives when it actually saves time — and you can switch the car off for any individual day."
          />
        ) : null}
        {step === 6 ? (
          <StepIntro
            title="How do you eat?"
            subtitle="So every food and drink stop fits you. Pick any that apply, or skip it."
          />
        ) : null}
        {step === 7 ? (
          <StepIntro
            title="Anyone with a usual spot?"
            subtitle="Save people and their place, so “chill at Ondra’s” lands at the right address — while “call Ondra” stays put. Optional."
          />
        ) : null}
        {step === 8 ? (
          <StepIntro
            title="Anything that repeats?"
            subtitle="Add weekly things like “Ping pong every Monday at 18:00”. They show on the day and come preselected when you plan. Optional."
          />
        ) : null}
        {step === 9 ? (
          <StepIntro
            title="Stay on track"
            subtitle="Want a heads-up before what's next? Diem can nudge you ahead of each stop — timed around travel so you leave right when you need to."
          />
        ) : null}

        {step === 0 ? (
          <Input
            placeholder="Your name"
            leftIcon="person-outline"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoComplete="name"
            autoCorrect={false}
            returnKeyType={editing ? 'done' : 'next'}
            onSubmitEditing={editing ? () => void saveEdit() : goNext}
          />
        ) : null}

        {step === 1 ? <HomePicker slot="home" /> : null}

        {step === 2 ? (
          <View style={{ gap: t.spacing.lg }}>
            <Card padded style={{ padding: 0 }}>
              <TimeRow
                icon="sunny-outline"
                label="Wake up"
                hint="When your day starts"
                value={times.wake}
                hhmm={toHHMM(times.wake)}
                first
                onChange={onTimeChange('wake')}
                onAndroidPress={() => setAndroidPicker('wake')}
              />
            </Card>

            <View style={{ gap: t.spacing.sm }}>
              <Text variant="body" weight="semibold">
                How long until you’re fully awake?
              </Text>
              <Text variant="caption" tone="tertiary">
                We keep the first stretch gentle and ease into focused work.
              </Text>
              <View style={styles.chips}>
                {WAKE_RAMP_OPTIONS.map((opt) => (
                  <SelectChip
                    key={opt.minutes}
                    label={opt.label}
                    selected={wakeRamp === opt.minutes}
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => undefined);
                      setWakeRamp(opt.minutes);
                    }}
                  />
                ))}
              </View>
            </View>

            <NoteBanner
              icon="rocket-outline"
              iconColor={t.colors.accent}
              backgroundColor={t.colors.accentSoft}
            >
              Diem aims to have you ready for focused, productive time around{' '}
              <Text variant="bodySm" weight="bold" tone="accent">
                {formatClock(productiveStart)}
              </Text>
              .
            </NoteBanner>
          </View>
        ) : null}

        {step === 3 ? (
          <Card padded style={{ padding: 0 }}>
            <MealRow
              icon="cafe-outline"
              label="Breakfast"
              first
              start={times.breakfastStart}
              end={times.breakfastEnd}
              onStartChange={onTimeChange('breakfastStart')}
              onEndChange={onTimeChange('breakfastEnd')}
              onAndroidStart={() => setAndroidPicker('breakfastStart')}
              onAndroidEnd={() => setAndroidPicker('breakfastEnd')}
            />
            <MealRow
              icon="fast-food-outline"
              label="Lunch"
              start={times.lunchStart}
              end={times.lunchEnd}
              onStartChange={onTimeChange('lunchStart')}
              onEndChange={onTimeChange('lunchEnd')}
              onAndroidStart={() => setAndroidPicker('lunchStart')}
              onAndroidEnd={() => setAndroidPicker('lunchEnd')}
            />
            <MealRow
              icon="restaurant-outline"
              label="Dinner"
              start={times.dinnerStart}
              end={times.dinnerEnd}
              onStartChange={onTimeChange('dinnerStart')}
              onEndChange={onTimeChange('dinnerEnd')}
              onAndroidStart={() => setAndroidPicker('dinnerStart')}
              onAndroidEnd={() => setAndroidPicker('dinnerEnd')}
            />
          </Card>
        ) : null}

        {step === 4 ? (
          <View style={{ gap: t.spacing.lg }}>
            <Card padded style={{ padding: 0 }}>
              <TimeRow
                icon="cloudy-night-outline"
                label="Wind down from"
                hint="Diem keeps things calm after this"
                value={times.windDown}
                hhmm={toHHMM(times.windDown)}
                first
                onChange={onTimeChange('windDown')}
                onAndroidPress={() => setAndroidPicker('windDown')}
              />
              <TimeRow
                icon="moon-outline"
                label="Sleep"
                hint="Lights out — the hard end of your day"
                value={times.bed}
                hhmm={toHHMM(times.bed)}
                onChange={onTimeChange('bed')}
                onAndroidPress={() => setAndroidPicker('bed')}
              />
            </Card>

            <NoteBanner
              icon="leaf-outline"
              iconColor={t.colors.success}
              backgroundColor={t.colors.successSoft}
            >
              After{' '}
              <Text variant="bodySm" weight="bold">
                {formatClock(times.windDown)}
              </Text>{' '}
              Diem only suggests calm, sleep-friendly things — reading, a
              stretch, a warm shower — and won’t pack in anything high-energy.
            </NoteBanner>

            <Card padded style={{ padding: 0 }}>
              <ToggleRow
                icon="tv-outline"
                label="Allow screen-time wind-down"
                hint="Movies, gaming, scrolling before bed"
                value={allowScreen}
                onValueChange={(v) => {
                  Haptics.selectionAsync().catch(() => undefined);
                  setAllowScreen(v);
                }}
                first
              />
            </Card>

            {allowScreen ? (
              <NoteBanner
                icon="alert-circle-outline"
                iconColor={t.colors.warning}
                backgroundColor={t.colors.warningSoft}
              >
                Screens close to bedtime can hurt sleep quality. Diem will keep
                any screen-based wind-down light and wrap it up before{' '}
                <Text variant="bodySm" weight="bold">
                  {formatClock(times.bed)}
                </Text>
                .
              </NoteBanner>
            ) : null}
          </View>
        ) : null}

        {step === 5 ? (
          <View style={{ gap: t.spacing.md }}>
            <ChoiceCard
              icon="car-sport"
              label="Yes, I have a car"
              hint="Diem drives only when it helps — you choose per day"
              selected={hasCar === true}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setHasCar(true);
              }}
            />
            <ChoiceCard
              icon="walk"
              label="No car"
              hint="We'll lean on walking and transit"
              selected={hasCar === false}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setHasCar(false);
              }}
            />
          </View>
        ) : null}

        {step === 6 ? (
          <View style={{ gap: t.spacing.lg }}>
            <View style={styles.chips}>
              {DIET_OPTIONS.map((opt) => (
                <SelectChip
                  key={opt}
                  label={opt}
                  selected={dietary.includes(opt)}
                  onPress={() => toggleDiet(opt)}
                />
              ))}
            </View>
            <Input
              placeholder="Allergies or notes (optional)"
              leftIcon="information-circle-outline"
              value={dietaryNotes}
              onChangeText={setDietaryNotes}
              autoCapitalize="sentences"
              returnKeyType="done"
            />
          </View>
        ) : null}

        {step === 7 ? <PeopleManager /> : null}

        {step === 8 ? <RecurringErrandManager /> : null}

        {step === 9 ? (
          <View style={{ gap: t.spacing.md }}>
            <ChoiceCard
              icon="notifications"
              label="Before everything"
              hint="A smart heads-up before every upcoming stop"
              selected={planRemindersMode === 'smart'}
              onPress={() => choosePlanReminders('smart')}
            />
            <ChoiceCard
              icon="lock-closed"
              label="Only fixed plans"
              hint="Just set commitments — meetings, events, reservations"
              selected={planRemindersMode === 'fixed'}
              onPress={() => choosePlanReminders('fixed')}
            />
            <ChoiceCard
              icon="notifications-off"
              label="No reminders"
              hint="Skip per-plan nudges — you can change this anytime"
              selected={planRemindersMode === 'none'}
              onPress={() => choosePlanReminders('none')}
            />
            {planRemindersMode !== 'none' ? (
              <NoteBanner
                icon="sparkles-outline"
                iconColor={t.colors.accent}
                backgroundColor={t.colors.accentSoft}
              >
                Reminders are timed for you — when a stop needs travel, Diem
                nudges you to head out, not just when it starts.
              </NoteBanner>
            ) : null}
          </View>
        ) : null}

        {error ? (
          <View
            style={[styles.banner, { backgroundColor: t.colors.dangerSoft }]}
          >
            <Ionicons name="alert-circle" size={18} color={t.colors.danger} />
            <Text variant="bodySm" tone="danger" style={{ flex: 1 }}>
              {error}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {androidPicker && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={times[androidPicker]}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={onTimeChange(androidPicker)}
        />
      ) : null}

      <View
        style={[
          styles.footer,
          {
            paddingHorizontal: t.spacing.xl,
            paddingBottom: insets.bottom + 8,
            borderTopColor: t.colors.separator,
          },
        ]}
      >
        {editing ? (
          <>
            <Button
              title="Cancel"
              variant="ghost"
              size="lg"
              onPress={cancelEdit}
              disabled={saving}
            />
            <Button
              title="Save"
              size="lg"
              onPress={saveEdit}
              disabled={!canContinue || saving}
              loading={saving}
              style={styles.footerCta}
            />
          </>
        ) : (
          <>
            {step > 0 ? (
              <Button title="Back" variant="ghost" size="lg" onPress={goBack} />
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Button
              title={step === STEP_COUNT - 1 ? 'Finish' : 'Continue'}
              size="lg"
              onPress={goNext}
              disabled={!canContinue || saving}
              loading={saving}
              style={styles.footerCta}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function StepIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={{ gap: 8, marginBottom: 4 }}>
      <Text variant="title1" weight="heavy" tight>
        {title}
      </Text>
      <Text variant="body" tone="secondary">
        {subtitle}
      </Text>
    </View>
  );
}

/** The platform-appropriate inline time control (iOS compact / Android pill). */
function InlineTimePicker({
  value,
  hhmm,
  onChange,
  onAndroidPress,
}: {
  value: Date;
  hhmm: string;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidPress: () => void;
}) {
  const t = useTheme();
  if (Platform.OS === 'ios') {
    return (
      <DateTimePicker
        value={value}
        mode="time"
        display="compact"
        minuteInterval={5}
        onChange={onChange}
        themeVariant={t.isDark ? 'dark' : 'light'}
      />
    );
  }
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onAndroidPress();
      }}
      style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
    >
      <Text variant="body" weight="bold" tone="accent">
        {formatTime(hhmm)}
      </Text>
    </Pressable>
  );
}

function TimeRow({
  icon,
  label,
  hint,
  value,
  hhmm,
  first,
  onChange,
  onAndroidPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value: Date;
  hhmm: string;
  first?: boolean;
  onChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidPress: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.timeRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.colors.separator,
        },
      ]}
    >
      <View style={[styles.timeIcon, { backgroundColor: t.colors.fill1 }]}>
        <Ionicons name={icon} size={18} color={t.colors.textPrimary} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold">
          {label}
        </Text>
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      </View>
      <InlineTimePicker
        value={value}
        hhmm={hhmm}
        onChange={onChange}
        onAndroidPress={onAndroidPress}
      />
    </View>
  );
}

/** A meal row: icon + label on top, then a "start → end" window of pickers. */
function MealRow({
  icon,
  label,
  first,
  start,
  end,
  onStartChange,
  onEndChange,
  onAndroidStart,
  onAndroidEnd,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  first?: boolean;
  start: Date;
  end: Date;
  onStartChange: (e: DateTimePickerEvent, d?: Date) => void;
  onEndChange: (e: DateTimePickerEvent, d?: Date) => void;
  onAndroidStart: () => void;
  onAndroidEnd: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.mealRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.colors.separator,
        },
      ]}
    >
      <View style={styles.mealHeader}>
        <View style={[styles.timeIcon, { backgroundColor: t.colors.fill1 }]}>
          <Ionicons name={icon} size={18} color={t.colors.textPrimary} />
        </View>
        <Text variant="body" weight="semibold">
          {label}
        </Text>
      </View>
      <View style={styles.mealPickers}>
        <InlineTimePicker
          value={start}
          hhmm={toHHMM(start)}
          onChange={onStartChange}
          onAndroidPress={onAndroidStart}
        />
        <Text variant="bodySm" tone="tertiary">
          to
        </Text>
        <InlineTimePicker
          value={end}
          hhmm={toHHMM(end)}
          onChange={onEndChange}
          onAndroidPress={onAndroidEnd}
        />
      </View>
    </View>
  );
}

/** A labelled row with a trailing iOS-style Switch. */
function ToggleRow({
  icon,
  label,
  hint,
  value,
  onValueChange,
  first,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  first?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.timeRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.colors.separator,
        },
      ]}
    >
      <View style={[styles.timeIcon, { backgroundColor: t.colors.fill1 }]}>
        <Ionicons name={icon} size={18} color={t.colors.textPrimary} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold">
          {label}
        </Text>
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
      />
    </View>
  );
}

/** A soft, tinted explainer/warning banner with a leading icon. */
function NoteBanner({
  icon,
  iconColor,
  backgroundColor,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  backgroundColor: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.note, { backgroundColor }]}>
      <Ionicons name={icon} size={18} color={iconColor} />
      <Text variant="bodySm" tone="secondary" style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

function ChoiceCard({
  icon,
  label,
  hint,
  selected,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected ? t.colors.accentSoft : t.colors.surface1,
          borderColor: selected ? t.colors.accent : t.colors.separator,
          borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
          borderRadius: t.radii.lg,
        },
        pressed && { opacity: 0.9 },
      ]}
    >
      <View
        style={[
          styles.choiceIcon,
          {
            backgroundColor: selected ? t.colors.accent : t.colors.fill1,
          },
        ]}
      >
        <Ionicons
          name={icon}
          size={22}
          color={selected ? t.colors.textOnAccent : t.colors.textPrimary}
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold">
          {label}
        </Text>
        <Text variant="caption" tone="secondary">
          {hint}
        </Text>
      </View>
      <Ionicons
        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
        size={24}
        color={selected ? t.colors.accent : t.colors.textTertiary}
      />
    </Pressable>
  );
}

function SelectChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? t.colors.accentSoft : t.colors.surface1,
          borderColor: selected ? t.colors.accent : t.colors.separator,
          borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
          borderRadius: t.radii.pill,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      {selected ? (
        <Ionicons name="checkmark" size={15} color={t.colors.accent} />
      ) : null}
      <Text
        variant="bodySm"
        weight="semibold"
        tone={selected ? 'accent' : 'primary'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    gap: 10,
    paddingTop: 8,
    paddingBottom: 12,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 6,
  },
  editHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  editClose: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressSeg: {
    flex: 1,
    height: 5,
    borderRadius: 999,
  },
  content: {
    paddingTop: 8,
    paddingBottom: 24,
    gap: 16,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  timeIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  mealRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  mealHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  mealPickers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 48,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  choiceIcon: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerCta: {
    flex: 1,
  },
});
