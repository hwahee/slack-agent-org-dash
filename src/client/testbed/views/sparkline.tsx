/**
 * Events per second over the last 60 s, drawn on a `<canvas>` by its own
 * animation frames (docs/testbed/dashboard.md §3) — React only hands it the
 * latest events.
 */
import { useEffect, useRef } from 'react';

import type { TestbedEvent } from '@shared/testbed/events';

import { TESTID } from '../../testing/testids';
import { eventsPerSecond } from './stats';

const WIDTH = 360;
const HEIGHT = 64;

export function Sparkline({ events, label }: { events: readonly TestbedEvent[]; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(events);
  useEffect(() => {
    latest.current = events;
  }, [events]);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = WIDTH * ratio;
    element.height = HEIGHT * ratio;
    context.scale(ratio, ratio);
    let frame = 0;
    let lastSecond = -1;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const now = Date.now();
      // Redraw only when the second (or the data) changes.
      const second = Math.floor(now / 1000) * 1e6 + latest.current.length;
      if (second === lastSecond) return;
      lastSecond = second;
      const buckets = eventsPerSecond(latest.current, now);
      const max = Math.max(1, ...buckets);
      const style = getComputedStyle(element);
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.strokeStyle = style.color;
      context.lineWidth = 1.5;
      context.beginPath();
      buckets.forEach((count, index) => {
        const x = (index / (buckets.length - 1)) * (WIDTH - 2) + 1;
        const y = HEIGHT - 2 - (count / max) * (HEIGHT - 4);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvas}
      className="tb-sparkline"
      style={{ width: WIDTH, height: HEIGHT }}
      role="img"
      aria-label={label}
      data-testid={TESTID.testbed.stats.sparkline}
    />
  );
}
