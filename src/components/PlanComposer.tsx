import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';

interface Props {
  /** Show/hide the bar — it fades + slides out of the way when false. */
  visible: boolean;
  /** True while the planner is working (disables the field, shows a spinner). */
  busy?: boolean;
  placeholder?: string;
  /** Fired when the user sends non-empty text. The field clears itself after. */
  onSubmit: (text: string) => void;
  style?: StyleProp<ViewStyle>;
}

const FIELD_MIN_H = 52;
const MAX_INPUT_H = 132;
const BTN = 44;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A floating, keyboard-aware composer for the planner drawer — the same
 * liquid-glass field + accent round button as the home screen, but multiline so
 * the user can pour a whole day's description into it before sending it to the
 * planner. Rides up frame-for-frame with the keyboard (see `ChatComposerBar`
 * for the rationale) and clears itself once a plan is sent.
 */
export function PlanComposer({
  visible,
  busy,
  placeholder = 'Describe your day…',
  onSubmit,
  style,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState('');

  // Vertical lift to sit above the keyboard, plus a 0→1 visibility driver.
  const lift = useSharedValue(0);
  const vis = useSharedValue(visible ? 1 : 0);
  const press = useSharedValue(1);

  useEffect(() => {
    vis.value = withTiming(visible ? 1 : 0, { duration: 200 });
    if (!visible) Keyboard.dismiss();
  }, [visible, vis]);

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

  const containerStyle = useAnimatedStyle(() => ({
    opacity: vis.value,
    transform: [{ translateY: lift.value + (1 - vis.value) * 28 }],
  }));

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: press.value }],
  }));

  const canSend = text.trim().length > 0 && !busy;

  const submit = () => {
    const clean = text.trim();
    if (!clean || busy) {
      Keyboard.dismiss();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
      () => undefined,
    );
    onSubmit(clean);
    setText('');
    Keyboard.dismiss();
  };

  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, 60) },
        containerStyle,
        style,
      ]}
    >
      <View style={styles.row}>
        <View style={[styles.fieldShadow, { shadowColor: t.colors.shadow }]}>
          <GlassSurface
            variant="thick"
            radius={24}
            style={styles.field}
            innerStyle={styles.fieldInner}
          >
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={placeholder}
              placeholderTextColor={t.colors.textTertiary}
              editable={!busy}
              multiline
              style={[styles.input, { color: t.colors.textPrimary }]}
            />
          </GlassSurface>
        </View>

        <AnimatedPressable
          onPress={submit}
          onPressIn={() => {
            press.value = withTiming(0.94, { duration: 90 });
          }}
          onPressOut={() => {
            press.value = withTiming(1, { duration: 130 });
          }}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Plan my day"
          style={[
            styles.button,
            {
              backgroundColor: canSend ? t.colors.accent : t.colors.fill2,
              shadowColor: t.colors.accent,
            },
            canSend && styles.buttonActiveShadow,
            buttonStyle,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={t.colors.textOnAccent} />
          ) : (
            <Ionicons
              name="arrow-up"
              size={22}
              color={canSend ? t.colors.textOnAccent : t.colors.textTertiary}
            />
          )}
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
    bottom: 0,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  fieldShadow: {
    flex: 1,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 8,
  },
  field: {
    flex: 1,
  },
  fieldInner: {
    minHeight: FIELD_MIN_H,
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 6,
  },
  input: {
    fontSize: 17,
    maxHeight: MAX_INPUT_H,
    paddingTop: Platform.OS === 'ios' ? 8 : 6,
    paddingBottom: Platform.OS === 'ios' ? 8 : 6,
    lineHeight: 22,
  },
  button: {
    width: BTN,
    height: BTN,
    borderRadius: BTN / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: (FIELD_MIN_H - BTN) / 2,
  },
  buttonActiveShadow: {
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
  },
});
