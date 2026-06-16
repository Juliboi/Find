import React, { useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
  useColorScheme,
} from 'react-native';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Sheet } from '@/components/Sheet';
import { HomePicker, type AnchorSlot } from '@/components/HomePicker';
import { useAuthStore } from '@/store/useAuthStore';
import { useProfileStore } from '@/store/useProfileStore';
import { useHomeStore } from '@/store/useHomeStore';
import { usePeopleStore } from '@/store/usePeopleStore';
import { useRecurringErrandsStore } from '@/store/useRecurringErrandsStore';
import { useNotificationStore } from '@/store/useNotificationStore';
import { type PlanRemindersMode } from '@/lib/notifications';
import { formatTime } from '@/utils/time';
import { useDevClockStore } from '@/store/useDevClockStore';
import { seedTestPlan } from '@/lib/dev/seedTestPlan';

/** Seed a time picker from a stored "HH:MM" (falls back to 9 PM if unparseable). */
function hhmmToDate(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(Number.isFinite(h) ? h : 21, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

interface RowProps {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Position in the group — controls divider visibility. */
  first?: boolean;
  last?: boolean;
}

function Row({
  icon,
  iconColor,
  iconBg,
  title,
  subtitle,
  trailing,
  onPress,
  first,
}: RowProps) {
  const t = useTheme();
  const content = (
    <View style={styles.row}>
      <View
        style={[
          styles.rowIcon,
          {
            backgroundColor: iconBg ?? t.colors.fill1,
          },
        ]}
      >
        <Ionicons
          name={icon}
          size={16}
          color={iconColor ?? t.colors.textPrimary}
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View>{trailing}</View> : null}
      {onPress ? (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={t.colors.textTertiary}
        />
      ) : null}
    </View>
  );

  const wrapStyle = [
    styles.rowWrap,
    !first && {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.separator,
    },
  ];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [wrapStyle, pressed && { opacity: 0.8 }]}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={wrapStyle}>{content}</View>;
}

/**
 * A single-select option row (radio-style) used for the plan-reminders mode.
 * Mirrors `Row`'s layout but trails a check instead of a chevron, since these
 * pick between mutually-exclusive choices rather than drilling in.
 */
