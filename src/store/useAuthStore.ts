import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { useHomeStore } from '@/store/useHomeStore';
import { useProfileStore } from '@/store/useProfileStore';
import { usePlanSetupStore } from '@/store/usePlanSetupStore';
import {
  normalizeTime,
  type OnboardingInput,
  type ProfileRow,
} from '@/types/profile';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  profile: ProfileRow | null;
  /** True once we've attempted to load the profile for the current user. */
  profileLoaded: boolean;
  /** Derived: signed in but hasn't finished onboarding yet. */
  needsOnboarding: boolean;
  /** Whether native Sign in with Apple is usable on this device. */
  appleAuthAvailable: boolean;
  initialized: boolean;

  init: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /** Resolves with whether email confirmation is required before sign-in. */
  signUpWithEmail: (
    email: string,
    password: string,
  ) => Promise<{ needsConfirmation: boolean }>;
  fetchProfile: () => Promise<void>;
  saveOnboarding: (input: OnboardingInput) => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Push a freshly-loaded/saved profile row into the local stores the rest of the
 * app reads from, so onboarding answers immediately shape planning (home
 * anchor, day-start) without waiting on another network read.
 */
function applyProfileToStores(row: ProfileRow) {
  const wake = normalizeTime(row.wake_time);
  const bed = normalizeTime(row.bed_time);
  useProfileStore.getState().hydrate({
    fullName: row.full_name,
    wakeTime: wake,
    bedTime: bed,
    hasCar: row.has_car,
    onboardingComplete: row.onboarding_completed,
  });
  if (row.home_label && row.home_latitude != null && row.home_longitude != null) {
    useHomeStore.getState().setHome({
      label: row.home_label,
      latitude: row.home_latitude,
      longitude: row.home_longitude,
    });
  }
  // Wake time seeds the planner's default day-start, so the answer actually
  // does something instead of just sitting in a column.
  if (wake) usePlanSetupStore.getState().setDayStartTime(wake);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  session: null,
  user: null,
  profile: null,
  profileLoaded: false,
  needsOnboarding: false,
  appleAuthAvailable: false,
  initialized: false,

  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync()
        .then((ok) => set({ appleAuthAvailable: ok }))
        .catch(() => set({ appleAuthAvailable: false }));
    }

    // No backend configured → run fully local and skip the auth/onboarding gate
    // so the app stays usable without Supabase env vars.
    if (!supabase) {
      set({ status: 'signedIn', profileLoaded: true, needsOnboarding: false });
      return;
    }

    const { data } = await supabase.auth.getSession();
    if (data.session) {
      set({
        session: data.session,
        user: data.session.user,
        status: 'signedIn',
      });
      await get().fetchProfile();
    } else {
      set({ status: 'signedOut', profileLoaded: true });
    }

    // React to later auth changes (sign in/out, token refresh). Awaiting
    // Supabase calls *inside* this callback can deadlock the auth lock, so we
    // defer the profile fetch to a fresh task.
    supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        useProfileStore.getState().reset();
        useHomeStore.getState().clearHome();
        set({
          session: null,
          user: null,
          profile: null,
          profileLoaded: true,
          needsOnboarding: false,
          status: 'signedOut',
        });
        return;
      }
      const sameUser = get().user?.id === session.user.id;
      set({
        session,
        user: session.user,
        status: 'signedIn',
        // Hold the gate on the splash until a new user's profile loads rather
        // than flashing the home screen before bouncing to onboarding.
        profileLoaded: sameUser ? get().profileLoaded : false,
      });
      setTimeout(() => {
        void get().fetchProfile();
      }, 0);
    });
  },

  fetchProfile: async () => {
    const user = get().user;
    if (!supabase || !user) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    if (error) {
      // Most likely the migration hasn't been applied yet. Let the user proceed
      // into onboarding; the upsert there will surface the real error if the
      // table is genuinely missing.
      console.warn('[auth] could not load profile:', error.message);
      set({ profile: null, profileLoaded: true, needsOnboarding: true });
      return;
    }
    if (data) {
      const row = data as ProfileRow;
      applyProfileToStores(row);
      set({
        profile: row,
        profileLoaded: true,
        needsOnboarding: !row.onboarding_completed,
      });
    } else {
      set({ profile: null, profileLoaded: true, needsOnboarding: true });
    }
  },

  signInWithApple: async () => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    const identityToken = credential.identityToken;
    if (!identityToken) {
      throw new Error('No identity token returned from Apple.');
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: identityToken,
    });
    if (error) throw error;

    // Apple only returns the user's name on the FIRST authorization, so persist
    // it into user_metadata while we have it.
    const fullName = [
      credential.fullName?.givenName,
      credential.fullName?.familyName,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (fullName) {
      await supabase.auth
        .updateUser({ data: { full_name: fullName } })
        .catch(() => undefined);
    }
  },

  signInWithEmail: async (email, password) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  signUpWithEmail: async (email, password) => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    // When "Confirm email" is enabled in the Supabase dashboard, sign-up
    // succeeds but no session is issued until the user clicks the email link.
    return { needsConfirmation: !data.session };
  },

  saveOnboarding: async (input) => {
    const user = get().user;
    if (!supabase || !user) throw new Error('You need to be signed in.');
    const metaName =
      typeof user.user_metadata?.full_name === 'string'
        ? (user.user_metadata.full_name as string)
        : null;
    const row = {
      id: user.id,
      full_name: input.fullName ?? metaName ?? get().profile?.full_name ?? null,
      email: user.email ?? null,
      home_label: input.homeLabel,
      home_latitude: input.homeLatitude,
      home_longitude: input.homeLongitude,
      wake_time: input.wakeTime,
      bed_time: input.bedTime,
      has_car: input.hasCar,
      onboarding_completed: true,
    };
    const { data, error } = await supabase
      .from('profiles')
      .upsert(row, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;
    const saved = data as ProfileRow;
    applyProfileToStores(saved);
    set({ profile: saved, profileLoaded: true, needsOnboarding: false });
  },

  signOut: async () => {
    if (supabase) await supabase.auth.signOut().catch(() => undefined);
    useProfileStore.getState().reset();
    useHomeStore.getState().clearHome();
    set({
      session: null,
      user: null,
      profile: null,
      profileLoaded: true,
      needsOnboarding: false,
      status: 'signedOut',
    });
  },
}));
