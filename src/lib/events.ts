/**
 * Thin re-export so existing imports keep working. The implementation lives in
 * `events/parse.ts` (record coercion), `events/compaction.ts` (compaction
 * policy), `events/reduce.ts` (the reducers), and `events/ids.ts` (transcript
 * identity).
 */
export {
  applyPrimeEvent,
  createQueuedMessageEvent,
  createSteerAcceptedEvent,
  createSteerPickupEvent,
  createSteerRetractEvent,
  createPrimeEventBuffer,
  replayPrimeEvents,
  type PrimeEventBuffer,
  type PrimeEventReplayStats,
} from './events/reduce'
export { resetTranscriptIdsForTests } from './events/ids'
