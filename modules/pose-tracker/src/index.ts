import { NitroModules } from 'react-native-nitro-modules';
import type { PoseLandmarker } from './PoseLandmarker.nitro';

export type { PoseLandmarker } from './PoseLandmarker.nitro';

let instance: PoseLandmarker | undefined;

export function getPoseLandmarker(): PoseLandmarker {
  if (!instance) instance = NitroModules.createHybridObject<PoseLandmarker>('PoseLandmarker');
  return instance;
}
