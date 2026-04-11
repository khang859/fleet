import { Terminal, Folder, FileText } from 'lucide-react';
import { shortenPath } from '../lib/shorten-path';

const ASCII_LINES = [
  '███████╗██╗     ███████╗███████╗████████╗',
  '██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝',
  '█████╗  ██║     █████╗  █████╗     ██║   ',
  '██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ',
  '██║     ███████╗███████╗███████╗   ██║   ',
  '╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   '
];

const LINE_COLORS = [
  'text-teal-500',
  'text-teal-500',
  'text-cyan-500',
  'text-cyan-500',
  'text-cyan-400',
  'text-cyan-400'
];

type DashboardProps = {
  recentFiles: string[];
  recentFolders: string[];
  onNewTerminal: () => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
};

export function Dashboard({
  recentFiles,
  recentFolders,
  onNewTerminal,
  onOpenFile,
  onOpenFolder
}: DashboardProps): React.JSX.Element {
  const displayFiles = recentFiles.slice(0, 10);
  const displayFolders = recentFolders.slice(0, 10);

  return (
    <div className="flex items-center justify-center h-full select-none">
      <div className="flex flex-col items-center gap-8 max-w-xl">
        {/* ASCII Art Header */}
        <pre className="text-sm leading-tight font-mono">
          {ASCII_LINES.map((line, i) => (
            <span key={line} className={`block ${LINE_COLORS[i]}`}>
              {line}
            </span>
          ))}
        </pre>

        {/* Tagline */}
        <p className="text-neutral-600 text-xs tracking-wide">terminal multiplexer for ai agents</p>

        {/* New Terminal Action */}
        <button
          onClick={onNewTerminal}
          className="flex items-center gap-3 text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer group"
        >
          <Terminal size={16} />
          <span className="text-sm">New Terminal</span>
          <kbd className="text-xs text-neutral-600 group-hover:text-neutral-500 ml-2">⌘T</kbd>
        </button>

        {/* Recent Folders */}
        {displayFolders.length > 0 && (
          <div className="w-full">
            <h3 className="text-neutral-600 text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
              <Folder size={12} />
              Recent Folders
            </h3>
            <ul className="space-y-1">
              {displayFolders.map((folder) => (
                <li key={folder}>
                  <button
                    onClick={() => onOpenFolder(folder)}
                    className="text-sm text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer truncate block w-full text-left"
                  >
                    {shortenPath(folder)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent Files */}
        {displayFiles.length > 0 && (
          <div className="w-full">
            <h3 className="text-neutral-600 text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
              <FileText size={12} />
              Recent Files
            </h3>
            <ul className="space-y-1">
              {displayFiles.map((file) => (
                <li key={file}>
                  <button
                    onClick={() => onOpenFile(file)}
                    className="text-sm text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer truncate block w-full text-left"
                  >
                    {shortenPath(file)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
