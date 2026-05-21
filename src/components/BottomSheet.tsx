import React, { useEffect } from 'react';
import {
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';
import { TopBar, type TopBarAction } from './TopBar';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Height fraction of the screen (0..1). Default 0.86 for tall sheets. */
  heightFraction?: number;
  /** Optional title shown in the sheet header. */
  title?: string;
  /** Optional confirm action (renders as accent ✓ in the right cluster). */
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  /** Don't render the X / ✓ header pair (useful for purely info sheets). */
  hideDefaultHeader?: boolean;
  children?: React.ReactNode;
  /** Style applied to the inner content container. */
  contentStyle?: StyleProp<ViewStyle>;
}

const SCREEN = Dimensions.get('window');

/**
 * Apple-style bottom sheet. Pulls up from the bottom, tinted glass surface,
 * draggable to dismiss. Header follows the pattern from the reference
 * screenshots: a glass X on the left, a glass ✓ on the right.
 *
 * The sheet auto-renders a `KeyboardAvoidingView` so input-heavy sheets
 * (like Add Plan) play nicely with the keyboard.
 */
export function BottomSheet({
  visible,
  onClose,
  heightFraction = 0.86,
  title,
  onConfirm,
  confirmDisabled,
  hideDefaultHeader,
  children,
  contentStyle,
}: Props) {
  const t = useTheme();
  const sheetHeight = SCREEN.height * heightFraction;

  const translateY = useSharedValue(sheetHeight);
  const overlayOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, {
        damping: 24,
        stiffness: 220,
        mass: 0.9,
      });
      overlayOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.ease),
      });
    } else {
      translateY.value = withTiming(sheetHeight, {
        duration: 220,
        easing: Easing.in(Easing.ease),
      });
      overlayOpacity.value = withTiming(0, {
        duration: 180,
        easing: Easing.in(Easing.ease),
      });
    }
  }, [visible, sheetHeight, translateY, overlayOpacity]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  const dragGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 700) {
        translateY.value = withTiming(sheetHeight, { duration: 220 });
        runOnJS(onClose)();
      } else {
        translateY.value = withSpring(0, {
          damping: 22,
          stiffness: 200,
        });
      }
    });

  const actions: TopBarAction[] = onConfirm
    ? [
        {
          icon: 'checkmark',
          accent: true,
          onPress: confirmDisabled ? undefined : onConfirm,
          accessibilityLabel: 'Confirm',
        },
      ]
    : [];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, overlayStyle]}>
            <Pressable
              style={[StyleSheet.absoluteFill, styles.scrim]}
              onPress={onClose}
              accessibilityLabel="Dismiss"
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.sheetWrap,
              { height: sheetHeight, shadowColor: t.colors.shadow },
              sheetStyle,
            ]}
          >
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <GlassSurface
                variant="thick"
                radius={t.radii.xl}
                style={styles.sheet}
                innerStyle={styles.sheetInner}
              >
                <GestureDetector gesture={dragGesture}>
                  <View style={styles.handleHit}>
                    <View
                      style={[
                        styles.handle,
                        { backgroundColor: t.colors.fill3 },
                      ]}
                    />
                  </View>
                </GestureDetector>

                {!hideDefaultHeader ? (
                  <TopBar
                    title={title}
                    left={{
                      icon: 'close',
                      onPress: onClose,
                      accessibilityLabel: 'Close',
                    }}
                    actions={actions}
                  />
                ) : null}

                <View style={[styles.content, contentStyle]}>{children}</View>
              </GlassSurface>
            </KeyboardAvoidingView>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: 'rgba(0, 0, 0, 0.40)',
  },
  sheetWrap: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.25,
    shadowRadius: 32,
    elevation: 24,
  },
  sheet: {
    flex: 1,
  },
  sheetInner: {
    flex: 1,
  },
  handleHit: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  handle: {
    width: 40,
    height: 5,
    borderRadius: 999,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
});
