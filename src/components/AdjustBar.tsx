import React, { useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedKeyboard,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

interface Props {
  /** Show the bar (drawer expanded + a plan is on screen). */
  visible: boolean;
  /** True while an edit/AI re-plan is in flight. */
  busy?: boolean;
  /** Safe-area bottom inset, so the bar floats above the home indicator. */
  bottomInset: number;
  onSubmit: (text: string) => void;
}

/**
 * Floating, keyboard-aware "adjust your day" input — an Apple/ChatGPT-style
 * rounded field pinned to the bottom of the drawer. Only rendered while the
 * sheet is expanded and a plan exists; it rides up with the keyboard and shows
 * a thinking state while an edit is being applied.
 */
export function AdjustBar({ visible, busy, bottomInset, onSubmit }: Props) {
  const t = useTheme();
  const [text, setText] = useState('');
  const keyboard = useAnimatedKeyboard();

  const containerStyle = useAnimatedStyle(() => {
    // Lift above the keyboard when it's open; otherwise sit on the safe inset.
    const lift = Math.max(keyboard.height.value - bottomInset, 0);
    return {
      transform: [
        { translateY: withTiming(visible ? -lift : 24, { duration: 160 }) },
      ],
      opacity: withTiming(visible ? 1 : 0, { duration: 160 }),
    };
  });

  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setText('');
    Keyboard.dismiss();
    onSubmit(v);
  };

  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[styles.wrap, { paddingBottom: bottomInset + 8 }, containerStyle]}
    >
      <View
        style={[
          styles.bar,
          {
            backgroundColor: t.colors.surface2,
            borderColor: t.colors.separator,
            shadowColor: '#000',
          },
        ]}
      >
        {busy ? (
          <Animated.View entering={FadeIn} style={styles.leading}>
            <ActivityIndicator size="small" color={t.colors.accent} />
          </Animated.View>
        ) : (
          <View style={styles.leading}>
            <Ionicons name="sparkles" size={18} color={t.colors.accent} />
          </View>
        )}
        <TextInput
          style={[styles.input, { color: t.colors.textPrimary }]}
          placeholder={busy ? 'Updating your day…' : 'Adjust your day…'}
          placeholderTextColor={t.colors.textTertiary}
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          editable={!busy}
          returnKeyType="send"
          multiline
        />
        <Pressable
          onPress={submit}
          disabled={!text.trim() || busy}
          hitSlop={8}
          style={({ pressed }) => [
            styles.send,
            {
              backgroundColor: text.trim() && !busy ? t.colors.accent : t.colors.fill2,
            },
            pressed && { opacity: 0.8 },
          ]}
        >
          <Ionicons
            name="arrow-up"
            size={18}
            color={text.trim() && !busy ? t.colors.textOnAccent : t.colors.textTertiary}
          />
        </Pressable>
      </View>
      {/* {busy ? null : (
        <Text variant="micro" tone="tertiary" style={styles.hint}>
          e.g. “lunch 30 min longer”, “skip the column”, “make the evening relaxed”
        </Text>
      )} */}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 52,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  leading: {
    width: 22,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontSize: 16,
    maxHeight: 120,
    paddingTop: 9,
    paddingBottom: 9,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
  },
  hint: {
    textAlign: 'center',
    marginTop: 6,
  },
});
