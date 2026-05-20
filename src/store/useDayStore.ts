import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Plan } from '@/types/plan';
import { rescheduleDay, scheduleDay } from '@/lib/ai/scheduler';
import { todayISO } from '@/utils/time';
import { uid } from '@/utils/id';

interface DayState {
  date: string;
  /** Raw plan strings that the user is currently drafting before AI runs. */
  draft: string[];
  /** Scheduled plans (after AI has structured + ordered them). */
  plans: Plan[];
  summary: string;
  isScheduling: boolean;
  needsClarification: boolean;
  usedAi: boolean;

  addDraft: (text: string) => void;
  updateDraft: (index: number, text: string) => void;
  removeDraft: (index: number) => void;
  clearDraft: () => void;

  confirmDraft: (startTime?: string) => Promise<void>;
  reorderAndReschedule: () => Promise<void>;
  resolveClarification: (planId: string, answer: string) => Promise<void>;
  removePlan: (planId: string) => Promise<void>;
  resetDay: () => void;
}

export const useDayStore = create<DayState>()(
  persist(
    (set, get) => ({
      date: todayISO(),
      draft: [],
      plans: [],
      summary: '',
      isScheduling: false,
      needsClarification: false,
      usedAi: false,

      addDraft: (text) => {
        const t = text.trim();
        if (!t) return;
        set({ draft: [...get().draft, t] });
      },
      updateDraft: (index, text) => {
        const next = [...get().draft];
        next[index] = text;
        set({ draft: next });
      },
      removeDraft: (index) => {
        const next = get().draft.filter((_, i) => i !== index);
        set({ draft: next });
      },
      clearDraft: () => set({ draft: [] }),

      confirmDraft: async (startTime) => {
        const drafts = get().draft;
        if (drafts.length === 0) return;
        set({ isScheduling: true });
        try {
          const result = await scheduleDay(drafts, { startTime });
          set({
            plans: result.plans,
            summary: result.summary,
            needsClarification: result.needsClarification,
            usedAi: result.usedAi,
            draft: [],
            date: todayISO(),
          });
        } finally {
          set({ isScheduling: false });
        }
      },

      reorderAndReschedule: async () => {
        set({ isScheduling: true });
        try {
          const result = await rescheduleDay(get().plans);
          set({
            plans: result.plans,
            summary: result.summary,
            needsClarification: result.needsClarification,
          });
        } finally {
          set({ isScheduling: false });
        }
      },

      resolveClarification: async (planId, answer) => {
        const plans = get().plans.map((p) =>
          p.id === planId
            ? {
                ...p,
                location: answer || p.location,
                description: p.description ?? (answer || undefined),
                status: 'scheduled' as const,
                clarificationQuestion: undefined,
                clarificationSuggestions: undefined,
              }
            : p,
        );
        set({ plans });
        await get().reorderAndReschedule();
      },

      removePlan: async (planId) => {
        set({ plans: get().plans.filter((p) => p.id !== planId) });
        await get().reorderAndReschedule();
      },

      resetDay: () => {
        set({
          date: todayISO(),
          draft: [],
          plans: [],
          summary: '',
          needsClarification: false,
          usedAi: false,
        });
      },
    }),
    {
      name: 'dayflow.day-store.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        date: state.date,
        draft: state.draft,
        plans: state.plans,
        summary: state.summary,
        needsClarification: state.needsClarification,
        usedAi: state.usedAi,
      }),
    },
  ),
);

export function emptyPlan(): Plan {
  return {
    id: uid('plan'),
    title: '',
    rawText: '',
    subtasks: [],
    durationMinutes: 30,
    orderIndex: 0,
    status: 'draft',
  };
}
