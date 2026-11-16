import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Sparkles } from 'lucide-react';
import {
  drainPrismBridgeActions,
  getBootstrap,
  inspectPath,
  isTauriRuntime,
  listRuntimes,
  openInContextVault,
  pickDocumentFile,
  pickWorkspaceFolder,
  savePreferences,
  scanWorkspace,
  startCodeRun,
  stopCodeRun,
} from '@/api/client';
import type { CodeJumpTarget } from '@/components/CodeEditorPane';
import {
  ConsoleDrawer,
  type WorkingDirOption,
} from '@/components/ConsoleDrawer';
import { HtmlPane } from '@/components/HtmlPane';
import { MarkdownPane } from '@/components/MarkdownPane';
import { OutlineToc } from '@/components/OutlineToc';
import { type CommandItem, QuickOpenModal } from '@/components/QuickOpenModal';
import { Sidebar, type SidebarTabMode } from '@/components/Sidebar';
import { type EditorCursorStatus, StatusBar } from '@/components/StatusBar';
import { TabStrip } from '@/components/TabStrip';
import { TopBar } from '@/components/TopBar';
import {
  type ScratchpadLanguage,
  WelcomeWorkbench,
} from '@/components/WelcomeWorkbench';
import { WorkspaceBar } from '@/components/WorkspaceBar';
import type {
  AiSessionMarkdownPayload,
  ConsoleChunk,
  ContentWidth,
  FileDescriptor,
  FileTreeNode,
  HeadingItem,
  OpenTab,
  PrismBridgeAction,
  RunDoneEvent,
  RunOutputEvent,
  RuntimeProfile,
  SavedWorkspaceSession,
  SaveResult,
  ThemeMode,
  UserPreferences,
  WorkspaceSearchHit,
} from '@/types';
import {
  countMultiRootFiles,
  createEmptyWorkspaceSession,
  findMatchingMountedRoot,
  formatWorkspaceSessionLabel,
  getParentDirPath,
  getPathBasename,
  isPathInsideRoot,
  normalizePathKey,
  pathsEqual,
  resolveEffectiveWorkingDir,
  type WorkspaceSession,
} from '@/utils/workspaceUtils';

const LazyCodeEditorPane = React.lazy(
  () => import('@/components/CodeEditorPane')
);
const LazyPdfPane = React.lazy(() => import('@/components/PdfPane'));

const DEFAULT_PREFS: UserPreferences = {
  theme: 'light',
  fontSize: 16,
  contentWidth: 'comfortable',
  lastWorkspace: null,
  recentWorkspaces: [],
  recentFiles: [],
  bookmarks: [],
  preferredPython: null,
  savedWorkspaces: [],
  activeWorkspaceId: null,
};

function findFirstReadableNode(node: FileTreeNode): FileTreeNode | null {
  for (const child of node.children) {
    if (
      child.kind === 'markdown' ||
      child.kind === 'pdf' ||
      child.kind === 'code'
    ) {
      return child;
    }
  }
  for (const child of node.children) {
    if (child.kind === 'folder') {
      const sub = findFirstReadableNode(child);
      if (sub) return sub;
    }
  }
  return null;
}

function normalizeBridgeLanguage(raw: string): {
  lang: ScratchpadLanguage;
  ext: string;
} {
  const k = (raw || '').trim().toLowerCase();
  if (k === 'ts' || k === 'tsx' || k === 'typescript') {
    return { lang: 'typescript', ext: 'ts' };
  }
  if (k === 'js' || k === 'jsx' || k === 'javascript' || k === 'node') {
    return { lang: 'javascript', ext: 'js' };
  }
  if (
    k === 'ps1' ||
    k === 'pwsh' ||
    k === 'powershell' ||
    k === 'sh' ||
    k === 'bash' ||
    k === 'cmd' ||
    k === 'bat'
  ) {
    return { lang: 'powershell', ext: 'ps1' };
  }
  if (k === 'rs' || k === 'rust') {
    return { lang: 'rust', ext: 'rs' };
  }
  if (k === 'json' || k === 'jsonc') {
    return { lang: 'json', ext: 'json' };
  }
  if (k === 'md' || k === 'markdown') {
    return { lang: 'markdown', ext: 'md' };
  }
  return { lang: 'python', ext: 'py' };
}

