export type PlanStatus = 'draft' | 'needs_clarification' | 'scheduled' | 'done';

export interface SubTask {
  id: string;
  title: string;
  durationMinutes: number;
}

export interface Plan {
  id: string;
  title: string;
  /** Original raw text the user typed. */
  rawText: string;
  /** Free-form description (what / where / why). */
  description?: string;
  /** Human-readable location label, set after AI clarification. */
  location?: string;
  /** Logical sub-steps inferred by AI (e.g. prep, cook, cleanup). */
  subtasks: SubTask[];
  /** Estimated minutes for the whole plan including subtasks. */
  durationMinutes: number;
  /** ISO time-of-day "HH:MM" once scheduled. */
  startTime?: string;
  /** AI-asked question we still need an answer for. */
  clarificationQuestion?: string;
  /** Pre-baked suggestions for the user to pick from when clarifying. */
  clarificationSuggestions?: string[];
  /**
   * Last clarification the user resolved on this plan. Sent back to the AI on
   * reschedule so it won't ask the same thing again.
   */
  resolvedClarification?: { question: string; answer: string };
  status: PlanStatus;
  orderIndex: number;
}

export interface DaySchedule {
  id: string;
  date: string; // YYYY-MM-DD
  summary?: string;
  plans: Plan[];
  updatedAt: string;
}
