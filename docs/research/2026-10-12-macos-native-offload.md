# macOS-native offload: fewer model downloads, fewer LLM tokens

2026-10-12 · research only, no code changed · measured on macOS 27.0.1, arm64, Swift 6.4

## Question

Which jobs can the system frameworks do instead of a downloaded model or a paid LLM call, without
breaking an existing feature?

## What runs today

| Job | Now | Where |
| --- | --- | --- |
| Background removal | rembg + `u2net.onnx` (176 MB download) | `py/vox_py/cutout.py` |
| Transcription | Whisper large-v3-turbo (MLX) | `py/vox_py/transcribe.py` |
| Voice activity | Silero VAD (vendored ONNX) | `py/vox_py/vad.py` |
| Face tracking | MediaPipe BlazeFace on tiles; Vision for bodies and saliency | `py/vox_py/facetrack.py` |
| Image generation | mflux (Z-Image-Turbo / FLUX.1-schnell) | `py/vox_py/imagegen.py` |
| Looking at footage | `view_frames` / `view_media`, up to 8 images per call; `vision` role describes them when the editor model cannot see | `packages/agent/src/tools/read.ts` |
| Quick-clips scoring | `fast` model, batches of 30 candidates | `apps/desktop/src/main/quickScorer.ts` |
| Video summary | `scripts/vidprep.py` (Vision OCR, contact sheet, about 2-3K tokens) | dev script only, not wired to the agent |

All 21 framework APIs below typecheck against the macOS 27 SDK on this Mac.

## Measured

### Background removal: Vision `VNGenerateForegroundInstanceMaskRequest` vs rembg u2net

| Image | Vision | rembg | Coverage (Vision / rembg) |
| --- | --- | --- | --- |
| `faces/face-a.jpg` 720×900 | 381 ms | 2,808 ms | 0.619 / 0.619 |
| talking-head frame 1920×1080 | 160 ms | 2,055 ms | 0.204 / 0.240 |

- Vision needs no model file. It ships with macOS 14+, the app's minimum.
- Edge quality: Vision kept finer hair. On the talking-head frame, rembg also kept colour-bar blobs
  at the bottom (the extra 0.036 coverage). Vision left only a thin sliver.
- rembg timings include Python start-up and model load, which is what a `cutout` job pays.

### Transcription: Speech `SpeechTranscriber` (macOS 26+) vs Whisper

- `talking-head-20s.mp4`: 60 words, word-level `audioTimeRange`, punctuation, 827 ms in total.
- The text matches the Whisper fixture `talking-head-20s.json` word for word. Only "Demo"/"demo"
  differs in case.
- The language model is an OS-managed asset (`AssetInventory`). The app downloads and stores nothing.
- Not measured yet: filler words. Whisper keeps "um"/"uh" and the filler-cut feature depends on it.
  `SpeechTranscriber` may drop them. Test against `fixtures/transcripts/speech-fillers.json` first.

### Frame card: Vision as text instead of pixels

A talking-head frame with `VNClassifyImageRequest`, fast `VNRecognizeTextRequest`,
`VNDetectFaceRectanglesRequest` and `VNCalculateImageAestheticsScoresRequest` took 336 ms:

```
labels: people 0.71, adult 0.71
text: 9
faces: 1  aesthetics: 0.57 utility: false
```

That is about 40 tokens. One 1080p still sent to Claude costs about 1,600 tokens, so 8 stills are
about 12,800. Vision fails on a 0×0 image (`Code=13`), so the tool must guard empty decodes.

## Proposals, by token or download saved

### A. LLM tokens (largest win)

1. **Frame cards before pixels.** `view_frames` / `view_media` return a Vision card per still
   (labels, OCR text, face count and boxes, saliency box, aesthetics score). The model asks for
   pixels only when the card is not enough (`detail: "pixels"`). This also replaces the paid
   `vision`-role description when the editor model cannot see. About 95% fewer tokens per frame.
2. **Wire vidprep into the agent.** Run it at ingest, cache `summary.md` next to the proxy, and
   expose it as a `summarize_media` tool. The agent reads one 2-3K-token card per video, not frames.
3. **Pre-filter quick-clip candidates locally.** Drop weak candidates before the `fast` model sees
   them. Signals: SoundAnalysis `SNClassifySoundRequest` (laughter, applause, music, speech), face
   present, aesthetics score, speech rate from the transcript. When Apple Intelligence is on, the
   `fast` role can default to `vox-apple-llm`. Its 8k context fits batches of 30.
4. **Local embeddings for the `embed` role.** `NLEmbedding.sentenceEmbedding` or
   `NLContextualEmbedding` for semantic transcript search and b-roll matching.
   `VNGenerateImageFeaturePrintRequest` for visual similarity and near-duplicate shots.
5. **Caption translation (if added):** `Translation` framework (macOS 15+), not an LLM call.

### B. Model downloads and compute

6. **Cutout → Vision subject lift.** Measured above: 6-13× faster, no 176 MB model, cleaner edges.
   It covers every supported macOS version. Keep rembg only as the fallback when Vision finds no
   subject.
7. **Transcribe → `SpeechTranscriber` first, Whisper fallback.** Use it on macOS 26+ when the
   locale is supported and the filler test passes. Whisper stays for macOS 14/15, unsupported
   languages and a failed asset install. Silero VAD is small and vendored, so keep it.
