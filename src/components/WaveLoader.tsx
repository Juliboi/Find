import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const AnimatedPath = Animated.createAnimatedComponent(Path);

interface Props {
  /** Overall width of the wave. */
  width?: number;
  /** Overall height — also the vertical room reserved for the soft glow. */
  height?: number;
  /** Thickness of the crisp core line. The glow layers scale off this. */
  strokeWidth?: number;
  /** Seconds for one full flow cycle. Lower = faster. */
  durationMs?: number;
  style?: StyleProp<ViewStyle>;
}

/** How many straight segments approximate the curve. 64 reads as perfectly smooth. */
const SEGMENTS = 64;
/** Number of full sine periods drawn across the width (the reference is ~one). */
const PERIODS = 1;

/** The brand sweep: blue → indigo → violet → magenta → amber. Matches GradientWave. */
const STOPS = [
  { offset: '0%', color: '#1BA1E3' },
  { offset: '26%', color: '#5489D6' },
  { offset: '50%', color: '#9B72CB' },
  { offset: '74%', color: '#D96570' },
  { offset: '100%', color: '#F49C46' },
];

/**
 * A glowing, flowing multi-colour wave — the brand loader.
 *
 * An SVG sine path is rebuilt every frame on the UI thread (the phase flows
 * endlessly) and stroked three times — wide+faint, medium, then crisp — to fake
 * a soft neon glow with no platform blur filters. An envelope pins both tips to
 * the centre line so the wave tapers off cleanly at the ends, like the reference
 * image. Colours run blue → violet → amber to echo the app's gradient field.
 */
export function WaveLoader({
  width = 240,
  height = 132,
  strokeWidth = 5,
  durationMs = 2800,
  style,
}: Props) {
  const phase = useSharedValue(0);
  useEffect(() => {
    phase.value = withRepeat(
      withTiming(Math.PI * 2, { duration: durationMs, easing: Easing.linear }),
      -1,
      false,
    );
  }, [phase, durationMs]);

  const midY = height / 2;
  const amp = height * 0.24;

  // Build the path once per frame; each stroke layer reuses the same string.
  const d = useDerivedValue(() => {
    'worklet';
    const step = width / SEGMENTS;
    let path = '';
    for (let i = 0; i <= SEGMENTS; i++) {
      const tt = i / SEGMENTS;
      const env = Math.sin(tt * Math.PI); // 0 at the tips, 1 in the middle
      const y = midY - Math.sin(tt * Math.PI * 2 * PERIODS + phase.value) * amp * env;
      const x = i * step;
      path += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return path;
  }, [width, midY, amp]);

  const glowProps = useAnimatedProps(() => ({ d: d.value }));
  const haloProps = useAnimatedProps(() => ({ d: d.value }));
  const coreProps = useAnimatedProps(() => ({ d: d.value }));

  return (
    <View style={[{ width, height }, style]} pointerEvents="none">
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient
            id="waveStroke"
            x1="0"
            y1="0"
            x2={width}
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            {STOPS.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>

        {/* Outer glow */}
        <AnimatedPath
          animatedProps={glowProps}
          stroke="url(#waveStroke)"
          strokeWidth={strokeWidth * 3.4}
          strokeOpacity={0.14}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Mid halo */}
        <AnimatedPath
          animatedProps={haloProps}
          stroke="url(#waveStroke)"
          strokeWidth={strokeWidth * 1.9}
          strokeOpacity={0.32}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Crisp core */}
        <AnimatedPath
          animatedProps={coreProps}
          stroke="url(#waveStroke)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </View>
  );
}
