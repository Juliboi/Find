/**
 * Global design tokens for the app.
 *
 * The values are intentionally close to Apple's HIG / iOS 17 conventions so
 * the UI feels native on iOS while still being legible on Android. Everything
 * here is **not** dependent on light/dark mode — for color tokens see
 * `./colors.ts`.
 *
 * Usage:
 *   const { spacing, radii, type } = useTheme();
 *   <View style={{ padding: spacing.lg, borderRadius: radii.xl }}>
 */

import { Platform } from 'react-native';

export const spacing = {
  /** 2 — hairlines, icon paddings */
  xxs: 2,
  /** 4 — tight inline gaps */
  xs: 4,
  /** 8 — between chips, default row gap */
  sm: 8,
  /** 12 — card inner padding (small) */
  md: 12,
  /** 16 — card inner padding (default), screen edges */
  lg: 16,
  /** 20 — section spacing */
  xl: 20,
  /** 24 — large section spacing */
  xxl: 24,
  /** 32 — block separation */
  xxxl: 32,
  /** 48 — page-level rhythm */
  huge: 48,
} as const;

export const radii = {
  /** 4 — chips / pills inner radius */
  xs: 4,
  /** 8 — inputs (small) */
  sm: 8,
  /** 12 — inputs, small cards */
  md: 12,
  /** 18 — primary cards (default) */
  lg: 18,
  /** 24 — large container cards, bottom sheets */
  xl: 24,
  /** 28 — XL containers, floating tab bar */
  xxl: 28,
  /** 999 — pills, FAB, icon buttons */
  pill: 999,
} as const;

export const typeScale = {
  /** 11 — micro labels, badges */
  micro: 11,
  /** 13 — captions, footnotes */
  caption: 13,
  /** 15 — secondary body */
  bodySm: 15,
  /** 17 — primary body (iOS default) */
  body: 17,
  /** 20 — emphasized body / subhead */
  subhead: 20,
  /** 22 — section title */
  title3: 22,
  /** 28 — page section title */
  title2: 28,
  /** 34 — large title (top of screen) */
  title1: 34,
  /** 44 — display, hero */
  display: 44,
} as const;

export const lineHeights = {
  micro: 14,
  caption: 18,
  bodySm: 20,
  body: 22,
  subhead: 26,
  title3: 28,
  title2: 34,
  title1: 40,
  display: 52,
} as const;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const;

/**
 * The app uses the platform's default UI font (San Francisco on iOS,
 * Roboto on Android, system on web). That's *the* "well-known clean
 * library" for this kind of UI — no custom font shipping required, and it
 * automatically matches the OS look. If a brand font is ever desired,
 * swap `system` with the loaded family name here.
 */
export const fontFamily = {
  system: Platform.select({
    ios: undefined, // iOS uses San Francisco by default
    android: undefined, // Roboto by default
    default: undefined,
  }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const;

export const motion = {
  /** Snappy taps */
  fast: 120,
  /** Default page / sheet transitions */
  base: 220,
  /** Slow, hero animations */
  slow: 380,
} as const;

export const hitSlop = { top: 10, right: 10, bottom: 10, left: 10 } as const;

export type Spacing = typeof spacing;
export type Radii = typeof radii;
export type TypeScale = typeof typeScale;
export type LineHeights = typeof lineHeights;
export type FontWeights = typeof fontWeights;
export type Motion = typeof motion;
