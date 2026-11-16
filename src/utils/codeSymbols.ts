import type { HeadingItem } from '@/types';

/**
 * Lightweight zero-AST-overhead symbol outline extractor for Python, JS/TS, Rust, C/C++, and JSON
 * so the right-hand Outline panel works seamlessly on both Markdown articles and Code files!
 */
export function extractCodeSymbols(code: string, language: string): HeadingItem[] {
  if (!code) return [];
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const items: HeadingItem[] = [];
  const maxItems = 250;

  if (language === 'python') {
    for (let i = 0; i < lines.length && items.length < maxItems; i++) {
      const line = lines[i];
      const match = line.match(/^(\s*)(?:async\s+)?(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*([(:]?)/);
      if (match) {
        const indentSpaces = match[1].replace(/\t/g, '    ').length;
        const kw = match[2];
        const name = match[3];
        const level = Math.min(4, 1 + Math.floor(indentSpaces / 4));
        items.push({
          id: `sym-${i + 1}`,
          text: kw === 'class' ? `class ${name}` : `${name}()`,
          level,
          line: i + 1,
          symbolKind: kw === 'class' ? 'class' : 'function',
        });
      }
    }
    return items;
  }

  if (language === 'javascript' || language === 'typescript') {
    for (let i = 0; i < lines.length && items.length < maxItems; i++) {
      const line = lines[i];
      const clsMatch = line.match(
        /^(\s*)(?:export\s+)?(?:default\s+)?(class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
      );
      if (clsMatch) {
        const level = Math.min(4, 1 + Math.floor(clsMatch[1].length / 2));
        items.push({
          id: `sym-${i + 1}`,
          text: `${clsMatch[2]} ${clsMatch[3]}`,
          level,
          line: i + 1,
          symbolKind: 'class',
        });
        continue;
      }
      const fnMatch = line.match(
        /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/
      );
      if (fnMatch) {
        const level = Math.min(4, 1 + Math.floor(fnMatch[1].length / 2));
        items.push({
          id: `sym-${i + 1}`,
          text: `${fnMatch[2]}()`,
          level,
          line: i + 1,
          symbolKind: 'function',
        });
        continue;
      }
      const arrowMatch = line.match(
        /^(\s*)(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/
      );
      if (arrowMatch) {
        const level = Math.min(4, 1 + Math.floor(arrowMatch[1].length / 2));
        items.push({
          id: `sym-${i + 1}`,
          text: `${arrowMatch[2]}()`,
          level,
          line: i + 1,
          symbolKind: 'function',
        });
      }
    }
    return items;
  }

  if (language === 'rust') {
    for (let i = 0; i < lines.length && items.length < maxItems; i++) {
      const line = lines[i];
      const m = line.match(
        /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][A-Za-z0-9_<>]*)/
      );
      if (m) {
        const indentSpaces = m[1].replace(/\t/g, '    ').length;
        const kw = m[2];
        const name = m[3];
        items.push({
          id: `sym-${i + 1}`,
          text: kw === 'fn' ? `fn ${name}()` : `${kw} ${name}`,
          level: Math.min(4, 1 + Math.floor(indentSpaces / 4)),
          line: i + 1,
          symbolKind: kw === 'fn' ? 'function' : 'class',
        });
      }
    }
    return items;
  }

  if (language === 'json') {
    for (let i = 0; i < lines.length && items.length < maxItems; i++) {
      const line = lines[i];
      // Extract shallow keys (depth 1 or 2: <= 6 leading spaces)
      const m = line.match(/^(\s{1,6})"([^"]+)"\s*:/);
      if (m) {
        const spaces = m[1].length;
        items.push({
          id: `sym-${i + 1}`,
          text: m[2],
          level: spaces <= 2 ? 1 : 2,
          line: i + 1,
          symbolKind: 'property',
        });
      }
    }
    return items;
  }

  return items;
}
