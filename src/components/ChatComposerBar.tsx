import React, { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';

interface Props {
  /**
   * The primary action for the "+" button — same job the old FAB had.
   * Fires only from the resting (unfocused) state.
   */
  onPlus: () => void;
  /**
   * Fired when the user sends non-empty text (taps the morphed "send" button or
   * hits return). The field clears itself afterwards. Used to capture a quick
   * errand/reminder. When omitted, "send" just dismisses the keyboard.
   */
  onSubmit?: (text: string) => void;
  placeholder?: string;
  /** Hide the bar entirely (useful for modal sub-screens). */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
}

const BAR_H = 54;
const BTN = 54; // resting "+" diameter
const BTN_SM = 40; // focused "send" diameter
const GAP = 10; // gap between field and the split "+" button
const INSET = 7; // focused button inset from the field's right edge

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const TIMING = { duration: 240, easing: Easing.out(Easing.cubic) };

/**
 * A ChatGPT-style composer docked at the bottom of the home screen, replacing
 * the old tab bar. At rest it reads as a text field with a separate, blue "+"
 * button to its right (the FAB's old job). On focus the "+" animates *into* the
 * field's right edge and morphs into a circular "send" button.
 *
 * The text field is intentionally inert for now — it's a placeholder for a
 * future chat/compose entry point. Only the "+" is wired (to `onPlus`).
 */
export function ChatComposerBar({
  onPlus,
  onSubmit,
  placeholder = 'Ask anything',
  hidden,
  style,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');

  // 0 = resting (split "+"), 1 = focused (in-field "send"). Drives the morph.
  const p = useSharedValue(0);
  // Tap feedback for the button, kept on the UI thread so it composes with the
  // morph transform rather than fighting a function `style`.
  const press = useSharedValue(1);
  // Vertical lift to sit above the keyboard. Driven off the native keyboard
  // events rather than reanimated's `useAnimatedKeyboard` — that hook snaps
  // 0 → full in a few steps on iOS (the "jumps up late" glitch). `willShow`
  // fires as the keyboard *starts* moving and carries the exact duration, so
  // matching it makes the bar track the keyboard frame-for-frame.
  const lift = useSharedValue(0);

  useEffect(() => {
    const isIOS = Platform.OS === 'ios';
    const showEvt = isIOS ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = isIOS ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: KeyboardEvent) => {
      const h = e.endCoordinates?.height ?? 0;
      const duration = e.duration && e.duration > 0 ? e.duration : 250;
      lift.value = withTiming(-Math.max(h - insets.bottom, 0), {
        duration,
        easing: Easing.out(Easing.ease),
      });
    };
    const onHide = (e: KeyboardEvent) => {
      const duration = e.duration && e.duration > 0 ? e.duration : 250;
      lift.value = withTiming(0, { duration, easing: Easing.in(Easing.ease) });
    };
    const showSub = Keyboard.addListener(showEvt, onShow);
    const hideSub = Keyboard.addListener(hideEvt, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom, lift]);

  const animateTo = (to: number) => {
    p.value = withTiming(to, TIMING);
  };

  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: lift.value }],
  }));

  const fieldStyle = useAnimatedStyle(() => ({
    marginRight: interpolate(p.value, [0, 1], [BTN + GAP, 0]),
  }));

  const spacerStyle = useAnimatedStyle(() => ({
    width: interpolate(p.value, [0, 1], [0, BTN_SM]),
  }));

  const buttonStyle = useAnimatedStyle(() => ({
    width: interpolate(p.value, [0, 1], [BTN, BTN_SM]),
    height: interpolate(p.value, [0, 1], [BTN, BTN_SM]),
    borderRadius: interpolate(p.value, [0, 1], [BTN / 2, BTN_SM / 2]),
    right: interpolate(p.value, [0, 1], [0, INSET]),
    top: interpolate(
      p.value,
      [0, 1],
      [(BAR_H - BTN) / 2, (BAR_H - BTN_SM) / 2],
    ),
    transform: [{ scale: press.value }],
  }));

  const plusIconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.45], [1, 0]),
    transform: [{ scale: interpolate(p.value, [0, 1], [1, 0.6]) }],
  }));

  const sendIconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0.55, 1], [0, 1]),
    transform: [{ scale: interpolate(p.value, [0, 1], [0.6, 1]) }],
  }));

  if (hidden) return null;

  const submit = () => {
    const clean = text.trim();
    if (!clean) {
      Keyboard.dismiss();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    onSubmit?.(clean);
    setText('');
    Keyboard.dismiss();
  };

  const onButtonPress = () => {
    if (focused) {
      // "Send": capture the typed text as an errand (or, with no handler / no
      // text, just dismiss the keyboard, returning the button to its "+" rest).
      submit();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    onPlus();
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, t.spacing.md) },
        liftStyle,
        style,
      ]}
    >
      <View style={styles.row}>
        <Animated.View
          style={[
            styles.fieldShadow,
            { shadowColor: t.colors.shadow },
            fieldStyle,
          ]}
        >
          <GlassSurface
            variant="thick"
            radius={BAR_H / 2}
            style={styles.field}
            innerStyle={styles.fieldInner}
          >
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={placeholder}
              placeholderTextColor={t.colors.textTertiary}
              onFocus={() => {
                setFocused(true);
                animateTo(1);
              }}
              onBlur={() => {
                setFocused(false);
                animateTo(0);
              }}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              style={[styles.input, { color: t.colors.textPrimary }]}
              returnKeyType="send"
            />
            <Animated.View style={spacerStyle} />
          </GlassSurface>
        </Animated.View>

        <AnimatedPressable
          onPress={onButtonPress}
          onPressIn={() => {
            press.value = withTiming(0.94, { duration: 90 });
          }}
          onPressOut={() => {
            press.value = withTiming(1, { duration: 130 });
          }}
          accessibilityRole="button"
          accessibilityLabel={focused ? 'Send' : 'Add'}
          style={[
            styles.button,
            {
              backgroundColor: t.colors.accent,
              shadowColor: t.colors.accent,
            },
            buttonStyle,
          ]}
        >
          <Animated.View style={[styles.iconLayer, plusIconStyle]}>
            <Ionicons name="add" size={28} color={t.colors.textOnAccent} />
          </Animated.View>
          <Animated.View style={[styles.iconLayer, sendIconStyle]}>
            <Ionicons name="arrow-up" size={22} color={t.colors.textOnAccent} />
          </Animated.View>
        </AnimatedPressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAR_H,
  },
  fieldShadow: {
    flex: 1,
    height: BAR_H,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 8,
  },
  field: {
    flex: 1,
    height: BAR_H,
  },
  fieldInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  button: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
    zIndex: 2,
  },
  iconLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
