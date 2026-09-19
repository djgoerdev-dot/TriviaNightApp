import React from 'react';
import type { StrokeInk } from '@trivia/shared';
import { pathD, VBW, VBH } from './ink-utils';

interface InkSvgProps {
  ink?: StrokeInk | null;
  strokeUnits?: number; // width in 1000-unit viewBox
  className?: string;
  animate?: boolean; // optional draw-on replay
}

export const InkSvg: React.FC<InkSvgProps> = ({
  ink,
  strokeUnits = 18,
  className = 'w-full h-full block text-current',
  animate = false
}) => {
  if (!ink || !ink.s || ink.s.length === 0) {
    return null;
  }

  const box = ink.box || [VBW, VBH];
  const combinedPath = ink.s.map(s => pathD(s.p)).join(' ');

  return (
    <svg
      viewBox={`0 0 ${box[0]} ${box[1]}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={className}
    >
      <path
        d={combinedPath}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeUnits}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
