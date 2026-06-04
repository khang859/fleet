import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { FileText, FileCode, Database, File } from 'lucide-react';
import type { ArtifactKind } from '../../../../shared/kanban-types';
import type { KanbanArtifactPreviewResponse } from '../../../../shared/ipc-api';

export const KIND_ICON: Record<ArtifactKind, typeof FileText> = {
  document: FileText,
  code: FileCode,
  data: Database,
  other: File
};

/** The expandable preview panel shared by the task-detail and artifacts-browser rows. */
export function ArtifactPreview({
  preview,
  kind
}: {
  preview: KanbanArtifactPreviewResponse | null;
  kind: ArtifactKind;
}): React.JSX.Element {
  return (
    <div className="mt-1 border-t border-neutral-800 pt-1">
      {!preview && <p className="text-[10px] text-neutral-500">Loading preview…</p>}
      {preview && !preview.previewable && (
        <p className="text-[10px] text-amber-400" title={preview.reason}>
          ⚠ Preview unavailable
        </p>
      )}
      {preview && preview.previewable && (
        <>
          {kind === 'document' ? (
            <div className="markdown-preview max-h-64 overflow-y-auto rounded border border-neutral-800 bg-neutral-900 p-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {preview.text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="max-h-64 overflow-auto rounded border border-neutral-800 bg-neutral-900 p-2 text-[10px] text-neutral-300">
              {preview.text}
            </pre>
          )}
          {preview.truncated && (
            <p className="mt-0.5 text-[10px] text-neutral-600">Preview truncated.</p>
          )}
        </>
      )}
    </div>
  );
}
