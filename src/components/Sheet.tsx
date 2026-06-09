import React, { useCallback, useEffect, useMemo, useRef } from 'react';
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
  // Tracks whether *we* have an outstanding `present()`. Gating present/dismiss
  // on real transitions (rather than firing on every render or on mount) keeps
  // gorhom's modal queue clean — redundant `dismiss()` calls during the close
  // animation are what make a later `present()` silently get dropped, which
  // showed up as the sheet "only sometimes" opening.
  const presented = useRef(false);

  useEffect(() => {
    if (open && !presented.current) {
      presented.current = true;
      ref.current?.present();
    } else if (!open && presented.current) {
      presented.current = false;
      ref.current?.dismiss();
    }
  }, [open]);

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
          { backgroundColor: t.colors.surface1, borderColor: t.colors.separator },
        ]}
      />
    ),
    [t.colors.surface1, t.colors.separator],
  );

  return (
    <BottomSheetModal
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