function sanitizeNoteFilename(rawTitle: string, ext: string): string {
  const cleaned = (rawTitle || 'AI会话笔记')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
    .slice(0, 48);
  const base = cleaned || 'AI会话笔记';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export const App: React.FC = () => {
  const [assetBaseUrl, setAssetBaseUrl] = useState('');
  const [isPortable, setIsPortable] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [runtimes, setRuntimes] = useState<RuntimeProfile[]>([]);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<SidebarTabMode>('explorer');
  const [tocOpen, setTocOpen] = useState(true);

  // Multi-Workspace + Multi-Root Sessions
  const [workspaces, setWorkspaces] = useState<WorkspaceSession[]>(() => [
    createEmptyWorkspaceSession(0, 'ws-main'),
  ]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('ws-main');

  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [scrollHeadingId, setScrollHeadingId] = useState<string | null>(null);
  const [codeJumpState, setCodeJumpState] = useState<{
    tabId: string;
    target: CodeJumpTarget;
  } | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorCursorStatus | null>(
    null
  );

  const [quickOpen, setQuickOpen] = useState<{
    open: boolean;
    mode: 'files' | 'commands';
  }>({ open: false, mode: 'files' });

  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Code Runner & Console Drawer state
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runLabel, setRunLabel] = useState<string>('');
  const [consoleChunks, setConsoleChunks] = useState<ConsoleChunk[]>([]);
  const [lastRunDone, setLastRunDone] = useState<RunDoneEvent | null>(null);

  const mainSplitRef = useRef<HTMLElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const scratchSeqRef = useRef<number>(0);
  const accentSeqRef = useRef<number>(1);
  const jumpSeqRef = useRef<number>(0);
  const zoomHudTimerRef = useRef<number | null>(null);
  const wheelAccumRef = useRef<number>(0);
  const bootstrappedRef = useRef<boolean>(false);
  const bridgeFlushChainRef = useRef<Promise<void>>(Promise.resolve());
  const [zoomHudSize, setZoomHudSize] = useState<number | null>(null);

  const workspacesRef = useRef<WorkspaceSession[]>(workspaces);
  workspacesRef.current = workspaces;
  const activeWorkspaceIdRef = useRef<string>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  const activeSessionIndex = useMemo(() => {
    const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
    return idx >= 0 ? idx : 0;
  }, [workspaces, activeWorkspaceId]);

  const activeWorkspace = workspaces[activeSessionIndex] || workspaces[0];

  const workspaceFileCount = useMemo(
    () => countMultiRootFiles(activeWorkspace.rootTrees),
    [activeWorkspace.rootTrees]
  );

  const allMountedRootPaths = useMemo(() => {
    const list: string[] = [];
    const seen = new Set<string>();
    const pushUnique = (p: string) => {
      const k = normalizePathKey(p);
      if (k && !seen.has(k)) {
        seen.add(k);
        list.push(p);
      }
    };
    for (const p of activeWorkspace.rootPaths) pushUnique(p);
    for (const ws of workspaces) {
      for (const p of ws.rootPaths) pushUnique(p);
    }
    return list;
  }, [activeWorkspace.rootPaths, workspaces]);

  const availableWorkingDirs = useMemo<WorkingDirOption[]>(() => {
    return allMountedRootPaths.map((p) => ({
      path: p,
      label: `${getPathBasename(p)} — ${p}`,
    }));
  }, [allMountedRootPaths]);

  const leftActiveTab = useMemo(
    () =>
      activeWorkspace.leftTabs.find(
        (t) => t.id === activeWorkspace.leftActiveId
      ) || null,
    [activeWorkspace.leftTabs, activeWorkspace.leftActiveId]
  );

  const rightActiveTab = useMemo(
    () =>
      activeWorkspace.rightTabs.find(
        (t) => t.id === activeWorkspace.rightActiveId
      ) || null,
    [activeWorkspace.rightTabs, activeWorkspace.rightActiveId]
  );

  const activeFocusedTab =
    activeWorkspace.focusedPane === 'right' ? rightActiveTab : leftActiveTab;

  const resolvedCwd = useMemo(
    () =>
      resolveEffectiveWorkingDir({
        activeTab: activeFocusedTab,
        rootPaths: activeWorkspace.rootPaths,
        cwdOverride: activeWorkspace.consoleCwdOverride,
      }),
    [
      activeFocusedTab,
      activeWorkspace.rootPaths,
      activeWorkspace.consoleCwdOverride,
    ]
  );

  const effectiveWorkingDir = resolvedCwd.dir;
  const isCwdAuto = resolvedCwd.isAuto;
  const activeMatchedRoot = resolvedCwd.matchedRoot;
  const isCodeRunning = activeRunId !== null;

  // Sync theme attribute on <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', prefs.theme);
    document.documentElement.classList.toggle('dark', prefs.theme === 'dark');
  }, [prefs.theme]);

  // Debounced preference persistence
  const persistPrefs = useCallback(
    (updater: (prev: UserPreferences) => UserPreferences) => {
      setPrefs((prev) => {
        const next = updater(prev);
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = window.setTimeout(() => {
          void savePreferences(next);
        }, 450);
        return next;
      });
    },
    []
  );

  const mergeDiscoveredRuntimes = useCallback((discovered: RuntimeProfile[]) => {
    if (!discovered || discovered.length === 0) return;
    setRuntimes((prev) => {
      const seen = new Set(
        prev.map((r) => `${r.language}::${r.executable.toLowerCase()}`)
      );
      const merged = prev.slice();
      let changed = false;
      for (const item of discovered) {
        const key = `${item.language}::${item.executable.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push({ ...item, id: `${item.language}-${merged.length}` });
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, []);

  const recordRecentWorkspace = useCallback(
    (folderPath: string) => {
      persistPrefs((prev) => ({
        ...prev,
        lastWorkspace: folderPath,
        recentWorkspaces: [
          folderPath,
          ...prev.recentWorkspaces.filter((p) => !pathsEqual(p, folderPath)),
        ].slice(0, 15),
      }));
    },
    [persistPrefs]
  );

  // Sync savedWorkspaces & activeWorkspaceId whenever session structure changes after bootstrap
  const workspacePersistSignature = useMemo(() => {
    const slim: SavedWorkspaceSession[] = workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name ?? null,
      rootPaths: ws.rootPaths,
    }));
    return JSON.stringify({ slim, activeId: activeWorkspace.id });
  }, [workspaces, activeWorkspace.id]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    const savedWorkspaces: SavedWorkspaceSession[] = workspacesRef.current.map(
      (ws) => ({
        id: ws.id,
        name: ws.name ?? null,
        rootPaths: ws.rootPaths,
      })
    );
    const primaryActiveRoot =
      workspacesRef.current.find(
        (w) => w.id === activeWorkspaceIdRef.current
      )?.rootPaths[0] ?? null;

    persistPrefs((prev) => ({
      ...prev,
      savedWorkspaces,
      activeWorkspaceId: activeWorkspaceIdRef.current,
      lastWorkspace: primaryActiveRoot ?? prev.lastWorkspace,
    }));
  }, [workspacePersistSignature, persistPrefs]);

  const updateWorkspaceById = useCallback(
    (wsId: string, updater: (ws: WorkspaceSession) => WorkspaceSession) => {
      setWorkspaces((prev) => {
        const idx = prev.findIndex((w) => w.id === wsId);
        if (idx < 0) return prev;
        const updated = updater(prev[idx]);
        if (updated === prev[idx]) return prev;
        const copy = prev.slice();
        copy[idx] = updated;
        return copy;
      });
    },
    []
  );

  const updateActiveWorkspace = useCallback(
    (updater: (ws: WorkspaceSession) => WorkspaceSession) => {
      const targetId = activeWorkspaceIdRef.current;
      setWorkspaces((prev) => {
        const idx = prev.findIndex((w) => w.id === targetId);
        const realIdx = idx >= 0 ? idx : 0;
        if (realIdx >= prev.length) return prev;
        const updated = updater(prev[realIdx]);
        if (updated === prev[realIdx]) return prev;
        const copy = prev.slice();
        copy[realIdx] = updated;
        return copy;
      });
    },
    []
  );

  // Listen to live streaming stdout/stderr/system events from Rust RunnerManager
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlistenOut: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;

    listen<RunOutputEvent>('code-run-output', (ev) => {
      const payload = ev.payload;
      if (activeRunIdRef.current && payload.runId !== activeRunIdRef.current) {
        return;
      }
      setConsoleChunks((prev) => {
        if (prev.length > 0) {
          const last = prev[prev.length - 1];
          if (last.stream === payload.stream && last.text.length < 8192) {
            const copy = prev.slice();
            copy[copy.length - 1] = {
              stream: last.stream,
              text: last.text + payload.text,
            };
            return copy;
          }
        }
        const next = [...prev, { stream: payload.stream, text: payload.text }];
        return next.length > 400 ? next.slice(next.length - 400) : next;
      });
    })
      .then((fn) => {
        unlistenOut = fn;
      })
      .catch(console.error);

    listen<RunDoneEvent>('code-run-done', (ev) => {
      const payload = ev.payload;
      if (activeRunIdRef.current && payload.runId !== activeRunIdRef.current) {
        return;
      }
      activeRunIdRef.current = null;
      setActiveRunId(null);
      setLastRunDone(payload);
    })
      .then((fn) => {
        unlistenDone = fn;
      })
      .catch(console.error);

    return () => {
      unlistenOut?.();
      unlistenDone?.();
    };
  }, []);

  const handleRunCode = useCallback(
    async (params: {
      language: string;
      code: string;
      filePath: string | null;
      workingDir?: string | null;
      isSavedFile: boolean;
    }) => {
      if (activeRunIdRef.current) {
        void stopCodeRun(activeRunIdRef.current);
      }

      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      setLastRunDone(null);
      setConsoleChunks([]);
      setConsoleOpen(true);

      const labelName = params.filePath
        ? getPathBasename(params.filePath)
        : params.language === 'powershell' && params.code.length <= 48
          ? `PS> ${params.code}`
          : `${params.language.toUpperCase()} 代码块`;
      setRunLabel(labelName);

      if (!isTauriRuntime()) {
        setConsoleChunks([
          {
            stream: 'system',
            text: '[提示] 当前处于浏览器预览环境；请在 PrismStudio.exe 桌面端直接运行本地代码。\n',
          },
        ]);
        activeRunIdRef.current = null;
        setActiveRunId(null);
        return;
      }

      const customExe =
        params.language === 'python'
          ? prefs.preferredPython ||
            runtimes.find((r) => r.language === 'python')?.executable ||
            null
          : null;

      // Smart Working Directory resolution:
      // 1. Explicit param override -> 2. Console manual lock -> 3. Matched mounted root of filePath -> 4. File parent / effectiveWorkingDir
      let resolvedDir: string | null = params.workingDir ?? null;
      if (!resolvedDir) {
        if (
          activeWorkspace.consoleCwdOverride &&
          activeWorkspace.consoleCwdOverride !== 'auto'
        ) {
          resolvedDir = activeWorkspace.consoleCwdOverride;
        } else if (params.filePath) {
          resolvedDir =
            findMatchingMountedRoot(params.filePath, allMountedRootPaths) ??
            getParentDirPath(params.filePath) ??
            effectiveWorkingDir;
        } else {
          resolvedDir = effectiveWorkingDir;
        }
      }

      try {
        await startCodeRun({
          runId,
          language: params.language,
          code: params.code,
          filePath: params.filePath,
          workingDir: resolvedDir,
          customExecutable: customExe,
          isSavedFile: params.isSavedFile,
        });
      } catch (err) {
        activeRunIdRef.current = null;
        setActiveRunId(null);
        setConsoleChunks([
          { stream: 'stderr', text: `启动运行失败：${String(err)}\n` },
        ]);
      }
    },
    [
      activeWorkspace.consoleCwdOverride,
      allMountedRootPaths,
      effectiveWorkingDir,
      prefs.preferredPython,
      runtimes,
    ]
  );

  const handleStopRun = useCallback(async () => {
    const id = activeRunIdRef.current;
    if (!id) return;
    await stopCodeRun(id);
  }, []);

  const handleChangePreferredPython = useCallback(
    (executable: string) => {
      persistPrefs((prev) => ({ ...prev, preferredPython: executable }));
    },
    [persistPrefs]
  );

  const openTabInPane = useCallback(
    (tab: OpenTab, targetPane: 'left' | 'right', targetWsId?: string) => {
      const wsId = targetWsId || activeWorkspaceIdRef.current;
      updateWorkspaceById(wsId, (ws) => {
        if (targetPane === 'right') {
          const nextRight = ws.rightTabs.some((t) => t.id === tab.id)
            ? ws.rightTabs
            : [...ws.rightTabs, tab];
          return {
            ...ws,
            splitMode: true,
            rightTabs: nextRight,
            rightActiveId: tab.id,
            focusedPane: 'right',
          };
        }
        const nextLeft = ws.leftTabs.some((t) => t.id === tab.id)
          ? ws.leftTabs
          : [...ws.leftTabs, tab];
        return {
          ...ws,
          leftTabs: nextLeft,
          leftActiveId: tab.id,
          focusedPane: 'left',
        };
      });

      if (!tab.isScratchpad) {
        persistPrefs((prev) => {
          if (pathsEqual(prev.recentFiles[0], tab.path)) return prev;
          return {
            ...prev,
            recentFiles: [
              tab.path,
              ...prev.recentFiles.filter((p) => !pathsEqual(p, tab.path)),
            ].slice(0, 25),
          };
        });
      }
    },
    [persistPrefs, updateWorkspaceById]
  );

  const handleNewScratchpad = useCallback(
    (langOrEvent?: ScratchpadLanguage | React.SyntheticEvent) => {
      const lang: ScratchpadLanguage =
        typeof langOrEvent === 'string' ? langOrEvent : 'python';
      const metaMap: Record<
        ScratchpadLanguage,
        { prefix: string; ext: string }
      > = {
        python: { prefix: '临时实验', ext: 'py' },
        typescript: { prefix: '临时脚本', ext: 'ts' },
        javascript: { prefix: '临时脚本', ext: 'js' },
        powershell: { prefix: '临时终端', ext: 'ps1' },
        rust: { prefix: '临时源码', ext: 'rs' },
        json: { prefix: '临时配置', ext: 'json' },
        markdown: { prefix: '临时笔记', ext: 'md' },
      };
      const meta = metaMap[lang] || metaMap.python;
      scratchSeqRef.current += 1;
      const seq = scratchSeqRef.current;
      const id = `scratchpad-${seq}`;
      const curWs =
        workspacesRef.current.find(
          (w) => w.id === activeWorkspaceIdRef.current
        ) || workspacesRef.current[0];

      openTabInPane(
        {
          id,
          name: `${meta.prefix}_${seq}.${meta.ext}`,
          path: id,
          slashPath: id,
          kind: 'code',
          language: lang,
          isScratchpad: true,
          initialContent: '',
        },
        curWs?.focusedPane || 'left',
        curWs?.id
      );
    },
    [openTabInPane]
  );

  const handleDirtyChange = useCallback((tabId: string, isDirty: boolean) => {
    const updateList = (list: OpenTab[]) => {
      const idx = list.findIndex((t) => t.id === tabId);
      if (idx === -1 || Boolean(list[idx].isDirty) === isDirty) return list;
      const copy = list.slice();
      copy[idx] = { ...copy[idx], isDirty };
      return copy;
    };
    setWorkspaces((prev) =>
      prev.map((ws) => {
        const nextLeft = updateList(ws.leftTabs);
        const nextRight = updateList(ws.rightTabs);
        if (nextLeft === ws.leftTabs && nextRight === ws.rightTabs) return ws;
        return { ...ws, leftTabs: nextLeft, rightTabs: nextRight };
      })
    );
  }, []);

  const refreshWorkspaceTrees = useCallback(
    async (workspaceId?: string, specificRootPath?: string) => {
      const targetId = workspaceId || activeWorkspaceIdRef.current;
      const targetWs = workspacesRef.current.find((w) => w.id === targetId);
      if (!targetWs || targetWs.rootPaths.length === 0) return;

      const pathsToScan = specificRootPath
        ? targetWs.rootPaths.filter((p) => pathsEqual(p, specificRootPath))
        : targetWs.rootPaths;
      if (pathsToScan.length === 0) return;

      const scannedEntries = await Promise.all(
        pathsToScan.map(async (p) => {
          try {
            const tree = await scanWorkspace(p);
            return { path: p, tree };
          } catch {
            return null;
          }
        })
      );

      updateWorkspaceById(targetId, (ws) => {
        const nextTrees = ws.rootPaths
          .map((rp, i) => {
            const updated = scannedEntries.find(
              (e) => e && pathsEqual(e.path, rp)
            );
            return updated ? updated.tree : ws.rootTrees[i];
          })
          .filter((t): t is FileTreeNode => Boolean(t));
        return { ...ws, rootTrees: nextTrees };
      });
    },
    [updateWorkspaceById]
  );

  const handleSavedAs = useCallback(
    (tabId: string, saved: SaveResult, newLanguage: string) => {
      const nextKind: OpenTab['kind'] =
        newLanguage === 'markdown' ? 'markdown' : 'code';
      const upgrade = (list: OpenTab[]) =>
        list.map((t) =>
          t.id === tabId
            ? {
                ...t,
                id: saved.path,
                name: saved.name,
                path: saved.path,
                slashPath: saved.slashPath,
                kind: nextKind,
                language: newLanguage,
                sizeBytes: saved.sizeBytes,
                isScratchpad: false,
                isDirty: false,
              }
            : t
        );

      setWorkspaces((prev) =>
        prev.map((ws) => {
          const hasInLeft = ws.leftTabs.some((t) => t.id === tabId);
          const hasInRight = ws.rightTabs.some((t) => t.id === tabId);
          if (!hasInLeft && !hasInRight) return ws;
          return {
            ...ws,
            leftTabs: hasInLeft ? upgrade(ws.leftTabs) : ws.leftTabs,
            rightTabs: hasInRight ? upgrade(ws.rightTabs) : ws.rightTabs,
            leftActiveId: ws.leftActiveId === tabId ? saved.path : ws.leftActiveId,
            rightActiveId:
              ws.rightActiveId === tabId ? saved.path : ws.rightActiveId,
          };
        })
      );

      void refreshWorkspaceTrees(activeWorkspaceIdRef.current);
    },
    [refreshWorkspaceTrees]
  );

  // Replace primary folder of the active workspace (or mount if empty)
  const replacePrimaryFolder = useCallback(
    async (folderPath: string, autoOpenFirst = false) => {
      try {
        const [tree, discovered] = await Promise.all([
          scanWorkspace(folderPath),
          listRuntimes(folderPath),
        ]);
        mergeDiscoveredRuntimes(discovered);
        recordRecentWorkspace(tree.path);

        const targetId = activeWorkspaceIdRef.current;
        updateWorkspaceById(targetId, (ws) => {
          const restPaths = ws.rootPaths
            .slice(1)
            .filter((p) => !pathsEqual(p, tree.path));
          const restTrees = ws.rootTrees
            .slice(1)
            .filter((t) => !pathsEqual(t.path, tree.path));
          return {
            ...ws,
            rootPaths: [tree.path, ...restPaths],
            rootTrees: [tree, ...restTrees],
          };
        });

        setSidebarOpen(true);

        if (autoOpenFirst) {
          const curWs = workspacesRef.current.find((w) => w.id === targetId);
          const hasAnyTabs =
            (curWs?.leftTabs.length ?? 0) + (curWs?.rightTabs.length ?? 0) > 0;
          if (!hasAnyTabs) {
            const first = findFirstReadableNode(tree);
            if (first && first.kind !== 'folder') {
              openTabInPane(
                {
                  id: first.path,
                  name: first.name,
                  path: first.path,
                  slashPath: first.slashPath,
                  kind: first.kind,
                  language: first.language ?? undefined,
                  sizeBytes: first.sizeBytes,
                },
                'left',
                targetId
              );
            }
          }
        }
      } catch (err) {
        console.error('Failed to scan workspace:', err);
      }
    },
    [mergeDiscoveredRuntimes, openTabInPane, recordRecentWorkspace, updateWorkspaceById]
  );

  // Append a parallel folder into the target (or active) workspace session
  const appendParallelFolder = useCallback(
    async (folderPath: string, targetWsId?: string) => {
      const wsId = targetWsId || activeWorkspaceIdRef.current;
      setActiveWorkspaceId(wsId);
      setSidebarOpen(true);
      setSidebarMode('explorer');

      try {
        const [tree, discovered] = await Promise.all([
          scanWorkspace(folderPath),
          listRuntimes(folderPath),
        ]);
        mergeDiscoveredRuntimes(discovered);
        recordRecentWorkspace(tree.path);

        updateWorkspaceById(wsId, (ws) => {
          const existingIdx = ws.rootPaths.findIndex((p) =>
            pathsEqual(p, tree.path)
          );
          if (existingIdx >= 0) {
            const nextTrees = ws.rootTrees.slice();
            nextTrees[existingIdx] = tree;
            return { ...ws, rootTrees: nextTrees };
          }
          return {
            ...ws,
            rootPaths: [...ws.rootPaths, tree.path],
            rootTrees: [...ws.rootTrees, tree],
          };
        });
      } catch (err) {
        console.error('Failed to append parallel workspace folder:', err);
      }
    },
    [mergeDiscoveredRuntimes, recordRecentWorkspace, updateWorkspaceById]
  );

  // Open a folder in a brand-new Workspace Session (or switch 0ms if already open as a session!)
  const openFolderInNewWorkspace = useCallback(
    async (folderPath: string): Promise<string> => {
      // If another session already has this exact folder mounted, jump straight to it in 0ms!
      const existing =
        workspacesRef.current.find(
          (ws) => ws.rootPaths.length > 0 && pathsEqual(ws.rootPaths[0], folderPath)
        ) ||
        workspacesRef.current.find((ws) =>
          ws.rootPaths.some((rp) => pathsEqual(rp, folderPath))
        );
      if (existing) {
        activeWorkspaceIdRef.current = existing.id;
        setActiveWorkspaceId(existing.id);
        setSidebarOpen(true);
        recordRecentWorkspace(existing.rootPaths[0]);
        return existing.id;
      }

      // If the currently active workspace is completely empty (0 folders and 0 tabs), reuse it cleanly
      const curActive = workspacesRef.current.find(
        (w) => w.id === activeWorkspaceIdRef.current
      );
      if (
        curActive &&
        curActive.rootPaths.length === 0 &&
        curActive.leftTabs.length === 0 &&
        curActive.rightTabs.length === 0
      ) {
        await replacePrimaryFolder(folderPath, false);
        return curActive.id;
      }

      try {
        const [tree, discovered] = await Promise.all([
          scanWorkspace(folderPath),
          listRuntimes(folderPath),
        ]);
        mergeDiscoveredRuntimes(discovered);
        recordRecentWorkspace(tree.path);

        const nextAccent = accentSeqRef.current++;
        const newSession: WorkspaceSession = {
          ...createEmptyWorkspaceSession(nextAccent),
          rootPaths: [tree.path],
          rootTrees: [tree],
        };

        workspacesRef.current = [...workspacesRef.current, newSession];
        activeWorkspaceIdRef.current = newSession.id;
        setWorkspaces((prev) => [...prev, newSession]);
        setActiveWorkspaceId(newSession.id);
        setSidebarOpen(true);
        setSidebarMode('explorer');
        return newSession.id;
      } catch (err) {
        console.error('Failed to open folder in new workspace:', err);
        return activeWorkspaceIdRef.current;
      }
    },
    [mergeDiscoveredRuntimes, recordRecentWorkspace, replacePrimaryFolder]
  );

  const createBlankWorkspace = useCallback(() => {
    const nextAccent = accentSeqRef.current++;
    const blank = createEmptyWorkspaceSession(nextAccent);
    setWorkspaces((prev) => [...prev, blank]);
    setActiveWorkspaceId(blank.id);
  }, []);

  const removeRootFromActiveWorkspace = useCallback(
    (rootPath: string) => {
      updateActiveWorkspace((ws) => {
        const nextPaths = ws.rootPaths.filter((p) => !pathsEqual(p, rootPath));
        const nextTrees = ws.rootTrees.filter(
          (t) => !pathsEqual(t.path, rootPath)
        );
        const resetCwd = pathsEqual(ws.consoleCwdOverride, rootPath)
          ? 'auto'
          : ws.consoleCwdOverride;
        return {
          ...ws,
          rootPaths: nextPaths,
          rootTrees: nextTrees,
          consoleCwdOverride: resetCwd,
        };
      });
    },
    [updateActiveWorkspace]
  );

  const closeWorkspaceSession = useCallback((workspaceId: string) => {
    const target = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!target) return;

    const hasDirty =
      target.leftTabs.some((t) => t.isDirty) ||
      target.rightTabs.some((t) => t.isDirty);
    if (hasDirty) {
      const ok = window.confirm(
        `工作空间「${formatWorkspaceSessionLabel(target)}」内有尚未保存的文件修改，确定关闭吗？`
      );
      if (!ok) return;
    }

    setWorkspaces((prev) => {
      if (prev.length <= 1) {
        const fresh = createEmptyWorkspaceSession(0, 'ws-main');
        setActiveWorkspaceId(fresh.id);
        return [fresh];
      }
      const idx = prev.findIndex((w) => w.id === workspaceId);
      const next = prev.filter((w) => w.id !== workspaceId);
      if (activeWorkspaceIdRef.current === workspaceId && next.length > 0) {
        const fallbackIdx = Math.min(idx, next.length - 1);
        setActiveWorkspaceId(next[Math.max(0, fallbackIdx)].id);
      }
      return next;
    });
  }, []);

  const renameWorkspaceSession = useCallback(
    (workspaceId: string, newName: string) => {
      updateWorkspaceById(workspaceId, (ws) => ({
        ...ws,
        name: newName || undefined,
      }));
    },
    [updateWorkspaceById]
  );

  const cycleWorkspaceSession = useCallback(() => {
    const list = workspacesRef.current;
    if (list.length <= 1) return;
    const idx = list.findIndex((w) => w.id === activeWorkspaceIdRef.current);
    const nextIdx = (idx + 1) % list.length;
    setActiveWorkspaceId(list[nextIdx].id);
  }, []);

  const handlePickPrimaryFolder = useCallback(async () => {
    const defaultDir =
      activeWorkspace.rootPaths[0] ?? prefs.lastWorkspace ?? null;
    const picked = await pickWorkspaceFolder(defaultDir);
    if (picked) {
      await replacePrimaryFolder(picked, false);
    }
  }, [activeWorkspace.rootPaths, prefs.lastWorkspace, replacePrimaryFolder]);

  const handlePickFolderInNewWorkspace = useCallback(async () => {
    const defaultDir =
      activeWorkspace.rootPaths[0] ?? prefs.lastWorkspace ?? null;
    const picked = await pickWorkspaceFolder(defaultDir);
    if (picked) {
      await openFolderInNewWorkspace(picked);
    }
  }, [activeWorkspace.rootPaths, openFolderInNewWorkspace, prefs.lastWorkspace]);

  const handlePickParallelFolder = useCallback(
    async (targetWsId?: string) => {
      const defaultDir =
        activeWorkspace.rootPaths[0] ?? prefs.lastWorkspace ?? null;
      const picked = await pickWorkspaceFolder(defaultDir);
      if (picked) {
        await appendParallelFolder(picked, targetWsId);
      }
    },
    [activeWorkspace.rootPaths, appendParallelFolder, prefs.lastWorkspace]
  );

  const openArbitraryLocalPath = useCallback(
    async (
      rawPath: string,
      inSplit = false,
      jumpLine?: number,
      projectPath?: string | null
    ) => {
      const info: FileDescriptor | null = await inspectPath(rawPath);
      if (!info) return;
      if (info.kind === 'folder') {
        // Smart folder open: never clobber an active workspace that already has folders!
        await openFolderInNewWorkspace(info.path);
        return;
      }

      let targetWsId = activeWorkspaceIdRef.current;
      const wsContainingFile = workspacesRef.current.find((ws) =>
        ws.rootPaths.some((rp) => isPathInsideRoot(info.path, rp))
      );
      if (wsContainingFile) {
        targetWsId = wsContainingFile.id;
        if (activeWorkspaceIdRef.current !== targetWsId) {
          activeWorkspaceIdRef.current = targetWsId;
          setActiveWorkspaceId(targetWsId);
        }
      } else if (projectPath) {
        targetWsId = await openFolderInNewWorkspace(projectPath);
      }

      const curWs =
        workspacesRef.current.find((w) => w.id === targetWsId) ||
        workspacesRef.current[0];
      openTabInPane(
        {
          id: info.path,
          name: info.name,
          path: info.path,
          slashPath: info.slashPath,
          kind: info.kind,
          language: info.language ?? undefined,
          sizeBytes: info.sizeBytes,
        },
        inSplit ? 'right' : curWs?.focusedPane || 'left',
        targetWsId
      );

      if (jumpLine && jumpLine > 0 && info.kind === 'code') {
        jumpSeqRef.current += 1;
        setCodeJumpState({
          tabId: info.path,
          target: { line: jumpLine, seq: jumpSeqRef.current },
        });
      }
    },
    [openFolderInNewWorkspace, openTabInPane]
  );

  const handleOpenAiSessionNote = useCallback(
    (payload: AiSessionMarkdownPayload, inSplitPane = false) => {
      const id = `ai-session-${payload.id}`;
      const curWs =
        workspacesRef.current.find(
          (w) => w.id === activeWorkspaceIdRef.current
        ) || workspacesRef.current[0];
      openTabInPane(
        {
          id,
          name: sanitizeNoteFilename(payload.title, 'md'),
          path: id,
          slashPath: id,
          kind: 'markdown',
          language: 'markdown',
          isScratchpad: true,
          initialContent: payload.markdown,
          defaultSaveDir:
            payload.projectPath || curWs?.rootPaths[0] || undefined,
          isDirty: false,
        },
        inSplitPane ? 'right' : curWs?.focusedPane || 'left',
        curWs?.id
      );
    },
    [openTabInPane]
  );

  const executeBridgeAction = useCallback(
    async (act: PrismBridgeAction) => {
      if (act.action === 'open-workspace') {
        if (act.mode === 'parallel-root') {
          await appendParallelFolder(act.path);
        } else {
          await openFolderInNewWorkspace(act.path);
        }
        return;
      }

      if (act.action === 'open-file') {
        await openArbitraryLocalPath(
          act.path,
          false,
          act.line ?? undefined,
          act.projectPath ?? null
        );
        return;
      }

      if (act.action === 'open-code-snippet') {
        let targetWsId = activeWorkspaceIdRef.current;
        if (act.projectPath) {
          targetWsId = await openFolderInNewWorkspace(act.projectPath);
        }
        const { lang, ext } = normalizeBridgeLanguage(act.language);
        scratchSeqRef.current += 1;
        const id = `bridge-code-${scratchSeqRef.current}`;
        const tabName = sanitizeNoteFilename(act.title || 'AI代码实验', ext);
        const curWs = workspacesRef.current.find((w) => w.id === targetWsId);
        openTabInPane(
          {
            id,
            name: tabName,
            path: id,
            slashPath: id,
            kind: lang === 'markdown' ? 'markdown' : 'code',
            language: lang,
            isScratchpad: true,
            initialContent: act.code,
            defaultSaveDir: act.projectPath || undefined,
            isDirty: false,
          },
          curWs?.focusedPane || 'left',
          targetWsId
        );
        if (act.autoRun && lang !== 'markdown' && lang !== 'json') {
          await handleRunCode({
            language: lang,
            code: act.code,
            filePath: null,
            workingDir: act.projectPath || null,
            isSavedFile: false,
          });
        }
        return;
      }

      if (act.action === 'open-markdown-note') {
        let targetWsId = activeWorkspaceIdRef.current;
        if (act.projectPath) {
          const matchedWs = workspacesRef.current.find((ws) =>
            ws.rootPaths.some((rp) => pathsEqual(rp, act.projectPath!))
          );
          if (matchedWs) {
            targetWsId = matchedWs.id;
            activeWorkspaceIdRef.current = targetWsId;
            setActiveWorkspaceId(targetWsId);
          } else {
            const curWs = workspacesRef.current.find(
              (w) => w.id === activeWorkspaceIdRef.current
            );
            if (!curWs || curWs.rootPaths.length === 0) {
              targetWsId = await openFolderInNewWorkspace(act.projectPath);
            }
          }
        }
        scratchSeqRef.current += 1;
        const id = `bridge-md-${scratchSeqRef.current}`;
        const curWs = workspacesRef.current.find((w) => w.id === targetWsId);
        openTabInPane(
          {
            id,
            name: sanitizeNoteFilename(act.title || 'AI会话精排', 'md'),
            path: id,
            slashPath: id,
            kind: 'markdown',
            language: 'markdown',
            isScratchpad: true,
            initialContent: act.markdown,
            defaultSaveDir: act.projectPath || undefined,
            isDirty: false,
          },
          curWs?.focusedPane || 'left',
          targetWsId
        );
      }
    },
    [
      appendParallelFolder,
      handleRunCode,
      openArbitraryLocalPath,
      openFolderInNewWorkspace,
      openTabInPane,
    ]
  );

  const executeBridgeRef = useRef(executeBridgeAction);
  executeBridgeRef.current = executeBridgeAction;

  const flushBridgeQueue = useCallback(() => {
    if (!isTauriRuntime()) return Promise.resolve();
    bridgeFlushChainRef.current = bridgeFlushChainRef.current
      .then(async () => {
        const actions = await drainPrismBridgeActions();
        for (const act of actions) {
          try {
            await executeBridgeRef.current(act);
          } catch (err) {
            console.error('Bridge action failed:', err);
          }
        }
      })
      .catch((err) => {
        console.error('Failed to drain Prism bridge queue:', err);
      });
    return bridgeFlushChainRef.current;
  }, []);

  const handlePickFile = useCallback(async () => {
    const defaultDir =
      effectiveWorkingDir ??
      activeWorkspace.rootPaths[0] ??
      prefs.lastWorkspace ??
      null;
    const picked = await pickDocumentFile(defaultDir);
    if (picked && picked.kind !== 'folder') {
      openTabInPane(
        {
          id: picked.path,
          name: picked.name,
          path: picked.path,
          slashPath: picked.slashPath,
          kind: picked.kind,
          language: picked.language ?? undefined,
          sizeBytes: picked.sizeBytes,
        },
        activeWorkspace.focusedPane,
        activeWorkspace.id
      );
    }
  }, [
    activeWorkspace.focusedPane,
    activeWorkspace.id,
    activeWorkspace.rootPaths,
    effectiveWorkingDir,
    openTabInPane,
    prefs.lastWorkspace,
  ]);

  // Initial bootstrap: restore multi-workspace sessions & parallel root trees
  useEffect(() => {
    let mounted = true;
    (async () => {
      const boot = await getBootstrap();
      if (!mounted) return;
      setAssetBaseUrl(boot.assetBaseUrl);
      setIsPortable(boot.isPortable);
      setPrefs(boot.preferences);
      setRuntimes(boot.runtimes || []);

      const savedList = boot.preferences.savedWorkspaces || [];
      let restoredAny = false;

      if (savedList.length > 0) {
        const hydrated: WorkspaceSession[] = [];
        for (let i = 0; i < savedList.length; i++) {
          const saved = savedList[i];
          const validPairs = (
            await Promise.all(
              (saved.rootPaths || []).map(async (rp) => {
                try {
                  const [tree, disc] = await Promise.all([
                    scanWorkspace(rp),
                    listRuntimes(rp),
                  ]);
                  if (mounted) mergeDiscoveredRuntimes(disc);
                  return { path: tree.path, tree };
                } catch {
                  return null;
                }
              })
            )
          ).filter(
            (item): item is { path: string; tree: FileTreeNode } =>
              item !== null
          );

          if (validPairs.length > 0 || savedList.length === 1) {
            hydrated.push({
              ...createEmptyWorkspaceSession(i, saved.id),
              name: saved.name ?? undefined,
              rootPaths: validPairs.map((v) => v.path),
              rootTrees: validPairs.map((v) => v.tree),
            });
          }
        }

        if (hydrated.length > 0 && hydrated.some((h) => h.rootPaths.length > 0)) {
          accentSeqRef.current = hydrated.length;
          const desiredActive =
            boot.preferences.activeWorkspaceId &&
            hydrated.some((h) => h.id === boot.preferences.activeWorkspaceId)
              ? boot.preferences.activeWorkspaceId
              : hydrated[0].id;
          if (mounted) {
            setWorkspaces(hydrated);
            setActiveWorkspaceId(desiredActive);
            restoredAny = true;
          }
        }
      }

      if (!restoredAny) {
        if (boot.preferences.lastWorkspace) {
          await replacePrimaryFolder(boot.preferences.lastWorkspace, false);
        } else if (!isTauriRuntime()) {
          await replacePrimaryFolder('demo', true);
        }
      }

      if (boot.cliFiles.length > 0) {
        for (const p of boot.cliFiles) {
          await openArbitraryLocalPath(p, false);
        }
      }

      if (mounted) {
        bootstrappedRef.current = true;
        await flushBridgeQueue();
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live Cross-App Bridge Listener (Context Vault -> PrismStudio single-instance IPC)
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    listen('prism://bridge-action', () => {
      if (bootstrappedRef.current) {
        void flushBridgeQueue();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(console.error);
    return () => {
      unlisten?.();
    };
  }, [flushBridgeQueue]);

  // Native file/folder drag & drop support in Tauri v2
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setIsDraggingOver((prev) => (prev ? prev : true));
        } else if (event.payload.type === 'leave') {
          setIsDraggingOver(false);
        } else if (event.payload.type === 'drop') {
          setIsDraggingOver(false);
          for (const droppedPath of event.payload.paths) {
            void openArbitraryLocalPath(droppedPath, false);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, [openArbitraryLocalPath]);

  // Global Zoom HUD & Ctrl + Mouse Wheel Zoom
  const showZoomHud = useCallback((nextSize: number) => {
    setZoomHudSize(nextSize);
    if (zoomHudTimerRef.current !== null) {
      window.clearTimeout(zoomHudTimerRef.current);
    }
    zoomHudTimerRef.current = window.setTimeout(() => {
      setZoomHudSize(null);
    }, 1000);
  }, []);

  const adjustFontSize = useCallback(
    (delta: number) => {
      persistPrefs((prev) => {
        const nextSize = Math.min(38, Math.max(10, prev.fontSize + delta));
        showZoomHud(nextSize);
        if (nextSize === prev.fontSize) return prev;
        return { ...prev, fontSize: nextSize };
      });
    },
    [persistPrefs, showZoomHud]
  );

  const resetFontSize = useCallback(() => {
    persistPrefs((prev) => {
      showZoomHud(16);
      if (prev.fontSize === 16) return prev;
      return { ...prev, fontSize: 16 };
    });
  }, [persistPrefs, showZoomHud]);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        wheelAccumRef.current = 0;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          '[data-lightbox-modal="true"], [data-pdf-zoom-host="true"]'
        )
      ) {
        return;
      }

      e.preventDefault();
      if (e.deltaY === 0) return;

      if (Math.abs(e.deltaY) >= 40) {
        wheelAccumRef.current = 0;
        adjustFontSize(e.deltaY < 0 ? 1 : -1);
      } else {
        wheelAccumRef.current += e.deltaY;
        if (Math.abs(wheelAccumRef.current) >= 32) {
          const step = wheelAccumRef.current < 0 ? 1 : -1;
          wheelAccumRef.current = 0;
          adjustFontSize(step);
        }
      }
    };

    window.addEventListener('wheel', onWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [adjustFontSize]);

  const closeTab = useCallback(
    (wsId: string, pane: 'left' | 'right', id: string) => {
      updateWorkspaceById(wsId, (ws) => {
        if (pane === 'left') {
          const next = ws.leftTabs.filter((t) => t.id !== id);
          const nextActive =
            ws.leftActiveId === id
              ? next.length > 0
                ? next[next.length - 1].id
                : null
              : ws.leftActiveId;
          return { ...ws, leftTabs: next, leftActiveId: nextActive };
        }
        const next = ws.rightTabs.filter((t) => t.id !== id);
        const nextActive =
          ws.rightActiveId === id
            ? next.length > 0
              ? next[next.length - 1].id
              : null
            : ws.rightActiveId;
        return {
          ...ws,
          rightTabs: next,
          rightActiveId: nextActive,
          splitMode: next.length === 0 ? false : ws.splitMode,
          focusedPane: next.length === 0 ? 'left' : ws.focusedPane,
        };
      });
    },
    [updateWorkspaceById]
  );

  const closeOtherTabs = useCallback(
    (wsId: string, pane: 'left' | 'right', keepId: string) => {
      updateWorkspaceById(wsId, (ws) => {
        if (pane === 'left') {
          return {
            ...ws,
            leftTabs: ws.leftTabs.filter((t) => t.id === keepId),
            leftActiveId: keepId,
          };
        }
        return {
          ...ws,
          rightTabs: ws.rightTabs.filter((t) => t.id === keepId),
          rightActiveId: keepId,
        };
      });
    },
    [updateWorkspaceById]
  );

  const closeAllTabs = useCallback(
    (wsId: string, pane: 'left' | 'right') => {
      updateWorkspaceById(wsId, (ws) => {
        if (pane === 'left') {
          return { ...ws, leftTabs: [], leftActiveId: null };
        }
        return {
          ...ws,
          rightTabs: [],
          rightActiveId: null,
          splitMode: false,
          focusedPane: 'left',
        };
      });
    },
    [updateWorkspaceById]
  );

  const activeWorkspaceLabel = useMemo(() => {
    if (activeWorkspace.rootPaths.length === 0 && !activeWorkspace.name) {
      return null;
    }
    return formatWorkspaceSessionLabel(activeWorkspace);
  }, [activeWorkspace]);

  // Dynamic Window Title sync
  useEffect(() => {
    const parts: string[] = [];
    if (activeFocusedTab) {
      parts.push(
        activeFocusedTab.isDirty
          ? `● ${activeFocusedTab.name}`
          : activeFocusedTab.name
      );
    }
    if (activeWorkspaceLabel) {
      parts.push(
        activeWorkspace.rootPaths.length > 1
          ? `${activeWorkspaceLabel} (+${activeWorkspace.rootPaths.length - 1})`
          : activeWorkspaceLabel
      );
    }
    parts.push('棱镜工坊 PrismStudio');
    const nextTitle = parts.join(' — ');
    document.title = nextTitle;
    if (isTauriRuntime()) {
      void getCurrentWindow()
        .setTitle(nextTitle)
        .catch(() => {});
    }
  }, [activeFocusedTab, activeWorkspace.rootPaths.length, activeWorkspaceLabel]);

  // Clear stale headings when switching to PDF / HTML / empty pane
  useEffect(() => {
    if (
      !activeFocusedTab ||
      (activeFocusedTab.kind !== 'markdown' && activeFocusedTab.kind !== 'code')
    ) {
      setHeadings([]);
    }
  }, [activeFocusedTab]);

  // Global IDE & Multi-Workspace Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Alt+1..9: 0ms jump to Workspace Session 1..9
      if (e.altKey && !mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < workspacesRef.current.length) {
          e.preventDefault();
          setActiveWorkspaceId(workspacesRef.current[idx].id);
        }
        return;
      }

      // Ctrl+Alt+Left / Right: Prev / Next Workspace Session
      if (
        mod &&
        e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        const list = workspacesRef.current;
        if (list.length > 1) {
          e.preventDefault();
          const curIdx = list.findIndex(
            (w) => w.id === activeWorkspaceIdRef.current
          );
          const step = e.key === 'ArrowRight' ? 1 : -1;
          const nextIdx = (curIdx + step + list.length) % list.length;
          setActiveWorkspaceId(list[nextIdx].id);
        }
        return;
      }

      if (mod && key === 'p') {
        e.preventDefault();
        setQuickOpen({ open: true, mode: e.shiftKey ? 'commands' : 'files' });
      } else if (mod && e.shiftKey && key === 'f') {
        e.preventDefault();
        setSidebarOpen(true);
        setSidebarMode('search');
      } else if (mod && e.shiftKey && key === 'a') {
        e.preventDefault();
        setSidebarOpen(true);
        setSidebarMode('ai-sessions');
      } else if (mod && !e.shiftKey && !e.altKey && key === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (mod && e.shiftKey && !e.altKey && key === 'o') {
        e.preventDefault();
        void handlePickFolderInNewWorkspace();
      } else if (mod && !e.shiftKey && e.altKey && key === 'o') {
        e.preventDefault();
        void handlePickParallelFolder();
      } else if (mod && !e.shiftKey && !e.altKey && key === 'o') {
        e.preventDefault();
        void handlePickFile();
      } else if (mod && !e.shiftKey && key === 'n') {
        e.preventDefault();
        handleNewScratchpad();
      } else if (mod && !e.shiftKey && key === 'w') {
        if (activeFocusedTab) {
          e.preventDefault();
          closeTab(
            activeWorkspace.id,
            activeWorkspace.focusedPane,
            activeFocusedTab.id
          );
        }
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const list =
          activeWorkspace.focusedPane === 'right'
            ? activeWorkspace.rightTabs
            : activeWorkspace.leftTabs;
        const curId =
          activeWorkspace.focusedPane === 'right'
            ? activeWorkspace.rightActiveId
            : activeWorkspace.leftActiveId;
        if (list.length > 1) {
          const idx = list.findIndex((t) => t.id === curId);
          const nextIdx = e.shiftKey
            ? (idx - 1 + list.length) % list.length
            : (idx + 1) % list.length;
          const nextId = list[nextIdx].id;
          updateActiveWorkspace((ws) =>
            ws.focusedPane === 'right'
              ? { ...ws, rightActiveId: nextId }
              : { ...ws, leftActiveId: nextId }
          );
        }
      } else if (mod && e.key === '`') {
        e.preventDefault();
        setConsoleOpen((v) => !v);
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        adjustFontSize(1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        adjustFontSize(-1);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        resetFontSize();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeFocusedTab,
    activeWorkspace.focusedPane,
    activeWorkspace.id,
    activeWorkspace.leftActiveId,
    activeWorkspace.leftTabs,
    activeWorkspace.rightActiveId,
    activeWorkspace.rightTabs,
    adjustFontSize,
    closeTab,
    handleNewScratchpad,
    handlePickFile,
    handlePickFolderInNewWorkspace,
    handlePickParallelFolder,
    resetFontSize,
    updateActiveWorkspace,
  ]);

  const handleOpenTreeNode = useCallback(
    (node: FileTreeNode, inSplitPane = false) => {
      if (node.kind === 'folder') return;
      openTabInPane(
        {
          id: node.path,
          name: node.name,
          path: node.path,
          slashPath: node.slashPath,
          kind: node.kind,
          language: node.language ?? undefined,
          sizeBytes: node.sizeBytes,
        },
        inSplitPane ? 'right' : activeWorkspace.focusedPane,
        activeWorkspace.id
      );
    },
    [activeWorkspace.focusedPane, activeWorkspace.id, openTabInPane]
  );

  const handleOpenSearchHit = useCallback(
    (hit: WorkspaceSearchHit) => {
      openTabInPane(
        {
          id: hit.path,
          name: hit.name,
          path: hit.path,
          slashPath: hit.slashPath,
          kind: hit.kind,
          language: hit.language,
        },
        activeWorkspace.focusedPane,
        activeWorkspace.id
      );
      if (hit.kind === 'code') {
        jumpSeqRef.current += 1;
        setCodeJumpState({
          tabId: hit.path,
          target: { line: hit.line, seq: jumpSeqRef.current },
        });
      }
    },
    [activeWorkspace.focusedPane, activeWorkspace.id, openTabInPane]
  );

  const handleSelectOutlineItem = useCallback(
    (item: HeadingItem) => {
      if (!activeFocusedTab) return;
      if (activeFocusedTab.kind === 'markdown') {
        setScrollHeadingId(null);
        requestAnimationFrame(() => setScrollHeadingId(item.id));
      } else if (activeFocusedTab.kind === 'code' && item.line) {
        jumpSeqRef.current += 1;
        setCodeJumpState({
          tabId: activeFocusedTab.id,
          target: { line: item.line, seq: jumpSeqRef.current },
        });
      }
    },
    [activeFocusedTab]
  );

  // Draggable Center Split-Pane Resizer
  const startSplitResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = mainSplitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const ratio = (ev.clientX - rect.left) / Math.max(1, rect.width);
      const clamped = Math.min(0.76, Math.max(0.24, ratio));
      updateActiveWorkspace((ws) => ({ ...ws, splitRatio: clamped }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Command Palette Commands (including Multi-Workspace & Multi-Root commands)
  const paletteCommands: CommandItem[] = useMemo(() => {
    const base: CommandItem[] = [
      {
        id: 'new-workspace-folder',
        category: '多工作空间',
        label: '在新工作空间中打开文件夹（保留当前空间与标签）...',
        shortcut: 'Ctrl+Shift+O',
        action: () => void handlePickFolderInNewWorkspace(),
      },
      {
        id: 'append-parallel-folder',
        category: '多工作空间',
        label: '向当前工作空间追加并列文件夹（左侧同时展示多目录）...',
        shortcut: 'Ctrl+Alt+O',
        action: () => void handlePickParallelFolder(),
      },
      {
        id: 'new-blank-workspace',
        category: '多工作空间',
        label: '新建空白实验工作空间',
        action: createBlankWorkspace,
      },
      {
        id: 'new-python',
        category: '代码',
        label: '新建轻量 Python 实验代码页',
        shortcut: 'Ctrl+N',
        action: () => handleNewScratchpad('python'),
      },
      {
        id: 'open-folder',
        category: '文件',
        label: '切换当前空间的主文件夹...',
        action: () => void handlePickPrimaryFolder(),
      },
      {
        id: 'open-file',
        category: '文件',
        label: '打开本地文件 (MD / PDF / 代码)...',
        shortcut: 'Ctrl+O',
        action: () => void handlePickFile(),
      },
      {
        id: 'search-workspace',
        category: '搜索',
        label: '跨所有挂载路径全文检索代码与文档',
        shortcut: 'Ctrl+Shift+F',
        action: () => {
          setSidebarOpen(true);
          setSidebarMode('search');
        },
      },
      {
        id: 'open-ai-sessions',
        category: 'AI 联动',
        label: '查看并研读当前空间关联的 AI 历史会话 (Context Vault)',
        shortcut: 'Ctrl+Shift+A',
        action: () => {
          setSidebarOpen(true);
          setSidebarMode('ai-sessions');
        },
      },
      {
        id: 'launch-context-vault',
        category: 'AI 联动',
        label: '调起 Context Vault 会话管理器并定位当前工程',
        action: () => {
          void openInContextVault(null, activeWorkspace.rootPaths[0] ?? null);
        },
      },
      {
        id: 'toggle-split',
        category: '视图',
        label: activeWorkspace.splitMode
          ? '关闭双栏对照视图'
          : '开启左右双栏对照视图',
        action: () => {
          updateActiveWorkspace((ws) => ({
            ...ws,
            splitMode: !ws.splitMode,
            focusedPane: !ws.splitMode ? ws.focusedPane : 'left',
          }));
        },
      },
      {
        id: 'toggle-console',
        category: '运行',
        label: consoleOpen
          ? '收起底部运行与命令控制台'
          : '展开底部运行与命令控制台',
        shortcut: 'Ctrl+`',
        action: () => setConsoleOpen((v) => !v),
      },
      {
        id: 'toggle-outline',
        category: '视图',
        label: tocOpen ? '隐藏右侧大纲面板' : '显示右侧大纲面板',
        action: () => setTocOpen((v) => !v),
      },
      {
        id: 'theme-light',
        category: '主题',
        label: '切换为「晴空纸白」亮色主题',
        action: () => persistPrefs((p) => ({ ...p, theme: 'light' })),
      },
      {
        id: 'theme-sepia',
        category: '主题',
        label: '切换为「暖阳羊皮纸」护眼主题',
        action: () => persistPrefs((p) => ({ ...p, theme: 'sepia' })),
      },
      {
        id: 'theme-dark',
        category: '主题',
        label: '切换为「深空极夜」暗色主题',
        action: () => persistPrefs((p) => ({ ...p, theme: 'dark' })),
      },
      {
        id: 'zoom-reset',
        category: '视图',
        label: '重置字体与界面缩放为 100%',
        shortcut: 'Ctrl+0',
        action: resetFontSize,
      },
    ];

    workspaces.forEach((ws, idx) => {
      if (ws.id === activeWorkspace.id) return;
      base.unshift({
        id: `switch-ws-${ws.id}`,
        category: '切换空间',
        label: `切换到工作空间：${formatWorkspaceSessionLabel(ws)}`,
        shortcut: idx < 9 ? `Alt+${idx + 1}` : undefined,
        action: () => setActiveWorkspaceId(ws.id),
      });
    });

    return base;
  }, [
    activeWorkspace.id,
    activeWorkspace.rootPaths,
    activeWorkspace.splitMode,
    consoleOpen,
    createBlankWorkspace,
    handleNewScratchpad,
    handlePickFile,
    handlePickFolderInNewWorkspace,
    handlePickParallelFolder,
    handlePickPrimaryFolder,
    persistPrefs,
    resetFontSize,
    tocOpen,
    updateActiveWorkspace,
    workspaces,
  ]);

  const handleOpenGeneratedMarkdown = useCallback(
    (
      wsId: string,
      sourcePane: 'left' | 'right',
      params: {
        suggestedName: string;
        markdown: string;
        defaultSaveDir: string;
      }
    ) => {
      scratchSeqRef.current += 1;
      const id = `pdf-md-${scratchSeqRef.current}`;
      const targetPane: 'left' | 'right' =
        sourcePane === 'left' ? 'right' : 'left';
      openTabInPane(
        {
          id,
          name: params.suggestedName,
          path: id,
          slashPath: id,
          kind: 'markdown',
          language: 'markdown',
          isScratchpad: true,
          initialContent: params.markdown,
          defaultSaveDir: params.defaultSaveDir,
          isDirty: true,
        },
        targetPane,
        wsId
      );
    },
    [openTabInPane]
  );

  // Keep-Alive multi-tab renderer inside each Workspace Session
  const renderPaneTabs = (
    ws: WorkspaceSession,
    isWsActive: boolean,
    tabs: OpenTab[],
    activeTabId: string | null,
    isPrimaryOutlineSource: boolean,
    paneSide: 'left' | 'right'
  ) => {
    if (tabs.length === 0 || !activeTabId) {
      if (!isWsActive) return null;
      return (
        <WelcomeWorkbench
          workspaceName={activeWorkspaceLabel}
          workspacePath={ws.rootPaths[0] || null}
          mountedRootPaths={ws.rootPaths}
          workspaceFileCount={workspaceFileCount}
          recentFiles={prefs.recentFiles}
          recentWorkspaces={prefs.recentWorkspaces}
          runtimes={runtimes}
          preferredPython={prefs.preferredPython ?? null}
          onNewScratchpad={(lang) => handleNewScratchpad(lang)}
          onPickFolder={() => void handlePickPrimaryFolder()}
          onPickFolderNewWorkspace={() => void handlePickFolderInNewWorkspace()}
          onPickParallelFolder={() => void handlePickParallelFolder()}
          onPickFile={() => void handlePickFile()}
          onOpenQuickSearch={(mode) => setQuickOpen({ open: true, mode })}
          onOpenRecentFile={(fp, inSplit) =>
            void openArbitraryLocalPath(fp, Boolean(inSplit))
          }
          onSelectWorkspace={(dir) => {
            setSidebarOpen(true);
            void replacePrimaryFolder(dir, false);
          }}
          onAppendRecentFolder={(dir) => void appendParallelFolder(dir)}
          onOpenRecentInNewWorkspace={(dir) =>
            void openFolderInNewWorkspace(dir)
          }
          onToggleConsole={() => setConsoleOpen((v) => !v)}
        />
      );
    }

    const keptTabs =
      tabs.length <= 6
        ? tabs
        : tabs.filter(
            (t, idx) =>
              t.id === activeTabId || Boolean(t.isDirty) || idx >= tabs.length - 5
          );

    return keptTabs.map((tab) => {
      const isTabActive = tab.id === activeTabId;
      const isPaneFocusedAndActive =
        isWsActive && isTabActive && isPrimaryOutlineSource;
      const tabWorkspaceDir =
        (!tab.isScratchpad
          ? findMatchingMountedRoot(tab.path, ws.rootPaths) ??
            findMatchingMountedRoot(tab.path, allMountedRootPaths)
          : tab.defaultSaveDir ?? null) ??
        ws.rootPaths[0] ??
        null;

      return (
        <div
          key={tab.id}
          className={isTabActive ? 'h-full w-full block' : 'hidden'}
        >
          {tab.kind === 'pdf' ? (
            <Suspense
              fallback={
                <div
                  className="p-8 text-xs"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  正在初始化 PDF 研读与批注引擎...
                </div>
              }
            >
              <LazyPdfPane
                filePath={tab.path}
                slashPath={tab.slashPath}
                sizeBytes={tab.sizeBytes}
                assetBaseUrl={assetBaseUrl}
                isActive={isPaneFocusedAndActive}
                onOpenGeneratedMarkdown={(params) =>
                  handleOpenGeneratedMarkdown(ws.id, paneSide, params)
                }
              />
            </Suspense>
          ) : tab.kind === 'html' ? (
            <HtmlPane
              filePath={tab.path}
              slashPath={tab.slashPath}
              assetBaseUrl={assetBaseUrl}
            />
          ) : tab.kind === 'code' ? (
            <Suspense
              fallback={
                <div
                  className="p-8 text-xs"
                  style={{ color: 'var(--dp-text-muted)' }}
                >
                  正在加载轻量代码编辑器...
                </div>
              }
            >
              <LazyCodeEditorPane
                tabId={tab.id}
                filePath={tab.path}
                initialLanguage={tab.language || 'python'}
                isScratchpad={tab.isScratchpad}
                initialContent={tab.initialContent}
                theme={prefs.theme}
                fontSize={prefs.fontSize}
                isActive={isPaneFocusedAndActive}
                workspaceDir={tabWorkspaceDir}
                jumpTarget={
                  codeJumpState && codeJumpState.tabId === tab.id
                    ? codeJumpState.target
                    : null
                }
                onHeadingsChange={
                  isWsActive && isPrimaryOutlineSource ? setHeadings : undefined
                }
                onCursorStatusChange={
                  isWsActive && isPrimaryOutlineSource
                    ? setEditorStatus
                    : undefined
                }
                runtimes={runtimes}
                preferredPython={prefs.preferredPython ?? null}
                onChangePreferredPython={handleChangePreferredPython}
                isRunning={isCodeRunning}
                onRunCode={(p) => void handleRunCode(p)}
                onStopRun={() => void handleStopRun()}
                onDirtyChange={handleDirtyChange}
                onSavedAs={handleSavedAs}
              />
            </Suspense>
          ) : (
            <MarkdownPane
              tabId={tab.id}
              filePath={tab.path}
              initialName={tab.name}
              isScratchpad={tab.isScratchpad}
              initialContent={tab.initialContent}
              defaultSaveDir={tab.defaultSaveDir ?? tabWorkspaceDir}
              assetBaseUrl={assetBaseUrl}
              theme={prefs.theme}
              fontSize={prefs.fontSize}
              contentWidth={prefs.contentWidth}
              isActive={isPaneFocusedAndActive}
              scrollTargetHeadingId={
                isPaneFocusedAndActive ? scrollHeadingId : null
              }
              onHeadingsChange={
                isWsActive && isPrimaryOutlineSource ? setHeadings : undefined
              }
              onOpenLocalPath={(p, line) =>
                void openArbitraryLocalPath(p, false, line)
              }
              runtimes={runtimes}
              preferredPython={prefs.preferredPython ?? null}
              onChangePreferredPython={handleChangePreferredPython}
              isRunning={isCodeRunning}
              onRunCode={(p) => void handleRunCode(p)}
              onStopRun={() => void handleStopRun()}
              onDirtyChange={handleDirtyChange}
              onSavedAs={handleSavedAs}
            />
          )}
        </div>
      );
    });
  };

  // Keep up to 6 Workspace Sessions mounted in DOM (always keeping active + any dirty workspaces!)
  const keptWorkspaces = useMemo(() => {
    if (workspaces.length <= 6) return workspaces;
    return workspaces.filter((ws, idx) => {
      if (ws.id === activeWorkspace.id) return true;
      const hasDirty =
        ws.leftTabs.some((t) => t.isDirty) ||
        ws.rightTabs.some((t) => t.isDirty);
      if (hasDirty) return true;
      return idx >= workspaces.length - 5;
    });
  }, [workspaces, activeWorkspace.id]);

  const showOutlinePanel =
    tocOpen &&
    Boolean(
      activeFocusedTab &&
        (activeFocusedTab.kind === 'markdown' ||
          activeFocusedTab.kind === 'code')
    );

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden relative">
      <TopBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        hasMountedFolders={activeWorkspace.rootPaths.length > 0}
        currentRootPaths={activeWorkspace.rootPaths}
        recentWorkspaces={prefs.recentWorkspaces}
        onPickFolder={() => void handlePickPrimaryFolder()}
        onPickFolderNewWorkspace={() => void handlePickFolderInNewWorkspace()}
        onPickParallelFolder={() => void handlePickParallelFolder()}
        onOpenRecentInNewWorkspace={(dir) => void openFolderInNewWorkspace(dir)}
        onAppendRecentFolder={(dir) => void appendParallelFolder(dir)}
        onPickFile={() => void handlePickFile()}
        onNewScratchpad={handleNewScratchpad}
        onOpenQuickSearch={() => setQuickOpen({ open: true, mode: 'files' })}
        activeDocKind={activeFocusedTab?.kind || null}
        consoleOpen={consoleOpen}
        onToggleConsole={() => setConsoleOpen((v) => !v)}
        isCodeRunning={isCodeRunning}
        splitMode={activeWorkspace.splitMode}
        onToggleSplit={() => {
          updateActiveWorkspace((ws) => ({
            ...ws,
            splitMode: !ws.splitMode,
            focusedPane: !ws.splitMode ? ws.focusedPane : 'left',
          }));
        }}
        tocOpen={tocOpen}
        onToggleToc={() => setTocOpen((v) => !v)}
        theme={prefs.theme}
        onChangeTheme={(theme: ThemeMode) =>
          persistPrefs((prev) => ({ ...prev, theme }))
        }
        fontSize={prefs.fontSize}
        onChangeFontSize={adjustFontSize}
        onResetFontSize={resetFontSize}
        contentWidth={prefs.contentWidth}
        onCycleWidth={() => {
          const order: ContentWidth[] = ['narrow', 'comfortable', 'wide'];
          persistPrefs((prev) => ({
            ...prev,
            contentWidth:
              order[(order.indexOf(prev.contentWidth) + 1) % order.length],
          }));
        }}
        isPortable={isPortable}
      />

      {/* Multi-Workspace 0ms Switcher + Parallel Folder Mount Strip */}
      <WorkspaceBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace.id}
        effectiveWorkingDir={effectiveWorkingDir}
        isCwdAuto={isCwdAuto}
        onSelectWorkspace={setActiveWorkspaceId}
        onCloseWorkspace={closeWorkspaceSession}
        onRenameWorkspace={renameWorkspaceSession}
        onCreateWorkspaceFromFolder={() =>
          void handlePickFolderInNewWorkspace()
        }
        onCreateBlankWorkspace={createBlankWorkspace}
        onAddParallelFolder={(wsId) => void handlePickParallelFolder(wsId)}
        onRefreshWorkspace={(wsId) => void refreshWorkspaceTrees(wsId)}
        onToggleConsole={() => setConsoleOpen((v) => !v)}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {sidebarOpen && (
          <Sidebar
            workspaceTrees={activeWorkspace.rootTrees}
            activeRootPath={activeMatchedRoot}
            activePath={activeFocusedTab?.path || null}
            mode={sidebarMode}
            onChangeMode={setSidebarMode}
            onOpenNode={handleOpenTreeNode}
            onOpenSearchHit={handleOpenSearchHit}
            onOpenAiSessionNote={handleOpenAiSessionNote}
            onItemCreated={(item) => {
              void refreshWorkspaceTrees(activeWorkspace.id);
              if (item.kind !== 'folder') {
                openTabInPane(
                  {
                    id: item.path,
                    name: item.name,
                    path: item.path,
                    slashPath: item.slashPath,
                    kind: item.kind,
                    language: item.language ?? undefined,
                    sizeBytes: item.sizeBytes,
                  },
                  activeWorkspace.focusedPane,
                  activeWorkspace.id
                );
              }
            }}
            onItemRenamedOrDeleted={() => {
              void refreshWorkspaceTrees(activeWorkspace.id);
            }}
            onRefreshWorkspace={(rootPath) =>
              void refreshWorkspaceTrees(activeWorkspace.id, rootPath)
            }
            onSwitchWorkspace={(dir) => void replacePrimaryFolder(dir, false)}
            onAddParallelFolder={() => void handlePickParallelFolder()}
            onAppendWorkspacePath={(dir) => void appendParallelFolder(dir)}
            onOpenWorkspaceInNewSession={(dir) =>
              void openFolderInNewWorkspace(dir)
            }
            onOpenNewWorkspaceDialog={() =>
              void handlePickFolderInNewWorkspace()
            }
            onRemoveRootFolder={removeRootFromActiveWorkspace}
            onOpenRecentFile={(fp) => void openArbitraryLocalPath(fp, false)}
            bookmarks={prefs.bookmarks}
            onToggleBookmark={(folderPath) =>
              persistPrefs((prev) => ({
                ...prev,
                bookmarks: prev.bookmarks.some((b) =>
                  pathsEqual(b, folderPath)
                )
                  ? prev.bookmarks.filter((b) => !pathsEqual(b, folderPath))
                  : [folderPath, ...prev.bookmarks],
              }))
            }
            recentWorkspaces={prefs.recentWorkspaces}
            recentFiles={prefs.recentFiles}
          />
        )}

        {/* Center Column: Keep-Alive Multi-Workspace Panes + Bottom Console Drawer */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
          {keptWorkspaces.map((ws) => {
            const isWsActive = ws.id === activeWorkspace.id;
            return (
              <main
                key={ws.id}
                ref={isWsActive ? mainSplitRef : undefined}
                className={
                  isWsActive
                    ? 'flex-1 flex min-w-0 min-h-0 overflow-hidden relative'
                    : 'hidden'
                }
              >
                <section
                  onMouseDown={() => {
                    if (ws.focusedPane !== 'left') {
                      updateWorkspaceById(ws.id, (cur) => ({
                        ...cur,
                        focusedPane: 'left',
                      }));
                    }
                  }}
                  style={
                    ws.splitMode
                      ? { width: `${(ws.splitRatio * 100).toFixed(2)}%` }
                      : undefined
                  }
                  className={`${
                    ws.splitMode ? 'shrink-0' : 'flex-1'
                  } flex flex-col min-w-0 h-full overflow-hidden`}
                >
                  <TabStrip
                    tabs={ws.leftTabs}
                    activeTabId={ws.leftActiveId}
                    isFocusedPane={!ws.splitMode || ws.focusedPane === 'left'}
                    onSelectTab={(id) => {
                      updateWorkspaceById(ws.id, (cur) => ({
                        ...cur,
                        leftActiveId: id,
                        focusedPane: 'left',
                      }));
                    }}
                    onCloseTab={(id) => closeTab(ws.id, 'left', id)}
                    onCloseOthers={(id) => closeOtherTabs(ws.id, 'left', id)}
                    onCloseAll={() => closeAllTabs(ws.id, 'left')}
                    onOpenInSplit={(tab) => openTabInPane(tab, 'right', ws.id)}
                  />
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {renderPaneTabs(
                      ws,
                      isWsActive,
                      ws.leftTabs,
                      ws.leftActiveId,
                      ws.focusedPane === 'left' || !ws.splitMode,
                      'left'
                    )}
                  </div>
                </section>

                {ws.splitMode && (
                  <>
                    {/* Draggable Split Divider */}
                    <div
                      onMouseDown={startSplitResize}
                      onDoubleClick={() =>
                        updateWorkspaceById(ws.id, (cur) => ({
                          ...cur,
                          splitRatio: 0.5,
                        }))
                      }
                      title="左右拖拽调整分屏比例，双击恢复 50% 等宽"
                      className="w-1.5 h-full shrink-0 cursor-col-resize hover:bg-blue-500/40 transition border-x"
                      style={{
                        backgroundColor: 'var(--dp-sidebar)',
                        borderColor: 'var(--dp-border-strong)',
                      }}
                    />

                    <section
                      onMouseDown={() => {
                        if (ws.focusedPane !== 'right') {
                          updateWorkspaceById(ws.id, (cur) => ({
                            ...cur,
                            focusedPane: 'right',
                          }));
                        }
                      }}
                      className="flex-1 flex flex-col min-w-0 h-full overflow-hidden"
                    >
                      <TabStrip
                        tabs={ws.rightTabs}
                        activeTabId={ws.rightActiveId}
                        isFocusedPane={ws.focusedPane === 'right'}
                        onSelectTab={(id) => {
                          updateWorkspaceById(ws.id, (cur) => ({
                            ...cur,
                            rightActiveId: id,
                            focusedPane: 'right',
                          }));
                        }}
                        onCloseTab={(id) => closeTab(ws.id, 'right', id)}
                        onCloseOthers={(id) =>
                          closeOtherTabs(ws.id, 'right', id)
                        }
                        onCloseAll={() => closeAllTabs(ws.id, 'right')}
                      />
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {renderPaneTabs(
                          ws,
                          isWsActive,
                          ws.rightTabs,
                          ws.rightActiveId,
                          ws.focusedPane === 'right',
                          'right'
                        )}
                      </div>
                    </section>
                  </>
                )}
              </main>
            );
          })}

          <ConsoleDrawer
            open={consoleOpen}
            onClose={() => setConsoleOpen(false)}
            isRunning={isCodeRunning}
            runLabel={runLabel}
            chunks={consoleChunks}
            lastDone={lastRunDone}
            onStopRun={() => void handleStopRun()}
            onClear={() => {
              setConsoleChunks([]);
              setLastRunDone(null);
            }}
            onRunCommand={(cmd) =>
              void handleRunCode({
                language: 'powershell',
                code: cmd,
                filePath: null,
                workingDir: effectiveWorkingDir,
                isSavedFile: false,
              })
            }
            workspaceDir={effectiveWorkingDir}
            cwdMode={activeWorkspace.consoleCwdOverride}
            availableDirs={availableWorkingDirs}
            onChangeCwdMode={(nextMode) =>
              updateActiveWorkspace((ws) => ({
                ...ws,
                consoleCwdOverride: nextMode,
              }))
            }
            runtimes={runtimes}
            preferredPython={prefs.preferredPython ?? null}
            onChangePreferredPython={handleChangePreferredPython}
            fontSize={prefs.fontSize}
          />
        </div>

        {showOutlinePanel && (
          <OutlineToc
            headings={headings}
            docKind={activeFocusedTab?.kind || null}
            onSelectItem={handleSelectOutlineItem}
            onClose={() => setTocOpen(false)}
          />
        )}
      </div>

      {/* Unified Studio Bottom StatusBar */}
      <StatusBar
        workspaceName={activeWorkspaceLabel}
        workspacePath={activeWorkspace.rootPaths[0] || null}
        workspaceFileCount={workspaceFileCount}
        workspaceSessionCount={workspaces.length}
        activeSessionIndex={activeSessionIndex}
        mountedFolderCount={activeWorkspace.rootPaths.length}
        effectiveWorkingDir={effectiveWorkingDir}
        onCycleWorkspace={cycleWorkspaceSession}
        activeTab={activeFocusedTab}
        editorStatus={activeFocusedTab?.kind === 'code' ? editorStatus : null}
        fontSize={prefs.fontSize}
        onResetZoom={resetFontSize}
        isRunning={isCodeRunning}
        consoleOpen={consoleOpen}
        onToggleConsole={() => setConsoleOpen((v) => !v)}
        runtimes={runtimes}
        preferredPython={prefs.preferredPython ?? null}
        onChangePreferredPython={handleChangePreferredPython}
        onPickFolder={() => void handlePickPrimaryFolder()}
        onOpenQuickSearch={() => setQuickOpen({ open: true, mode: 'files' })}
        onOpenFullTextSearch={() => {
          setSidebarOpen(true);
          setSidebarMode('search');
        }}
      />

      {/* Quick Open & Command Palette Modal (Ctrl+P / Ctrl+Shift+P) */}
      <QuickOpenModal
        open={quickOpen.open}
        initialMode={quickOpen.mode}
        workspaceTrees={activeWorkspace.rootTrees}
        recentFiles={prefs.recentFiles}
        commands={paletteCommands}
        onOpenNode={handleOpenTreeNode}
        onOpenRecentPath={(p, inSplit) =>
          void openArbitraryLocalPath(p, inSplit)
        }
        onClose={() => setQuickOpen((prev) => ({ ...prev, open: false }))}
      />

      {zoomHudSize !== null && (
        <div className="fixed bottom-9 right-6 z-40 px-3.5 py-1.5 rounded-full bg-slate-900/90 text-white text-xs font-semibold shadow-lg border border-slate-700 pointer-events-none flex items-center gap-2">
          <span>🔍 缩放 {Math.round((zoomHudSize / 16) * 100)}%</span>
          <span className="text-slate-400 font-mono">({zoomHudSize}px)</span>
        </div>
      )}

      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-blue-600/20 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="px-6 py-4 rounded-2xl bg-slate-900 text-white shadow-2xl flex items-center gap-3 text-sm font-bold">
            <Sparkles className="w-5 h-5 text-sky-400" />
            <span>
              松开即可打开文档/代码；拖入文件夹将在新工作空间中独立开启（保留当前工作路径）
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
