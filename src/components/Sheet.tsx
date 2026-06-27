import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  type BottomSheetBackdropProps,
  type BottomSheetBackgroundProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/useTheme';

interface Props {
  /** Whether the sheet is presented. Mirrors the old `!!item` prop pattern. */
  open: boolean;
  /** Fired when the sheet dismisses — by drag-down, backdrop tap, or `open=false`. */
  onClose: () => void;
  /**
   * Fixed resting height as a fraction of the screen (e.g. `0.82`). When set,
   * content auto-sizing is disabled and the sheet rests at this height — use it
   * for sheets that own a scroll view. Omit it to let the sheet hug its content.
   */
  heightFraction?: number;
  /**
   * Allow dragging the sheet *body* to dismiss. Defaults to `true`. Set `false`
   * for sheets whose content owns the vertical gesture (e.g. a scroll wheel) so
   * dragging the content doesn't fight the sheet — the handle still dismisses.
   */
  enableContentPanningGesture?: boolean;
  children?: React.ReactNode;
}

/**
 * Themed wrapper around `@gorhom/bottom-sheet`'s `BottomSheetModal`. Gives every
 * action sheet a real, draggable native surface — follows your finger, snaps to
 * its content height, and dismisses on drag-down or backdrop tap — while keeping
 * the simple declarative `open` / `onClose` API the old overlay sheets used.
 *
 * Children supply their own content container: `BottomSheetView` for content-
 * sized sheets, or a flex `View` + `BottomSheetScrollView` when `heightFraction`
 * is set.
 */
export function Sheet({
  open,
  onClose,
  heightFraction,
  enableContentPanningGesture = true,
  children,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const ref = useRef<BottomSheetModal>(null);

  // @gorhom/bottom-sheet 5.2.11+ has a regression (issue #2669) where, once a
  // BottomSheetModal has been dismissed, its internal status can latch and EVERY
  // later `present()` silently no-ops — the sheet "only opens once". It bit the
  // fixed-height action sheets here. Reusing one modal instance is what's fragile,
  // so instead we mount a FRESH instance each time the sheet opens: a brand-new
  // modal always has a clean status, so `present()` is reliable. `instanceId`
  // bumps on every false→true `open` transition and keys the modal; on mount it
  // is 0 and we never `dismiss()` an un-presented modal (the trigger for #2669).
  const [instanceId, setInstanceId] = useState(0);
  const prevOpen = useRef(false);
  const presented = useRef(false);

  useEffect(() => {
    if (open && !prevOpen.current) {
      // Opening: spin up a fresh instance; the present() fires in the effect
      // below, once that instance has mounted and `ref` points at it.
      presented.current = false;
      setInstanceId((n) => n + 1);
    } else if (!open && prevOpen.current && presented.current) {
      // Closing from a presented state: animate the live instance shut.
      presented.current = false;
      ref.current?.dismiss();
    }
    prevOpen.current = open;
  }, [open]);

  // Present the freshly-mounted instance. Runs after the remount commit, so
  // `ref` is the new modal. Guarded by `open` so a close that landed before this
  // ran can't pop the sheet back up.
  useEffect(() => {
    if (instanceId === 0 || !open || presented.current) return;
    presented.current = true;
    ref.current?.present();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  // Fired when the sheet closes itself (drag-down / backdrop tap). Clear our
  // flag first so the `open -> false` re-render doesn't call `dismiss()` again
  // mid-animation.
  const handleDismiss = useCallback(() => {
    presented.current = false;
    onClose();
  }, [onClose]);

  const snapPoints = useMemo(
    () => (heightFraction ? [`${Math.round(heightFraction * 100)}%`] : undefined),
    [heightFraction],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={0.4}
      />
    ),
    [],
  );

  const renderBackground = useCallback(
    ({ style, pointerEvents }: BottomSheetBackgroundProps) => (
      <View
        pointerEvents={pointerEvents}
        style={[
          style,
          styles.background,
          { backgroundColor: t.colors.background, borderColor: t.colors.separator },
        ]}
      />
    ),
    [t.colors.background, t.colors.separator],
  );

  return (
    <BottomSheetModal
      key={instanceId}
      ref={ref}
      index={0}
      onDismiss={handleDismiss}
      enablePanDownToClose
      enableDynamicSizing={!heightFraction}
      enableContentPanningGesture={enableContentPanningGesture}
      snapPoints={snapPoints}
      topInset={insets.top}
      backdropComponent={renderBackdrop}
      backgroundComponent={renderBackground}
      handleIndicatorStyle={[styles.handleIndicator, { backgroundColor: t.colors.separator }]}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      {children}
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  background: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handleIndicator: {
    width: 38,
    height: 5,
    borderRadius: 3,
  },
});
