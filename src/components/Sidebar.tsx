import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Columns2,
  Copy,
  Edit3,
  ExternalLink,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  TextSearch,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import {
  createWorkspaceItem,
  deleteWorkspaceItem,
  openInContextVault,
  renameWorkspaceItem,
  revealInExplorer,
  searchInWorkspace,
} from '@/api/client';
import { AiSessionsPanel } from '@/components/AiSessionsPanel';
import { FileBadge } from '@/components/FileBadge';
import type {
  AiSessionMarkdownPayload,
  FileDescriptor,
  FileTreeNode,
  WorkspaceSearchHit,
} from '@/types';
import {
  getPathBasename,
  isPathInsideRoot,
  normalizePathKey,
  pathsEqual,
  WORKSPACE_ACCENTS,
} from '@/utils/workspaceUtils';

export type SidebarTabMode = 'explorer' | 'search' | 'ai-sessions';

interface SidebarProps {
  workspaceTrees: FileTreeNode[];
  activeRootPath: string | null;
  activePath: string | null;
  mode: SidebarTabMode;
  onChangeMode: (mode: SidebarTabMode) => void;
  onOpenNode: (node: FileTreeNode, inSplitPane?: boolean) => void;
  onOpenSearchHit: (hit: WorkspaceSearchHit) => void;
  onOpenAiSessionNote: (
    payload: AiSessionMarkdownPayload,
    inSplitPane?: boolean
  ) => void;
  onItemCreated: (item: FileDescriptor) => void;
  onItemRenamedOrDeleted: () => void;
  onRefreshWorkspace: (rootPath?: string) => void;
  onSwitchWorkspace: (folderPath: string) => void;
  onAddParallelFolder: () => void;
  onAppendWorkspacePath: (folderPath: string) => void;
  onOpenWorkspaceInNewSession: (folderPath: string) => void;
  onOpenNewWorkspaceDialog: () => void;
  onRemoveRootFolder: (rootPath: string) => void;
  onOpenRecentFile: (filePath: string) => void;
  bookmarks: string[];
  onToggleBookmark: (folderPath: string) => void;
  recentWorkspaces: string[];
  recentFiles: string[];
}

interface ScopedSearchHit extends WorkspaceSearchHit {
  rootName: string;
  rootPath: string;
}

function filterTree(
  node: FileTreeNode,
  query: string,
  isRoot = true
): FileTreeNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;

  if (node.kind !== 'folder') {
    return node.name.toLowerCase().includes(q) ? node : null;
  }

  if (!isRoot && node.name.toLowerCase().includes(q)) {
    return node;
  }

  const filteredChildren = node.children
    .map((c) => filterTree(c, q, false))
    .filter((c): c is FileTreeNode => c !== null);

  if (!isRoot && filteredChildren.length === 0) {
    return null;
  }

  return {
    ...node,
    children: filteredChildren,
  };
}

function countTotalFiles(node: FileTreeNode | null): number {
  if (!node) return 0;
  let total = 0;
  const walk = (n: FileTreeNode) => {
    if (n.kind !== 'folder') total += 1;
    n.children.forEach(walk);
  };
  walk(node);
  return total;
}

function collectFolderPaths(
  node: FileTreeNode | null,
  minDepth = 1
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (!node) return map;
  const walk = (n: FileTreeNode, depth: number) => {
    if (n.kind === 'folder') {
      if (depth >= minDepth) {
        map[n.path] = true;
      }
      n.children.forEach((c) => walk(c, depth + 1));
    }
  };
  node.children.forEach((c) => walk(c, 0));
  return map;
}

