# Vendored models

Model files here are committed with their licence, never downloaded at run time (R3, D-15).

| File              | Upstream                                                                                                                                                                                                 | Licence               | SHA-256                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| `silero_vad.onnx` | Silero VAD v6.2.3, `src/silero_vad/data/silero_vad.onnx` at commit `5cd7945676eb32225748052e2e6a0580e4686a08` (<https://github.com/snakers4/silero-vad/blob/v6.2.3/src/silero_vad/data/silero_vad.onnx>) | MIT, `LICENSE.silero` | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` |

The SHA-256 is also recorded in `plan/ref/R5-pins.md`. `vox_py.vad.load_model` checks it and fails
with `MODEL_HASH_MISMATCH` on any change. Downloaded models (the MediaPipe face model, the Whisper
weights) are not stored here; their URL, revision and SHA-256 are pinned in `facetrack.py` and
`transcribe.py`.
