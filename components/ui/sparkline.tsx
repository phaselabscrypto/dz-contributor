"use client";

import { useMemo } from "react";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
  fill?: string;
}

/**
 * Lightweight inline SVG sparkline. No external lib, ~0KB cost.
 * Renders min/max range with a smooth area fill underneath.
 */
export function Sparkline({
  data,
  width = 220,
  height = 56,
  className,
  stroke = "currentColor",
  fill = "currentColor",
}: SparklineProps) {
  const path = useMemo(() => {
    if (data.length === 0) return { line: "", area: "" };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = data.length > 1 ? width / (data.length - 1) : 0;
    const points = data.map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return [x, y] as const;
    });
    const line = points
      .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
      .join(" ");
    const area =
      `M0,${height} ` +
      points.map(([x, y]) => `L${x},${y}`).join(" ") +
      ` L${width},${height} Z`;
    return { line, area };
  }, [data, width, height]);

  if (data.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <path d={path.area} fill={fill} fillOpacity={0.12} />
      <path d={path.line} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}
