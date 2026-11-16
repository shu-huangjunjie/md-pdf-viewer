import type { FileTreeNode, OpenTab } from '@/types';

export interface WorkspaceSession {
  id: string;
  name?: string;
  accentIndex: number;
  rootPaths: string[];
  rootTrees: FileTreeNode[];
  leftTabs: OpenTab[];
  leftActiveId: string | null;
  rightTabs: OpenTab[];
  rightActiveId: string | null;
  splitMode: boolean;
  splitRatio: number;
  focusedPane: 'left' | 'right';
  consoleCwdOverride: string; // 'auto' or explicit directory path
}

export interface FlatMultiRootFileItem {
  node: FileTreeNode;
  rootName: string;
  rootPath: string;
  relDir: string;
  searchLower: string;
  nameLower: string;
}

export const WORKSPACE_ACCENTS = [
  { name: 'ocean', dot: '#3b82f6', border: '#3b82f6', badgeBg: 'rgba(59,130,246,0.14)' },
  { name: 'emerald', dot: '#10b981', border: '#10b981', badgeBg: 'rgba(16,185,129,0.14)' },
  { name: 'violet', dot: '#8b5cf6', border: '#8b5cf6', badgeBg: 'rgba(139,92,246,0.14)' },
  { name: 'amber', dot: '#f59e0b', border: '#f59e0b', badgeBg: 'rgba(245,158,11,0.16)' },
  { name: 'cyan', dot: '#06b6d4', border: '#06b6d4', badgeBg: 'rgba(6,182,212,0.14)' },
  { name: 'rose', dot: '#f43f5e', border: '#f43f5e', badgeBg: 'rgba(244,63,94,0.14)' },
] as const;

