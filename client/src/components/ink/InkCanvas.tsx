import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Stroke, StrokeInk } from '@trivia/shared';
import { VBW, VBH, simplifyPoints, pathD } from './ink-utils';
import { Undo2, Trash2, Lock } from 'lucide-react';

interface InkCanvasProps {
  onStrokeChange?: (ink: StrokeInk) => void;
  isLocked?: boolean;
  maxStrokes?: number;
}

export const InkCanvas: React.FC<InkCanvasProps> = ({
  onStrokeChange,
  isLocked = false,
  maxStrokes = 80
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  strokesRef.current = strokes;

  const currentStrokeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  // Redraw canvas content
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = canvas.width / VBW;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.strokeStyle = '#14181A';
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

  // Responsive canvas sizing
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.width * (VBH / VBW) * dpr);

    redraw();
  }, [redraw]);

  useEffect(() => {
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  const emitInkChange = useCallback((updatedStrokes: Stroke[]) => {
    if (onStrokeChange) {
      onStrokeChange({
        v: 1,
        box: [VBW, VBH],
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
    const x = Math.round(((e.clientX - rect.left) / rect.width) * VBW);
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

    for (const ev of coalesced) {
      const x = Math.round(((ev.clientX - rect.left) / rect.width) * VBW);
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
    <div className="w-full flex flex-col gap-2">
      <div
        ref={containerRef}
        className={`relative w-full rounded-xl border border-[#D2DACF] overflow-hidden transition-colors ${
          isLocked ? 'bg-[#E3E9E1] cursor-not-allowed' : 'bg-white shadow-sm'
        }`}
        style={{
          // Ruled baseline at 72% height (matching the 250px baseline in 360px box)
          backgroundImage: 'linear-gradient(to bottom, transparent calc(70% - 1px), #D2DACF calc(70% - 1px), #D2DACF 70%, transparent 70%)'
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`block w-full aspect-[1000/360] ${
            isLocked ? 'pointer-events-none' : 'cursor-crosshair touch-none'
          }`}
        />

        {/* Placeholder hint when canvas is clean */}
        {!isLocked && strokes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-[#5C6B64] text-sm md:text-base font-medium select-none">
            Write your answer with your finger
          </div>
        )}

        {/* Lock Badges & Indicators */}
        {isLocked && strokes.length > 0 && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1 bg-[#D9EDE5] text-[#1B7A5A] rounded-full text-xs font-bold uppercase tracking-wider shadow-sm animate-fade-in">
            <Lock size={13} />
            <span>Answer locked</span>
          </div>
        )}

        {isLocked && strokes.length === 0 && (
          <>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-[#8C9A93] text-sm md:text-base font-medium select-none italic">
              — no answer recorded —
            </div>
            <div className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1 bg-[#EFF2EE] text-[#5C6B64] border border-[#D2DACF] rounded-full text-xs font-bold uppercase tracking-wider shadow-sm animate-fade-in">
              <span>No answer</span>
            </div>
          </>
        )}
      </div>

      {/* Action buttons & Stroke Counter */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={isLocked || strokes.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-[#D2DACF] rounded-lg text-[#14181A] hover:bg-[#F4F7F3] disabled:opacity-35 disabled:cursor-not-allowed transition-all"
          >
            <Undo2 size={13} />
            <span>Undo</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={isLocked || strokes.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#5C6B64] hover:text-[#B93E33] hover:bg-[#F6DEDB] rounded-lg disabled:opacity-35 disabled:cursor-not-allowed transition-all"
          >
            <Trash2 size={13} />
            <span>Clear</span>
          </button>
        </div>

        <div className="text-right text-[11px] font-mono text-[#5C6B64]">
          {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
        </div>
      </div>
    </div>
  );
};
