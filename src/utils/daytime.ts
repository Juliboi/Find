import type { GradientPalette } from '@/components/GradientWave';

/**
 * The five parts of the day that drive the home screen's living gradient.
 * The colour field shifts from a warm sunrise through a bright midday and a
 * golden afternoon into a vivid sunset, then settles into a deep indigo night
 * — always melting down into the dark page background.
 */
export type DayPart = 'morning' | 'noon' | 'afternoon' | 'sunset' | 'night';

/** Bucket the given time (defaults to now) into a part of the day. */
export function getDayPart(date: Date = new Date()): DayPart {
  const h = date.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 15) return 'noon';
  if (h >= 15 && h < 18) return 'afternoon';
  if (h >= 18 && h < 21) return 'sunset';
  return 'night';
}

/** A warm, human greeting for the part of the day. */
export function getGreeting(part: DayPart): string {
  switch (part) {
    case 'morning':
      return 'Good morning';
    case 'noon':
    case 'afternoon':
      return 'Good afternoon';
    case 'sunset':
    case 'night':
      return 'Good evening';
  }
}

/** A short uppercase label naming the part of the day. */
export function getDayPartLabel(part: DayPart): string {
  switch (part) {
    case 'morning':
      return 'Morning';
    case 'noon':
      return 'Midday';
    case 'afternoon':
      return 'Afternoon';
    case 'sunset':
      return 'Sunset';
    case 'night':
      return 'Night';
  }
}

/**
 * Colour palettes for each part of the day. Each is tuned to read against a
 * dark background and to feel like the sky at that hour: peachy dawn, clear
 * blue midday, golden afternoon, fiery sunset, deep indigo night.
 */
export const DAYTIME_PALETTES: Record<DayPart, GradientPalette> = {
  morning: {
    sweep: ['#FFC9A3', '#FF9E80', '#F77FA1', '#B98DD6'],
    blobs: ['#FFB07C', '#F77FA1', '#FFD9A0'],
  },
  noon: {
    sweep: ['#74C7F5', '#4FA3E8', '#5E86DE', '#93B7F0'],
    blobs: ['#5BB0F0', '#86D2F5', '#9FB8F0'],
  },
  afternoon: {
    sweep: ['#5FBDEB', '#7FA8DC', '#E8B36E', '#F3CB5C'],
    blobs: ['#6FB6E8', '#F2C266', '#E89B6E'],
  },
  sunset: {
    sweep: ['#FF9E64', '#FF6B6B', '#D14D8B', '#7B5EA7'],
    blobs: ['#FF7E5F', '#FF5E84', '#8E5AA8'],
  },
  night: {
    sweep: ['#4458C9', '#5A47A8', '#7A4FB0', '#2A2E63'],
    blobs: ['#4F63D2', '#7A4FB0', '#314AA0'],
  },
};