8. **Face tracking → `VNDetectFaceRectanglesRequest`.** Bodies and saliency already use Vision.
   D-log notes speed is bound by BlazeFace runs per frame. A/B small-face recall on the fixtures
   before switching. It would remove one download and the tiling.
9. **Image generation → `ImageCreator` (Image Playground) as an option only.** No download, but
   only animation, illustration and sketch styles, and Apple Intelligence must be on. mflux stays
   the default for photoreal.

### C. New features with no model

- Voice-over: `AVSpeechSynthesizer` (system and Personal Voice) written to a file.
- Video person matte: `VNGeneratePersonSegmentationRequest` per frame, or `CIPersonSegmentation`.
- Upscale, denoise, slow motion: `VTFrameProcessor` with `VTSuperResolutionScalerConfiguration`,
  `VTTemporalNoiseFilterConfiguration` and `VTFrameRateConversionConfiguration` (macOS 26+).
- Sound tags for SFX and music beds: SoundAnalysis built-in classifier (`.version1`).

## Rules so nothing conflicts

- **Same contract.** The native path returns the same JSON result as the Python tool it replaces,
  for example cutout's `{ output, width, height, coverage }`. Callers and tests do not change.
- **Native first, model as fallback.** Check at run time: OS version (`#available`), locale
  support, asset installed, Apple Intelligence on. On any failure, fall back to today's path and
  record which engine ran.
- **One Swift helper.** Add the commands to a `vox-native` helper beside `vox-apple-llm` (same
  JSON-lines protocol). Weak-link macOS 26 frameworks, as D-log already does for FoundationModels.
- **Cache keys name the engine.** `transcriptRev` hashes repo and revision now, so add
  `engine: apple-speech | whisper` to it. Otherwise caches mix outputs from both engines.
- **Downloads become lazy.** Fetch u2net, BlazeFace and Whisper only when their fallback is first
  needed. `doctor` reports which engine is active.
- **Setting to force the model path** for anyone who wants Whisper or rembg output.

## macOS 27 additions (WWDC26), checked against the 27.0 SDK and run on this Mac

| API | OS | Measured here | Use in Vox |
| --- | --- | --- | --- |
| FoundationModels `Attachment(cgImage)` image input; `SystemLanguageModel.capabilities.contains(.vision)` | 27 | `vision=true`, context 8192, about 3.0 s per 1080p frame | Frame descriptions on the device, so the paid `vision` role is not called. Can fill the `vision` role when Apple Intelligence is on |
| MediaIntelligence `VideoAnalyzer.shared.analyze(_:for: HighlightAnalysisRequest(), KeyFrameAnalysisRequest())` | 27 | 20 s H.264 in 6.0 s: highlight 4.5–14.5 s, 40 levels (0.5 s steps), key frame 4.0 s. 180 s in 23.4 s. **VP9 fails** with `Code=-18 … Analysis failed to complete` | Free quick-clip signal and thumbnail frame, fed to the scorer before the `fast` model. Run it on the H.264 proxy, not the source |
| MusicUnderstanding `MusicUnderstandingSession(asset:)`, `analyze(for: [.rhythm, .structure, .loudness])` | 27 | Synthetic 120 BPM track: `beatsPerMinute` 120.05, 61 beats at 0.50 s steps, integrated −15.6 LUFS, 1.1–1.9 s for 30 s | Beat-snapped cuts, bed placement by section, duck under `.vocal` activity, loudness to target. No mood, no stems |
| Vision `GenerateIterativeSegmentationRequest(seedPoint:/seedBox:/seedScribbleBuffer:)` | 27 | not run (needs `downloadAssets`) | Click-to-mask cutout for non-salient objects, where subject lift picks the wrong thing |
| `_Vision_FoundationModels` `OCRTool`, `BarcodeReaderTool` | 27 | not run | The on-device model reads on-screen text itself |
| `PrivateCloudComputeLanguageModel` (32K context, reasoning levels) | 27 | not run; needs an Apple entitlement and has a per-user daily quota | Larger free fallback for the `editor` or `fast` role. Apply for the entitlement first |
| `SystemLanguageModel.tokenCount(for:)`, `contextSize`, `Usage` | 26.4 / 27 | `contextSize` 8192 | Exact budget checks in `providers/apple.ts`, replacing the estimate |
| VideoToolbox `VTSuperResolutionScalerConfiguration`, `VTTemporalNoiseFilterConfiguration` | 26 | not run | Upscale and denoise webcam footage |
| Speech `AssetInputSequenceProvider.provider(from: AVAsset, …)` | 27 | not run | Transcribe straight from the asset, no WAV extraction |

Not usable:
- `ImageCreator` is deprecated in 27 (the UI sheet only), so mflux stays.
- Cinematic refocus only works on clips that already carry Cinematic metadata.
- `FaceGroupAnalyzer` works on still images only.
- Nothing new for voice isolation, stems, mood or translation of audio.

## Suggested order

1. Cutout → Vision (smallest change, measured win, macOS 14+).
2. Frame cards in `view_frames` (largest token win).
3. vidprep as `summarize_media`.
4. `SpeechTranscriber` with Whisper fallback, after the filler test.
5. Quick-clip local pre-filter.

Probe sources (scratchpad, not committed): `cutout.swift`, `stt.swift`, `card.swift`, `p.swift`.
