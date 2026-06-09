import React, { useEffect } from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';

/** A flowing colour field: a diagonal `sweep` plus three drifting `blobs`. */
export interface GradientPalette {
  /** 3–5 colour stops for the diagonal sweep (top-left → bottom-right). */
  sweep: string[];
  /** Three blob colours for the wandering, aurora-like highlights. */
  blobs: string[];
}

/** The default Gemini sweep: blue → indigo → violet → magenta → amber. */
const GEMINI_PALETTE: GradientPalette = {
  sweep: ['#1BA1E3', '#5489D6', '#9B72CB', '#D96570', '#F49C46'],
  blobs: ['#9B72CB', '#1BA1E3', '#F49C46'],
};

/**
 * The base colour field — an oversized diagonal sweep that slowly slides and
 * rotates so the whole palette appears to flow. It's drawn once and only its
 * transform is animated, so the movement runs entirely on the UI thread.
 */
function MovingSweep({
  width,
  height,
  stops,
}: {
  width: number;
  height: number;
  stops: string[];
}) {
  const w = width * 2;
  const h = height * 2;
  const ax = width * 0.22;
  const ay = height * 0.17;
  const ar = 8;

  const tx = useSharedValue(-ax);
  const ty = useSharedValue(-ay);
  const rot = useSharedValue(-ar);

  useEffect(() => {
    tx.value = withRepeat(
      withTiming(ax, { duration: 7500, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    ty.value = withRepeat(
      withTiming(ay, { duration: 10000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    rot.value = withRepeat(
      withTiming(ar, { duration: 13000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [tx, ty, rot, ax, ay, ar]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { rotate: `${rot.value}deg` },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: -(w - width) / 2,
          top: -(h - height) / 2,
          width: w,
          height: h,
        },
        animatedStyle,
      ]}
    >
      <Svg width={w} height={h}>
        <Defs>
          <LinearGradient id="gem" x1="0%" y1="0%" x2="100%" y2="100%">
            {stops.map((c, i) => (
              <Stop
                key={`${c}-${i}`}
                offset={`${(i / (stops.length - 1)) * 100}%`}
                stopColor={c}
              />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={w} height={h} fill="url(#gem)" />
      </Svg>
    </Animated.View>
  );
}

/**
 * A soft, slowly wandering colour blob. Several of these drifting at different
 * speeds make the gradient feel alive and aurora-like.
 */
function FloatingBlob({
  id,
  color,
  size,
  left,
  top,
  dx,
  dy,
  duration,
}: {
  id: string;
  color: string;
  size: number;
  left: number;
  top: number;
  dx: number;
  dy: number;
  duration: number;
}) {
  const x = useSharedValue(-dx);
  const y = useSharedValue(-dy);

  useEffect(() => {
    x.value = withRepeat(
      withTiming(dx, { duration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    y.value = withRepeat(
      withTiming(dy, { duration: duration * 1.35, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [x, y, dx, dy, duration]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', left, top, width: size, height: size }, animatedStyle]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <Stop offset="55%" stopColor={color} stopOpacity={0.16} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={size} height={size} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

interface Props {
  /** Total height of the header banner. */
  height: number;
  /** Colour palette to flow. Defaults to the Gemini sweep. */
  palette?: GradientPalette;
  style?: StyleProp<ViewStyle>;
}

/**
 * A Gemini-style header: a living, drifting colour field that melts smoothly
 * down into the page background.
 */
export function GradientWave({ height, palette = GEMINI_PALETTE, style }: Props) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const bg = t.colors.background;
  const blob = Math.max(width, height) * 0.9;

  // Bloom the whole field up out of pure black on mount, so entering the screen
  // reads as a smooth fade from the dark background into the gradient.
  const appear = useSharedValue(0);
  useEffect(() => {
    appear.value = withTiming(1, { duration: 1300, easing: Easing.out(Easing.cubic) });
  }, [appear]);
  const introStyle = useAnimatedStyle(() => ({ opacity: appear.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { height, width }, introStyle, style]}
    >
      {/* Flowing colour sweep. */}
      <MovingSweep width={width} height={height} stops={palette.sweep} />

      {/* Wandering colour blobs for an aurora-like motion. */}
      <FloatingBlob
        id="blobA"
        color={palette.blobs[0]}
        size={blob}
        left={-blob * 0.2}
        top={-blob * 0.25}
        dx={width * 0.36}
        dy={height * 0.2}
        duration={9000}
      />
      <FloatingBlob
        id="blobB"
        color={palette.blobs[1]}
        size={blob * 0.9}
        left={width - blob * 0.6}
        top={-blob * 0.18}
        dx={width * 0.3}
        dy={height * 0.26}
        duration={11500}
      />
      <FloatingBlob
        id="blobC"
        color={palette.blobs[2]}
        size={blob * 0.8}
        left={width * 0.25}
        top={height * 0.1}
        dx={width * 0.4}
        dy={height * 0.18}
        duration={13000}
      />

      {/* Long, smooth fade down into the page background. */}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="vFade" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={bg} stopOpacity={0} />
            <Stop offset="45%" stopColor={bg} stopOpacity={0} />
            <Stop offset="75%" stopColor={bg} stopOpacity={0.55} />
            <Stop offset="100%" stopColor={bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#vFade)" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
  },
});
