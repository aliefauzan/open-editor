# Deep dive: what else to cut after D-72..D-75

2026-10-12 · research only · measured on an M5, macOS 27.0.1, SDK 27.0 · follows
`2026-10-12-macos-native-offload.md`

Already shipped: cutout via Vision (D-72), frame cards (D-73), Apple on-device vision role (D-74),
MediaIntelligence highlights for quick clips (D-75). This note covers what is left: LLM tokens the agent
still spends, pipeline time on the quick path, and features an Apple framework could add without a model.

Test input: the owner's test video `rtcMRI3ARck` (667 s, Indonesian talking head, H.264 1620×1080 30 fps
source, 810×540 proxy).

## 1. LLM tokens still spent

Token figures are estimates (characters / 4) from reading the code, not billed numbers.

| # | Sink | Estimate | Where |
| --- | --- | --- | --- |
| 1 | **No prompt caching.** No `cacheControl` anywhere; `system` goes to `streamText` as a plain string. Each step re-sends about 5k stable tokens (system prompt + tools) plus the growing history, uncached | 1.5–2M input tokens per clipper run (3 stylize sub-runs) | `packages/agent/src/loop/run.ts:505` |
| 2 | Screenplay ranking without an `embed` role: one LLM call per scene per 12 clips | about 480k (60 scenes × 40 clips) | `packages/agent/src/screenplay/match.ts:126` |
| 3 | Screenplay tagging: 3 full-resolution stills per clip, sent straight to the vision model | about 200k on the first run (40 clips) | `packages/agent/src/workflows/screenplay.ts:256` |
| 4 | Images kept in recent history: `view_frames` with `detail: "pixels"` and `check_audio`'s qa.png. Full-resolution PNG, re-sent for `KEEP_RECENT_STEPS` = 8 steps | up to 13k per call, about 100k | `packages/agent/src/tools/read.ts`, `tools/jobs.ts:246` |
| 5 | `get_transcript`: about 100 characters of JSON per word | 40–50k for a 10-minute source | `packages/agent/src/tools/transcript.ts:19,121` |
| 6 | State block on every step: all items and captions as JSON | 0.8k–6k per step | `packages/agent/src/loop/run.ts:405` |
| 7 | Compaction summary: JSON of all old steps sent to the `fast` model | 20–60k per compaction | `packages/agent/src/loop/run.ts:472` |
| 8 | Style extract: 4 contact sheets, all re-sent on retry | 7–16k | `packages/agent/src/workflows/styleExtract.ts:190` |

### Cuts

1. **Prompt caching (plain engineering, biggest).** Send `system` as a message with
   `providerOptions.anthropic.cacheControl: { type: "ephemeral" }`. Put breakpoints on the last tool definition
   and on the last tool-result message. Move the state block to the tail so the history stays a stable
   prefix. The usage reader already counts `cacheReadTokens` (`run.ts:88`). OpenRouter's Anthropic models
   take the same field. Expected: most input billed at the cache-read rate.
2. **Local embeddings for screenplay ranking.** `NLContextualEmbedding` covers Indonesian and English on
   this Mac: assets installed, dimension 512. `NLEmbedding.sentenceEmbedding` exists for English but **not**
   for Indonesian, so use the contextual model and mean-pool it. This replaces the per-scene LLM ranking
   with one local pass.
3. **Screenplay tagging from frame cards.** Reuse D-73 cards for the 3 keyframes, then have the on-device
   model (D-74) write the tags. If the cloud path stays, downscale first.
4. **Images: downscale and drop.** Downscale stills to a 768 px long edge. After the step that used them,
   replace images in history with their frame card. Stop sending qa.png: `check_audio` already returns
   the numbers.
5. **Compact transcript lines.** One line per word (`i text startMs-endMs`) or per sentence is 4–5× smaller.
   Stylize passes the clip's `sourceRange` so only that span is read.
6. **State diff.** Send items changed since the last step and the full view every N steps.
7. **Compaction notes from the run record in code**, not an LLM call. The Apple model's context (8,192)
   is too small for today's 20–60k compaction input.

## 2. Quick-path time (667 s video: ingest 44 s, transcribe 42.8 s, facetrack 40 s, render 96 s)

### Transcribe

Apple has two on-device speech-to-text modules:
- `SpeechTranscriber` (macOS 26): 45 locales, **no Indonesian**.
- `DictationTranscriber`: 54 locales, including `id-ID` and `ms-MY`.

Measured on 240 s of the test video:

| Engine | Time | Words | Notes |
| --- | --- | --- | --- |
| Whisper large-v3-turbo (today) | 25 s (process total) | 502 | Punctuation, loanwords right ("nge-boost") |
| `DictationTranscriber` id-ID | 5.3 s (+ 44 s one-time OS language download) | 499 | No punctuation; slang and loanwords weaker ("ngebus", "memperl"); word time ranges present |
| `SpeechTranscriber` en-US on the same Indonesian audio | — | 15 | Wrong language: garbage, stopped early |

On English (`talking-head-20s`), `SpeechTranscriber` matched the Whisper fixture word for word in 827 ms.
On the Indonesian clip, the en-US transcriber kept an "uh", so fillers are not always dropped. Whisper
returned 0 fillers on the Indonesian clip even with the filler prompt. The filler question is still
open; test it on English speech with known fillers before switching.

`NLLanguageRecognizer` detected `id` from one sentence, which is enough to pick the locale.

