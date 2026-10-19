import Svg, { Path } from 'react-native-svg';

// Arxd mono glyph: two diagonally cut eyes and one crescent smile.
// Geometry lives in assets/rxd-mono.svg (256x256 viewBox) and is duplicated
// here so the mark renders as vector at any size and takes the theme color.
const EYE_LEFT = 'M40 66 113 128 87 149 40 111Z';
const EYE_RIGHT = 'M216 66 143 128 169 149 216 111Z';
const SMILE = 'M40 148C66 169 96 184 128 184s62-15 88-36c-11 47-47 76-88 76s-77-29-88-76Z';

export function Mark({ size = 24, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessible={false}>
      <Path d={EYE_LEFT} fill={color} />
      <Path d={EYE_RIGHT} fill={color} />
      <Path d={SMILE} fill={color} />
    </Svg>
  );
}
