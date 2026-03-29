import type { ReactNode } from 'react';
import { crtFrame, crtScanline, CRT_SLICE } from '../assets/crt-sprites';

// border-image-slice as percentage of the 160px source image
const SLICE_PCT = Math.round((CRT_SLICE / 160) * 100); // 37%
const BORDER_WIDTH = 16; // rendered border thickness in px

export function CrtFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="relative h-full pixelated"
      style={{
        background: '#171717',
        borderImage: `url("${crtFrame}") ${SLICE_PCT}% / ${BORDER_WIDTH}px / 0 stretch`,
        borderStyle: 'solid',
      }}
    >
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `url("${crtScanline}")`,
          backgroundRepeat: 'repeat',
          opacity: 0.05,
        }}
      />

      {/* Content */}
      <div className="relative h-full flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
