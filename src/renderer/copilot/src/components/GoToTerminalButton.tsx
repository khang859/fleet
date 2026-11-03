import type React from 'react';
import { TerminalSquare } from 'lucide-react';
import type { SessionRef } from '../../../../shared/claude-sessions';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** Brings the main window forward on the session's pane and closes the panel. */
export function GoToTerminalButton({ session }: { session: SessionRef }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Go to terminal"
          onClick={(e) => {
            e.stopPropagation();
            void window.copilot.focusTerminal(session);
          }}
        >
          <TerminalSquare size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Go to terminal</TooltipContent>
    </Tooltip>
  );
}
