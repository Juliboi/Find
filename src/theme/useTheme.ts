import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type ThemeColors } from './colors';
import {
  spacing,
  radii,
  typeScale,
  lineHeights,
  fontWeights,
  fontFamily,
  motion,
  hitSlop,
} from './tokens';

export type ColorScheme = 'light' | 'dark';

export interface Theme {
  colors: ThemeColors;
  scheme: ColorScheme;
  /** True when the user is in dark mode. */
  isDark: boolean;
  spacing: typeof spacing;
  radii: typeof radii;
  type: typeof typeScale;
  lineHeights: typeof lineHeights;
  weights: typeof fontWeights;
  fonts: typeof fontFamily;
  motion: typeof motion;
  hitSlop: typeof hitSlop;
}

export function useTheme(): Theme {
  const scheme: ColorScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const isDark = scheme === 'dark';
  return {
    colors: isDark ? darkColors : lightColors,
    scheme,
    isDark,
    spacing,
    radii,
    type: typeScale,
    lineHeights,
    weights: fontWeights,
    fonts: fontFamily,
    motion,
    hitSlop,
  };
}
