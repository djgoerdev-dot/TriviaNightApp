import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Stroke, StrokeInk } from '@trivia/shared';
import { VBW, VBH, simplifyPoints, pathD } from './ink-utils';
import { Undo2, Eraser, Lock } from 'lucide-react';

interface InkCanvasProps {
  teamName?: string;
  onStrokeChange?: (ink: StrokeInk) => void;
  isLocked?: boolean;
  maxStrokes?: number;
}

export const InkCanvas: React.FC<InkCanvasProps> = ({
  teamName,
  onStrokeChange,
  isLocked = false,
  maxStrokes = 80
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewBoxWidthRef = useRef<number>(VBW);

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  strokesRef.current = strokes;

  const currentStrokeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  // Redraw canvas content
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = canvas.height / VBH;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.strokeStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.45)';
    ctx.shadowBlur = 1.5;
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const allStrokes = [...strokesRef.current];
    if (currentStrokeRef.current) {
      allStrokes.push(currentStrokeRef.current);
    }

    for (const stroke of allStrokes) {
      if (stroke.p.length >= 2) {
        ctx.stroke(new Path2D(pathD(stroke.p)));
      }
    }
  }, []);

  // Responsive canvas sizing: fit container and dynamically compute matching viewBox width
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const { width: w, height: h } = container.getBoundingClientRect();
    if (w <= 0 || h <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    // Maintain uniform 1:1 scale by sizing viewBox width proportionally to height
    const vbw = Math.round(VBH * (w / h));
    viewBoxWidthRef.current = vbw;

    redraw();
  }, [redraw]);

  useEffect(() => {
    handleResize();
    const container = containerRef.current;
    let ro: ResizeObserver | null = null;
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        handleResize();
      });
      ro.observe(container);
    }

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [handleResize]);

  const emitInkChange = useCallback((updatedStrokes: Stroke[]) => {
    if (onStrokeChange) {
      onStrokeChange({
        v: 1,
        box: [viewBoxWidthRef.current, VBH],
        s: updatedStrokes
      });
    }
  }, [onStrokeChange]);

  useEffect(() => {
    if (isLocked && activePointerIdRef.current !== null && currentStrokeRef.current) {
      if (currentStrokeRef.current.p.length >= 2) {
        const simplified = simplifyPoints(currentStrokeRef.current.p, 1.8);
        const newStroke: Stroke = {
          t: currentStrokeRef.current.t,
          p: simplified
        };
        const updated = [...strokesRef.current, newStroke];
        strokesRef.current = updated;
        setStrokes(updated);
        emitInkChange(updated);
      }
      activePointerIdRef.current = null;
      currentStrokeRef.current = null;
    }
    redraw();
  }, [strokes, isLocked, emitInkChange, redraw]);

  const toViewBoxCoords = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const vbw = viewBoxWidthRef.current;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * vbw);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * VBH);
    return [x, y];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isLocked) return;
    if (activePointerIdRef.current !== null) return; // one finger palm rejection
    if (strokes.length >= maxStrokes) return;

    activePointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {}

    const [x, y] = toViewBoxCoords(e);
    currentStrokeRef.current = {
      t: Date.now() - startTimeRef.current,
      p: [x, y]
    };
    redraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointerIdRef.current || !currentStrokeRef.current) return;

    const nativeEvent = e.nativeEvent as any;
    const coalesced: PointerEvent[] = nativeEvent.getCoalescedEvents
      ? nativeEvent.getCoalescedEvents()
      : [nativeEvent];

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const vbw = viewBoxWidthRef.current;

    for (const ev of coalesced) {
      const x = Math.round(((ev.clientX - rect.left) / rect.width) * vbw);
      const y = Math.round(((ev.clientY - rect.top) / rect.height) * VBH);
      const p = currentStrokeRef.current.p;
      const len = p.length;

      // Avoid recording identical points
      if (len >= 2 && Math.hypot(x - p[len - 2], y - p[len - 1]) < 2) {
        continue;
      }
      p.push(x, y);
    }

    redraw();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;

    if (currentStrokeRef.current && currentStrokeRef.current.p.length >= 2) {
      const simplified = simplifyPoints(currentStrokeRef.current.p, 1.8);
      const newStroke: Stroke = {
        t: currentStrokeRef.current.t,
        p: simplified
      };

      const updated = [...strokes, newStroke];
      setStrokes(updated);
      emitInkChange(updated);
    }

    currentStrokeRef.current = null;
    redraw();
  };

  const handleUndo = () => {
    if (isLocked || strokes.length === 0) return;
    const updated = strokes.slice(0, -1);
    setStrokes(updated);
    emitInkChange(updated);
  };

  const handleClear = () => {
    if (isLocked || strokes.length === 0) return;
    setStrokes([]);
    emitInkChange([]);
  };

  return (
    <div className="flex-1 w-full bg-[#18231F] border-2 border-[#2B3A33] rounded-2xl p-2 shadow-inner flex flex-col justify-between min-h-0 overflow-hidden">
      {/* Blackboard Card Header: Exact match to Answer Board */}
      <div className="w-full text-[11px] font-bold uppercase tracking-wider text-[#8C9F97] mb-1 px-1 flex items-center justify-between flex-none">
        <span>Team: <b className="text-white font-extrabold">{teamName || 'Your Team'}</b></span>
        <span className="font-mono text-[10px] text-[#6A7D75]">Your Chalkboard</span>
      </div>

      {/* Chalkboard Drawing Surface: Stretches full-width across card */}
      <div className="flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden">
        <div
          ref={containerRef}
          style={{
            backgroundImage:
              'linear-gradient(to bottom, transparent calc(70% - 1px), rgba(255, 255, 255, 0.12) calc(70% - 1px), rgba(255, 255, 255, 0.12) 70%, transparent 70%)'
          }}
          className={`relative w-full h-full bg-[#121916] rounded-xl border border-[#25332C] overflow-hidden flex items-center justify-center shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)] ${
            isLocked ? 'cursor-not-allowed' : 'cursor-crosshair'
          }`}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`block w-full h-full ${
              isLocked ? 'pointer-events-none' : 'touch-none'
            }`}
          />

          {/* Placeholder hint when canvas is clean */}
          {!isLocked && strokes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-[#6A8177] text-xs md:text-sm font-medium select-none tracking-wide">
              Write your answer in chalk
            </div>
          )}

          {/* Lock Badges & Indicators */}
          {isLocked && strokes.length > 0 && (
            <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 px-2.5 py-1 bg-[#132A20] text-[#42DB99] border border-[#2EA572] rounded-full text-xs font-bold uppercase tracking-wider shadow-md animate-fade-in">
              <Lock size={12} />
              <span>Answer locked</span>
            </div>
          )}

          {isLocked && strokes.length === 0 && (
            <>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-[#5A6C65] text-xs md:text-sm font-medium select-none italic">
                — no answer recorded —
              </div>
              <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 px-2.5 py-1 bg-[#1E2623] text-[#8C9F97] border border-[#3A4843] rounded-full text-xs font-bold uppercase tracking-wider shadow-sm animate-fade-in">
                <span>No answer</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Action buttons & Stroke Counter (Matches full card width) */}
      <div className="w-full flex items-center justify-between px-1 pt-1.5 flex-none h-8">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={isLocked || strokes.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold bg-[#1F2925] border border-[#31413A] rounded-lg text-[#D3DFDA] hover:bg-[#27342F] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-sm"
          >
            <Undo2 size={13} />
            <span>Undo</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={isLocked || strokes.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold bg-[#1F2925] border border-[#31413A] rounded-lg text-[#A2B5AD] hover:text-[#FFA399] hover:bg-[#341F1D] hover:border-[#602B26] disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-sm"
          >
            <Eraser size={13} />
            <span>Clear</span>
          </button>
        </div>

        <div className="text-right text-[11px] font-mono text-[#7E9189]">
          {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
        </div>
      </div>
    </div>
  );
};
