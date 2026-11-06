'use client';

import { useEffect, useRef } from 'react';
import { LAND_B64, LAND_H, LAND_W } from './landMask';

// Decode the land bitmap. Rows that are almost all land outside Antarctica are
// artifacts from shapes crossing the date line, so they count as water.
function loadLand() {
  const bytes = Uint8Array.from(atob(LAND_B64), (c) => c.charCodeAt(0));
  const bit = (x: number, y: number) => {
    const i = y * LAND_W + x;
    return (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  };
  const bad = new Set<number>();
  for (let y = 0; y < LAND_H * 0.8; y++) {
    let n = 0;
    for (let x = 0; x < LAND_W; x++) n += bit(x, y);
    if (n > LAND_W * 0.9) bad.add(y);
  }
  return (lat: number, lon: number) => {
    const y = Math.min(LAND_H - 1, Math.floor(((90 - lat) / 180) * LAND_H));
    const x = Math.min(LAND_W - 1, Math.floor(((lon + 180) / 360) * LAND_W));
    return !bad.has(y) && bit(x, y) === 1;
  };
}

// A slowly spinning dotted globe behind the hero: continents drawn in dots, lime "agents" pinging on top.
export default function HeroGlobe() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Even spread of points over the sphere, kept only where there is land.
    const isLand = loadLand();
    const N = 9000;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = i * Math.PI * (3 - Math.sqrt(5));
      const x = Math.cos(t) * r;
      const z = Math.sin(t) * r;
      const lat = (Math.asin(y) * 180) / Math.PI;
      const lon = (Math.atan2(z, x) * 180) / Math.PI;
      if (isLand(lat, lon)) pts.push([x, -y, -z]); // flip z so the map is not mirrored
    }
    const agents = Array.from({ length: 14 }, (_, i) => pts[(i * 211 + 37) % pts.length]);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let angle = 0;
    const tilt = 0.35;

    const draw = (time: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) / 2 - 4;
      const cx = w / 2;
      const cy = h / 2;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      const project = ([x, y, z]: [number, number, number]) => {
        const x1 = x * cosA - z * sinA;
        const z1 = x * sinA + z * cosA;
        const y2 = y * cosT - z1 * sinT;
        const z2 = y * sinT + z1 * cosT;
        return [cx + x1 * R, cy + y2 * R, z2] as const;
      };

      // outline
      ctx.fillStyle = '#ebe8d6';
      ctx.strokeStyle = '#1f1f21';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      for (const p of pts) {
        const [sx, sy, z] = project(p);
        if (z < 0) continue;
        ctx.fillStyle = '#1f1f21';
        ctx.beginPath();
        ctx.arc(sx, sy, 0.8 + 1.1 * z, 0, Math.PI * 2);
        ctx.fill();
      }

      agents.forEach((p, i) => {
        const [sx, sy, z] = project(p);
        if (z < 0) return;
        const pulse = (time / 1600 + i / agents.length) % 1;
        ctx.strokeStyle = '#1f1f21';
        ctx.globalAlpha = 1 - pulse;
        ctx.beginPath();
        ctx.arc(sx, sy, 4 + pulse * 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#d3fb43';
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      if (!reduce) angle += 0.0025;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: '50%',
        top: 40,
        transform: 'translateX(-50%)',
        width: 'min(820px, 92vw)',
        aspectRatio: '1 / 1',
        zIndex: -1,
        opacity: 0.6,
        pointerEvents: 'none',
      }}
    />
  );
}