function PlanReminderOption({
  icon,
  title,
  subtitle,
  selected,
  onPress,
  first,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
  first?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.rowWrap,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.colors.separator,
        },
        pressed && { opacity: 0.8 },
      ]}
    >
      <View style={styles.row}>
        <View
          style={[
            styles.rowIcon,
            { backgroundColor: selected ? t.colors.accentSoft : t.colors.fill1 },
          ]}
        >
          <Ionicons
            name={icon}
            size={16}
            color={selected ? t.colors.accentText : t.colors.textPrimary}
          />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight="semibold">
            {title}
          </Text>
          <Text variant="caption" tone="secondary">
            {subtitle}
          </Text>
        </View>
        <Ionicons
          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={22}
          color={selected ? t.colors.accent : t.colors.textTertiary}
        />
      </View>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const t = useTheme();
  const systemScheme = useColorScheme();
  const insets = useSafeAreaInsets();

  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const fullName = useProfileStore((s) => s.fullName);
  const wakeTime = useProfileStore((s) => s.wakeTime);
  const bedTime = useProfileStore((s) => s.bedTime);
  const wakeUpDurationMin = useProfileStore((s) => s.wakeUpDurationMin);
  const breakfastStart = useProfileStore((s) => s.breakfastStart);
  const lunchStart = useProfileStore((s) => s.lunchStart);
  const dinnerStart = useProfileStore((s) => s.dinnerStart);
  const windDownTime = useProfileStore((s) => s.windDownTime);
  const hasCar = useProfileStore((s) => s.hasCar);
  const dietary = useProfileStore((s) => s.dietary);
  const dietaryNotes = useProfileStore((s) => s.dietaryNotes);
  const home = useHomeStore((s) => s.home);
  const work = useHomeStore((s) => s.work);
  const peopleCount = usePeopleStore((s) => s.items.length);
  const recurringCount = useRecurringErrandsStore((s) => s.items.length);

  const dailyReviewEnabled = useNotificationStore((s) => s.dailyReviewEnabled);
  const dailyReviewTime = useNotificationStore((s) => s.dailyReviewTime);
  const setDailyReviewEnabled = useNotificationStore(
    (s) => s.setDailyReviewEnabled,
  );
  const setDailyReviewTime = useNotificationStore((s) => s.setDailyReviewTime);
  const planRemindersMode = useNotificationStore((s) => s.planRemindersMode);
  const setPlanRemindersMode = useNotificationStore(
    (s) => s.setPlanRemindersMode,
  );

  // Which anchor the location-picker sheet is editing (null = closed).
  const [anchorSlot, setAnchorSlot] = useState<AnchorSlot | null>(null);
  // Android shows the time picker as a one-shot dialog; iOS renders it inline.
  const [androidTimeOpen, setAndroidTimeOpen] = useState(false);
  const reviewDate = useMemo(() => hhmmToDate(dailyReviewTime), [dailyReviewTime]);

  const onToggleDailyReview = (next: boolean) => {
    Haptics.selectionAsync().catch(() => undefined);
    void setDailyReviewEnabled(next).then((ok) => {
      if (next && ok) {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => undefined);
      } else if (next && !ok) {
        // Permission was refused (or previously denied) — the toggle stays off;
        // point the user at system settings where they can grant it.
        Alert.alert(
          'Turn on notifications',
          'Diem needs notification permission to send your evening planning reminder. You can enable it in Settings.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => void Linking.openSettings(),
            },
          ],
        );
      }
    });
  };

  const onReviewTimeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidTimeOpen(false);
    if (picked) {
      Haptics.selectionAsync().catch(() => undefined);
      void setDailyReviewTime(dateToHHMM(picked));
    }
  };

  const onChoosePlanReminders = (mode: PlanRemindersMode) => {
    if (mode === planRemindersMode) return;
    Haptics.selectionAsync().catch(() => undefined);
    void setPlanRemindersMode(mode).then((ok) => {
      if (mode !== 'none' && ok) {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => undefined);
      } else if (mode !== 'none' && !ok) {
        // The choice still sticks; it just can't fire until permission is
        // granted, so point the user at system settings.
        Alert.alert(
          'Turn on notifications',
          'Diem needs notification permission to remind you before your plans. You can enable it in Settings.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Open Settings',
              onPress: () => void Linking.openSettings(),
            },
          ],
        );
      }
    });
  };

  // DEV-only fake clock ("time machine"). Lets us rehearse a plan as if it were
  // an arbitrary instant — e.g. 9 AM on a weekday — so shops read as open and
  // the planner starts in the morning instead of late at night.
  const devClockEnabled = useDevClockStore((s) => s.enabled);
  const devAnchorRealMs = useDevClockStore((s) => s.anchorRealMs);
  const devAnchorFakeMs = useDevClockStore((s) => s.anchorFakeMs);
  const setDevFakeNow = useDevClockStore((s) => s.setFakeNow);
  const setDevClockEnabled = useDevClockStore((s) => s.setEnabled);
  const resetDevClock = useDevClockStore((s) => s.reset);
  // Android picks date + time in two sequential dialogs; iOS shows one inline.
  const [androidDevStage, setAndroidDevStage] = useState<'idle' | 'date' | 'time'>(
    'idle',
  );
  const [androidDevDraft, setAndroidDevDraft] = useState<Date | null>(null);

  // The instant the picker seeds from and the label shows: the live simulated
  // "now" when the clock is on, else real now.
  const devClockValue = useMemo(() => {
    if (devClockEnabled && devAnchorRealMs != null && devAnchorFakeMs != null) {
      return new Date(devAnchorFakeMs + (Date.now() - devAnchorRealMs));
    }
    return new Date();
  }, [devClockEnabled, devAnchorRealMs, devAnchorFakeMs]);

  const onToggleDevClock = (next: boolean) => {
    Haptics.selectionAsync().catch(() => undefined);
    if (next) {
      // First time on with nothing pinned: default to 9 AM today so a tap is
      // immediately useful ("plan my morning"). Re-enabling keeps the last pin.
      if (devAnchorFakeMs == null) {
        const seed = new Date();
        seed.setHours(9, 0, 0, 0);
        setDevFakeNow(seed);
      } else {
        setDevClockEnabled(true);
      }
    } else {
      setDevClockEnabled(false);
    }
  };

  const onDevTimeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (picked) {
      Haptics.selectionAsync().catch(() => undefined);
      setDevFakeNow(picked);
    }
  };

  // Android two-step: pick the date, then the time, then pin the combined value.
  const onAndroidDevChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (!picked) {
      setAndroidDevStage('idle');
      setAndroidDevDraft(null);
      return;
    }
    if (androidDevStage === 'date') {
      setAndroidDevDraft(picked);
      setAndroidDevStage('time');
      return;
    }
    if (androidDevStage === 'time') {
      const base = androidDevDraft ?? new Date();
      const combined = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        picked.getHours(),
        picked.getMinutes(),
        0,
        0,
      );
      Haptics.selectionAsync().catch(() => undefined);
      setDevFakeNow(combined);
      setAndroidDevStage('idle');
      setAndroidDevDraft(null);
    }
  };

  const devClockLabel = devClockValue.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const dietarySummary = dietary.length
    ? dietary.join(', ')
    : dietaryNotes
      ? dietaryNotes
      : 'No restrictions';

  const mealSummary =
    breakfastStart && lunchStart && dinnerStart
      ? `${formatTime(breakfastStart)} · ${formatTime(lunchStart)} · ${formatTime(dinnerStart)}`
      : 'Set your meal windows';

  const accountName =
    fullName ??
    (typeof user?.user_metadata?.full_name === 'string'
      ? (user.user_metadata.full_name as string)
      : null);
  const accountEmail = user?.email ?? null;
  const accountInitial = (accountName ?? accountEmail ?? '?')
    .trim()
    .charAt(0)
    .toUpperCase();

  // Jump straight to the matching onboarding step to edit a single preference;
  // onboarding runs in "edit" mode and returns here on Save/Cancel.
  const editPref = (
    key: 'morning' | 'meals' | 'winddown' | 'car' | 'diet',
  ) => {
    Haptics.selectionAsync().catch(() => undefined);
    router.push({ pathname: '/onboarding', params: { edit: key } });
  };

  // DEV-only: replay the entire onboarding wizard (all steps, not the single-
  // preference edit mode) to test the first-run flow without signing out. We
  // only flip the in-memory `needsOnboarding` gate, which makes the auth gate
  // route to /onboarding; the saved profile is left untouched, so finishing the
  // wizard (or just relaunching the app) returns everything to normal.
  const replayOnboarding = () => {
    Haptics.selectionAsync().catch(() => undefined);
    useAuthStore.setState({ needsOnboarding: true });
    router.replace('/onboarding');
  };

  const confirmSignOut = () => {
    Haptics.selectionAsync().catch(() => undefined);
    Alert.alert('Sign out?', 'You can sign back in anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void signOut();
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          ).catch(() => undefined);
        },
      },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <TopBar
        kicker="Profile"
        title="Settings"
        left={{
          icon: 'chevron-back',
          onPress: () => router.back(),
          accessibilityLabel: 'Back',
        }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.sm,
            paddingBottom: 40,
          },
        ]}
      >
        {user ? (
          <Card padded style={{ padding: 0 }}>
            <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
              <Text
                variant="caption"
                tone="secondary"
                uppercase
                weight="semibold"
              >
                Account
              </Text>
            </View>
            <View style={[styles.accountRow, { paddingHorizontal: 16 }]}>
              <View
                style={[styles.avatar, { backgroundColor: t.colors.accentSoft }]}
              >
                <Text variant="title3" weight="bold" tone="accent">
                  {accountInitial}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {accountName ?? 'Signed in'}
                </Text>
                {accountEmail ? (
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {accountEmail}
                  </Text>
                ) : null}
              </View>
            </View>
            <Row
              icon="log-out-outline"
              iconBg={t.colors.dangerSoft}
              iconColor={t.colors.danger}
              title="Sign out"
              onPress={confirmSignOut}
            />
          </Card>
        ) : null}

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Daily preferences
            </Text>
          </View>
          <Row
            first
            icon="sunny-outline"
            iconBg={t.colors.warningSoft}
            iconColor={t.colors.warning}
            title="Morning routine"
            subtitle={`${wakeUpDurationMin} min to get going`}
            onPress={() => editPref('morning')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {wakeTime ? formatTime(wakeTime) : 'Not set'}
              </Text>
            }
          />
          <Row
            icon="fast-food-outline"
            iconBg={t.colors.infoSoft}
            iconColor={t.colors.info}
            title="Meal times"
            subtitle={mealSummary}
            onPress={() => editPref('meals')}
          />
          <Row
            icon="cloudy-night-outline"
            iconBg={t.colors.fill1}
            title="Wind down"
            subtitle="Calm-only activities after this"
            onPress={() => editPref('winddown')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {windDownTime ? formatTime(windDownTime) : 'Not set'}
              </Text>
            }
          />
          <Row
            icon="moon-outline"
            iconBg={t.colors.fill1}
            title="Bed time"
            subtitle="Lights out — the end of your day"
            onPress={() => editPref('winddown')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {bedTime ? formatTime(bedTime) : 'Not set'}
              </Text>
            }
          />
          <Row
            icon={hasCar ? 'car-sport' : 'walk'}
            iconBg={t.colors.infoSoft}
            iconColor={t.colors.info}
            title="Transport"
            subtitle={
              hasCar
                ? 'Driven only when it helps — toggle per day'
                : 'Walking and transit between stops'
            }
            onPress={() => editPref('car')}
            trailing={
              <Text variant="body" weight="semibold" tone="secondary">
                {hasCar ? 'Has a car' : 'No car'}
              </Text>
            }
          />
          <Row
            icon="restaurant-outline"
            iconBg={t.colors.successSoft}
            iconColor={t.colors.success}
            title="Dietary"
            subtitle="Filters food and drink stops"
            onPress={() => editPref('diet')}
            trailing={
              <Text
                variant="body"
                weight="semibold"
                tone="secondary"
                numberOfLines={1}
                style={styles.dietaryValue}
              >
                {dietarySummary}
              </Text>
            }
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Notifications
            </Text>
          </View>
          <Row
            first
            icon="moon-outline"
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Plan tomorrow"
            subtitle="An evening nudge to review today and set up tomorrow"
            trailing={
              <Switch
                value={dailyReviewEnabled}
                onValueChange={onToggleDailyReview}
                trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
              />
            }
          />
          {dailyReviewEnabled ? (
            <Row
              icon="time-outline"
              iconBg={t.colors.fill1}
              title="Remind me at"
              subtitle="When the nudge arrives each day"
              trailing={
                Platform.OS === 'ios' ? (
                  <DateTimePicker
                    value={reviewDate}
                    mode="time"
                    display="compact"
                    minuteInterval={5}
                    onChange={onReviewTimeChange}
                    themeVariant={t.isDark ? 'dark' : 'light'}
                  />
                ) : (
                  <Pressable
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => undefined);
                      setAndroidTimeOpen(true);
                    }}
                    style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
                  >
                    <Text variant="body" weight="bold" tone="accent">
                      {formatTime(dailyReviewTime)}
                    </Text>
                  </Pressable>
                )
              }
            />
          ) : null}
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Plan reminders
            </Text>
          </View>
          <PlanReminderOption
            first
            icon="notifications"
            title="Before everything"
            subtitle="A smart heads-up before every upcoming stop"
            selected={planRemindersMode === 'smart'}
            onPress={() => onChoosePlanReminders('smart')}
          />
          <PlanReminderOption
            icon="lock-closed"
            title="Only fixed plans"
            subtitle="Just commitments — meetings, events, reservations"
            selected={planRemindersMode === 'fixed'}
            onPress={() => onChoosePlanReminders('fixed')}
          />
          <PlanReminderOption
            icon="notifications-off"
            title="No reminders"
            subtitle="Don't send per-plan nudges"
            selected={planRemindersMode === 'none'}
            onPress={() => onChoosePlanReminders('none')}
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Appearance
            </Text>
          </View>
          <Row
            first
            icon={t.isDark ? 'moon' : 'sunny'}
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Theme"
            subtitle={`Following system (${systemScheme ?? 'unknown'})`}
            trailing={
              <View
                style={[
                  styles.pill,
                  {
                    backgroundColor: t.colors.fill1,
                  },
                ]}
              >
                <Text variant="micro" weight="bold" tone="secondary" uppercase>
                  Auto
                </Text>
              </View>
            }
          />
          <Row
            icon="color-palette-outline"
            iconBg={t.colors.fill1}
            title="Accent color"
            subtitle="System blue · matches iOS look"
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              Places
            </Text>
          </View>
          <Row
            first
            icon="home-outline"
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="Home"
            subtitle={home ? home.label : 'Set your home base'}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setAnchorSlot('home');
            }}
          />
          <Row
            icon="briefcase-outline"
            iconBg={t.colors.fill1}
            title="Work"
            subtitle={work ? work.label : 'Optional — for office plans'}
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setAnchorSlot('work');
            }}
          />
        </Card>

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              People & routines
            </Text>
          </View>
          <Row
            first
            icon="people-outline"
            iconBg={t.colors.accentSoft}
            iconColor={t.colors.accentText}
            title="People"
            subtitle={
              peopleCount > 0
                ? `${peopleCount} saved · used for “at their place”`
                : 'Save contacts and their fixed place'
            }
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              router.push('/people');
            }}
          />
          <Row
            icon="repeat"
            iconBg={t.colors.fill1}
            title="Recurring errands"
            subtitle={
              recurringCount > 0
                ? `${recurringCount} repeating`
                : 'Things that repeat on a weekday'
            }
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              router.push('/recurring-errands');
            }}
          />
        </Card>

        {__DEV__ ? (
          <Card padded style={{ padding: 0 }}>
            <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
              <Text
                variant="caption"
                tone="secondary"
                uppercase
                weight="semibold"
              >
                Developer
              </Text>
            </View>
            <Row
              first
              icon="time-outline"
              iconBg={t.colors.infoSoft}
              iconColor={t.colors.info}
              title="Fake clock"
              subtitle={
                devClockEnabled
                  ? `Simulating ${devClockLabel}`
                  : 'Test plans at any time of day'
              }
              trailing={
                <Switch
                  value={devClockEnabled}
                  onValueChange={onToggleDevClock}
                  trackColor={{ true: t.colors.accent, false: t.colors.fill2 }}
                />
              }
            />
            {devClockEnabled ? (
              <Row
                icon="calendar-outline"
                iconBg={t.colors.fill1}
                title="Set date & time"
                subtitle="Plan as if it were this moment"
                trailing={
                  Platform.OS === 'ios' ? (
                    <DateTimePicker
                      value={devClockValue}
                      mode="datetime"
                      display="compact"
                      onChange={onDevTimeChange}
                      themeVariant={t.isDark ? 'dark' : 'light'}
                    />
                  ) : (
                    <Pressable
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => undefined);
                        setAndroidDevDraft(devClockValue);
                        setAndroidDevStage('date');
                      }}
                      style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
                    >
                      <Text variant="body" weight="bold" tone="accent">
                        {devClockLabel}
                      </Text>
                    </Pressable>
                  )
                }
              />
            ) : null}
            {devClockEnabled ? (
              <Row
                icon="refresh-outline"
                iconBg={t.colors.dangerSoft}
                iconColor={t.colors.danger}
                title="Reset to real time"
                subtitle="Back to the actual clock"
                onPress={() => {
                  Haptics.selectionAsync().catch(() => undefined);
                  resetDevClock();
                }}
              />
            ) : null}
            <Row
              icon="play-circle-outline"
              iconBg={t.colors.accentSoft}
              iconColor={t.colors.accentText}
              title="Replay onboarding"
              subtitle="Walk the full first-run setup again"
              onPress={replayOnboarding}
            />
            <Row
              icon="flask-outline"
              iconBg={t.colors.accentSoft}
              iconColor={t.colors.accentText}
              title="Generate test plan"
              subtitle="Reseed tomorrow's fixed errands + auto-plan"
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                const { intent } = seedTestPlan();
                router.push({
                  pathname: '/itinerary',
                  params: { autoplan: '1', seedIntent: intent },
                });
              }}
            />
            <Row
              icon="search-outline"
              iconBg={t.colors.infoSoft}
              iconColor={t.colors.info}
              title="Discovery sandbox"
              subtitle="Test place search, blurbs & latency"
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                router.push('/discover-sandbox');
              }}
            />
          </Card>
        ) : null}

        <Card padded style={{ padding: 0 }}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              About
            </Text>
          </View>
          <Row
            first
            icon="information-circle-outline"
            title="Diem"
            subtitle="v0.1.0 · A dynamic day planner"
          />
        </Card>
      </ScrollView>

      {androidTimeOpen && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={reviewDate}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={onReviewTimeChange}
        />
      ) : null}

      {__DEV__ && Platform.OS !== 'ios' && androidDevStage === 'date' ? (
        <DateTimePicker
          value={androidDevDraft ?? devClockValue}
          mode="date"
          display="default"
          onChange={onAndroidDevChange}
        />
      ) : null}
      {__DEV__ && Platform.OS !== 'ios' && androidDevStage === 'time' ? (
        <DateTimePicker
          value={androidDevDraft ?? devClockValue}
          mode="time"
          display="default"
          onChange={onAndroidDevChange}
        />
      ) : null}

      <Sheet
        open={anchorSlot !== null}
        onClose={() => setAnchorSlot(null)}
        heightFraction={0.99}
        enableContentPanningGesture={false}
      >
        <BottomSheetScrollView
          contentContainerStyle={{
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.sm,
            paddingBottom: insets.bottom + 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {anchorSlot ? <HomePicker slot={anchorSlot} flat /> : null}
        </BottomSheetScrollView>
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    gap: 16,
  },
  rowWrap: {
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  timePill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  dietaryValue: {
    maxWidth: 170,
    textAlign: 'right',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingBottom: 14,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
