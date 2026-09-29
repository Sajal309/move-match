import React from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import type { PosePoint } from '@move-match/rep-engine';

const skeletonLinks: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [9, 10], [0, 11], [0, 12],
];

export function PoseOverlay({ landmarks, mirrored }: { landmarks: { value: PosePoint[] }; mirrored: boolean }) {
  const size = useSharedValue({ width: 0, height: 0 });
  const path = useDerivedValue(() => {
    const output = Skia.Path.Make();
    const entries = landmarks.value;
    const { width, height } = size.value;
    if (entries.length < 33 || width <= 0 || height <= 0) return output;
    for (const [from, to] of skeletonLinks) {
      const a = entries.find((point) => point.index === from);
      const b = entries.find((point) => point.index === to);
      if (!a || !b || Math.min(a.visibility, b.visibility) < 0.55) continue;
      const ax = mirrored ? 1 - a.x : a.x;
      const bx = mirrored ? 1 - b.x : b.x;
      output.moveTo(ax * width, a.y * height);
      output.lineTo(bx * width, b.y * height);
    }
    return output;
  });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.value = { width, height };
  };
  return <View pointerEvents="none" accessible={false} onLayout={onLayout} style={StyleSheet.absoluteFill}>
    <Canvas style={StyleSheet.absoluteFill}>
      <Path path={path} color="#D7F36C" style="stroke" strokeWidth={4} strokeCap="round" strokeJoin="round" />
    </Canvas>
  </View>;
}
