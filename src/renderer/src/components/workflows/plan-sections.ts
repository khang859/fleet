export type PlanSection = { level: number; title: string };

const HEADING = /^(#{1,3})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(```|~~~)/;

/** The headings of a plan, for the section list. A code block holds none. */
export function planSections(text: string): PlanSection[] {
  const sections: PlanSection[] = [];
  let inCode = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inCode = !inCode;
    const match = inCode ? null : HEADING.exec(line);
    if (match) sections.push({ level: match[1].length, title: plainText(match[2]) });
  }
  return sections;
}

/** What the page shows for a heading, so a jump can find it. */
function plainText(title: string): string {
  return title.replace(/[`*_]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}
