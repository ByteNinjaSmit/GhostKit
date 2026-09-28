/**
 * geminiHalfCascadeAdapter.ts
 *
 * The A/B CANDIDATE adapter: a half-cascade Live model
 * (`gemini-3.1-flash-live-preview`) configured for TEXT responses. The
 * hypothesis (docs/audio-latency-audit.md §3, §5) is that a text-capable Live
 * model has no mandatory synthesized-audio output turn, so it does NOT starve
 * next-question transcription the way the native-audio model does -- which, if
 * true, is the actual fix for the 4-8s multi-turn delay.
 *
 * UNVERIFIED until benched: geminiLive.ts's comments record that
 * `gemini-3.8-live` accepted the TEXT handshake but then closed once generation
 * started, and `gemini-3.1-flash-live-preview` rejected TEXT outright at the
 * time. Model availability/behavior on this key changes over time -- the
 * benchmark (scripts/asr-bench.mjs) exists precisely to re-check this against
 * the live API rather than trusting a stale comment. If TEXT still fails,
 * switch `responseModalities` to [AUDIO] here and compare that instead: even an
 * audio half-cascade may schedule its output turn differently from
 * native-audio-dialog. The model id and modality are the only knobs; the rest
 * is the shared LiveAdapterBase.
 */
import { Modality } from '@google/genai'
import { LiveAdapterBase } from './liveAdapterBase'

export class GeminiHalfCascadeAsrAdapter extends LiveAdapterBase {
  constructor() {
    super({
      id: 'gemini-half-cascade',
      model: 'gemini-3.1-flash-live-preview',
      // TEXT is the whole point -- no synthesized-speech output turn to starve
      // the next question. Falls back to AUDIO by editing this line if the API
      // rejects TEXT for this model (see class doc comment).
      responseModalities: [Modality.TEXT],
      extraConfig: () => ({
        realtimeInputConfig: {
          automaticActivityDetection: { silenceDurationMs: 400, prefixPaddingMs: 100 }
        }
      })
    })
  }
}
