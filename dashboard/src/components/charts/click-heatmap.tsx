"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ClickPoint {
  x: number;
  y: number;
}

interface ClickHeatmapProps {
  points: ClickPoint[];
}

const WIDTH = 320;
const HEIGHT = 180;
const RADIUS = 20;

function drawHeatmap(canvas: HTMLCanvasElement, points: ClickPoint[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  for (const pt of points) {
    // Normalize to canvas size (assume viewport ~1920x1080)
    const cx = (pt.x / 1920) * WIDTH;
    const cy = (pt.y / 1080) * HEIGHT;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, RADIUS);
    grad.addColorStop(0, "rgba(255,50,50,0.4)");
    grad.addColorStop(1, "rgba(255,50,50,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function ClickHeatmap({ points }: ClickHeatmapProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    if (canvasRef.current) {
      drawHeatmap(canvasRef.current, points);
    }
  }, [points]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Click heatmap</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative bg-muted rounded-md overflow-hidden">
          {points.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              No click data
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            className="w-full"
          />
        </div>
      </CardContent>
    </Card>
  );
}
