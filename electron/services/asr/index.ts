/**
 * index.ts (asr)
 *
 * The one place that knows which concrete ASR adapters exist. geminiLive.ts (once
 * wired) picks a route by id here, so swapping the interview's ASR provider is a
 * one-argument change, not a code edit spread across the service. IDs are stable
 * strings shared with the bench harness (scripts/asr-bench.mjs) so a bench result
 * names the exact adapter it measured.
 */
import type { ASRAdapter } from './asrAdapter'
import { GeminiNativeAudioAsrAdapter } from './geminiNativeAudioAdapter'
import { GeminiHalfCascadeAsrAdapter } from './geminiHalfCascadeAdapter'
import { FasterWhisperAsrAdapter } from './fasterWhisperAdapter'

export type ASRAdapterId = 'gemini-native-audio' | 'gemini-half-cascade' | 'faster-whisper-local'

/** The id GhostKit uses today. Keep this pointing at the proven route until the bench promotes another. */
export const DEFAULT_ASR_ADAPTER_ID: ASRAdapterId = 'gemini-native-audio'

/** Constructs a fresh adapter instance for `id`. One instance owns at most one session -- callers get a new one per interview. */
export function createASRAdapter(id: ASRAdapterId = DEFAULT_ASR_ADAPTER_ID): ASRAdapter {
  switch (id) {
    case 'gemini-half-cascade':
      return new GeminiHalfCascadeAsrAdapter()
    case 'faster-whisper-local':
      // Optional offline route -- fails typed at start() if the Python sidecar
      // can't launch, so the caller can fall back to a cloud adapter.
      return new FasterWhisperAsrAdapter()
    case 'gemini-native-audio':
    default:
      return new GeminiNativeAudioAsrAdapter()
  }
}

export type { ASRAdapter, ASREvent, ASREventSink, ASRSessionConfig } from './asrAdapter'
