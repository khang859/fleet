import { useEffect, useRef, useState } from 'react';
import type { BundledLanguage, Highlighter } from 'shiki';
import { getLanguageForPath } from '../../../../shared/languages';

let highlighterPromise: Promise<Highlighter> | null = null;
let bundledLangSet: Set<string> | null = null;

/** Core languages to pre-load with the highlighter */
const PRELOAD_LANGS = [
  'typescript',
  'javascript',
  'json',
  'html',
  'css',
  'python',
  'bash',
  'yaml',
  'markdown',
  'tsx',
  'jsx',
  'rust',
  'go'
] as const;

function isBundledLanguage(id: string): id is BundledLanguage {
  return bundledLangSet?.has(id) === true;
}

async function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then(async (mod) => {
    bundledLangSet = new Set(Object.keys(mod.bundledLanguages));
    return mod.createHighlighter({
      themes: ['one-dark-pro'],
      langs: [...PRELOAD_LANGS]
    });
  });
  return highlighterPromise;
}

type Props = {
  content: string;
  filePath: string;
};

export function ShikiPreview({ content, filePath }: Props): React.JSX.Element {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setHighlightedHtml(null);

    const langInfo = getLanguageForPath(filePath);
    if (!langInfo) return;

    void (async () => {
      try {
        const highlighter = await getHighlighter();

        // Load the language grammar if not already loaded
        const loadedLangs = highlighter.getLoadedLanguages();
        if (!loadedLangs.includes(langInfo.id)) {
          if (!isBundledLanguage(langInfo.id)) return; // not a Shiki language
          try {
            await highlighter.loadLanguage(langInfo.id);
          } catch {
            // Language not available in Shiki — fall back to plain text
            return;
          }
        }

        if (generation !== generationRef.current) return; // stale

        const html = highlighter.codeToHtml(content, {
          lang: langInfo.id,
          theme: 'one-dark-pro'
        });

        if (generation === generationRef.current) {
          setHighlightedHtml(html);
        }
      } catch {
        // Shiki failed — leave highlightedHtml null to show fallback
      }
    })();
  }, [content, filePath]);

  if (highlightedHtml) {
    return (
      <div
        className="shiki-preview text-[11px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!text-[11px] [&_code]:!leading-relaxed"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  // Fallback: plain text (shown immediately, or when language is unknown)
  return (
    <pre className="text-[11px] text-neutral-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
      {content}
    </pre>
  );
}
