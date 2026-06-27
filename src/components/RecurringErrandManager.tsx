import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { RecurringErrandEditorSheet } from './RecurringErrandEditorSheet';
import {
  useRecurringErrandsStore,
  type RecurringErrand,
} from '@/store/useRecurringErrandsStore';
import { propagateRecurringEdit } from '@/lib/recurring';
import { formatTime } from '@/utils/time';

interface Props {
  /** Open the editor for this template id on mount (deep-link from Settings/home). */
  editId?: string | null;
}

const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human summary of the repeat rule: "Every day", "Weekdays", or "Mon, Wed". */
function weekdaysLabel(days: number[]): string {
  if (days.length === 0) return 'No days set';
  const set = new Set(days);
  if (set.size === 7) return 'Every day';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Weekdays';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends';
  // Monday-first ordering for the list.
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => set.has(d))
    .map((d) => SHORT[d])
    .join(', ');
}

function subtitle(errand: RecurringErrand): string {
  const parts = [weekdaysLabel(errand.weekdays)];
  if (errand.startTime) parts.push(formatTime(errand.startTime));
  if (errand.address) parts.push(errand.address);
  return parts.join(' · ');
}

/**
 * The reusable Recurring-errands list + add button (the editor is a modal
 * sheet, so this owns no scroll view and drops into onboarding or a Settings
 * screen). Reads/writes `useRecurringErrandsStore` directly.
 */
export function RecurringErrandManager({ editId }: Props) {
  const t = useTheme();
  const errands = useRecurringErrandsStore((s) => s.items);
  const add = useRecurringErrandsStore((s) => s.add);
  const update = useRecurringErrandsStore((s) => s.update);
  const remove = useRecurringErrandsStore((s) => s.remove);

  const [editing, setEditing] = useState<RecurringErrand | 'new' | null>(null);

  useEffect(() => {
    if (!editId) return;
    const match = errands.find((e) => e.id === editId);
    if (match) setEditing(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const editingErrand = editing && editing !== 'new' ? editing : null;

  return (
    <View style={styles.wrap}>
      {errands.length === 0 ? (
        <Text variant="bodySm" tone="tertiary">
          Nothing recurring yet. Add something like “Ping pong every Monday at 18:00”.
        </Text>
      ) : (
        <View style={[styles.list, { borderColor: t.colors.separator }]}>
          {errands.map((errand, i) => (
            <Pressable
              key={errand.id}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setEditing(errand);
              }}
              style={({ pressed }) => [
                styles.row,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.separator },
                pressed && { backgroundColor: t.colors.fill1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${errand.title}`}
            >
              <View style={[styles.icon, { backgroundColor: t.colors.accentSoft }]}>
                <Ionicons name="repeat" size={18} color={t.colors.accent} />
              </View>
              <View style={styles.rowText}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {errand.title}
                </Text>
                <Text variant="caption" tone="secondary" numberOfLines={1}>
                  {subtitle(errand)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={t.colors.textTertiary} />
            </Pressable>
          ))}
        </View>
      )}

      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          setEditing('new');
        }}
        style={({ pressed }) => [
          styles.addRow,
          { borderColor: t.colors.separator },
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Add a recurring errand"
      >
        <Ionicons name="add-circle-outline" size={20} color={t.colors.accent} />
        <Text variant="body" weight="semibold" tone="accent">
          Add a recurring errand
        </Text>
      </Pressable>

      <RecurringErrandEditorSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        errand={editingErrand}
        onSubmit={(input) => {
          if (editingErrand) {
            update(editingErrand.id, input);
            // Push the edit onto occurrences already on screen (the idempotent
            // materializer won't), so existing days reflect the new rule.
            propagateRecurringEdit(editingErrand.id);
          } else add(input);
        }}
        onDelete={editingErrand ? () => remove(editingErrand.id) : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  list: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 1 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
  },
});
