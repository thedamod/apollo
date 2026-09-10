import React, { useMemo } from "react";
import Svg, { Polyline } from "react-native-svg";

/** Tiny history sparkline like the mock's CPU/RAM/Disk tiles. */
export function Sparkline({
  values,
  color,
  width = 140,
  height = 28,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  const points = useMemo(() => {
    const v = values.length > 1 ? values : [0, 0];
    const min = Math.min(...v);
    const max = Math.max(...v);
    const span = max - min || 1;
    return v
      .map((n, i) => {
        const x = (i / (v.length - 1)) * width;
        const y = height - 3 - ((n - min) / span) * (height - 6);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values, width, height]);
  return (
    <Svg width={width} height={height}>
      <Polyline points={points} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
