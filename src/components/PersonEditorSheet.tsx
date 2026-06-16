import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { ErrandAddressField, type AddressValue } from './ErrandAddressField';
import { useHomeStore } from '@/store/useHomeStore';
import type { Person, PersonInput, PersonPlace } from '@/store/usePeopleStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The person being edited, or null/undefined to add a new one. */
  person?: Person | null;
  onSubmit: (input: PersonInput) => void;
  /** Shown only when editing an existing person. */
  onDelete?: () => void;
}

function placeToValue(place: PersonPlace | null | undefined): AddressValue | null {
  if (!place?.label) return null;
  return {
    label: place.label,
    latitude: place.latitude,
    longitude: place.longitude,
    placeId: place.placeId ?? null,
  };
}

function valueToPlace(value: AddressValue | null): PersonPlace | null {
  if (!value?.label) return null;
  return {
    label: value.label,
    latitude: value.latitude ?? undefined,
    longitude: value.longitude ?? undefined,
    placeId: value.placeId ?? undefined,
  };
}

/**
 * Add / edit a saved person: a name, any number of nicknames, and one fixed
 * place (the home/flat the errand parser uses for "at <name>'s place"). Lives in
 * a bottom sheet so the place picker's `BottomSheetTextInput` works, and so it
 * can be summoned from onboarding (a plain screen) or Settings alike.
 */
export function PersonEditorSheet({ open, onClose, person, onSubmit, onDelete }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const home = useHomeStore((s) => s.home);
  const center = useMemo(
    () => (home ? { latitude: home.latitude, longitude: home.longitude } : null),
    [home],
  );

  const [name, setName] = useState('');
  const [nicknames, setNicknames] = useState<string[]>([]);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [place, setPlace] = useState<AddressValue | null>(null);
  const [notes, setNotes] = useState('');

  // Re-seed each time the sheet opens for a (different) person. The key also
  // drives the address field's own re-seed.
  const seedKey = `person-${person?.id ?? 'new'}-${open ? 'open' : 'closed'}`;
  useEffect(() => {
    if (!open) return;
    setName(person?.name ?? '');
    setNicknames(person?.nicknames ?? []);
    setNicknameDraft('');
    setPlace(placeToValue(person?.place));
    setNotes(person?.notes ?? '');
  }, [open, person]);

  const addNickname = () => {
    const v = nicknameDraft.trim();
    if (!v) return;
    Haptics.selectionAsync().catch(() => undefined);
    setNicknames((prev) =>
      prev.some((n) => n.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v],
    );
    setNicknameDraft('');
  };

  const removeNickname = (n: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setNicknames((prev) => prev.filter((x) => x !== n));
  };

  const canSave = name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    Haptics.selectionAsync().catch(() => undefined);
    onSubmit({
      name: name.trim(),
      nicknames,
      place: valueToPlace(place),
      notes: notes.trim() ? notes.trim() : undefined,
    });
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} heightFraction={0.9} enableContentPanningGesture={false}>
      <View style={styles.container}>
        <BottomSheetScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text variant="title3" weight="heavy" tight>
            {person ? 'Edit person' : 'Add a person'}
          </Text>
          <Text variant="bodySm" tone="secondary">
            Diem uses their place when you say “at {name.trim() || 'their'}’s place”, but
            not for “with {name.trim() || 'them'}”.
          </Text>

          <FieldLabel icon="person-outline" label="Name" />
          <BottomSheetTextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Ondra"
            placeholderTextColor={t.colors.textTertiary}
            autoCapitalize="words"
            autoCorrect={false}
            style={[
              styles.input,
              { backgroundColor: t.colors.fill1, color: t.colors.textPrimary },
            ]}
          />

          <FieldLabel icon="pricetags-outline" label="Nicknames" />
          {nicknames.length > 0 ? (
            <View style={styles.chips}>
              {nicknames.map((n) => (
                <Pressable
                  key={n}
                  onPress={() => removeNickname(n)}
                  style={[
                    styles.chip,
                    { backgroundColor: t.colors.accentSoft, borderColor: t.colors.accent },
                  ]}
                >
                  <Text variant="bodySm" weight="semibold" tone="accent">
                    {n}
                  </Text>
                  <Ionicons name="close" size={14} color={t.colors.accent} />
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.nicknameRow}>
            <BottomSheetTextInput
              value={nicknameDraft}
              onChangeText={setNicknameDraft}
              placeholder="Add a nickname"
              placeholderTextColor={t.colors.textTertiary}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={addNickname}
              style={[
                styles.input,
                { flex: 1, backgroundColor: t.colors.fill1, color: t.colors.textPrimary },
              ]}
            />
            <Pressable
              onPress={addNickname}
              disabled={!nicknameDraft.trim()}
              style={[
                styles.addBtn,
                {
                  backgroundColor: nicknameDraft.trim()
                    ? t.colors.accent
                    : t.colors.fill2,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Add nickname"
            >
              <Ionicons
                name="add"
                size={22}
                color={nicknameDraft.trim() ? t.colors.textOnAccent : t.colors.textTertiary}
              />
            </Pressable>
          </View>

          <FieldLabel icon="home-outline" label="Their place" />
          <ErrandAddressField
            value={place}
            center={center}
            seedKey={seedKey}
            onChange={setPlace}
          />

          <FieldLabel icon="document-text-outline" label="Note" />
          <BottomSheetTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            placeholderTextColor={t.colors.textTertiary}
            multiline
            style={[
              styles.input,
              styles.notes,
              { backgroundColor: t.colors.fill1, color: t.colors.textPrimary },
            ]}
          />

          {onDelete ? (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                onDelete();
                onClose();
              }}
              style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
            >
              <Ionicons name="trash-outline" size={18} color={t.colors.danger} />
              <Text variant="body" weight="semibold" tone="danger">
                Delete person
              </Text>
            </Pressable>
          ) : null}
        </BottomSheetScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: insets.bottom + 8, borderTopColor: t.colors.separator },
          ]}
        >
          <Button
            title={person ? 'Save' : 'Add person'}
            size="lg"
            onPress={save}
            disabled={!canSave}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}

function FieldLabel({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  const t = useTheme();
  return (
    <View style={styles.fieldLabel}>
      <Ionicons name={icon} size={15} color={t.colors.textSecondary} />
      <Text variant="micro" uppercase weight="bold" tone="secondary" style={{ letterSpacing: 1 }}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 10,
  },
  fieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  input: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  notes: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  nicknameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 10,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
