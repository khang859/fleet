import { useEffect, useRef } from 'react';
import { EmptyState } from './components/EmptyState';
import { Notes } from './components/Notes';
import { ResizeGrip } from './components/ResizeGrip';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useTeleprompterState } from './lib/use-teleprompter';

export function App(): React.JSX.Element | null {
  const state = useTeleprompterState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const index = state?.index;

  // A new section starts at its top; a live reload of the same one keeps its scroll.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [index]);

  if (!state) return null;
  const message = state.error;

  return (
    <div className="group h-full w-full">
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-xl border border-white/10 text-white/95"
        style={{ backgroundColor: `rgb(12 14 18 / ${state.opacity})` }}
      >
        {!state.locked && <Toolbar state={state} />}
        <div
          ref={scrollRef}
          className={`tp-scroll min-h-0 flex-1 overflow-y-auto px-5 ${state.locked ? 'pt-4' : 'pt-1'} pb-2`}
        >
          {state.total === 0 ? (
            <EmptyState locked={state.locked} />
          ) : (
            <Notes markdown={state.current} fontSize={state.fontSize} />
          )}
        </div>
        {message && (
          <div className="shrink-0 truncate px-5 text-[12px] text-amber-300" title={message}>
            {message}
          </div>
        )}
        <StatusBar state={state} />
        {!state.locked && <ResizeGrip />}
      </div>
    </div>
  );
}
