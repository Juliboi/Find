import React, { useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';

const EXAMPLE_PROMPTS = [
  'Go to the gym',
  'Cook dinner',
  'Grocery shopping',
  'Deep work block',
  'Call mom',
  'Go for a walk',
];

export default function AddPlanScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  const draft = useDayStore((s) => s.draft);
  const addDraft = useDayStore((s) => s.addDraft);
  const updateDraft = useDayStore((s) => s.updateDraft);
  const removeDraft = useDayStore((s) => s.removeDraft);
  const clearDraft = useDayStore((s) => s.clearDraft);
  const confirmDraft = useDayStore((s) => s.confirmDraft);
  const isScheduling = useDayStore((s) => s.isScheduling);

  const [current, setCurrent] = useState('');
  const inputRef = useRef<TextInput>(null);

  const onAdd = () => {
    const text = current.trim();
    if (!text) return;
    addDraft(text);
    setCurrent('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onConfirm = async () => {
    const hasPending = current.trim().length > 0;
    if (hasPending) addDraft(current.trim());
    setCurrent('');
    await confirmDraft();
    router.back();
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Pressable
            hitSlop={12}
            onPress={() => router.back()}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.headerAction, { color: colors.textMuted }]}>
              Cancel
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Add today's plans
          </Text>
          {draft.length > 0 ? (
            <Pressable
              hitSlop={12}
              onPress={clearDraft}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.headerAction, { color: colors.textMuted }]}>
                Clear
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: 50 }} />
          )}
        </View>

        <FlatList
          data={draft}
          keyExtractor={(item, idx) => `${idx}-${item}`}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListHeaderComponent={
            <View style={{ marginBottom: 16 }}>
              <Text style={[styles.lead, { color: colors.textMuted }]}>
                Type whatever you want to do today, one plan at a time. You can
                be vague — DayFlow will ask follow-ups if it needs to.
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <View
              style={[
                styles.row,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text style={[styles.rowIndex, { color: colors.textMuted }]}>
                {index + 1}
              </Text>
              <TextInput
                value={item}
                onChangeText={(t) => updateDraft(index, t)}
                style={[styles.rowInput, { color: colors.text }]}
                placeholderTextColor={colors.textMuted}
              />
              <Pressable
                hitSlop={10}
                onPress={() => removeDraft(index)}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
              >
                <Text style={[styles.rowRemove, { color: colors.textMuted }]}>
                  ×
                </Text>
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.suggestionsBlock}>
              <Text style={[styles.suggestionsTitle, { color: colors.textMuted }]}>
                Need ideas?
              </Text>
              <View style={styles.suggestionsRow}>
                {EXAMPLE_PROMPTS.map((p) => (
                  <Chip key={p} label={p} onPress={() => addDraft(p)} />
                ))}
              </View>
            </View>
          }
        />

        <View style={[styles.composer, { borderTopColor: colors.border }]}>
          <Input
            ref={inputRef}
            value={current}
            onChangeText={setCurrent}
            placeholder="Add a plan…"
            returnKeyType="done"
            onSubmitEditing={onAdd}
            containerStyle={{ flex: 1 }}
          />
          <Button
            title="Add"
            variant="secondary"
            onPress={onAdd}
            disabled={!current.trim()}
            style={{ marginLeft: 8, paddingHorizontal: 16 }}
          />
        </View>

        <View style={styles.confirmRow}>
          <Button
            title={
              draft.length === 0
                ? 'Add at least one plan'
                : `Plan my day (${draft.length})`
            }
            onPress={onConfirm}
            disabled={draft.length === 0 && !current.trim()}
            loading={isScheduling}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerAction: {
    fontSize: 15,
    fontWeight: '500',
    minWidth: 50,
  },
  lead: {
    fontSize: 15,
    lineHeight: 22,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
  },
  rowIndex: {
    width: 18,
    fontSize: 14,
    fontWeight: '600',
  },
  rowInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 12,
  },
  rowRemove: {
    fontSize: 24,
    lineHeight: 24,
    fontWeight: '300',
  },
  suggestionsBlock: {
    marginTop: 8,
    gap: 10,
  },
  suggestionsTitle: {
    fontSize: 13,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  confirmRow: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
});
