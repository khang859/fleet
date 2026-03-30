import type { ReactNode } from 'react';

export function CrtFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="relative h-full rounded-lg overflow-hidden"
      style={{
        background: '#0a0e14',
        border: '4px solid #1a3a4a',
        boxShadow:
          'inset 0 0 30px rgba(0, 200, 200, 0.03), 0 0 15px rgba(0, 200, 200, 0.15), 0 0 40px rgba(0, 200, 200, 0.05)',
      }}
    >
      {/* Top accent bar */}
      <div
        className="absolute top-0 left-8 right-8 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, #0ff3, transparent)' }}
      />

      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 rounded-tl-lg" style={{ borderColor: '#0ff6' }} />
      <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 rounded-tr-lg" style={{ borderColor: '#0ff6' }} />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 rounded-bl-lg" style={{ borderColor: '#0ff6' }} />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 rounded-br-lg" style={{ borderColor: '#0ff6' }} />

      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.01) 2px, rgba(0,255,255,0.01) 4px)',
        }}
      />

      {/* Content */}
      <div className="relative h-full flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
