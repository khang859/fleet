import type { ReactNode } from 'react';
import {
  crtCornerTl as cornerTL,
  crtCornerTr as cornerTR,
  crtCornerBl as cornerBL,
  crtCornerBr as cornerBR,
  crtEdgeH as edgeH,
  crtEdgeV as edgeV,
  crtScanline as scanline,
} from '../assets/crt-sprites';

const CORNER = 32; // px - matches cropped corner size
const EDGE = 16;   // px - matches cropped edge thickness

export function CrtFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="relative h-full" style={{ background: '#171717' }}>
      {/* Corners */}
      <img
        src={cornerTL}
        alt=""
        className="pixelated absolute top-0 left-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerTR}
        alt=""
        className="pixelated absolute top-0 right-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerBL}
        alt=""
        className="pixelated absolute bottom-0 left-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerBR}
        alt=""
        className="pixelated absolute bottom-0 right-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />

      {/* Horizontal edges (top and bottom) */}
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          top: 0,
          left: CORNER,
          right: CORNER,
          height: EDGE,
          backgroundImage: `url(${edgeH})`,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `auto ${EDGE}px`,
        }}
      />
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          bottom: 0,
          left: CORNER,
          right: CORNER,
          height: EDGE,
          backgroundImage: `url(${edgeH})`,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `auto ${EDGE}px`,
          transform: 'scaleY(-1)',
        }}
      />

      {/* Vertical edges (left and right) */}
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          left: 0,
          top: CORNER,
          bottom: CORNER,
          width: EDGE,
          backgroundImage: `url(${edgeV})`,
          backgroundRepeat: 'repeat-y',
          backgroundSize: `${EDGE}px auto`,
        }}
      />
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          right: 0,
          top: CORNER,
          bottom: CORNER,
          width: EDGE,
          backgroundImage: `url(${edgeV})`,
          backgroundRepeat: 'repeat-y',
          backgroundSize: `${EDGE}px auto`,
          transform: 'scaleX(-1)',
        }}
      />

      {/* Scanline overlay */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: EDGE,
          left: EDGE,
          right: EDGE,
          bottom: EDGE,
          backgroundImage: `url(${scanline})`,
          backgroundRepeat: 'repeat',
          opacity: 0.05,
        }}
      />

      {/* Content area - padded to sit inside the frame */}
      <div
        className="relative h-full flex flex-col overflow-hidden"
        style={{
          paddingTop: CORNER,
          paddingBottom: EDGE,
          paddingLeft: EDGE,
          paddingRight: EDGE,
        }}
      >
        {children}
      </div>
    </div>
  );
}