export function createEmptyWorkspaceSession(
  accentIndex = 0,
  customId?: string
): WorkspaceSession {
  const id =
    customId ||
    `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    accentIndex: Math.abs(accentIndex) % WORKSPACE_ACCENTS.length,
    rootPaths: [],
    rootTrees: [],
    leftTabs: [],
    leftActiveId: null,
    rightTabs: [],
    rightActiveId: null,
    splitMode: false,
    splitRatio: 0.5,
    focusedPane: 'left',
    consoleCwdOverride: 'auto',
  };
}

/**
 * Normalizes a Windows or POSIX path for case-insensitive path comparisons.
 * Preserves drive roots like "d:\" while stripping trailing slashes on subfolders.
 */
export function normalizePathKey(rawPath: string | null | undefined): string {
  if (!rawPath) return '';
  const unified = rawPath.trim().replace(/\//g, '\\');
  if (!unified) return '';
  if (/^[a-zA-Z]:\\?$/.test(unified)) {
    return `${unified[0].toLowerCase()}:\\`;
  }
  return unified.replace(/\\+$/, '').toLowerCase();
}

export function pathsEqual(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const ka = normalizePathKey(a);
  const kb = normalizePathKey(b);
  return ka.length > 0 && ka === kb;
}

export function isPathInsideRoot(
  targetPath: string | null | undefined,
  rootPath: string | null | undefined
): boolean {
  const kt = normalizePathKey(targetPath);
  const kr = normalizePathKey(rootPath);
  if (!kt || !kr) return false;
  if (kt === kr) return true;
  const prefix = kr.endsWith('\\') ? kr : `${kr}\\`;
  return kt.startsWith(prefix);
}

export function getPathBasename(rawPath: string | null | undefined): string {
  if (!rawPath) return '';
  const cleaned = rawPath.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  if (!cleaned) return rawPath;
  const parts = cleaned.split('\\').filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

export function getParentDirPath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const cleaned = rawPath.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const idx = cleaned.lastIndexOf('\\');
  if (idx < 0) return null;
  if (idx === 2 && /^[a-zA-Z]:/.test(cleaned)) {
    return `${cleaned.slice(0, 2)}\\`;
  }
  return cleaned.slice(0, idx) || null;
}

/**
 * Finds the best (longest-prefix) mounted root path containing `filePath`.
 * Supports nested roots (e.g., both `D:\repo` and `D:\repo\subproject` mounted).
 */
export function findMatchingMountedRoot(
  filePath: string | null | undefined,
  rootPaths: string[]
): string | null {
  if (!filePath || rootPaths.length === 0) return null;
  let bestRoot: string | null = null;
  let bestLen = -1;

  for (const root of rootPaths) {
    if (isPathInsideRoot(filePath, root)) {
      const len = normalizePathKey(root).length;
      if (len > bestLen) {
        bestLen = len;
        bestRoot = root;
      }
    }
  }
  return bestRoot;
}

/**
 * Resolves the effective working directory for Code Runner (F5), Sibling IntelliSense,
 * and interactive PowerShell commands.
 */
export function resolveEffectiveWorkingDir(params: {
  activeTab: OpenTab | null;
  rootPaths: string[];
  cwdOverride?: string | null;
}): {
  dir: string | null;
  isAuto: boolean;
  matchedRoot: string | null;
} {
  const { activeTab, rootPaths, cwdOverride } = params;

  if (cwdOverride && cwdOverride !== 'auto') {
    return {
      dir: cwdOverride,
      isAuto: false,
      matchedRoot: findMatchingMountedRoot(cwdOverride, rootPaths),
    };
  }

  if (activeTab && !activeTab.isScratchpad && activeTab.path) {
    const matched = findMatchingMountedRoot(activeTab.path, rootPaths);
    if (matched) {
      return {
        dir: matched,
        isAuto: true,
        matchedRoot: matched,
      };
    }
    const parent = getParentDirPath(activeTab.path);
    return {
      dir: parent ?? rootPaths[0] ?? null,
      isAuto: true,
      matchedRoot: null,
    };
  }

  const primary = rootPaths[0] ?? null;
  return {
    dir: primary,
    isAuto: true,
    matchedRoot: primary,
  };
}

export function formatWorkspaceSessionLabel(session: {
  name?: string | null;
  rootPaths: string[];
  rootTrees?: FileTreeNode[];
}): string {
  if (session.name && session.name.trim().length > 0) {
    return session.name.trim();
  }
  if (session.rootTrees && session.rootTrees.length > 0) {
    return session.rootTrees[0].name;
  }
  if (session.rootPaths.length > 0) {
    return getPathBasename(session.rootPaths[0]);
  }
  return '空白工作空间';
}

export function countMultiRootFiles(roots: FileTreeNode[]): number {
  const seen = new Set<string>();
  const walk = (n: FileTreeNode) => {
    for (const c of n.children) {
      if (c.kind === 'folder') {
        walk(c);
      } else {
        seen.add(normalizePathKey(c.path));
      }
    }
  };
  for (const r of roots) {
    walk(r);
  }
  return seen.size;
}

export function flattenMultiRootFiles(
  roots: FileTreeNode[]
): FlatMultiRootFileItem[] {
  if (!roots || roots.length === 0) return [];
  const list: FlatMultiRootFileItem[] = [];
  const seenPaths = new Set<string>();
  const isMultiRoot = roots.length > 1;

  for (const root of roots) {
    const rootPrefix = root.slashPath.endsWith('/')
      ? root.slashPath
      : `${root.slashPath}/`;

    const walk = (node: FileTreeNode) => {
      for (const child of node.children) {
        if (child.kind === 'folder') {
          walk(child);
        } else {
          const key = normalizePathKey(child.path);
          if (seenPaths.has(key)) continue;
          seenPaths.add(key);

          const relSlash = child.slashPath.startsWith(rootPrefix)
            ? child.slashPath.slice(rootPrefix.length)
            : child.name;
          const lastSlash = relSlash.lastIndexOf('/');
          const subDir = lastSlash >= 0 ? relSlash.slice(0, lastSlash) : '';
          const relDir = isMultiRoot
            ? subDir
              ? `${root.name} / ${subDir}`
              : root.name
            : subDir;
          const searchTarget = isMultiRoot
            ? `${root.name}/${relSlash}`
            : relSlash;

          list.push({
            node: child,
            rootName: root.name,
            rootPath: root.path,
            relDir,
            searchLower: searchTarget.toLowerCase(),
            nameLower: child.name.toLowerCase(),
          });
        }
      }
    };

    walk(root);
  }

  return list;
}
