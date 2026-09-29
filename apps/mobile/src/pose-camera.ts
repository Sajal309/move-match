import { NitroModules } from 'react-native-nitro-modules';
import type { Frame } from 'react-native-vision-camera';
import type { PoseLandmarker } from '@move-match/pose-tracker';

export function poseLandmarker() {
  'worklet';
  return NitroModules.createHybridObject<PoseLandmarker>('PoseLandmarker');
}

export function readPose(frame: Frame, tracker: PoseLandmarker): string {
  'worklet';
  return tracker.process(frame);
}
