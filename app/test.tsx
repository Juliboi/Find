import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { useHomeStore, selectEndOfDay } from '@/store/useHomeStore';
import { HomePicker } from '@/components/HomePicker';
import { PlanCard } from '@/components/PlanCard';
import { TopBar } from '@/components/TopBar';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import {
  rescheduleDay,
  scheduleDay,
  type SchedulerContext,
  type SchedulerDebug,
} from '@/lib/ai/scheduler';
import { Plan } from '@/types/plan';
import { currentHHMM } from '@/utils/time';

interface ResolveOptions {
  startTime?: string;
  location?: string;
}

export default function TestScreen() {
  const router = useRouter();
  const t = useTheme();
  const home = useHomeStore((s) => s.home);
  const endOfDay = useHomeStore((s) => selectEndOfDay(s));

  const [input, setInput] = useState('gym');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [usedAi, setUsedAi] = useState(false);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<SchedulerDebug | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const context: SchedulerContext = { home, endOfDay };

  const planIt = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await scheduleDay([text], {
        startTime: currentHHMM(),
        context,
        debug: true,
      });
      const first = result.plans[0] ?? null;
      setPlan(first);
      setUsedAi(result.usedAi);
      setDebug(result.debug ?? null);
      if (!first) setErrorMsg('AI returned no plan. Check the debug section.');
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (
    planId: string,
    answer: string,
    opts?: ResolveOptions,
  ) => {
    if (!plan || plan.id !== planId || loading) return;
    const question = plan.clarificationQuestion;
    const isLocationAnswer = /where|which|location|nearby|spot|place|gym|store|cafe|restaurant|shop|office|school/i.test(
      question ?? '',
    );
    const updated: Plan = {
      ...plan,
      location: opts?.location ?? (isLocationAnswer ? answer : plan.location),
      description:
        opts?.location || isLocationAnswer
          ? plan.description
          : answer || plan.description,
      startTime: opts?.startTime ?? plan.startTime,
      status: 'scheduled',
      clarificationQuestion: undefined,
      clarificationSuggestions: undefined,
      resolvedClarification: question
        ? { question, answer }
        : plan.resolvedClarification,
    };
    setPlan(updated);
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await rescheduleDay([updated], {
        startTime: updated.startTime,
        context,
        debug: true,
      });
      const next = result.plans[0] ?? null;
      setPlan(next);
      setUsedAi(result.usedAi);
      setDebug(result.debug ?? null);
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setPlan(null);
    setDebug(null);
    setErrorMsg(null);
    setUsedAi(false);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar
          kicker="Developer"
          title="Sandbox"
          left={{
            icon: 'chevron-back',
            onPress: () => router.back(),
            accessibilityLabel: 'Back',
          }}
          actions={[
            {
              icon: 'refresh',
              onPress: reset,
              accessibilityLabel: 'Reset',
            },
          ]}
        />

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.sm,
              paddingBottom: t.spacing.xxl,
            },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <HomePicker title="Home" />

          <Card padded>
            <Text variant="title3" weight="bold" tight>
              Single plan
            </Text>
            <Text
              variant="caption"
              tone="secondary"
              style={{ marginTop: 4, marginBottom: 12 }}
            >
              Type one activity, then tap "Plan it" to send it to the AI in
              isolation. The full clarification flow runs locally on this
              screen — nothing touches your day.
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: t.colors.fill1,
                  color: t.colors.textPrimary,
                  borderRadius: t.radii.md,
                },
              ]}
              placeholder="e.g. gym, grocery, lunch, deep work"
              placeholderTextColor={t.colors.textTertiary}
              value={input}
              onChangeText={setInput}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={planIt}
              returnKeyType="go"
            />
            <Button
              title={loading ? 'Planning…' : 'Plan it'}
              onPress={planIt}
              loading={loading}
              disabled={loading || input.trim().length === 0}
              fullWidth
              style={{ marginTop: 12 }}
            />
          </Card>

          {errorMsg ? (
            <Card
              padded
              style={{
                backgroundColor: t.colors.dangerSoft,
                borderColor: t.colors.danger,
                borderWidth: 1,
              }}
            >
              <View style={styles.errorRow}>
                <Ionicons
                  name="alert-circle"
                  size={18}
                  color={t.colors.danger}
                />
                <Text variant="bodySm" tone="danger" style={{ flex: 1 }}>
                  {errorMsg}
                </Text>
              </View>
            </Card>
          ) : null}

          {plan ? (
            <View style={{ gap: 10 }}>
              <View style={styles.resultHeader}>
                <Text variant="title3" weight="bold" tight>
                  Result
                </Text>
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor: usedAi
                        ? t.colors.accentSoft
                        : t.colors.fill1,
                    },
                  ]}
                >
                  <Text
                    variant="micro"
                    weight="bold"
                    uppercase
                    tone={usedAi ? 'accent' : 'secondary'}
                  >
                    {usedAi ? 'AI' : 'Offline'}
                  </Text>
                </View>
              </View>
              <PlanCard plan={plan} onResolveClarification={handleResolve} />
            </View>
          ) : null}

          {debug ? (
            <Card padded>
              <Pressable onPress={() => setShowDebug((v) => !v)} hitSlop={6}>
                <View style={styles.debugHeader}>
                  <Text variant="title3" weight="bold" tight>
                    Debug
                  </Text>
                  <Ionicons
                    name={showDebug ? 'chevron-down' : 'chevron-forward'}
                    size={18}
                    color={t.colors.textSecondary}
                  />
                </View>
              </Pressable>
              {showDebug ? (
                <View style={{ gap: 12, marginTop: 12 }}>
                  <View style={{ gap: 6 }}>
                    <Text
                      variant="micro"
                      tone="secondary"
                      uppercase
                      weight="bold"
                    >
                      Request
                    </Text>
                    <View
                      style={[
                        styles.debugBox,
                        {
                          backgroundColor: t.colors.fill1,
                          borderRadius: t.radii.sm,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.debugText,
                          { color: t.colors.textPrimary, fontFamily: t.fonts.mono },
                        ]}
                        selectable
                      >
                        {JSON.stringify(debug.request, null, 2)}
                      </Text>
                    </View>
                  </View>
                  <View style={{ gap: 6 }}>
                    <Text
                      variant="micro"
                      tone="secondary"
                      uppercase
                      weight="bold"
                    >
                      Response
                    </Text>
                    <View
                      style={[
                        styles.debugBox,
                        {
                          backgroundColor: t.colors.fill1,
                          borderRadius: t.radii.sm,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.debugText,
                          { color: t.colors.textPrimary, fontFamily: t.fonts.mono },
                        ]}
                        selectable
                      >
                        {JSON.stringify(debug.response, null, 2)}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : null}
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    gap: 16,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
    minHeight: 48,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  debugBox: {
    padding: 10,
  },
  debugText: {
    fontSize: 11,
    lineHeight: 16,
  },
});
