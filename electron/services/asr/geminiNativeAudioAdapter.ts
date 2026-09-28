/**
 * geminiNativeAudioAdapter.ts
 *
 * The A/B BASELINE adapter: the ASR route GhostKit runs today --
 * `gemini-2.5-flash-native-audio-latest` with AUDIO responses (the only
 * modality this native-audio model accepts; TEXT-only closes the socket 1007
 * before setupComplete -- confirmed in geminiLive.ts). Its whole behavior is
 * the shared LiveAdapterBase; it contributes only the model id, the forced
 * AUDIO modality, and the same aggressive activity-detection tuning
 * (silenceDurationMs 400 / prefixPadding 100) the live path uses.
 *
 * This adapter carries the SUSPECTED multi-turn defect (see
 * docs/audio-latency-audit.md §3): the mandatory audio-out turn starves
 * next-question transcription. It exists here as the number the alternate
 * adapter must beat, on the same fixture, in the bench.
 */
import { Modality } from '@google/genai'
import { LiveAdapterBase } from './liveAdapterBase'

export class GeminiNativeAudioAsrAdapter extends LiveAdapterBase {
  constructor() {
    super({
      id: 'gemini-native-audio',
      model: 'gemini-2.5-flash-native-audio-latest',
      responseModalities: [Modality.AUDIO],
      extraConfig: () => ({
        realtimeInputConfig: {
          automaticActivityDetection: { silenceDurationMs: 400, prefixPaddingMs: 100 }
        }
      })
    })
  }
}
