import type { HarnessId } from '@/types/api'

/** Product name shown in window chrome and the brand area. */
export const HARNESS_PRODUCT_NAMES: Record<HarnessId, string> = { omp: 'OMP Desktop' }

/** The agent each harness runs, used in settings and error copy. */
export const HARNESS_AGENT_NAMES: Record<HarnessId, string> = { omp: 'OMP' }

/** Short conversational name ("OMP is working"). */
export const HARNESS_SHORT_NAMES: Record<HarnessId, string> = { omp: 'OMP' }
