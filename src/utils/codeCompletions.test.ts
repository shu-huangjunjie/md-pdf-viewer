import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  analyzeDocumentForCompletions,
  buildLanguageCompletionSource,
  extractImportedPythonModules,
  type IntelliSenseExternalContext,
} from './codeCompletions';

const EMPTY_EXT: IntelliSenseExternalContext = {
  siblingModules: [],
  runtimePythonModules: {},
};

function queryCompletions(
  doc: string,
  language: string,
  ext: IntelliSenseExternalContext = EMPTY_EXT,
  explicit = false
): CompletionResult | null {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, doc.length, explicit);
  const source = buildLanguageCompletionSource(language, () => ext);
  return source(ctx) as CompletionResult | null;
}

describe('codeCompletions IntelliSense engine', () => {
  it('ranks contextually most relevant items at #1 instead of Python builtins', () => {
    // 1. Top-level statement start: `im` -> `import` is #1
    const rImport = queryCompletions('im', 'python');
    expect(rImport).not.toBeNull();
    expect(rImport!.options[0].label).toBe('import');
    expect(rImport!.options.every((o) => o.section === undefined)).toBe(true);

    // 2. Top-level statement start: `de` -> `def` is #1
    const rDef = queryCompletions('de', 'python');
    expect(rDef).not.toBeNull();
    expect(rDef!.options[0].label).toBe('def');

    // 3. Inside function statement start: `re` -> `return` is #1
    const rReturn = queryCompletions(
      ['def add_bias(x, bias=10):', '    re'].join('\n'),
      'python'
    );
    expect(rReturn).not.toBeNull();
    expect(rReturn!.options[0].label).toBe('return');

    // 4. Inside function expression: `return x + b` -> parameter `bias` is #1 (beats `bool`)
    const rParam = queryCompletions(
      ['def add_bias(x, bias=10):', '    return x + b'].join('\n'),
      'python'
    );
    expect(rParam).not.toBeNull();
    expect(rParam!.options[0].label).toBe('bias');

    // 5. Local variable & local function beat Python builtins (`abs` / `all` / `any`)
    const rLocal = queryCompletions(
      [
        'import numpy as np',
        'def add_bias(x, bias=10):',
        '    return x + bias',
        '',
        'if __name__ == "__main__":',
        '    arr = np.linspace(0, 1, 5)',
        '    res = a',
      ].join('\n'),
      'python'
    );
    expect(rLocal).not.toBeNull();
    expect(rLocal!.options[0].label).toBe('arr');
    expect(rLocal!.options[1].label).toBe('add_bias');

    // 6. Inside `print(r`: local variable `res` is #1 (beats `range` / `round`)
    const rPrintArg = queryCompletions(
      [
        'if __name__ == "__main__":',
        '    arr = [1, 2, 3]',
        '    res = sum(arr)',
        '    print(r',
      ].join('\n'),
      'python'
    );
    expect(rPrintArg).not.toBeNull();
    expect(rPrintArg!.options[0].label).toBe('res');
  });

  it('suppresses noisy popups when declaring new function names, parameter names, or import aliases', () => {
    expect(queryCompletions('import numpy as np', 'python')).toBeNull();
    expect(queryCompletions('def add_bias', 'python')).toBeNull();
    expect(queryCompletions('def add_bias(x, bias', 'python')).toBeNull();
    expect(queryCompletions('for item', 'python')).toBeNull();
  });

  it('completes NumPy and custom aliased PyTorch members on dot trigger', () => {
    const code = [
      'import numpy as np',
      'import torch.nn.functional as fn_ops',
      'x = np.li',
    ].join('\n');

    const res = queryCompletions(code, 'python');
    expect(res).not.toBeNull();
    expect(res!.options[0].label).toBe('linspace');

    const code2 = [
      'import torch.nn.functional as fn_ops',
      'loss = fn_ops.',
    ].join('\n');
    const res2 = queryCompletions(code2, 'python');
    expect(res2).not.toBeNull();
    const labels2 = res2!.options.map((o) => o.label);
    expect(labels2).toContain('mse_loss');
    expect(labels2).toContain('gelu');
  });

  it('completes self. attributes prioritized above nn.Module base methods inside a Python class', () => {
    const code = [
      'import torch.nn as nn',
      'class ThermalNet(nn.Module):',
      '    def __init__(self, hidden_dim: int):',
      '        super().__init__()',
      '        self.encoder = nn.Linear(4, hidden_dim)',
      '        self.scale_factor = 0.5',
      '',
      '    def compute_flux(self, temp_field):',
      '        return temp_field * self.scale_factor',
      '',
      '    def forward(self, x):',
      '        return self.',
    ].join('\n');

    const res = queryCompletions(code, 'python');
    expect(res).not.toBeNull();
    const top3 = res!.options.slice(0, 3).map((o) => o.label);
    expect(top3).toContain('encoder');
    expect(top3).toContain('scale_factor');
    expect(top3).toContain('compute_flux');
  });

  it('extracts local functions with signatures, docstrings, and sibling module members', () => {
    const code = [
      'import core_solver',
      '',
      'def calibrate_sensor(raw_temp: float, offset: float = 1.2):',
      '    """校准结晶器热电偶温度读数"""',
      '    return raw_temp + offset',
    ].join('\n');

    const analyzed = analyzeDocumentForCompletions(code, 'python');
    const sig = analyzed.localSignatures.get('calibrate_sensor');
    expect(sig).toBeDefined();
    expect(sig?.params).toBe('(raw_temp: float, offset: float = 1.2)');
    expect(sig?.doc).toBe('校准结晶器热电偶温度读数');

    const extCtx: IntelliSenseExternalContext = {
      siblingModules: [
        {
          moduleName: 'core_solver',
          filePath: 'D:\\demo\\core_solver.py',
          symbols: [
            {
              label: 'solve_step',
              kind: 'function',
              detail: '(grid, dt=0.01)',
              doc: '推进单步热传导方程',
            },
          ],
        },
      ],
      runtimePythonModules: {},
    };

    const dotRes = queryCompletions(`${code}\ncore_solver.`, 'python', extCtx);
    expect(dotRes).not.toBeNull();
    expect(dotRes!.options[0].label).toBe('solve_step');
  });

  it('extracts imported Python module names for background runtime reflection', () => {
    const code = [
      'import gzip, hashlib as hl',
      'from scipy.interpolate import griddata',
      'from flask import Flask, jsonify',
    ].join('\n');

    const mods = extractImportedPythonModules(code);
    expect(mods).toContain('gzip');
    expect(mods).toContain('hashlib');
    expect(mods).toContain('scipy.interpolate');
    expect(mods).toContain('scipy');
    expect(mods).toContain('flask');
  });
});
