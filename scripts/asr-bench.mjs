#!/usr/bin/env node
/**
 * asr-bench.mjs
 *
 * Fair A/B for the interview ASR route: streams ONE fixed audio fixture through
 * a Gemini Live model exactly as GhostKit does (100 ms PCM16 @ 16 kHz chunks,
 * same transcription/compression/activity-detection config) and measures the
 * ONE thing the multi-turn defect is about -- how long AFTER a gap of silence
 * the model emits the FIRST caption of the next utterance. Run it once per
 * model against the SAME fixture and compare; that isolates the native-audio
 * output-turn starvation (docs/audio-latency-audit.md) from everything else.
 *
 * Self-contained on purpose: plain Node + the already-installed @google/genai,
 * no TS build step, no Electron, no keytar. It does NOT import the app's
 * adapters -- it mirrors their Live config so it runs with a bare `node`.
 *
 * USAGE:
 *   GEMINI_API_KEY=xxxx node scripts/asr-bench.mjs <fixture.pcm> [modelId]
 *
 *   <fixture.pcm>  raw signed 16-bit little-endian mono PCM at 16 kHz.
 *                  Make one from any audio with ffmpeg:
 *                    ffmpeg -i input.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 fixture.pcm
 *                  Record a real multi-turn clip: Q1, ~3-5 s pause (answer time),
 *                  Q2, pause, Q3 -- the gap before Q2/Q3's first caption is the metric.
 *   [modelId]      default gemini-2.5-flash-native-audio-latest (the baseline).
 *                  Compare against e.g. gemini-3.1-flash-live-preview.
 *
 * Nothing here plays audio or generates answers -- it only reads transcription
 * timing. Key comes from the environment; it is never logged.
 */
import { readFileSync } from 'node:fs'
import { GoogleGenAI, Modality } from '@google/genai'

const CHUNK_MS = 100
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS / 1000) * BYTES_PER_SAMPLE // 3200

function nowMono() {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

async function main() {
  const [, , fixturePath, modelArg] = process.argv
  const model = modelArg ?? 'gemini-2.5-flash-native-audio-latest'
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('Set GEMINI_API_KEY in the environment first.')
    process.exit(1)
  }
  if (!fixturePath) {
    console.error('Usage: GEMINI_API_KEY=xxx node scripts/asr-bench.mjs <fixture.pcm> [modelId]')
    process.exit(1)
  }

  const pcm = readFileSync(fixturePath)
  const totalChunks = Math.ceil(pcm.length / CHUNK_BYTES)
  console.log(`[bench] model=${model} fixture=${fixturePath} bytes=${pcm.length} (~${(pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(1)}s, ${totalChunks} chunks)`)

  // Turn tracking: an "utterance" starts at the first interim caption after a
  // quiet stretch, and ends when captions stop for > QUIET_MS. The gap measured
  // is (this utterance's first caption) - (previous utterance's last caption).
  const QUIET_MS = 1500
  let lastCaptionMono = null
  let utteranceOpen = false
  let prevUtteranceLastCaptionMono = null
  const gaps = []

  const onCaption = (text) => {
    const t = nowMono()
    if (!utteranceOpen) {
      utteranceOpen = true
      if (prevUtteranceLastCaptionMono !== null) {
        const gap = t - prevUtteranceLastCaptionMono
        gaps.push(gap)
        console.log(`[bench] utterance #${gaps.length + 1} first caption: ${gap.toFixed(0)}ms after previous utterance ended  preview="${text.slice(0, 40)}"`)
      } else {
        console.log(`[bench] utterance #1 first caption  preview="${text.slice(0, 40)}"`)
      }
    }
    lastCaptionMono = t
  }

  // Close an utterance after a quiet stretch so the next caption counts as a new one.
  const quietPoll = setInterval(() => {
    if (utteranceOpen && lastCaptionMono !== null && nowMono() - lastCaptionMono > QUIET_MS) {
      utteranceOpen = false
      prevUtteranceLastCaptionMono = lastCaptionMono
    }
  }, 100)

  const ai = new GoogleGenAI({ apiKey })
  const isNativeAudio = model.includes('native-audio')
  const session = await ai.live.connect({
    model,
    config: {
      // Native-audio models only accept AUDIO; text-capable half-cascade models
      // can take TEXT (the config under test). Mirror the app's other settings.
      responseModalities: [isNativeAudio ? Modality.AUDIO : Modality.TEXT],
      inputAudioTranscription: { languageCodes: ['en-IN', 'en-US', 'hi-IN'] },
      outputAudioTranscription: {},
      thinkingConfig: { includeThoughts: false },
      contextWindowCompression: { slidingWindow: {} },
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: 400, prefixPaddingMs: 100 }
      }
    },
    callbacks: {
      onopen: () => {},
      onmessage: (message) => {
        const c = message.serverContent
        const interim = c?.interimInputTranscription?.text
        if (typeof interim === 'string' && interim.trim().length > 0) onCaption(interim)
        const finalText = c?.inputTranscription?.text
        if (typeof finalText === 'string' && finalText.trim().length > 0) onCaption(finalText)
      },
      onerror: (e) => console.error('[bench] socket error:', e?.message ?? 'unknown'),
      onclose: (e) => console.warn('[bench] socket closed code=', e?.code ?? 'unknown')
    }
  })

  // Stream the fixture at real-time cadence (one 100 ms chunk every 100 ms) so
  // the model's VAD/endpointing sees the same timing a live interview produces.
  const startMono = nowMono()
  for (let i = 0; i < totalChunks; i++) {
    const slice = pcm.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
    session.sendRealtimeInput({
      audio: { data: Buffer.from(slice).toString('base64'), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
    })
    await sleep(CHUNK_MS)
  }
  // Let trailing transcription/endpointing settle.
  await sleep(QUIET_MS + 1500)
  clearInterval(quietPoll)
  try { session.close() } catch {}

  console.log(`[bench] done in ${((nowMono() - startMono) / 1000).toFixed(1)}s`)
  if (gaps.length === 0) {
    console.log('[bench] no multi-turn gaps measured -- fixture needs >=2 utterances separated by a real pause.')
  } else {
    const sorted = [...gaps].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    console.log(`[bench] RESULT model=${model} next-utterance gap p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms n=${gaps.length}`)
    console.log(`[bench] (lower is better; the reported defect is 4000-8000ms on utterance #2+)`)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[bench] failed:', err?.message ?? err)
  process.exit(1)
})
