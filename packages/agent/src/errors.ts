// The agent throws the engine's VoxError (R3 "Errors"); the codes live in the engine's ERROR_CODES.
export {
  VoxError,
  isVoxError,
  toVoxErrorJson,
  type ErrorCode,
  type VoxErrorJson,
} from '@vox/engine';
