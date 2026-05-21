import React, { useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { TopBar } from '@/components/TopBar';
import { Text } from '@/components/Text';
import { Card } from '@/components/Card';

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
  const t = useTheme();

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
    Haptics.selectionAsync().catch(() => undefined);
    addDraft(text);
    setCurrent('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onConfirm = async () => {
    const hasPending = current.trim().length > 0;
    if (hasPending) addDraft(current.trim());
    setCurrent('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    await confirmDraft();
    router.back();
  };

  const onClose = () => {
    router.back();
  };

  const canConfirm = draft.length > 0 || current.trim().length > 0;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: t.colors.background }]}
      edges={['top', 'bottom']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar
          title="Add plans"
          left={{
            icon: 'close',
            onPress: onClose,
            accessibilityLabel: 'Close',
          }}
          actions={[
            {
              icon: 'checkmark',
              accent: true,
              onPress: canConfirm ? onConfirm : undefined,
              accessibilityLabel: 'Confirm',
            },
          ]}
        />

        <FlatList
          data={draft}
          keyExtractor={(item, idx) => `${idx}-${item}`}
          contentContainerStyle={[
            styles.listContent,
            {
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.md,
              paddingBottom: t.spacing.md,
            },
          ]}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ marginBottom: 16 }}>
              <Text variant="bodySm" tone="secondary">
                Type whatever you want to do today, one plan at a time. You
                can be vague — Diem will ask follow-ups if it needs to.
              </Text>
              {draft.length > 0 ? (
                <Pressable
                  onPress={clearDraft}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.clearRow,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Ionicons
                    name="trash-outline"
                    size={14}
                    color={t.colors.textSecondary}
                  />
                  <Text variant="caption" tone="secondary" weight="semibold">
                    Clear all
                  </Text>
                </Pressable>
              ) : null}
            </View>
          }
          renderItem={({ item, index }) => (
            <Card padded small style={styles.row}>
              <View
                style={[
                  styles.rowBadge,
                  { backgroundColor: t.colors.fill1 },
                ]}
              >
                <RNText
                  style={[
                    styles.rowBadgeText,
                    { color: t.colors.textSecondary },
                  ]}
                >
                  {index + 1}
                </RNText>
              </View>
              <TextInput
                value={item}
                onChangeText={(text) => updateDraft(index, text)}
                style={[styles.rowInput, { color: t.colors.textPrimary }]}
                placeholderTextColor={t.colors.textTertiary}
              />
              <Pressable
                hitSlop={8}
                onPress={() => removeDraft(index)}
                style={({ pressed }) => [
                  styles.rowRemove,
                  { backgroundColor: t.colors.fill1 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Ionicons
                  name="close"
                  size={14}
                  color={t.colors.textSecondary}
                />
              </Pressable>
            </Card>
          )}
          ListEmptyComponent={
            <View style={{ gap: 14 }}>
              <Text
                variant="caption"
                tone="secondary"
                uppercase
                weight="semibold"
              >
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

        <View
          style={[
            styles.composer,
            {
              backgroundColor: t.colors.background,
              borderTopColor: t.colors.separator,
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.md,
              paddingBottom: t.spacing.md,
            },
          ]}
        >
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
            variant="tonal"
            size="md"
            onPress={onAdd}
            disabled={!current.trim()}
            style={{ marginLeft: 8 }}
          />
        </View>

        <View
          style={[
            styles.confirmRow,
            {
              paddingHorizontal: t.spacing.lg,
              paddingBottom: t.spacing.md,
            },
          ]}
        >
          <Button
            title={
              !canConfirm
                ? 'Add at least one plan'
                : `Plan my day (${
                    draft.length + (current.trim() ? 1 : 0)
                  })`
            }
            onPress={onConfirm}
            disabled={!canConfirm}
            loading={isScheduling}
            fullWidth
            size="lg"
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    flexGrow: 1,
  },
  clearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 10,
    alignSelf: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
  },
  rowBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  rowInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 6,
  },
  rowRemove: {
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  confirmRow: {
    paddingTop: 4,
  },
});
