import { FadeInDown, FadeOutUp } from 'react-native-reanimated';

/**
 * Per-section staggered transitions shared across the errand drawer's steps
 * (header, the confirm form, and — later — the place-discovery step). Each block
 * rises in from just below while fading, one after another, so the drawer's
 * content flows in instead of appearing as one slab. The gorhom modal remounts
 * its children on every present, so this replays each time it opens.
 */
export const ENTER = (i: number) => FadeInDown.duration(360).delay(110 + i * 60);
export const EXIT = (i: number) => FadeOutUp.duration(200).delay(i * 30);