function findFolderByPathInRoots(
  roots: FileTreeNode[],
  targetPath: string
): FileTreeNode | null {
  const findInTree = (node: FileTreeNode): FileTreeNode | null => {
    if (pathsEqual(node.path, targetPath)) return node;
    for (const child of node.children) {
      if (child.kind === 'folder') {
        const hit = findInTree(child);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const root of roots) {
    const found = findInTree(root);
    if (found) return found;
  }
  return null;
}

function suggestUniqueName(
  roots: FileTreeNode[],
  parentDir: string,
  baseName: string,
  ext = ''
): string {
  const folder = findFolderByPathInRoots(roots, parentDir);
  const existing = new Set(
    (folder?.children || []).map((c) => c.name.toLowerCase())
  );
  const firstCandidate = `${baseName}${ext}`;
  if (!existing.has(firstCandidate.toLowerCase())) {
    return firstCandidate;
  }
  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseName}_${i}${ext}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return firstCandidate;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileTreeNode;
  isRootBlank?: boolean;
  isMountedRoot?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  workspaceTrees,
  activeRootPath,
  activePath,
  mode,
  onChangeMode,
  onOpenNode,
  onOpenSearchHit,
  onOpenAiSessionNote,
  onItemCreated,
  onItemRenamedOrDeleted,
  onRefreshWorkspace,
  onSwitchWorkspace,
  onAddParallelFolder,
  onAppendWorkspacePath,
  onOpenWorkspaceInNewSession,
  onOpenNewWorkspaceDialog,
  onRemoveRootFolder,
  onOpenRecentFile,
  bookmarks,
  onToggleBookmark,
  recentWorkspaces,
  recentFiles,
}) => {
  const [width, setWidth] = useState<number>(296);
  const [search, setSearch] = useState('');
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [collapsedRoots, setCollapsedRoots] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);

  // Full-text search state (supports multi-root scope!)
  const [ftQuery, setFtQuery] = useState('');
  const [ftCaseSensitive, setFtCaseSensitive] = useState(false);
  const [ftScopeRoot, setFtScopeRoot] = useState<string>('all');
  const [ftHits, setFtHits] = useState<ScopedSearchHit[]>([]);
  const [ftSearching, setFtSearching] = useState(false);

  // File management modal dialog state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [actionDialog, setActionDialog] = useState<
    | { type: 'create'; parentDir: string; isDir: boolean; value: string }
    | { type: 'rename'; targetPath: string; value: string }
    | { type: 'delete'; targetPath: string; name: string; isDir: boolean }
    | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const initializedRootsRef = useRef<Set<string>>(new Set());

  const isMultiRoot = workspaceTrees.length > 1;
  const primaryTree = workspaceTrees[0] || null;

  const displayTrees = useMemo(() => {
    return workspaceTrees.map((root) => ({
      original: root,
      filtered: filterTree(root, search),
      fileCount: countTotalFiles(root),
    }));
  }, [workspaceTrees, search]);

  // Reset full-text scope if previously selected root was unmounted
  useEffect(() => {
    if (
      ftScopeRoot !== 'all' &&
      !workspaceTrees.some((r) => pathsEqual(r.path, ftScopeRoot))
    ) {
      setFtScopeRoot('all');
    }
  }, [ftScopeRoot, workspaceTrees]);

  // Initialize deep-subfolder collapse ONLY for newly mounted huge roots (preserves manual expand/collapse)
  useEffect(() => {
    const currentKeys = new Set(workspaceTrees.map((r) => normalizePathKey(r.path)));
    // Clean up unmounted roots from initialized tracker
    for (const oldKey of Array.from(initializedRootsRef.current)) {
      if (!currentKeys.has(oldKey)) {
        initializedRootsRef.current.delete(oldKey);
      }
    }

    const toMerge: Record<string, boolean> = {};
    let hasNew = false;
    for (const root of workspaceTrees) {
      const rKey = normalizePathKey(root.path);
      if (!initializedRootsRef.current.has(rKey)) {
        initializedRootsRef.current.add(rKey);
        if (countTotalFiles(root) > 40) {
          Object.assign(toMerge, collectFolderPaths(root, 1));
          hasNew = true;
        }
      }
    }
    if (hasNew) {
      setCollapsedDirs((prev) => ({ ...prev, ...toMerge }));
    }
  }, [workspaceTrees]);

  // Auto-select input text when create/rename modal opens
  useEffect(() => {
    if (actionDialog && actionDialog.type !== 'delete') {
      requestAnimationFrame(() => {
        dialogInputRef.current?.focus();
        dialogInputRef.current?.select();
      });
    }
  }, [actionDialog?.type]);

  // Scroll newly created item into view once workspaceTrees refresh
  useEffect(() => {
    if (!highlightedPath || !treeScrollRef.current) return;
    const el = treeScrollRef.current.querySelector<HTMLElement>(
      `[data-tree-path="${CSS.escape(highlightedPath)}"]`
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const timer = window.setTimeout(() => setHighlightedPath(null), 3500);
    return () => window.clearTimeout(timer);
  }, [highlightedPath, workspaceTrees]);

  // Ensure ancestors (and root section) of activePath are expanded when activePath changes
  useEffect(() => {
    if (!activePath || workspaceTrees.length === 0) return;
    setCollapsedDirs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const dirPath of Object.keys(next)) {
        if (next[dirPath] && isPathInsideRoot(activePath, dirPath) && !pathsEqual(activePath, dirPath)) {
          next[dirPath] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setCollapsedRoots((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of workspaceTrees) {
        if (next[r.path] && isPathInsideRoot(activePath, r.path)) {
          next[r.path] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath, workspaceTrees]);

  // Close context menu on window click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  // Debounced multi-root full-text search execution
  useEffect(() => {
    if (mode !== 'search' || workspaceTrees.length === 0 || !ftQuery.trim()) {
      setFtHits([]);
      setFtSearching(false);
      return;
    }

    const targets =
      ftScopeRoot === 'all'
        ? workspaceTrees
        : workspaceTrees.filter((r) => pathsEqual(r.path, ftScopeRoot));

    if (targets.length === 0) {
      setFtHits([]);
      setFtSearching(false);
      return;
    }

    let cancelled = false;
    setFtSearching(true);
    const timer = window.setTimeout(() => {
      Promise.all(
        targets.map(async (root) => {
          const hits = await searchInWorkspace(
            root.path,
            ftQuery,
            ftCaseSensitive
          );
          return hits.map<ScopedSearchHit>((h) => ({
            ...h,
            rootName: root.name,
            rootPath: root.path,
          }));
        })
      )
        .then((groups) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const merged: ScopedSearchHit[] = [];
          for (const g of groups) {
            for (const item of g) {
              const dedupKey = `${normalizePathKey(item.path)}:${item.line}`;
              if (!seen.has(dedupKey)) {
                seen.add(dedupKey);
                merged.push(item);
              }
              if (merged.length >= 250) break;
            }
            if (merged.length >= 250) break;
          }
          setFtHits(merged);
          setFtSearching(false);
        })
        .catch(() => {
          if (!cancelled) setFtSearching(false);
        });
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, workspaceTrees, ftQuery, ftCaseSensitive, ftScopeRoot]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(220, startW + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const isPrimaryBookmarked =
    primaryTree !== null &&
    bookmarks.some((b) => pathsEqual(b, primaryTree.path));

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleRootSection = (rootPath: string) => {
    setCollapsedRoots((prev) => ({ ...prev, [rootPath]: !prev[rootPath] }));
  };

  const handleCollapseAll = () => {
    const merged: Record<string, boolean> = {};
    for (const root of workspaceTrees) {
      Object.assign(merged, collectFolderPaths(root, 0));
    }
    setCollapsedDirs(merged);
  };

  const handleExpandAll = () => {
    setCollapsedDirs({});
    setCollapsedRoots({});
  };

  const openCreateDialog = (parentDir: string, isDir: boolean) => {
    setActionError(null);
    const suggested = isDir
      ? suggestUniqueName(workspaceTrees, parentDir, '新建文件夹')
      : suggestUniqueName(workspaceTrees, parentDir, 'untitled', '.py');
    setActionDialog({
      type: 'create',
      parentDir,
      isDir,
      value: suggested,
    });
  };

  const submitActionDialog = async () => {
    if (!actionDialog) return;
    setActionError(null);
    try {
      if (actionDialog.type === 'create') {
        const created = await createWorkspaceItem(
          actionDialog.parentDir,
          actionDialog.value,
          actionDialog.isDir
        );
        if (actionDialog.isDir) {
          setSearch('');
        }
        setCollapsedDirs((prev) => {
          const next = { ...prev, [actionDialog.parentDir]: false };
          if (actionDialog.isDir) {
            next[created.path] = false;
          }
          for (const k of Object.keys(next)) {
            if (isPathInsideRoot(created.path, k)) {
              next[k] = false;
            }
          }
          return next;
        });
        setCollapsedRoots((prev) => {
          const next = { ...prev };
          for (const r of workspaceTrees) {
            if (isPathInsideRoot(created.path, r.path)) {
              next[r.path] = false;
            }
          }
          return next;
        });
        setHighlightedPath(created.path);
        setActionDialog(null);
        onItemCreated(created);
      } else if (actionDialog.type === 'rename') {
        const renamed = await renameWorkspaceItem(
          actionDialog.targetPath,
          actionDialog.value
        );
        setHighlightedPath(renamed.path);
        setActionDialog(null);
        onItemRenamedOrDeleted();
      } else if (actionDialog.type === 'delete') {
        await deleteWorkspaceItem(actionDialog.targetPath);
        setActionDialog(null);
        onItemRenamedOrDeleted();
      }
    } catch (err) {
      setActionError(String(err));
    }
  };

  const renderNodes = (nodes: FileTreeNode[], depth = 0) => {
    return nodes.map((node) => {
      if (node.kind === 'folder') {
        const q = search.trim().toLowerCase();
        const folderNameMatches =
          q.length > 0 && node.name.toLowerCase().includes(q);
        if (q && node.children.length === 0 && !folderNameMatches) {
          return null;
        }
        const isCollapsed = !q && !!collapsedDirs[node.path];
        const isHighlighted = highlightedPath === node.path;

        return (
          <div key={node.path}>
            <div
              data-tree-path={node.path}
              onClick={() => toggleDir(node.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, node });
              }}
              style={{
                paddingLeft: `${8 + depth * 13}px`,
                backgroundColor: isHighlighted
                  ? 'var(--dp-accent-soft)'
                  : undefined,
                boxShadow: isHighlighted
                  ? 'inset 0 0 0 1px var(--dp-accent)'
                  : undefined,
              }}
              className="group w-full flex items-center justify-between gap-1 py-1 pr-1.5 text-left text-xs font-semibold rounded-md cursor-pointer transition hover:bg-black/5 dark:hover:bg-white/5"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {isCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
                )}
                {isCollapsed ? (
                  <Folder className="w-4 h-4 shrink-0 text-amber-500" />
                ) : (
                  <FolderOpen className="w-4 h-4 shrink-0 text-amber-500" />
                )}
                <span className="truncate" title={node.path}>
                  {node.name}
                </span>
              </div>

              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition">
                <button
                  type="button"
                  title="在此文件夹内新建文件"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCreateDialog(node.path, false);
                  }}
                  className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <FilePlus className="w-3.5 h-3.5 opacity-75" />
                </button>
                <button
                  type="button"
                  title="在此文件夹内新建子文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCreateDialog(node.path, true);
                  }}
                  className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <FolderPlus className="w-3.5 h-3.5 opacity-75" />
                </button>
              </div>
            </div>

            {!isCollapsed && (
              <div>
                {node.children.length > 0 ? (
                  renderNodes(node.children, depth + 1)
                ) : (
                  <div
                    style={{
                      paddingLeft: `${26 + depth * 13}px`,
                      color: 'var(--dp-text-muted)',
                    }}
                    className="py-0.5 text-[11px] italic select-none"
                  >
                    (空文件夹)
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }

      const isActive = pathsEqual(activePath, node.path);
      const isHighlighted = highlightedPath === node.path;
      return (
        <div
          key={node.path}
          data-tree-path={node.path}
          style={{
            paddingLeft: `${18 + depth * 13}px`,
            backgroundColor:
              isActive || isHighlighted ? 'var(--dp-accent-soft)' : undefined,
            color: isActive ? 'var(--dp-accent)' : undefined,
          }}
          className="group flex items-center justify-between gap-1 py-1 pr-1.5 rounded-md text-xs cursor-pointer transition hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => onOpenNode(node, false)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, node });
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileBadge
              kind={node.kind}
              language={node.language}
              name={node.name}
            />
            <span
              className={`truncate ${isActive ? 'font-bold' : ''}`}
              title={node.path}
            >
              {node.name}
            </span>
          </div>
          <button
            type="button"
            title="在右侧副栏分屏打开"
            onClick={(e) => {
              e.stopPropagation();
              onOpenNode(node, true);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition shrink-0"
          >
            <Columns2 className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    });
  };

  const renderWorkspaceFolderRow = (dir: string, iconPrefix: string) => {
    const isAlreadyMounted = workspaceTrees.some((r) => pathsEqual(r.path, dir));
    const shortName = getPathBasename(dir);
    return (
      <div
        key={dir}
        className="group flex items-center justify-between gap-1 py-1 px-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition"
      >
        <button
          type="button"
          onClick={() => {
            onSwitchWorkspace(dir);
            setShowHistory(false);
          }}
          className="flex-1 min-w-0 text-left truncate"
          title={`${dir}\n点击切换当前主目录，或使用右侧「+并列 / 新空间」`}
        >
          <span>
            {iconPrefix} {shortName}
          </span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {isAlreadyMounted ? (
            <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              已挂载
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAppendWorkspacePath(dir);
                setShowHistory(false);
              }}
              title={`追加为当前空间的并列目录：${dir}`}
              className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition"
            >
              +并列
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenWorkspaceInNewSession(dir);
              setShowHistory(false);
            }}
            title={`在新工作空间中打开：${dir}`}
            className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-sky-300 hover:bg-blue-500/25 transition"
          >
            新空间
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside
      style={{
        width: `${width}px`,
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: 'var(--dp-border)',
      }}
      className="shrink-0 border-r flex h-full select-none relative"
    >
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Mode Switcher: Explorer vs Full-Text Search vs AI Sessions */}
        <div
          className="grid grid-cols-3 border-b text-xs font-semibold shrink-0"
          style={{ borderColor: 'var(--dp-border)' }}
        >
          <button
            type="button"
            onClick={() => onChangeMode('explorer')}
            className="py-2 px-1 flex items-center justify-center gap-1 border-b-2 transition min-w-0"
            style={{
              borderColor:
                mode === 'explorer' ? 'var(--dp-accent)' : 'transparent',
              color:
                mode === 'explorer'
                  ? 'var(--dp-accent)'
                  : 'var(--dp-text-secondary)',
              backgroundColor:
                mode === 'explorer' ? 'var(--dp-surface)' : 'transparent',
            }}
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              目录{isMultiRoot ? `(${workspaceTrees.length})` : ''}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onChangeMode('search')}
            title="跨所有已挂载工作路径全文检索代码与文档内容 (Ctrl+Shift+F)"
            className="py-2 px-1 flex items-center justify-center gap-1 border-b-2 transition min-w-0"
            style={{
              borderColor:
                mode === 'search' ? 'var(--dp-accent)' : 'transparent',
              color:
                mode === 'search'
                  ? 'var(--dp-accent)'
                  : 'var(--dp-text-secondary)',
              backgroundColor:
                mode === 'search' ? 'var(--dp-surface)' : 'transparent',
            }}
          >
            <TextSearch className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">检索</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeMode('ai-sessions')}
            title="查看并研读当前工作空间关联的 AI 历史会话 (Ctrl+Shift+A)"
            className="py-2 px-1 flex items-center justify-center gap-1 border-b-2 transition min-w-0"
            style={{
              borderColor:
                mode === 'ai-sessions' ? 'var(--dp-accent)' : 'transparent',
              color:
                mode === 'ai-sessions'
                  ? 'var(--dp-accent)'
                  : 'var(--dp-text-secondary)',
              backgroundColor:
                mode === 'ai-sessions' ? 'var(--dp-surface)' : 'transparent',
            }}
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">AI 会话</span>
          </button>
        </div>

        {mode === 'explorer' ? (
          <>
            {/* Workspace Header & Quick Multi-Root Actions */}
            <div
              className="p-2.5 border-b space-y-2 shrink-0"
              style={{ borderColor: 'var(--dp-border)' }}
            >
              <div className="flex items-center justify-between gap-1">
                <span
                  className="text-xs font-bold truncate"
                  title={
                    isMultiRoot
                      ? `当前工作空间并列挂载了 ${workspaceTrees.length} 个目录：\n${workspaceTrees.map((t) => t.path).join('\n')}`
                      : primaryTree?.path || '尚未打开工作区文件夹'
                  }
                >
                  {isMultiRoot
                    ? `🗂️ 并列工作路径 (${workspaceTrees.length})`
                    : primaryTree
                      ? `📂 ${primaryTree.name}`
                      : '📂 本地工作区'}
                </span>

                <div className="flex items-center gap-0.5 shrink-0">
                  {!isMultiRoot && primaryTree && (
                    <>
                      <button
                        type="button"
                        onClick={() => openCreateDialog(primaryTree.path, false)}
                        title="在工作区根目录新建文件"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                      >
                        <FilePlus className="w-3.5 h-3.5 opacity-75" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openCreateDialog(primaryTree.path, true)}
                        title="在工作区根目录新建文件夹"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                      >
                        <FolderPlus className="w-3.5 h-3.5 opacity-75" />
                      </button>
                    </>
                  )}

                  {/* Add Parallel Folder Quick Action */}
                  <button
                    type="button"
                    onClick={onAddParallelFolder}
                    title="在此工作空间「追加并列文件夹」：无需切换窗口即可同时浏览、编辑多个工程路径 (Ctrl+Alt+O)"
                    className="px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 transition flex items-center gap-0.5"
                  >
                    <span>+并列</span>
                  </button>

                  {workspaceTrees.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleExpandAll}
                        title="展开全部子目录"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                      >
                        <ChevronsUpDown className="w-3.5 h-3.5 opacity-75" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCollapseAll}
                        title="折叠全部子目录"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                      >
                        <ChevronsDownUp className="w-3.5 h-3.5 opacity-75" />
                      </button>
                      {!isMultiRoot && primaryTree && (
                        <button
                          type="button"
                          onClick={() => onToggleBookmark(primaryTree.path)}
                          title={
                            isPrimaryBookmarked
                              ? '取消收藏此工作区'
                              : '收藏此工作区'
                          }
                          className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${
                              isPrimaryBookmarked
                                ? 'fill-amber-400 text-amber-500'
                                : 'opacity-65'
                            }`}
                          />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRefreshWorkspace()}
                        title="刷新目录树"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                      >
                        <RefreshCw className="w-3.5 h-3.5 opacity-70" />
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowHistory((v) => !v)}
                    title="收藏夹与最近打开的工作区（支持一键并列挂载或新空间打开）"
                    className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition"
                    style={{
                      color: showHistory ? 'var(--dp-accent)' : undefined,
                    }}
                  >
                    <Clock className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Filename Filter Input */}
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs"
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border-strong)',
                }}
              >
                <Search className="w-3.5 h-3.5 opacity-50 shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    isMultiRoot
                      ? '跨所有并列目录筛选文件名或后缀...'
                      : '按文件名、目录名或后缀筛选...'
                  }
                  className="w-full bg-transparent outline-none text-xs"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="opacity-60 hover:opacity-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Bookmarks & Recent Drawer */}
            {showHistory && (
              <div
                className="p-2.5 border-b max-h-64 overflow-y-auto space-y-2.5 text-xs shrink-0"
                style={{
                  borderColor: 'var(--dp-border)',
                  backgroundColor: 'var(--dp-surface)',
                }}
              >
                {bookmarks.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold opacity-60 mb-1">
                      ⭐ 收藏工作区
                    </div>
                    <div className="space-y-0.5">
                      {bookmarks.map((dir) =>
                        renderWorkspaceFolderRow(dir, '📁')
                      )}
                    </div>
                  </div>
                )}

                {recentWorkspaces.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold opacity-60 mb-1">
                      🕒 最近工作区
                    </div>
                    <div className="space-y-0.5">
                      {recentWorkspaces
                        .slice(0, 6)
                        .map((dir) => renderWorkspaceFolderRow(dir, '📂'))}
                    </div>
                  </div>
                )}

                {recentFiles.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold opacity-60 mb-1">
                      📄 最近文件
                    </div>
                    {recentFiles.slice(0, 6).map((fp) => (
                      <button
                        key={fp}
                        type="button"
                        onClick={() => {
                          onOpenRecentFile(fp);
                          setShowHistory(false);
                        }}
                        className="w-full text-left py-1 px-2 rounded hover:bg-black/5 dark:hover:bg-white/5 truncate block"
                        title={fp}
                      >
                        {getPathBasename(fp)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Main File Tree (Single-Root or Multi-Root Parallel Sections) */}
            <div
              ref={treeScrollRef}
              onContextMenu={(e) => {
                if (!primaryTree || isMultiRoot) return;
                e.preventDefault();
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  node: primaryTree,
                  isRootBlank: true,
                });
              }}
              className="flex-1 overflow-y-auto p-1.5 space-y-2"
            >
              {workspaceTrees.length === 0 ? (
                <div
                  className="p-5 text-center text-xs space-y-3"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  <p className="font-semibold text-sm" style={{ color: 'var(--dp-text)' }}>
                    尚未挂载工作目录
                  </p>
                  <p className="leading-relaxed">
                    支持在顶部开启多个独立「工作空间」，或在当前空间内并列挂载多个文件夹，告别反复新开窗口。
                  </p>
                  <div className="flex flex-col gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={onAddParallelFolder}
                      className="w-full py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition flex items-center justify-center gap-1.5"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>挂载本地工程目录</span>
                    </button>
                    <button
                      type="button"
                      onClick={onOpenNewWorkspaceDialog}
                      className="w-full py-1.5 px-3 rounded-lg border font-medium transition hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center gap-1.5"
                      style={{
                        borderColor: 'var(--dp-border-strong)',
                        color: 'var(--dp-text-secondary)',
                      }}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>新建独立工作空间...</span>
                    </button>
                  </div>
                </div>
              ) : !isMultiRoot ? (
                /* Clean Single-Root View */
                displayTrees[0]?.filtered &&
                displayTrees[0].filtered.children.length > 0 ? (
                  renderNodes(displayTrees[0].filtered.children)
                ) : (
                  <div
                    className="p-5 text-center text-xs space-y-2"
                    style={{ color: 'var(--dp-text-muted)' }}
                  >
                    <p className="font-semibold">
                      {search.trim()
                        ? '没有匹配当前筛选条件的文件'
                        : '此工作区目录目前为空'}
                    </p>
                    <p>
                      可右键空白处新建文件/文件夹，或点击上方「+并列」同时挂载第二个工作路径。
                    </p>
                  </div>
                )
              ) : (
                /* Multi-Root Parallel Folders View */
                displayTrees.map(({ original, filtered, fileCount }, rootIdx) => {
                  const accent =
                    WORKSPACE_ACCENTS[rootIdx % WORKSPACE_ACCENTS.length];
                  const isRootCollapsed =
                    !search.trim() && !!collapsedRoots[original.path];
                  const isActiveRoot = pathsEqual(activeRootPath, original.path);
                  const rootBookmarked = bookmarks.some((b) =>
                    pathsEqual(b, original.path)
                  );
                  const hasVisibleChildren =
                    Boolean(filtered && filtered.children.length > 0);

                  return (
                    <div
                      key={original.path}
                      className="rounded-lg border overflow-hidden"
                      style={{
                        borderColor: isActiveRoot
                          ? accent.border
                          : 'var(--dp-border)',
                        backgroundColor: 'var(--dp-surface)',
                      }}
                    >
                      {/* Collapsible Root Section Header */}
                      <div
                        onClick={() => toggleRootSection(original.path)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            node: original,
                            isMountedRoot: true,
                          });
                        }}
                        style={{
                          borderLeft: `3px solid ${accent.dot}`,
                          backgroundColor: isActiveRoot
                            ? accent.badgeBg
                            : 'var(--dp-sidebar)',
                        }}
                        className="group flex items-center justify-between gap-1 px-2 py-1.5 cursor-pointer select-none border-b transition hover:opacity-95"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isRootCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-70" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
                          )}
                          <span
                            className="text-xs font-bold truncate"
                            title={`${original.path}\n文件总数：${fileCount}`}
                          >
                            {original.name}
                          </span>
                          <span
                            className="text-[10px] font-mono px-1 rounded shrink-0"
                            style={{
                              backgroundColor: 'var(--dp-surface)',
                              color: 'var(--dp-text-muted)',
                            }}
                          >
                            {fileCount}
                          </span>
                          {isActiveRoot && (
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: accent.dot }}
                              title="当前聚焦文件所属根路径（F5 与终端自动跟随此路径）"
                            />
                          )}
                        </div>

                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-0.5 shrink-0"
                        >
                          <button
                            type="button"
                            onClick={() => openCreateDialog(original.path, false)}
                            title={`在「${original.name}」根目录新建文件`}
                            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-75 hover:opacity-100"
                          >
                            <FilePlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openCreateDialog(original.path, true)}
                            title={`在「${original.name}」根目录新建子文件夹`}
                            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-75 hover:opacity-100"
                          >
                            <FolderPlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleBookmark(original.path)}
                            title={
                              rootBookmarked ? '取消收藏此路径' : '收藏此路径'
                            }
                            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-75 hover:opacity-100"
                          >
                            <Star
                              className={`w-3 h-3 ${
                                rootBookmarked
                                  ? 'fill-amber-400 text-amber-500'
                                  : ''
                              }`}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveRootFolder(original.path)}
                            title={`从当前工作空间移除「${original.name}」挂载（不会删除本地文件）`}
                            className="p-0.5 rounded hover:bg-rose-500/15 hover:text-rose-500 opacity-65 hover:opacity-100 transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Root Tree Children */}
                      {!isRootCollapsed && (
                        <div className="p-1">
                          {hasVisibleChildren && filtered ? (
                            renderNodes(filtered.children, 0)
                          ) : (
                            <div
                              className="py-2 px-3 text-[11px] italic"
                              style={{ color: 'var(--dp-text-muted)' }}
                            >
                              {search.trim()
                                ? '无匹配筛选条件的文件'
                                : '(空目录，可点击右上角 + 新建文件)'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : mode === 'search' ? (
          /* Full-Text Multi-Root Workspace Search Panel */
          <div className="flex-1 flex flex-col min-h-0">
            <div
              className="p-2.5 border-b space-y-2 shrink-0"
              style={{ borderColor: 'var(--dp-border)' }}
            >
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs"
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border-strong)',
                }}
              >
                {ftSearching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
                ) : (
                  <Search className="w-3.5 h-3.5 opacity-50 shrink-0" />
                )}
                <input
                  type="text"
                  autoFocus
                  value={ftQuery}
                  onChange={(e) => setFtQuery(e.target.value)}
                  placeholder={
                    isMultiRoot
                      ? '跨并列工作路径搜索代码或文档...'
                      : '搜索工作区代码或文档内容...'
                  }
                  className="w-full bg-transparent outline-none text-xs"
                />
                {ftQuery && (
                  <button
                    type="button"
                    onClick={() => setFtQuery('')}
                    className="opacity-60 hover:opacity-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFtCaseSensitive((v) => !v)}
                  title="区分大小写 (Aa)"
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border"
                  style={{
                    backgroundColor: ftCaseSensitive
                      ? 'var(--dp-accent)'
                      : 'transparent',
                    borderColor: ftCaseSensitive
                      ? 'var(--dp-accent)'
                      : 'var(--dp-border)',
                    color: ftCaseSensitive ? '#fff' : 'var(--dp-text-muted)',
                  }}
                >
                  Aa
                </button>
              </div>

              {/* Scope Filter Chips when Multiple Roots are Mounted */}
              {isMultiRoot && (
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setFtScopeRoot('all')}
                    className="px-2 py-0.5 rounded-md text-[10.5px] font-semibold border transition"
                    style={{
                      backgroundColor:
                        ftScopeRoot === 'all'
                          ? 'var(--dp-accent-soft)'
                          : 'var(--dp-surface)',
                      borderColor:
                        ftScopeRoot === 'all'
                          ? 'var(--dp-accent)'
                          : 'var(--dp-border)',
                      color:
                        ftScopeRoot === 'all'
                          ? 'var(--dp-accent)'
                          : 'var(--dp-text-secondary)',
                    }}
                  >
                    全部路径 ({workspaceTrees.length})
                  </button>
                  {workspaceTrees.map((root) => {
                    const selected = pathsEqual(ftScopeRoot, root.path);
                    return (
                      <button
                        key={root.path}
                        type="button"
                        onClick={() => setFtScopeRoot(root.path)}
                        title={root.path}
                        className="px-2 py-0.5 rounded-md text-[10.5px] font-medium border truncate max-w-[120px] transition"
                        style={{
                          backgroundColor: selected
                            ? 'var(--dp-accent-soft)'
                            : 'var(--dp-surface)',
                          borderColor: selected
                            ? 'var(--dp-accent)'
                            : 'var(--dp-border)',
                          color: selected
                            ? 'var(--dp-accent)'
                            : 'var(--dp-text-secondary)',
                        }}
                      >
                        {root.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {ftQuery.trim() && (
                <div
                  className="text-[11px] flex justify-between"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  <span>
                    共找到 <b>{ftHits.length}</b> 处匹配
                    {ftHits.length >= 250 ? '（显示前 250 条）' : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {workspaceTrees.length === 0 ? (
                <div
                  className="p-5 text-center text-xs"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  请先挂载一个或多个本地工作区文件夹后再执行全文检索。
                </div>
              ) : !ftQuery.trim() ? (
                <div
                  className="p-5 text-center text-xs leading-relaxed"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  输入函数名、变量名或讲义关键词，即可跨所有已挂载目录的 `.py` / `.md` / `.js` / `.json` 文件极速定位到具体行号。
                </div>
              ) : ftHits.length === 0 && !ftSearching ? (
                <div
                  className="p-5 text-center text-xs"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  未找到包含「{ftQuery}」的内容
                </div>
              ) : (
                ftHits.map((hit, idx) => (
                  <button
                    key={`${hit.path}:${hit.line}:${idx}`}
                    type="button"
                    onClick={() => onOpenSearchHit(hit)}
                    className="w-full text-left p-2 rounded-lg border transition hover:border-blue-500/50 hover:bg-black/5 dark:hover:bg-white/5 space-y-1"
                    style={{
                      backgroundColor: 'var(--dp-surface)',
                      borderColor: 'var(--dp-border)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-1.5 text-xs">
                      <span className="flex items-center gap-1.5 min-w-0 font-semibold">
                        <FileBadge
                          kind={hit.kind}
                          language={hit.language}
                          name={hit.name}
                        />
                        <span className="truncate">{hit.name}</span>
                        {isMultiRoot && (
                          <span
                            className="text-[10px] px-1 py-0.2 rounded shrink-0 font-normal truncate max-w-[90px]"
                            style={{
                              backgroundColor: 'var(--dp-sidebar)',
                              color: 'var(--dp-text-muted)',
                            }}
                            title={hit.rootPath}
                          >
                            {hit.rootName}
                          </span>
                        )}
                      </span>
                      <span className="text-[10.5px] font-mono px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-600 dark:text-sky-400 shrink-0">
                        第 {hit.line} 行
                      </span>
                    </div>
                    <div
                      className="text-[11px] font-mono truncate"
                      style={{ color: 'var(--dp-text-secondary)' }}
                      title={hit.preview}
                    >
                      {hit.preview}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <AiSessionsPanel
            rootPaths={workspaceTrees.map((t) => t.path)}
            onOpenSessionNote={onOpenAiSessionNote}
          />
        )}
      </div>

      {/* Right Drag Resize Handle */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(296)}
        title="左右拖拽调整侧边栏宽度（双击恢复默认宽度）"
        className="w-1 h-full cursor-col-resize hover:bg-blue-500/60 transition shrink-0"
      />

      {/* Right-Click Context Menu */}
      {ctxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            left: `${Math.min(ctxMenu.x, window.innerWidth - 225)}px`,
            top: `${Math.min(ctxMenu.y, window.innerHeight - 280)}px`,
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
            color: 'var(--dp-text)',
          }}
          className="fixed z-50 w-56 py-1 rounded-xl border shadow-xl text-xs"
        >
          {ctxMenu.node.kind !== 'folder' && (
            <>
              <button
                type="button"
                onClick={() => {
                  onOpenNode(ctxMenu.node, false);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <FolderOpen className="w-3.5 h-3.5 opacity-70" />
                <span>打开文件</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenNode(ctxMenu.node, true);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <Columns2 className="w-3.5 h-3.5 opacity-70" />
                <span>在右侧分屏打开</span>
              </button>
              <div
                className="my-1 border-t"
                style={{ borderColor: 'var(--dp-border)' }}
              />
            </>
          )}

          <button
            type="button"
            onClick={() => {
              const parentDir =
                ctxMenu.node.kind === 'folder'
                  ? ctxMenu.node.path
                  : ctxMenu.node.path.replace(/\\[^\\]+$/, '');
              openCreateDialog(parentDir, false);
              setCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <FilePlus className="w-3.5 h-3.5 opacity-70" />
            <span>
              {ctxMenu.isRootBlank || ctxMenu.isMountedRoot
                ? '在此根目录新建文件...'
                : ctxMenu.node.kind === 'folder'
                  ? '在此文件夹内新建文件...'
                  : '在同级目录新建文件...'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const parentDir =
                ctxMenu.node.kind === 'folder'
                  ? ctxMenu.node.path
                  : ctxMenu.node.path.replace(/\\[^\\]+$/, '');
              openCreateDialog(parentDir, true);
              setCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <FolderPlus className="w-3.5 h-3.5 opacity-70" />
            <span>
              {ctxMenu.isRootBlank || ctxMenu.isMountedRoot
                ? '在此根目录新建文件夹...'
                : ctxMenu.node.kind === 'folder'
                  ? '在此文件夹内新建子文件夹...'
                  : '在同级目录新建文件夹...'}
            </span>
          </button>

          {!ctxMenu.isRootBlank && !ctxMenu.isMountedRoot && (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                setActionDialog({
                  type: 'rename',
                  targetPath: ctxMenu.node.path,
                  value: ctxMenu.node.name,
                });
                setCtxMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Edit3 className="w-3.5 h-3.5 opacity-70" />
              <span>重命名...</span>
            </button>
          )}

          <div
            className="my-1 border-t"
            style={{ borderColor: 'var(--dp-border)' }}
          />

          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(ctxMenu.node.path);
              setCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Copy className="w-3.5 h-3.5 opacity-70" />
            <span>复制完整路径</span>
          </button>

          <button
            type="button"
            onClick={() => {
              void revealInExplorer(ctxMenu.node.path);
              setCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <ExternalLink className="w-3.5 h-3.5 opacity-70" />
            <span>在资源管理器中显示</span>
          </button>

          {ctxMenu.node.kind === 'folder' && (
            <button
              type="button"
              onClick={() => {
                const targetDir = ctxMenu.node.path;
                setCtxMenu(null);
                void openInContextVault(null, targetDir);
              }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-sky-400" />
              <span>在 Context Vault 定位此目录会话</span>
            </button>
          )}

          {ctxMenu.isMountedRoot && (
            <>
              <div
                className="my-1 border-t"
                style={{ borderColor: 'var(--dp-border)' }}
              />
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.node.path;
                  setCtxMenu(null);
                  onRefreshWorkspace(p);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <RefreshCw className="w-3.5 h-3.5 opacity-70" />
                <span>刷新此挂载目录</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.node.path;
                  setCtxMenu(null);
                  onRemoveRootFolder(p);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
              >
                <Unplug className="w-3.5 h-3.5" />
                <span>从空间移除此并列目录</span>
              </button>
            </>
          )}

          {!ctxMenu.isRootBlank && !ctxMenu.isMountedRoot && (
            <>
              <div
                className="my-1 border-t"
                style={{ borderColor: 'var(--dp-border)' }}
              />
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  setActionDialog({
                    type: 'delete',
                    targetPath: ctxMenu.node.path,
                    name: ctxMenu.node.name,
                    isDir: ctxMenu.node.kind === 'folder',
                  });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>
                  删除{ctxMenu.node.kind === 'folder' ? '文件夹' : '文件'}...
                </span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Centered Modal Dialog for Create / Rename / Delete */}
      {actionDialog && (
        <div
          onMouseDown={() => setActionDialog(null)}
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] flex items-center justify-center p-4"
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border shadow-2xl p-5 space-y-3.5 text-xs"
            style={{
              backgroundColor: 'var(--dp-elevated)',
              borderColor: 'var(--dp-border-strong)',
              color: 'var(--dp-text)',
            }}
          >
            {actionDialog.type === 'delete' ? (
              <>
                <div className="text-sm font-bold text-rose-600 dark:text-rose-400">
                  确认删除{actionDialog.isDir ? '文件夹' : '文件'}
                </div>
                <p
                  className="leading-relaxed"
                  style={{ color: 'var(--dp-text-secondary)' }}
                >
                  确定永久删除「<b>{actionDialog.name}</b>」
                  {actionDialog.isDir ? '及其内部所有内容' : ''}吗？此操作无法撤销。
                </p>
                <div
                  className="px-2.5 py-1.5 rounded-lg font-mono text-[11px] break-all border"
                  style={{
                    backgroundColor: 'var(--dp-sidebar)',
                    borderColor: 'var(--dp-border)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  {actionDialog.targetPath}
                </div>
                {actionError && (
                  <div className="text-xs text-rose-500 font-medium">
                    {actionError}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setActionDialog(null)}
                    className="px-3.5 py-1.5 rounded-lg border font-medium hover:opacity-85 transition"
                    style={{
                      backgroundColor: 'var(--dp-surface)',
                      borderColor: 'var(--dp-border-strong)',
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitActionDialog()}
                    className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold shadow-sm transition"
                  >
                    确认删除
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">
                    {actionDialog.type === 'create'
                      ? actionDialog.isDir
                        ? '📁 新建文件夹'
                        : '📄 新建文件'
                      : '✏️ 重命名'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setActionDialog(null)}
                    className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {actionDialog.type === 'create' && (
                  <div
                    className="px-2.5 py-1.5 rounded-lg text-[11px] break-all border"
                    style={{
                      backgroundColor: 'var(--dp-sidebar)',
                      borderColor: 'var(--dp-border)',
                      color: 'var(--dp-text-secondary)',
                    }}
                  >
                    创建位置：<b>{actionDialog.parentDir}</b>
                  </div>
                )}

                <div>
                  <label
                    className="block mb-1 font-medium"
                    style={{ color: 'var(--dp-text-secondary)' }}
                  >
                    {actionDialog.type === 'create'
                      ? actionDialog.isDir
                        ? '请输入文件夹名称：'
                        : '请输入文件名（如 demo.py、note.md、config.json）：'
                      : '请输入新名称：'}
                  </label>
                  <input
                    ref={dialogInputRef}
                    type="text"
                    value={actionDialog.value}
                    onChange={(e) =>
                      setActionDialog({
                        ...actionDialog,
                        value: e.target.value,
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitActionDialog();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setActionDialog(null);
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg border outline-none text-xs font-medium focus:ring-2 focus:ring-blue-500/30"
                    style={{
                      backgroundColor: 'var(--dp-surface)',
                      borderColor: 'var(--dp-accent)',
                      color: 'var(--dp-text)',
                    }}
                  />
                </div>

                {actionError && (
                  <div className="text-xs text-rose-500 font-medium">
                    {actionError}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setActionDialog(null)}
                    className="px-3.5 py-1.5 rounded-lg border font-medium hover:opacity-85 transition"
                    style={{
                      backgroundColor: 'var(--dp-surface)',
                      borderColor: 'var(--dp-border-strong)',
                    }}
                  >
                    取消 (Esc)
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitActionDialog()}
                    className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm transition"
                  >
                    {actionDialog.type === 'rename'
                      ? '确定重命名 (Enter)'
                      : '确定创建 (Enter)'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};