Options, by risk:
- **Low risk:** pass only Silero VAD speech regions to Whisper (`clip_timestamps`). Today Whisper runs
  over silent audio too (`py/vox_py/transcribe.py:159-166`).
- **Medium:** add an Apple speech engine as an opt-in "fast transcribe". Use `SpeechTranscriber` where the
  locale is supported (better quality, punctuation) and `DictationTranscriber` otherwise. Whisper stays the
  default. The transcript cache key must name the engine.

### Facetrack

Today each sampled frame (12 fps, short side 360) gets BlazeFace on the full frame plus 3 tiles, so 4 CPU
runs per frame. Vision `VNDetectFaceRectanglesRequest` on 360 frames of the talking-head proxy took 3.9 ms
per frame and found the face in 360 of 360 frames. Current facetrack on the same 30 s took 6 s, including
bodies and saliency.

Swap: one Vision handler per frame with faces + humans + saliency, and drop MediaPipe. Or detect at
4 fps and use `VNTrackObjectRequest` in between. It changes box geometry and scores, so the facetrack
path version and cache key must be bumped, and D-21's tile tuning no longer applies. The full-run gain is
estimated, not measured.

### Render

HyperFrames screenshots every frame in Chrome and encodes with libx264 preset medium, crf 18. Vox calls
`hyperframes render` without `--gpu` (`packages/engine/src/export-api.ts:98-118`); with `--gpu`
HyperFrames uses `h264_videotoolbox` / `hevc_videotoolbox`.

Encode-only stand-in, 60 s at 1080×1920 from the test source:

| Encoder | Time | Size |
| --- | --- | --- |
| libx264 medium crf 18 (today) | 19.2 s | 30.8 MB |
| h264_videotoolbox 10 Mb/s | 6.8 s | 72.5 MB |

Hardware encode is 2.8× faster. Its bitrate must be tuned to keep file size near today's. Clips also
render one after another (`export-api.ts:368-370`); `--workers` and parallel clips are further options.
The Chrome capture cost is not measured here.

### Ingest

The proxy encode is not the bottleneck. 120 s at 540p: libx264 veryfast 3.9 s; with hardware decode
5.3 s; h264_videotoolbox 5.2 s. Keep libx264 (D-53). The real gains are elsewhere:
- **Download:** yt-dlp does not prefer H.264 (`packages/engine/src/stages/ytdlpArgs.ts:68-73`). YouTube
  serves VP9/AV1, which decodes in software and also fails MediaIntelligence (D-75 runs on the proxy for
  that reason). `-S vcodec:h264` is already in the D-53 backlog.

## 3. Features with no model

| Feature | API | Measured here | Notes |
| --- | --- | --- | --- |
| Translated captions | `Translation` `TranslationSession(installedSource:target:)` | id→en and en→id installed; 3 caption lines in 2.2 s (first call), correct meaning | macOS 15+ |
| Blur or replace the background behind the speaker | Vision `VNGeneratePersonSegmentationRequest` | per frame: 13.7 ms (fast, 256×192 mask), 17.9 ms (balanced, 512×384), 47.3 ms (accurate, full resolution) | A 60 s clip at 30 fps is about 32 s at balanced |
| Music beds with beat-snapped cuts | `MusicUnderstanding` (macOS 27) | 120.05 BPM exact on a 120 BPM test track; beats, bars, sections, LUFS | The spec defers music beds; this removes the librosa plan. Hold until 14f ducking is settled |
| Sound tags (laughter, applause, music) as highlight hints | `SNClassifySoundRequest` (`.version1`, 303 classes) | 240 s in 445 ms; this clip is 153 of 159 windows "speech" | Feed into the D-75 highlight blend |
| Language detection before transcribe | `NLLanguageRecognizer` | `id` from one sentence | Picks the speech engine and locale |
| Poster frame | MediaIntelligence key frame (D-75) + `VNCalculateImageAestheticsScoresRequest` | key frame already cached | D-75 follow-up in plan/TODO.md |
| Click-to-mask any object | Vision `GenerateIterativeSegmentationRequest` (macOS 27) | not run (needs `downloadAssets`) | For cutouts that subject lift gets wrong |
| Upscale / denoise | `VTFrameProcessor` super resolution, temporal noise filter (macOS 26) | not run | Low-light webcam footage |

Not usable:
- No public speaker-diarization API.
- `SpeechTranscriber` has no Indonesian.
- The only Indonesian TTS voice installed (Damayanti) is compact quality, and voice-over is a spec non-goal.
- No new audio voice-isolation API in 27.

## Recommended order

1. **Prompt caching** for the Anthropic and OpenRouter providers. Biggest token cut, no OS dependency.
2. **Screenplay on local signals:** `NLContextualEmbedding` ranking + frame-card tagging.
3. **Image hygiene:** downscale to 768, drop images from history after use, stop sending qa.png.
4. **Compact transcript format** + clip-scoped reads.
5. **yt-dlp prefers H.264** (D-53 backlog) and **`hyperframes render --gpu`** with a tuned bitrate.
6. **Whisper on VAD regions only.** Then an opt-in Apple speech engine after an English filler test.
7. **Facetrack on Vision faces**, with a cache-key bump and an A/B on the fixtures.
8. New features, owner's pick: translated captions, speaker background blur, music beds on
   MusicUnderstanding, sound tags in the highlight blend.
