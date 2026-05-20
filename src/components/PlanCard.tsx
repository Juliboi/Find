import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Plan } from '@/types/plan';
import { useTheme } from '@/theme/useTheme';
import { formatDuration, formatTime } from '@/utils/time';
import { Chip } from './Chip';

interface Props {
  plan: Plan;
  onResolveClarification?: (planId: string, answer: string) => void;
  onRemove?: (planId: string) => void;
}

export function PlanCard({ plan, onResolveClarification, onRemove }: Props) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [customAnswer, setCustomAnswer] = useState('');

  const needsClarification = plan.status === 'needs_clarification';

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: needsClarification ? colors.accent : colors.border,
        },
      ]}
    >
      <Pressable onPress={() => setExpanded((v) => !v)}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {plan.startTime ? (
              <Text style={[styles.time, { color: colors.accent }]}>
                {formatTime(plan.startTime)}
              </Text>
            ) : null}
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
              {plan.title}
            </Text>
            <View style={styles.metaRow}>
              <Text style={[styles.meta, { color: colors.textMuted }]}>
                {formatDuration(plan.durationMinutes)}
              </Text>
              {plan.location ? (
                <Text style={[styles.meta, { color: colors.textMuted }]}>
                  · {plan.location}
                </Text>
              ) : null}
            </View>
          </View>
          {onRemove ? (
            <Pressable
              hitSlop={12}
              onPress={() => onRemove(plan.id)}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.remove, { color: colors.textMuted }]}>×</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>

      {needsClarification && plan.clarificationQuestion ? (
        <View
          style={[
            styles.clarification,
            { backgroundColor: colors.accentSoft },
          ]}
        >
          <Text style={[styles.clarificationText, { color: colors.accent }]}>
            {plan.clarificationQuestion}
          </Text>
          <View style={styles.suggestionsRow}>
            {(plan.clarificationSuggestions ?? []).map((s) => (
              <Chip
                key={s}
                label={s}
                onPress={() => onResolveClarification?.(plan.id, s)}
              />
            ))}
            <Chip
              label="Skip"
              onPress={() => onResolveClarification?.(plan.id, customAnswer || 'Not specified')}
            />
          </View>
        </View>
      ) : null}

      {expanded && plan.subtasks.length > 0 ? (
        <View style={styles.subtasks}>
          {plan.subtasks.map((s) => (
            <View key={s.id} style={styles.subtaskRow}>
              <Text style={[styles.subtaskTitle, { color: colors.text }]}>
                · {s.title}
              </Text>
              <Text style={[styles.subtaskMeta, { color: colors.textMuted }]}>
                {formatDuration(s.durationMinutes)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flex: 1,
    gap: 2,
    paddingRight: 12,
  },
  time: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  meta: {
    fontSize: 13,
  },
  remove: {
    fontSize: 26,
    lineHeight: 26,
    fontWeight: '300',
  },
  clarification: {
    padding: 12,
    borderRadius: 10,
    gap: 10,
  },
  clarificationText: {
    fontSize: 14,
    fontWeight: '500',
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  subtasks: {
    gap: 6,
    paddingTop: 4,
  },
  subtaskRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  subtaskTitle: {
    fontSize: 14,
  },
  subtaskMeta: {
    fontSize: 13,
  },
});
