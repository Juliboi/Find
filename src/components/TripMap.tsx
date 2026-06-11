import React from 'react';
import {
  Platform,
  StyleSheet,
  Text as RNText,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/theme/useTheme';

/**
 * TripMap — the interactive map behind the itinerary drawer.
 *
 * `react-native-maps` is a NATIVE module: it renders in a development/EAS
 * build but throws ("RNMapsAirModule could not be found") in Expo Go on
 * SDK 54+. We therefore (a) require it defensively and (b) wrap the live map
 * in an error boundary, so the screen degrades to a clean placeholder
 * instead of crashing when the native module isn't present.
 */

// Defensive require: guards the case where the package isn't installed.
let Maps: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Maps = require('react-native-maps');
} catch {
  Maps = null;
}
const MapView: any = Maps?.default ?? null;
const Marker: any = Maps?.Marker ?? null;
const Polyline: any = Maps?.Polyline ?? null;
const PROVIDER_DEFAULT: any = Maps?.PROVIDER_DEFAULT;

export type TripStopKind = 'home' | 'stop' | 'waypoint';

export interface TripStop {
  id: string;
  /** 'home' = origin, 'stop' = numbered activity, 'waypoint' = transit station. */
  kind: TripStopKind;
  /** 1-based label shown in numbered activity pins. */
  label?: number;
  title: string;
  latitude: number;
  longitude: number;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

interface TripMapProps {
  stops: TripStop[];
  /** Decoded geometry of the full route, traced as the map line when present. */
  routeCoords?: LatLng[];
  activeId?: string | null;
  onSelectStop?: (id: string) => void;
  /** Where to center when there are no stops yet (e.g. the user's home). */
  fallbackCenter?: { latitude: number; longitude: number } | null;
  /** Pixels covered by the drawer at the bottom, so pins stay visible. */
  bottomInset?: number;
  /** Pixels reserved at the top (status bar + floating buttons). */
  topInset?: number;
}

const DEFAULT_REGION = {
  latitude: 50.0755,
  longitude: 14.4378, // Prague
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

function regionForStops(
  stops: TripStop[],
  fallbackCenter?: { latitude: number; longitude: number } | null,
) {
  if (stops.length === 0) {
    if (fallbackCenter) {
      return { ...fallbackCenter, latitudeDelta: 0.06, longitudeDelta: 0.06 };
    }
    return DEFAULT_REGION;
  }
  let minLat = stops[0].latitude;
  let maxLat = stops[0].latitude;
  let minLng = stops[0].longitude;
  let maxLng = stops[0].longitude;
  for (const s of stops) {
    minLat = Math.min(minLat, s.latitude);
    maxLat = Math.max(maxLat, s.latitude);
    minLng = Math.min(minLng, s.longitude);
    maxLng = Math.max(maxLng, s.longitude);
  }
  const latPad = Math.max((maxLat - minLat) * 0.4, 0.01);
  const lngPad = Math.max((maxLng - minLng) * 0.4, 0.01);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: maxLat - minLat + latPad * 2,
    longitudeDelta: maxLng - minLng + lngPad * 2,
  };
}

const toLatLng = (s: { latitude: number; longitude: number }): LatLng => ({
  latitude: s.latitude,
  longitude: s.longitude,
});

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const la1 = (a.latitude * Math.PI) / 180;
  const la2 = (b.latitude * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Builds a map region that frames `points` inside the VISIBLE band (the strip
 * above the drawer), with a deterministic, sensible zoom:
 *  - close/single points get a comfortable city zoom (not extreme),
 *  - the center is shifted south so the content sits in the strip, not behind
 *    the drawer.
 * This replaces fitToCoordinates+edgePadding, whose zoom was unreliable when
 * the bottom padding was most of the screen.
 */
function computeStripRegion(
  points: LatLng[],
  width: number,
  height: number,
  topInset: number,
  bottomInset: number,
) {
  let minLat = points[0].latitude;
  let maxLat = points[0].latitude;
  let minLng = points[0].longitude;
  let maxLng = points[0].longitude;
  for (const p of points) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLng = Math.min(minLng, p.longitude);
    maxLng = Math.max(maxLng, p.longitude);
  }
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;

  const visibleTop = topInset;
  const visibleBottom = height - bottomInset;
  const bandH = Math.max(visibleBottom - visibleTop, 100);
  const bandCenterY = (visibleTop + visibleBottom) / 2;
  const aspect = height / width; // >1 in portrait

  const PAD = 1.6;
  const MIN_SPAN = 0.006; // ~0.6 km — caps how far it zooms in
  const contentLat = Math.max((maxLat - minLat) * PAD, MIN_SPAN);
  const contentLng = Math.max((maxLng - minLng) * PAD, MIN_SPAN);

  // Vertical: content must fit the band (a fraction of the full map height).
  const latForBand = contentLat * (height / bandH);
  // Horizontal: content must fit the full width (respect aspect ratio).
  const latForWidth = contentLng * aspect;
  const latitudeDelta = Math.min(Math.max(latForBand, latForWidth), 1.2);
  const longitudeDelta = latitudeDelta / aspect;

  // Shift the region center south so the content lands in the visible band.
  const degPerPx = latitudeDelta / height;
  const latitude = cLat - degPerPx * (height / 2 - bandCenterY);
  return { latitude, longitude: cLng, latitudeDelta, longitudeDelta };
}

class MapErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Swallow — the fallback explains what's going on.
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function MapFallback({ stops }: { stops: TripStop[] }) {
  const t = useTheme();
  return (
    <View style={[styles.fallback, { backgroundColor: t.colors.surface1 }]}>
      <Ionicons name="map-outline" size={30} color={t.colors.textTertiary} />
      <RNText style={[styles.fallbackTitle, { color: t.colors.textSecondary }]}>
        {stops.length > 0 ? `${stops.length} stops mapped` : 'Map preview'}
      </RNText>
      <RNText style={[styles.fallbackBody, { color: t.colors.textTertiary }]}>
        The live map needs a development build — it can&apos;t render in Expo Go
        on this SDK. Run it in a dev build to see your route here.
      </RNText>
    </View>
  );
}

function StopMarker({
  stop,
  active,
  accent,
  surface,
  ring,
  onPress,
}: {
  stop: TripStop;
  active: boolean;
  accent: string;
  surface: string;
  ring: string;
  onPress?: () => void;
}) {
  // Custom marker views must stop tracking changes after paint or the map
  // re-rasterises every frame. Re-enable briefly whenever active flips.
  const [tracks, setTracks] = React.useState(true);
  React.useEffect(() => {
    setTracks(true);
    const id = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(id);
  }, [active]);

  let body: React.ReactNode;
  if (stop.kind === 'waypoint') {
    body = (
      <View
        style={[
          styles.waypoint,
          { backgroundColor: surface, borderColor: accent },
          active && styles.pinActive,
        ]}
      />
    );
  } else if (stop.kind === 'home') {
    body = (
      <View
        style={[
          styles.pin,
          { backgroundColor: surface, borderColor: accent },
          active && styles.pinActive,
        ]}
      >
        <RNText style={styles.homeEmoji}>🏠</RNText>
      </View>
    );
  } else {
    body = (
      <View
        style={[
          styles.pin,
          { backgroundColor: accent, borderColor: ring },
          active && styles.pinActive,
        ]}
      >
        <RNText style={[styles.pinText, { color: '#FFFFFF' }]}>{stop.label}</RNText>
      </View>
    );
  }

  return (
    <Marker
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      onPress={
        onPress
          ? () => {
              Haptics.selectionAsync().catch(() => undefined);
              onPress();
            }
          : undefined
      }
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracks}
      zIndex={stop.kind === 'waypoint' ? 1 : 2}
    >
      {body}
    </Marker>
  );
}

