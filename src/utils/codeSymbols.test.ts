import { describe, expect, it } from 'vitest';
import { isConfigLanguage, isScriptLanguage } from '@/components/FileBadge';
import { extractCodeSymbols } from '@/utils/codeSymbols';

describe('extractCodeSymbols & FileBadge classification', () => {
  it('extracts Python classes and functions with line numbers', () => {
    const py = [
      'import os',
      '',
      'class NeuralOperator:',
      '    def __init__(self, modes: int):',
      '        self.modes = modes',
      '',
      '    async def forward(self, x):',
      '        return x',
    ].join('\n');

    const symbols = extractCodeSymbols(py, 'python');
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({
      text: 'class NeuralOperator',
      line: 3,
      symbolKind: 'class',
    });
    expect(symbols[1]).toMatchObject({
      text: '__init__()',
      line: 4,
      symbolKind: 'function',
    });
    expect(symbols[2]).toMatchObject({
      text: 'forward()',
      line: 7,
      symbolKind: 'function',
    });
  });

  it('extracts shallow JSON keys for outline navigation', () => {
    const jsonText = [
      '{',
      '  "destination": "E:/lab",',
      '  "date": "2026-10-26",',
      '  "files": [',
      '    {',
      '      "path": "nested.py"',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const symbols = extractCodeSymbols(jsonText, 'json');
    expect(symbols.map((s) => s.text)).toEqual([
      'destination',
      'date',
      'files',
      'path',
    ]);
    expect(symbols[0].line).toBe(2);
  });

  it('separates executable script languages from config/data languages', () => {
    expect(isScriptLanguage('python')).toBe(true);
    expect(isScriptLanguage('rust')).toBe(true);
    expect(isScriptLanguage('json')).toBe(false);
    expect(isConfigLanguage('json')).toBe(true);
    expect(isConfigLanguage('toml')).toBe(true);
    expect(isConfigLanguage('python')).toBe(false);
  });
});
