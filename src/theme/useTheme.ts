import { useColorScheme } from 'react-native';
import { darkColors, lightColors, ThemeColors } from './colors';

export function useTheme(): { colors: ThemeColors; scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return {
    colors: scheme === 'dark' ? darkColors : lightColors,
    scheme,
  };
}
