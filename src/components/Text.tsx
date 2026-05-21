import React from 'react';
import {
  Text as RNText,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';
import { useTheme } from '@/theme/useTheme';

type Variant =
  | 'display'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'subhead'
  | 'body'
  | 'bodySm'
  | 'caption'
  | 'micro';

type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'inverse' | 'danger';

type Weight = 'regular' | 'medium' | 'semibold' | 'bold' | 'heavy';

interface Props extends TextProps {
  variant?: Variant;
  tone?: Tone;
  weight?: Weight;
  uppercase?: boolean;
  /** Tighter letter spacing, e.g. for big titles. */
  tight?: boolean;
  style?: StyleProp<TextStyle>;
}

/**
 * Typography primitive. Always use this instead of raw `Text` so that
 * type scale, weight, and color stay consistent across the app and react
 * to dark/light mode automatically.
 */
export function Text({
  variant = 'body',
  tone = 'primary',
  weight,
  uppercase,
  tight,
  style,
  children,
  ...rest
}: Props) {
  const t = useTheme();

  const variantStyle: TextStyle = {
    fontSize: t.type[variant],
    lineHeight: t.lineHeights[variant],
  };

  const defaultWeight: Weight = (() => {
    switch (variant) {
      case 'display':
      case 'title1':
      case 'title2':
        return 'bold';
      case 'title3':
        return 'semibold';
      case 'subhead':
        return 'semibold';
      case 'micro':
        return 'semibold';
      default:
        return 'regular';
    }
  })();

  const w = weight ?? defaultWeight;

  const toneColor = (() => {
    switch (tone) {
      case 'secondary':
        return t.colors.textSecondary;
      case 'tertiary':
        return t.colors.textTertiary;
      case 'accent':
        return t.colors.accentText;
      case 'inverse':
        return t.colors.textInverse;
      case 'danger':
        return t.colors.danger;
      default:
        return t.colors.textPrimary;
    }
  })();

  const transformStyle: TextStyle = uppercase
    ? { textTransform: 'uppercase', letterSpacing: 0.6 }
    : {};

  const tightStyle: TextStyle = tight ? { letterSpacing: -0.4 } : {};

  return (
    <RNText
      {...rest}
      style={[
        variantStyle,
        transformStyle,
        tightStyle,
        { color: toneColor, fontWeight: t.weights[w] as TextStyle['fontWeight'] },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}
