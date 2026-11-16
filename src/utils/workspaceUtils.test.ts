import { describe, expect, it } from 'vitest';
import type { FileTreeNode, OpenTab } from '@/types';
import {
  countMultiRootFiles,
  findMatchingMountedRoot,
  flattenMultiRootFiles,
  formatWorkspaceSessionLabel,
  isPathInsideRoot,
  pathsEqual,
  resolveEffectiveWorkingDir,
} from './workspaceUtils';

describe('workspaceUtils', () => {
  it('compares Windows paths case-insensitively and normalizes slashes', () => {
    expect(pathsEqual('D:\\Projects\\Demo\\', 'd:/projects/demo')).toBe(true);
    expect(pathsEqual('D:\\', 'd:/')).toBe(true);
    expect(isPathInsideRoot('D:\\Projects\\Demo\\src\\main.py', 'd:/projects/demo')).toBe(
      true
    );
    expect(isPathInsideRoot('D:\\Projects\\Demo2\\main.py', 'D:\\Projects\\Demo')).toBe(
      false
    );
  });

  it('picks the longest matching mounted root when roots are nested or parallel', () => {
    const roots = [
      'D:\\huangjunjie\\fine-tune the model using field data-total',
      'D:\\huangjunjie\\fine-tune the model using field data-total\\gemini',
      'D:\\huangjunjie\\tools\\md-pdf-viewer',
    ];

    expect(
      findMatchingMountedRoot(
        'D:\\huangjunjie\\fine-tune the model using field data-total\\gemini\\code_understanding\\test.py',
        roots
      )
    ).toBe('D:\\huangjunjie\\fine-tune the model using field data-total\\gemini');

    expect(
      findMatchingMountedRoot(
        'D:\\huangjunjie\\tools\\md-pdf-viewer\\src\\App.tsx',
        roots
      )
    ).toBe('D:\\huangjunjie\\tools\\md-pdf-viewer');
  });

  it('resolves effective working directory automatically from focused tab or manual pin', () => {
    const roots = ['D:\\project_alpha', 'E:\\project_beta'];
    const betaTab: OpenTab = {
      id: 'E:\\project_beta\\scripts\\train.py',
      name: 'train.py',
      path: 'E:\\project_beta\\scripts\\train.py',
      slashPath: 'E:/project_beta/scripts/train.py',
      kind: 'code',
      language: 'python',
    };

    const autoResolved = resolveEffectiveWorkingDir({
      activeTab: betaTab,
      rootPaths: roots,
      cwdOverride: 'auto',
    });
    expect(autoResolved.dir).toBe('E:\\project_beta');
    expect(autoResolved.isAuto).toBe(true);
    expect(autoResolved.matchedRoot).toBe('E:\\project_beta');

    const pinnedResolved = resolveEffectiveWorkingDir({
      activeTab: betaTab,
      rootPaths: roots,
      cwdOverride: 'D:\\project_alpha',
    });
    expect(pinnedResolved.dir).toBe('D:\\project_alpha');
    expect(pinnedResolved.isAuto).toBe(false);

    const scratchTab: OpenTab = {
      id: 'scratchpad-1',
      name: '临时实验_1.py',
      path: 'scratchpad-1',
      slashPath: 'scratchpad-1',
      kind: 'code',
      language: 'python',
      isScratchpad: true,
    };
    expect(
      resolveEffectiveWorkingDir({
        activeTab: scratchTab,
        rootPaths: roots,
        cwdOverride: 'auto',
      }).dir
    ).toBe('D:\\project_alpha');
  });

  it('flattens and deduplicates files across multiple parallel root trees', () => {
    const rootA: FileTreeNode = {
      name: 'proj_a',
      path: 'D:\\proj_a',
      slashPath: 'D:/proj_a',
      kind: 'folder',
      sizeBytes: 0,
      children: [
        {
          name: 'app.py',
          path: 'D:\\proj_a\\app.py',
          slashPath: 'D:/proj_a/app.py',
          kind: 'code',
          language: 'python',
          sizeBytes: 120,
          children: [],
        },
      ],
    };
    const rootB: FileTreeNode = {
      name: 'proj_b',
      path: 'E:\\proj_b',
      slashPath: 'E:/proj_b',
      kind: 'folder',
      sizeBytes: 0,
      children: [
        {
          name: 'src',
          path: 'E:\\proj_b\\src',
          slashPath: 'E:/proj_b/src',
          kind: 'folder',
          sizeBytes: 0,
          children: [
            {
              name: 'index.ts',
              path: 'E:\\proj_b\\src\\index.ts',
              slashPath: 'E:/proj_b/src/index.ts',
              kind: 'code',
              language: 'typescript',
              sizeBytes: 240,
              children: [],
            },
          ],
        },
      ],
    };

    const flat = flattenMultiRootFiles([rootA, rootB]);
    expect(flat).toHaveLength(2);
    expect(flat[0].relDir).toBe('proj_a');
    expect(flat[1].relDir).toBe('proj_b / src');
    expect(flat[1].searchLower).toBe('proj_b/src/index.ts');
    expect(countMultiRootFiles([rootA, rootB])).toBe(2);
    expect(
      formatWorkspaceSessionLabel({
        rootPaths: ['D:\\proj_a', 'E:\\proj_b'],
        rootTrees: [rootA, rootB],
      })
    ).toBe('proj_a');
  });
});
