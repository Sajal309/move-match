import React from 'react';
import { View } from 'react-native';
import { Canvas, Circle, Line, RoundedRect } from '@shopify/react-native-skia';
import { useAppTheme } from './theme';

export function MovementArt({ exercise }: { exercise: 'push_up' | 'pull_up' }) {
  const { theme } = useAppTheme();
  const teal = theme.primary;
  const ink = theme.text;
  const lime = theme.lime;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 128, height: 92 }}>
    <Canvas style={{ width: 128, height: 92 }}>
      {exercise === 'push_up' ? <>
        <Line p1={{ x: 20, y: 71 }} p2={{ x: 110, y: 71 }} color={theme.border} strokeWidth={4} />
        <Circle cx={86} cy={34} r={9} color={lime} />
        <Line p1={{ x: 79, y: 41 }} p2={{ x: 57, y: 55 }} color={ink} strokeWidth={8} strokeCap="round" />
        <Line p1={{ x: 57, y: 55 }} p2={{ x: 28, y: 61 }} color={ink} strokeWidth={8} strokeCap="round" />
        <Line p1={{ x: 57, y: 55 }} p2={{ x: 35, y: 70 }} color={teal} strokeWidth={7} strokeCap="round" />
        <Line p1={{ x: 35, y: 70 }} p2={{ x: 22, y: 70 }} color={teal} strokeWidth={7} strokeCap="round" />
        <Line p1={{ x: 57, y: 55 }} p2={{ x: 79, y: 70 }} color={teal} strokeWidth={7} strokeCap="round" />
        <Line p1={{ x: 79, y: 70 }} p2={{ x: 91, y: 70 }} color={teal} strokeWidth={7} strokeCap="round" />
      </> : <>
        <RoundedRect x={31} y={12} width={66} height={7} r={3} color={teal} />
        <Line p1={{ x: 64, y: 20 }} p2={{ x: 64, y: 35 }} color={theme.border} strokeWidth={4} />
        <Circle cx={64} cy={36} r={8} color={lime} />
        <Line p1={{ x: 64, y: 44 }} p2={{ x: 64, y: 64 }} color={ink} strokeWidth={8} strokeCap="round" />
        <Line p1={{ x: 64, y: 64 }} p2={{ x: 51, y: 82 }} color={teal} strokeWidth={7} strokeCap="round" />
        <Line p1={{ x: 64, y: 64 }} p2={{ x: 77, y: 82 }} color={teal} strokeWidth={7} strokeCap="round" />
        <Line p1={{ x: 60, y: 45 }} p2={{ x: 46, y: 22 }} color={ink} strokeWidth={6} strokeCap="round" />
        <Line p1={{ x: 68, y: 45 }} p2={{ x: 82, y: 22 }} color={ink} strokeWidth={6} strokeCap="round" />
      </>}
    </Canvas>
  </View>;
}
