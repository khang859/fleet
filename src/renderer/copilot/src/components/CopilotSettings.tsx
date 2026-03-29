import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { MASCOT_REGISTRY } from '../../../../shared/constants';
import { getSpriteSheet } from '../assets/sprite-loader';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSettings(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);
  const installHooks = useCopilotStore((s) => s.installHooks);
  const uninstallHooks = useCopilotStore((s) => s.uninstallHooks);
  const claudeDetected = useCopilotStore((s) => s.claudeDetected);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const currentSound = settings?.notificationSound ?? 'Pop';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={() => setView('sessions')}>
            ←
          </Button>
          <span className="text-xs font-medium text-neutral-200">Settings</span>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-3 py-2 space-y-3">
            {/* Notification Sound */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="text-[10px] text-neutral-400 block mb-1 cursor-help">
                    Notification Sound
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Sound played when an agent needs attention
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-xs">
                    {currentSound || 'None'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-48 overflow-y-auto">
                  <DropdownMenuItem onClick={() => updateSettings({ notificationSound: '' })}>
                    None
                  </DropdownMenuItem>
                  {SYSTEM_SOUNDS.map((sound) => (
                    <DropdownMenuItem
                      key={sound}
                      onClick={() => updateSettings({ notificationSound: sound })}
                    >
                      {sound}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Mascot */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">
                Mascot
              </label>
              <div className="flex gap-2">
                {MASCOT_REGISTRY.map((mascot) => {
                  const isSelected = (settings?.spriteSheet ?? 'spaceship') === mascot.id;
                  const sheet = getSpriteSheet(mascot.id);
                  return (
                    <button
                      key={mascot.id}
                      onClick={() => void updateSettings({ spriteSheet: mascot.id })}
                      className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-neutral-700 hover:border-neutral-500'
                      }`}
                    >
                      <div
                        style={{
                          width: 48,
                          height: 48,
                          backgroundImage: `url(${sheet})`,
                          backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
                          backgroundSize: `${128 * 9 * (48 / 128)}px ${48}px`,
                          backgroundRepeat: 'no-repeat',
                          imageRendering: 'pixelated',
                        }}
                      />
                      <span className="text-[10px] text-neutral-300">{mascot.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Claude Code Status */}
            {!claudeDetected && (
              <div className="rounded bg-amber-900/30 border border-amber-700/50 px-2 py-1.5">
                <span className="text-[10px] text-amber-400 block font-medium mb-0.5">
                  Claude Code not found
                </span>
                <span className="text-[10px] text-amber-400/70 block">
                  Install it with: npm install -g @anthropic-ai/claude-code
                </span>
              </div>
            )}

            {/* Claude Code Hooks */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="text-[10px] text-neutral-400 block mb-1 cursor-help">
                    Claude Code Hooks
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Hooks let Fleet monitor Claude Code sessions for permissions and status changes
                </TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-2">
                <Badge status={hookInstalled ? 'complete' : 'error'} />
                <span className="text-xs text-neutral-300">
                  {hookInstalled ? 'Installed' : 'Not installed'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={hookInstalled ? uninstallHooks : installHooks}
                >
                  {hookInstalled ? 'Uninstall' : 'Install'}
                </Button>
              </div>
              {!hookInstalled && (
                <span className="text-[10px] text-neutral-500 block mt-1">
                  Hooks are required for Fleet to monitor your Claude Code sessions.
                </span>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