function TripMapInner({
  stops,
  routeCoords,
  activeId,
  onSelectStop,
  fallbackCenter,
  bottomInset = 0,
  topInset = 0,
}: TripMapProps) {
  const t = useTheme();
  const mapRef = React.useRef<any>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();
  const initialRegion = React.useMemo(
    () => regionForStops(stops, fallbackCenter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Animate to a region that frames `points` inside the visible strip above
  // the drawer, with a deterministic zoom.
  const focus = React.useCallback(
    (points: LatLng[]) => {
      const map = mapRef.current;
      if (!map?.animateToRegion || points.length === 0) return;
      map.animateToRegion(
        computeStripRegion(points, screenW, screenH, topInset, bottomInset),
        600,
      );
    },
    [screenW, screenH, topInset, bottomInset],
  );

  // Overview: frame the whole route whenever the set of stops changes.
  React.useEffect(() => {
    if (stops.length === 0) return;
    focus(stops.map(toLatLng));
  }, [stops, focus]);

  // Frame the active stop as the user scrolls — adaptively: if the previous
  // stop is close, frame BOTH (so you see the short hop and it stays zoomed
  // in); if it's far (e.g. the intercity train), frame just the active stop
  // at a city zoom rather than zooming out to show both cities.
  React.useEffect(() => {
    if (!activeId) return;
    const anchors = stops.filter((s) => s.kind !== 'waypoint');
    const idx = anchors.findIndex((a) => a.id === activeId);
    if (idx < 0) return;
    const active = toLatLng(anchors[idx]);
    const prev = idx > 0 ? toLatLng(anchors[idx - 1]) : null;
    focus(prev && haversineKm(prev, active) < 3 ? [prev, active] : [active]);
  }, [activeId, stops, focus]);

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      initialRegion={initialRegion}
      showsUserLocation={false}
      showsMyLocationButton={false}
      showsCompass={false}
      pitchEnabled={false}
      toolbarEnabled={false}
      userInterfaceStyle={t.scheme === 'dark' ? 'dark' : 'light'}
    >
      {Polyline && routeCoords && routeCoords.length > 1 ? (
        <Polyline coordinates={routeCoords} strokeWidth={4} strokeColor={t.colors.accent} />
      ) : Polyline && stops.length > 1 ? (
        <Polyline
          coordinates={stops.map((s) => ({
            latitude: s.latitude,
            longitude: s.longitude,
          }))}
          strokeWidth={3}
          strokeColor={t.colors.accent}
          lineDashPattern={[1, 6]}
        />
      ) : null}
      {Marker
        ? stops.map((s) => (
            <StopMarker
              key={s.id}
              stop={s}
              active={s.id === activeId}
              accent={t.colors.accent}
              surface={t.colors.surface1}
              ring={t.colors.background}
              onPress={() => onSelectStop?.(s.id)}
            />
          ))
        : null}
    </MapView>
  );
}

export function TripMap(props: TripMapProps) {
  if (!MapView) return <MapFallback stops={props.stops} />;
  return (
    <MapErrorBoundary fallback={<MapFallback stops={props.stops} />}>
      <TripMapInner {...props} />
    </MapErrorBoundary>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 8,
  },
  fallbackTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
  },
  fallbackBody: {
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'center',
    lineHeight: 18,
  },
  pin: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.25,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      },
      android: { elevation: 4 },
    }),
  },
  pinActive: {
    transform: [{ scale: 1.32 }],
  },
  pinText: {
    fontSize: 13,
    fontWeight: '800',
  },
  homeEmoji: {
    fontSize: 13,
  },
  waypoint: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2.5,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowRadius: 2,
        shadowOffset: { width: 0, height: 1 },
      },
      android: { elevation: 3 },
    }),
  },
});
