import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import type { Errand, ErrandStatus } from '@/store/useErrandsStore';
import { formatTime, formatDuration } from '@/utils/time';
import { describeDay } from '@/utils/days';

interface Props {
  errand: Errand;
  /**
   * Tap the row body — opens the edit drawer on the home list. Omit to render a
   * non-editable display row (no body tap, no trailing chevron).
   */
  onPress?: () => void;
  onToggleDone: () => void;
  /** Draw a hairline separator below the row (omitted on the last row). */
  showSeparator?: boolean;
  /**
   * Cross out + dim completed errands. Defaults true (home list). Reference
   * views (e.g. the planner drawer) pass false so rows always read as plain.
   */
  dimWhenDone?: boolean;
  /**
   * Planner-drawer "pick what to fold into today" mode. The whole row becomes a
   * toggle and the leading circle turns into a selection indicator (a check when
   * `selected`) instead of the done control. Purely opt-in — the home list never
   * passes these, so its tap-to-complete / tap-to-edit behaviour is untouched.
   */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /**
   * Completed-section mode. When 'planned' or 'done' the row shows a status tag
   * and a leading control: ticking a planned errand DELETES it ({@link onDelete})
   * — "checked off, done with it, gone" — while a done one's control returns it
   * to the active list. A planned row also gets a trailing "pull back to active"
   * undo button (`onReopen`). Omit (or pass 'open') for a normal active row —
   * all existing behaviour is untouched.
   */
  status?: ErrandStatus;
  /** Pull the errand back to the active list (clears done + plannedDate). */
  onReopen?: () => void;
  /**
   * Completed-section only: permanently remove the errand. Wired to the leading
   * checkbox of a PLANNED row so ticking it off clears the errand for good
   * (the trailing undo arrow remains for "pull back to active" instead).
   */
  onDelete?: () => void;
}

/**
 * Builds the one-line meta string under an errand title, joining only the slots
 * that were actually filled. A fully-unspecified errand ("call mom") reads as a
 * gentle "Anytime" so the row never looks broken/empty.
 */
function metaParts(errand: Errand): string[] {
  const parts: string[] = [];
  if (errand.date) parts.push(describeDay(errand.date).title);
  if (errand.startTime) {
    parts.push(
      errand.endTime
        ? `${formatTime(errand.startTime)} – ${formatTime(errand.endTime)}`
        : formatTime(errand.startTime),
    );
  } else if (errand.durationMin) {
    // Untimed but with a length estimate — show it (e.g. "~1h") so the planner
    // hint the user set isn't invisible.
    parts.push(`~${formatDuration(errand.durationMin)}`);
  }
  if (errand.address) parts.push(errand.address);
  else if (errand.autoPlace) parts.push('Diem picks the spot');
  if (parts.length === 0) parts.push('Anytime');
  return parts;
}

/**
 * A single errand line on the home screen: a tap-to-complete circle, the title,
 * and a compact meta line (day · time · place). Tapping the body opens the edit
 * drawer. Completed errands dim + strike through and sort to the bottom.
 */
