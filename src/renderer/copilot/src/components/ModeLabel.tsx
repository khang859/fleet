import type { ClaudePermissionMode } from '../../../../shared/claude-sessions';
import { modeName } from '../lib/format-permission';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/**
 * The session's mode as Claude Code last reported it. It lags: Shift+Tab sends
 * Fleet nothing, so a switch shows only at the next prompt, stop or ask.
 */
export function ModeLabel({
  mode
}: {
  mode: ClaudePermissionMode | undefined;
}): React.JSX.Element | null {
  if (!mode) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 rounded border border-neutral-700 px-1 text-[10px] leading-4 text-neutral-400">
          {modeName(mode)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">
        The mode Claude last reported. A Shift+Tab switch shows at the next prompt, stop or
        permission ask.
      </TooltipContent>
    </Tooltip>
  );
}
