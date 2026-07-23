import type { ReactNode } from 'react';

interface SafeMarkdownProps {
  children: string;
}

function plainInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, 'Image omitted: $1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/[*_~`]+/gu, '')
    .trim();
}

function renderBlock(block: string, blockIndex: number): ReactNode {
  const lines = block.split('\n').map((line) => line.trimEnd());
  const first = lines[0] ?? '';
  const heading = /^(#{1,4})\s+(.+)$/u.exec(first);
  if (heading && lines.length === 1) {
    const text = plainInline(heading[2] ?? '');
    if (heading[1]?.length === 1) return <h2 key={blockIndex}>{text}</h2>;
    if (heading[1]?.length === 2) return <h3 key={blockIndex}>{text}</h3>;
    return <h4 key={blockIndex}>{text}</h4>;
  }
  if (lines.every((line) => /^\s*[-*]\s+/u.test(line))) {
    return (
      <ul key={blockIndex}>
        {lines.map((line, lineIndex) => (
          <li key={`${blockIndex}-${lineIndex}`}>
            {plainInline(line.replace(/^\s*[-*]\s+/u, ''))}
          </li>
        ))}
      </ul>
    );
  }
  if (first.startsWith('```') && lines.at(-1)?.startsWith('```')) {
    return <pre key={blockIndex}>{lines.slice(1, -1).join('\n')}</pre>;
  }
  return <p key={blockIndex}>{plainInline(lines.join(' '))}</p>;
}

/** A deliberately small Markdown renderer: it never creates HTML, links, images, or embeds. */
export function SafeMarkdown({ children }: SafeMarkdownProps) {
  const blocks = children
    .replaceAll('\r\n', '\n')
    .split(/\n\s*\n/gu)
    .map((block) => block.trim())
    .filter(Boolean);
  return <div className="safe-markdown">{blocks.map(renderBlock)}</div>;
}
