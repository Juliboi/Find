import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { HomePicker } from '@/components/HomePicker';
import { useHomeStore } from '@/store/useHomeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useProfileStore } from '@/store/useProfileStore';
import { formatTime } from '@/utils/time';

const STEP_COUNT = 3;

function makeTime(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

export default function OnboardingScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const home = useHomeStore((s) => s.home);
  const saveOnboarding = useAuthStore((s) => s.saveOnboarding);
  const storedWake = useProfileStore((s) => s.wakeTime);
  const storedBed = useProfileStore((s) => s.bedTime);

  const [step, setStep] = useState(0);
  const [wake, setWake] = useState<Date>(() => makeTime(7, 0));
  const [bed, setBed] = useState<Date>(() => makeTime(23, 0));
  const [hasCar, setHasCar] = useState<boolean | null>(null);
  const [androidPicker, setAndroidPicker] = useState<'wake' | 'bed' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue =
    step === 0 ? home != null : step === 2 ? hasCar != null : true;

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

  const finish = async () => {
    setError(null);
    setSaving(true);
    try {
      await saveOnboarding({
        fullName: null,
        homeLabel: home?.label ?? null,
        homeLatitude: home?.latitude ?? null,
        homeLongitude: home?.longitude ?? null,
        wakeTime: toHHMM(wake),
        bedTime: toHHMM(bed),
        hasCar: hasCar ?? false,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      // The auth gate sees needsOnboarding flip to false and routes to home.
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save your profile. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const onWakeChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(null);
    if (picked) setWake(picked);
  };
  const onBedChange = (_: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setAndroidPicker(null);
    if (picked) setBed(picked);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top', 'bottom']}
    >
      <View style={[styles.header, { paddingHorizontal: t.spacing.xl }]}>
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
            title="Where's home?"
            subtitle="Diem plans your day around it — travel times, your first stop, and the trip back home."
          />
        ) : null}
        {step === 1 ? (
          <StepIntro
            title="Your daily rhythm"
            subtitle="When do you usually wake up and wind down? We'll keep your plans inside these hours."
          />
        ) : null}
        {step === 2 ? (
          <StepIntro
            title="Do you have a car?"
            subtitle="This helps Diem choose between walking, transit, and driving routes between stops."
          />
        ) : null}

        {step === 0 ? <HomePicker slot="home" /> : null}

        {step === 1 ? (
          <Card padded style={{ padding: 0 }}>
            <TimeRow
              icon="sunny-outline"
              label="Wake up"
              hint="When your day starts"
              value={wake}
              hhmm={toHHMM(wake)}
              first
              onChange={onWakeChange}
              onAndroidPress={() => setAndroidPicker('wake')}
            />
            <TimeRow
              icon="moon-outline"
              label="Bed time"
              hint="When you want to be done"
              value={bed}
              hhmm={toHHMM(bed)}
              onChange={onBedChange}
              onAndroidPress={() => setAndroidPicker('bed')}
            />
          </Card>
        ) : null}

        {step === 2 ? (
          <View style={{ gap: t.spacing.md }}>
            <ChoiceCard
              icon="car-sport"
              label="Yes, I drive"
              hint="We'll prefer driving for longer hops"
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
          value={androidPicker === 'wake' ? wake : bed}
          mode="time"
          display="default"
          minuteInterval={5}
          onChange={androidPicker === 'wake' ? onWakeChange : onBedChange}
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
          onPress={onAndroidPress}
          style={[styles.timePill, { backgroundColor: t.colors.fill1 }]}
        >
          <Text variant="body" weight="bold" tone="accent">
            {formatTime(hhmm)}
          </Text>
        </Pressable>
      )}
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
    borderRadius: 12,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
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
