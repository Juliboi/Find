/**
 * Color palette modelled after Apple's HIG semantic colors. Each token has
 * a meaning ("textPrimary", "fill1", "separator") rather than a literal
 * description, which is what makes light/dark switching painless: the
 * same key resolves to a different concrete value per mode.
 *
 * Tiers, top-down:
 *   - canvas / background: the screen background (deepest)
 *   - surface1 / surface2 / surface3: ascending elevations for cards on top
 *   - fill1..fill3: subtle tinted fills (used inside surfaces)
 *   - glass*: translucent overlays designed to sit on top of a BlurView
 *   - accent / accentSoft: brand action color + soft variant for backgrounds
 *   - status colors (success, warning, danger, info)
 *
 * Why these specific blues / grays? They mirror iOS 17 system colors,
 * which is what "looks native on Apple" without shipping a custom font
 * or icon set.
 */

export interface ThemeColors {
  // Canvas
  background: string;

  // Solid surfaces (cards, sheets)
  surface1: string;
  surface2: string;
  surface3: string;

  // Inline fills (e.g. inside a card to indicate selection/section)
  fill1: string;
  fill2: string;
  fill3: string;

  // Translucent overlays for glass (apply *over* a BlurView)
  glassTint: string;
  glassBorder: string;
  glassHighlight: string;

  // Hairlines / separators
  separator: string;
  border: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  textOnAccent: string;

  // Accent (brand action)
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentText: string;

  // Status
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;

  // Categorical highlights (used by Plan time tags etc.)
  highlightYellow: string;
  highlightPurple: string;
  highlightRed: string;
  highlightBlue: string;

  // Shadows
  shadow: string;
}

export const lightColors: ThemeColors = {
  background: '#F5F5F7',

  surface1: '#FFFFFF',
  surface2: '#FBFBFD',
  surface3: '#F2F2F7',

  fill1: 'rgba(120, 120, 128, 0.10)',
  fill2: 'rgba(120, 120, 128, 0.16)',
  fill3: 'rgba(120, 120, 128, 0.24)',

  glassTint: 'rgba(255, 255, 255, 0.62)',
  glassBorder: 'rgba(0, 0, 0, 0.06)',
  glassHighlight: 'rgba(255, 255, 255, 0.80)',

  separator: 'rgba(60, 60, 67, 0.12)',
  border: 'rgba(60, 60, 67, 0.18)',

  textPrimary: '#0A0A0F',
  textSecondary: 'rgba(60, 60, 67, 0.70)',
  textTertiary: 'rgba(60, 60, 67, 0.45)',
  textInverse: '#FFFFFF',
  textOnAccent: '#FFFFFF',

  accent: '#0A84FF',
  accentHover: '#0066CC',
  accentSoft: 'rgba(10, 132, 255, 0.12)',
  accentText: '#0A84FF',

  success: '#34C759',
  successSoft: 'rgba(52, 199, 89, 0.14)',
  warning: '#FF9500',
  warningSoft: 'rgba(255, 149, 0, 0.16)',
  danger: '#FF3B30',
  dangerSoft: 'rgba(255, 59, 48, 0.12)',
  info: '#5AC8FA',
  infoSoft: 'rgba(90, 200, 250, 0.14)',

  highlightYellow: '#FFD60A',
  highlightPurple: '#AF52DE',
  highlightRed: '#FF3B30',
  highlightBlue: '#0A84FF',

  shadow: 'rgba(0, 0, 0, 0.12)',
};

export const darkColors: ThemeColors = {
  background: '#0B0B0F',

  surface1: '#16161B',
  surface2: '#1C1C22',
  surface3: '#22222A',

  fill1: 'rgba(120, 120, 128, 0.22)',
  fill2: 'rgba(120, 120, 128, 0.30)',
  fill3: 'rgba(120, 120, 128, 0.40)',

  glassTint: 'rgba(20, 20, 24, 0.55)',
  glassBorder: 'rgba(255, 255, 255, 0.08)',
  glassHighlight: 'rgba(255, 255, 255, 0.06)',

  separator: 'rgba(255, 255, 255, 0.08)',
  border: 'rgba(255, 255, 255, 0.12)',

  textPrimary: '#F2F2F7',
  textSecondary: 'rgba(235, 235, 245, 0.62)',
  textTertiary: 'rgba(235, 235, 245, 0.38)',
  textInverse: '#0A0A0F',
  textOnAccent: '#FFFFFF',

  accent: '#0A84FF',
  accentHover: '#3D9CFF',
  accentSoft: 'rgba(10, 132, 255, 0.20)',
  accentText: '#5AC8FA',

  success: '#30D158',
  successSoft: 'rgba(48, 209, 88, 0.18)',
  warning: '#FF9F0A',
  warningSoft: 'rgba(255, 159, 10, 0.20)',
  danger: '#FF453A',
  dangerSoft: 'rgba(255, 69, 58, 0.18)',
  info: '#64D2FF',
  infoSoft: 'rgba(100, 210, 255, 0.16)',

  highlightYellow: '#FFD60A',
  highlightPurple: '#BF5AF2',
  highlightRed: '#FF453A',
  highlightBlue: '#0A84FF',

  shadow: 'rgba(0, 0, 0, 0.5)',
};
