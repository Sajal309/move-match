import React, { useEffect, useMemo } from 'react';
import { LayoutChangeEvent, Linking, Pressable, StyleSheet, View, Text } from 'react-native';
import { Camera, CommonResolutions, useCameraDevice, useCameraPermission, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';
import { useSharedValue } from 'react-native-reanimated';
import { getPoseLandmarker } from '@move-match/pose-tracker';
import { createRepMachine, stepRepMachine } from '@move-match/rep-engine';
import type { Exercise, LocalRepObservation, PullUpCalibration, Quality } from '@move-match/rep-engine';
import { PoseOverlay } from './PoseOverlay';
import type { PosePacket, PosePoint } from '@move-match/rep-engine';
import { useAppTheme } from './theme';

export function PoseCamera({
  facing,
  active = true,
  landmarks,
  onPacket,
  exercise = 'push_up',
  counting = false,
  roundDurationMs,
  resetKey = 0,
  pullUpCalibration,
  onRep,
  onTracking,
  onPreviewTap,
  onPermissionRequest,
  compact = false,
}: {
  facing: 'front' | 'back';
  active?: boolean;
  landmarks?: { value: PosePoint[] };
  onPacket?: (json: string) => void;
  exercise?: Exercise;
  counting?: boolean;
  roundDurationMs?: number;
  resetKey?: number;
  pullUpCalibration?: PullUpCalibration;
  onRep?: (count: number, timestampMs: number, observation?: LocalRepObservation) => void;
  onTracking?: (status: { quality: Quality; cue: string; inferenceMs: number }) => void;
  onPreviewTap?: (point: { x: number; y: number }) => void;
  onPermissionRequest?: () => void;
  compact?: boolean;
}) {
  const { theme } = useAppTheme();
  const device = useCameraDevice(facing);
  const { hasPermission, requestPermission } = useCameraPermission();
  const tracker = useMemo(() => getPoseLandmarker(), []);
  const poseValue = useSharedValue<PosePoint[]>([]);
  const machine = useSharedValue(createRepMachine(exercise));
  const lastSample = useSharedValue(-1);
  const lastPacketSent = useSharedValue(-1);
  const lastStatusSent = useSharedValue(-1);
  const lastQuality = useSharedValue<Quality>('out_of_frame');
  const previewSize = React.useRef({ width: 1, height: 1 });
  useEffect(() => {
    machine.value = createRepMachine(exercise);
    lastSample.value = -1;
    lastPacketSent.value = -1;
    lastStatusSent.value = -1;
    lastQuality.value = 'out_of_frame';
    tracker.reset();
  }, [counting, exercise, resetKey, tracker]);
  const onFrame = useMemo(() => (frame: Parameters<typeof tracker.process>[0]) => {
    'worklet';
    try {
      const payload = tracker.process(frame);
      if (payload.length > 0) {
        const sample = JSON.parse(payload) as PosePacket;
        if (sample.timestampMs > lastSample.value) {
          lastSample.value = sample.timestampMs;
          poseValue.value = sample.landmarks;
          if (counting) {
            const result = stepRepMachine(machine.value, sample, pullUpCalibration, roundDurationMs);
            machine.value = result.machine;
            if (result.repCompleted && onRep && result.observation) scheduleOnRN(onRep, result.machine.count, sample.timestampMs, result.observation);
          }
          const indices = exercise === 'push_up' ? [11, 12, 13, 14, 15, 16, 23, 24, 27, 28]
            : [9, 10, 11, 12, 13, 14, 15, 16, 23, 24, 27, 28];
          const required = sample.landmarks.filter((point) => indices.includes(point.index));
          const confidence = required.length === indices.length ? Math.min(...required.map((point) => Math.min(point.visibility, point.presence))) : 0;
          const sampleQuality: Quality = sample.landmarks.length !== 33 || required.length !== indices.length
            ? 'out_of_frame' : confidence < 0.7 ? 'low_confidence' : 'ready';
          const quality = counting ? machine.value.quality : sampleQuality;
          if (onTracking && (quality !== lastQuality.value || sample.timestampMs - lastStatusSent.value >= 500)) {
            lastQuality.value = quality;
            lastStatusSent.value = sample.timestampMs;
            scheduleOnRN(onTracking, { quality, cue: sampleQuality === 'ready' ? machine.value.cue : quality === 'low_confidence'
              ? 'More light needed — keep key joints visible' : 'Move back and keep the required joints in frame', inferenceMs: sample.inferenceMs });
          }
          if (onPacket && sample.timestampMs - lastPacketSent.value >= 250) {
            lastPacketSent.value = sample.timestampMs;
            scheduleOnRN(onPacket, payload);
          }
        }
      }
    } finally {
      frame.dispose();
    }
  }, [counting, roundDurationMs, exercise, machine, onPacket, onRep, onTracking, lastPacketSent, lastQuality, lastSample,
    lastStatusSent, poseValue, pullUpCalibration, tracker]);
  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'yuv',
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame,
  });

  if (!hasPermission) {
    return <View style={[styles.message, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.messageTitle, { color: theme.text }]}>Camera access is needed for practice</Text>
      <Text style={[styles.messageBody, { color: theme.secondary }]}>Frames stay on this device. You can still browse MOVE / MATCH without granting access. If camera access was denied, change it in your phone settings.</Text>
      <Text onPress={() => { onPermissionRequest?.(); void requestPermission(); }} accessibilityRole="button"
        style={[styles.permissionAction, { color: theme.tealText }]}>Allow camera access</Text>
      <Text onPress={() => void Linking.openSettings()} accessibilityRole="button"
        style={[styles.permissionAction, { color: theme.tealText }]}>Open phone settings</Text>
    </View>;
  }
  if (!device) {
    return <View style={[styles.message, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.messageTitle, { color: theme.text }]}>Camera unavailable</Text>
      <Text style={[styles.messageBody, { color: theme.secondary }]}>Close other camera apps, then return here to try again.</Text>
    </View>;
  }

  const onLayout = (event: LayoutChangeEvent) => { previewSize.current = event.nativeEvent.layout; };
  return <View style={[styles.preview, compact && styles.previewCompact]} onLayout={onLayout}>
    <Camera style={StyleSheet.absoluteFill} device={device} isActive={active} outputs={[frameOutput]} />
    <PoseOverlay landmarks={landmarks ?? poseValue} mirrored={facing === 'front'} />
    {onPreviewTap ? <Pressable accessibilityLabel="Tap on the camera preview to mark the visible bar line" onPress={(event) => {
      const { locationX, locationY } = event.nativeEvent;
      const { width, height } = previewSize.current;
      const x = Math.max(0, Math.min(1, locationX / width));
      onPreviewTap({ x: facing === 'front' ? 1 - x : x, y: Math.max(0, Math.min(1, locationY / height)) });
    }} style={StyleSheet.absoluteFill} /> : null}
    <View pointerEvents="none" style={styles.cameraCaption}>
      <Text style={styles.cameraCaptionText}>CAMERA STAYS ON THIS DEVICE</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  preview: { width: '100%', aspectRatio: 0.75, overflow: 'hidden', borderRadius: 24, backgroundColor: '#152B35' },
  previewCompact: { aspectRatio: 0.75 },
  message: { minHeight: 220, borderWidth: 1, borderRadius: 20, padding: 24, justifyContent: 'center', gap: 12 },
  messageTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  messageBody: { fontSize: 15, lineHeight: 22 },
  permissionAction: { paddingVertical: 12, fontSize: 16, lineHeight: 22, fontWeight: '800' },
  cameraCaption: { position: 'absolute', top: 14, left: 14, paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 8, backgroundColor: 'rgba(16,40,57,0.88)' },
  cameraCaptionText: { color: '#FFFFFF', fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 0.8 },
});