export function ErrandRow({
  errand,
  onPress,
  onToggleDone,
  showSeparator,
  dimWhenDone = true,
  selectable = false,
  selected = false,
  onToggleSelect,
  status,
  onReopen,
  onDelete,
}: Props) {
  const t = useTheme();
  const meta = metaParts(errand).join(' · ');
  const done = errand.done;
  // Completed-section row (planned or done). `isDone` reflects the *derived*
  // status (a past planned day reads as done even though `errand.done` is false).
  const completed = status === 'planned' || status === 'done';
  const isDone = status === 'done';
  // Only cross out / dim a completed errand where that state is meaningful: a
  // done row in the completed section, or the home list (which passes
  // `dimWhenDone`). Planned rows + reference rows stay plain.
  const dim = completed ? isDone : done && dimWhenDone;
  // A resolved place (picked from search) carries coords — flag it so the user
  // can see at a glance which errands are pinned / planner-ready.
  const located = errand.latitude != null && errand.longitude != null;
  // Auto-place errands have no pin yet — flag them so the user can tell at a
  // glance the planner will choose the venue.
  const autoPlace = !located && !!errand.autoPlace;
  const rating = typeof errand.rating === 'number' ? errand.rating : null;
  const photo = !dim && errand.photoUrl ? errand.photoUrl : null;

  const rowStyle: StyleProp<ViewStyle> = [
    styles.row,
    showSeparator && {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.separator,
    },
  ];

  // Completed mode: the leading circle reflects done-ness — tapping marks a
  // planned errand done, or returns a done one to the active list. In select
  // mode the circle (and the whole row) toggles selection; editing is reachable
  // only via the trailing chevron. Otherwise it's the plain done toggle.
  const leading = completed ? (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        // Completed section: ticking a planned errand clears it for good; a done
        // one's control returns it to the active list (undo is the trailing arrow).
        if (isDone) onReopen?.();
        else onDelete?.();
      }}
      hitSlop={10}
      accessibilityRole={isDone ? 'checkbox' : 'button'}
      accessibilityState={{ checked: isDone }}
      accessibilityLabel={
        isDone
          ? `Return ${errand.title} to active errands`
          : `Check off and remove ${errand.title}`
      }
      style={[
        styles.check,
        {
          borderColor: isDone ? t.colors.accent : t.colors.border,
          backgroundColor: isDone ? t.colors.accent : 'transparent',
        },
      ]}
    >
      {isDone ? (
        <Ionicons name="checkmark" size={15} color={t.colors.textOnAccent} />
      ) : null}
    </Pressable>
  ) : selectable ? (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onToggleSelect?.();
      }}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={
        selected
          ? `Remove ${errand.title} from this plan`
          : `Add ${errand.title} to this plan`
      }
      style={[
        styles.check,
        {
          borderColor: selected ? t.colors.accent : t.colors.border,
          backgroundColor: selected ? t.colors.accent : 'transparent',
        },
      ]}
    >
      {selected ? (
        <Ionicons name="checkmark" size={15} color={t.colors.textOnAccent} />
      ) : null}
    </Pressable>
  ) : (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onToggleDone();
      }}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={done ? 'Mark errand not done' : 'Mark errand done'}
      style={[
        styles.check,
        {
          borderColor: done ? t.colors.accent : t.colors.border,
          backgroundColor: done ? t.colors.accent : 'transparent',
        },
      ]}
    >
      {done ? (
        <Ionicons name="checkmark" size={15} color={t.colors.textOnAccent} />
      ) : null}
    </Pressable>
  );

  const content = (
    <>
      {leading}

      {photo ? (
        <Image
          source={{ uri: photo }}
          style={[styles.thumb, { backgroundColor: t.colors.fill1 }]}
        />
      ) : null}

      <View style={styles.text}>
        <Text
          variant="body"
          weight="semibold"
          numberOfLines={1}
          tone={dim ? 'tertiary' : 'primary'}
          style={dim ? styles.struck : undefined}
        >
          {errand.title}
        </Text>
        <View style={styles.metaRow}>
          {completed ? (
            <View
              style={[
                styles.statusTag,
                { backgroundColor: isDone ? t.colors.fill2 : t.colors.accentSoft },
              ]}
            >
              <Text
                variant="micro"
                weight="bold"
                style={{
                  color: isDone ? t.colors.textTertiary : t.colors.accentText,
                }}
              >
                {isDone ? 'Done' : 'Planned'}
              </Text>
            </View>
          ) : null}
          {rating != null && !dim ? (
            <View style={styles.ratingPill}>
              <Ionicons name="star" size={11} color={t.colors.highlightYellow} />
              <Text variant="caption" tone="secondary" weight="semibold">
                {rating.toFixed(1)}
              </Text>
            </View>
          ) : null}
          {meta ? (
            <Text
              variant="caption"
              tone={dim ? 'tertiary' : 'secondary'}
              numberOfLines={1}
              style={{ flex: 1 }}
            >
              {meta}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.trailing}>
        {located && !photo && !dim && !completed ? (
          <Ionicons name="location" size={13} color={t.colors.accentText} />
        ) : null}
        {autoPlace && !photo && !dim && !completed ? (
          <Ionicons name="sparkles" size={12} color={t.colors.accentText} />
        ) : null}
        {completed && !isDone && onReopen ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              onReopen();
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={`Pull ${errand.title} back to active errands`}
            style={({ pressed }) => [styles.editButton, pressed && { opacity: 0.5 }]}
          >
            <Ionicons
              name="arrow-undo-outline"
              size={17}
              color={t.colors.textSecondary}
            />
          </Pressable>
        ) : null}
        {onPress ? (
          selectable ? (
            // Select mode: the row body toggles selection, so editing lives in
            // this dedicated right-side button (a nested Pressable, so its taps
            // don't bubble up and toggle selection).
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                onPress?.();
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Edit errand ${errand.title}`}
              style={({ pressed }) => [
                styles.editButton,
                pressed && { opacity: 0.5 },
              ]}
            >
              <Ionicons name="chevron-forward" size={18} color={t.colors.textSecondary} />
            </Pressable>
          ) : (
            <Ionicons name="chevron-forward" size={16} color={t.colors.textTertiary} />
          )
        ) : null}
      </View>
    </>
  );

  // Select mode: tapping the checkmark or anywhere on the row toggles whether
  // the errand folds into the plan. Editing is reachable only via the trailing
  // chevron button nested inside `content`.
  if (selectable) {
    return (
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          onToggleSelect?.();
        }}
        style={({ pressed }) => [
          rowStyle,
          pressed && { backgroundColor: t.colors.fill1 },
        ]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={
          selected
            ? `Remove ${errand.title} from today's plan`
            : `Add ${errand.title} to today's plan`
        }
      >
        {content}
      </Pressable>
    );
  }

  // Editable (home list): the whole row body opens the editor; the leading
  // circle stays the interactive done toggle.
  if (onPress) {
    return (
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          onPress();
        }}
        style={({ pressed }) => [
          rowStyle,
          pressed && { backgroundColor: t.colors.fill1 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Edit errand ${errand.title}`}
      >
        {content}
      </Pressable>
    );
  }

  // Display-only rows (no `onPress`) render as a plain View, leaving just the
  // done-toggle interactive.
  return <View style={rowStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 1,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 9,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  ratingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  statusTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  struck: {
    textDecorationLine: 'line-through',
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  editButton: {
    paddingLeft: 6,
    paddingVertical: 4,
  },
});
