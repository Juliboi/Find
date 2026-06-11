import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getCurrentCoordsIfPermitted, type Coords } from '@/lib/places';
import { reverseGeocodeCity } from '@/lib/geocoding';
import { getWeather, type TempUnit, type WeatherResult } from '@/lib/weather';
import { useHomeStore } from '@/store/useHomeStore';

type Status = 'idle' | 'loading' | 'ready' | 'unavailable';

interface WeatherState {
  /** Last fetched conditions + hourly forecast, or null if never loaded. */
  data: WeatherResult | null;
  /** Friendly locality label for the resolved coordinate, e.g. "Prague". */
  place: string | null;
  /** Epoch ms of the last successful fetch. */
  updatedAt: number | null;
  /** Display unit. Defaults to Celsius (the app is otherwise metric/24h). */
  unit: TempUnit;
  status: Status;

  setUnit: (unit: TempUnit) => void;
  /**
   * Refreshes weather if the cache is stale (or `force`). Resolves location
   * from an already-granted GPS fix, falling back to the saved home pin so the
   * widget never triggers a permission prompt on its own. No-ops while a
   * refresh is already in flight.
   */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
}

// Weather doesn't move fast; refetch at most every 20 minutes.
const TTL_MS = 20 * 60 * 1000;

// Module-level guard so overlapping calls (mount + focus) don't double-fetch.
let inflight: Promise<void> | null = null;

function resolveCoords(): Promise<Coords | null> {
  return getCurrentCoordsIfPermitted().then((gps) => {
    if (gps) return gps;
    const home = useHomeStore.getState().home;
    return home ? { latitude: home.latitude, longitude: home.longitude } : null;
  });
}

export const useWeatherStore = create<WeatherState>()(
  persist(
    (set, get) => ({
      data: null,
      place: null,
      updatedAt: null,
      unit: 'C',
      status: 'idle',

      setUnit: (unit) => set({ unit }),

      refresh: async (opts) => {
        if (inflight) return inflight;

        const { data, updatedAt } = get();
        const fresh =
          !opts?.force &&
          data != null &&
          updatedAt != null &&
          Date.now() - updatedAt < TTL_MS;
        if (fresh) return;

        // Only show a spinner on a true cold start; otherwise keep the stale
        // card visible while we refetch in the background.
        if (!data) set({ status: 'loading' });

        inflight = (async () => {
          const coords = await resolveCoords();
          if (!coords) {
            set((s) => ({ status: s.data ? 'ready' : 'unavailable' }));
            return;
          }
          const [result, city] = await Promise.all([
            getWeather(coords),
            reverseGeocodeCity(coords.latitude, coords.longitude).catch(
              () => null,
            ),
          ]);
          if (!result) {
            set((s) => ({ status: s.data ? 'ready' : 'unavailable' }));
            return;
          }
          set((s) => ({
            data: result,
            place: city ?? s.place ?? useHomeStore.getState().home?.label ?? null,
            updatedAt: Date.now(),
            status: 'ready',
          }));
        })()
          .catch(() => {
            set((s) => ({ status: s.data ? 'ready' : 'unavailable' }));
          })
          .finally(() => {
            inflight = null;
          });

        return inflight;
      },
    }),
    {
      name: 'dayflow.weather.v1',
      storage: createJSONStorage(() => AsyncStorage),
      // Persist the payload so the card paints instantly on launch, plus the
      // user's unit preference. Transient `status` is recomputed at runtime.
      partialize: (s) => ({
        data: s.data,
        place: s.place,
        updatedAt: s.updatedAt,
        unit: s.unit,
      }),
    },
  ),
);
