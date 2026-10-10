# Vendored models

Model files here are committed with their licence, never downloaded at run time (R3, D-15).

Future contents (phase 04):

- `silero_vad.onnx` and its MIT licence file `LICENSE.silero`. The SHA-256 is recorded in
  `plan/ref/R5-pins.md`; the loader checks it and fails on a mismatch.

Until then `placeholder.onnx` and `LICENSE.placeholder` exist only so the wheel build can be tested
for shipping package data. Phase 04 deletes both.
