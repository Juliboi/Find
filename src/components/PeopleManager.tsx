import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { PersonEditorSheet } from './PersonEditorSheet';
import { usePeopleStore, type Person } from '@/store/usePeopleStore';

interface Props {
  /** Open the editor for this person id on mount (deep-link from Settings/home). */
  editId?: string | null;
}

/**
 * The reusable People list + add button (the editor itself is a modal sheet, so
 * this owns no scroll view and drops straight into onboarding or a Settings
 * screen). Reads/writes `usePeopleStore` directly — local-first, synced.
 */
export function PeopleManager({ editId }: Props) {
  const t = useTheme();
  const people = usePeopleStore((s) => s.items);
  const add = usePeopleStore((s) => s.add);
  const update = usePeopleStore((s) => s.update);
  const remove = usePeopleStore((s) => s.remove);

  // null = closed, 'new' = adding, otherwise the person being edited.
  const [editing, setEditing] = useState<Person | 'new' | null>(null);

  useEffect(() => {
    if (!editId) return;
    const match = people.find((p) => p.id === editId);
    if (match) setEditing(match);
    // Only react to an incoming deep-link id, not every list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const editingPerson = editing && editing !== 'new' ? editing : null;

  return (
    <View style={styles.wrap}>
      {people.length === 0 ? (
        <Text variant="bodySm" tone="tertiary">
          No people yet. Add someone with a fixed place — Diem then understands “at their
          place”.
        </Text>
      ) : (
        <View style={[styles.list, { borderColor: t.colors.separator }]}>
          {people.map((person, i) => (
            <Pressable
              key={person.id}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setEditing(person);
              }}
              style={({ pressed }) => [
                styles.row,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.separator },
                pressed && { backgroundColor: t.colors.fill1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${person.name}`}
            >
              <View style={[styles.avatar, { backgroundColor: t.colors.accentSoft }]}>
                <Text variant="body" weight="bold" tone="accent">
                  {person.name.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View style={styles.rowText}>
                <Text variant="body" weight="semibold" numberOfLines={1}>
                  {person.name}
                </Text>
                <Text variant="caption" tone="secondary" numberOfLines={1}>
                  {subtitle(person)}
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
        accessibilityLabel="Add a person"
      >
        <Ionicons name="add-circle-outline" size={20} color={t.colors.accent} />
        <Text variant="body" weight="semibold" tone="accent">
          Add a person
        </Text>
      </Pressable>

      <PersonEditorSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        person={editingPerson}
        onSubmit={(input) => {
          if (editingPerson) update(editingPerson.id, input);
          else add(input);
        }}
        onDelete={editingPerson ? () => remove(editingPerson.id) : undefined}
      />
    </View>
  );
}

function subtitle(person: Person): string {
  const parts: string[] = [];
  if (person.nicknames.length) parts.push(person.nicknames.join(', '));
  if (person.place?.label) parts.push(person.place.label);
  return parts.length ? parts.join(' · ') : 'No place set';
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
  avatar: {
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
