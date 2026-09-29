import type { HybridObject } from 'react-native-nitro-modules';
import type { Frame } from 'react-native-vision-camera';

/** Native pose inference only. The frame is never copied to JS or serialized. */
export interface PoseLandmarker extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  /** Returns a compact JSON pose packet, or an empty string when no newer result exists. */
  process(frame: Frame): string;
  reset(): void;
  diagnostics(): string;
}
