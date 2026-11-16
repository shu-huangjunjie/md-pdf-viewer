import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Code2,
  Columns2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Layers,
  ListTree,
  Loader2,
  Minus,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Sunset,
  Terminal,
} from 'lucide-react';
import type { ContentWidth, DocKind, ThemeMode } from '@/types';
import { getPathBasename, pathsEqual } from '@/utils/workspaceUtils';

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  hasMountedFolders: boolean;
  currentRootPaths: string[];
  recentWorkspaces: string[];
  onPickFolder: () => void;
  onPickFolderNewWorkspace: () => void;
  onPickParallelFolder: () => void;
  onOpenRecentInNewWorkspace: (folderPath: string) => void;
  onAppendRecentFolder: (folderPath: string) => void;
  onPickFile: () => void;
  onNewScratchpad: () => void;
  onOpenQuickSearch: () => void;
  activeDocKind: Exclude<DocKind, 'folder'> | null;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  isCodeRunning: boolean;
  splitMode: boolean;
  onToggleSplit: () => void;
  tocOpen: boolean;
  onToggleToc: () => void;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  fontSize: number;
  onChangeFontSize: (delta: number) => void;
  onResetFontSize: () => void;
  contentWidth: ContentWidth;
  onCycleWidth: () => void;
  isPortable?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  sidebarOpen,
  onToggleSidebar,
  hasMountedFolders,
  currentRootPaths,
  recentWorkspaces,
  onPickFolder,
  onPickFolderNewWorkspace,
  onPickParallelFolder,
  onOpenRecentInNewWorkspace,
  onAppendRecentFolder,
  onPickFile,
  onNewScratchpad,
  onOpenQuickSearch,
  activeDocKind,
  consoleOpen,
  onToggleConsole,
  isCodeRunning,
  splitMode,
  onToggleSplit,
  tocOpen,
  onToggleToc,
  theme,
  onChangeTheme,
  fontSize,
  onChangeFontSize,
  onResetFontSize,
  contentWidth,
  onCycleWidth,
}) => {
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const folderMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!folderMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (
        folderMenuRef.current &&
        !folderMenuRef.current.contains(e.target as Node)
      ) {
        setFolderMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFolderMenuOpen(false);
    };
    window.addEventListener('mousedown', onOutside);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onOutside);
      window.removeEventListener('keydown', onEsc);
    };
  }, [folderMenuOpen]);

  const widthLabels: Record<ContentWidth, string> = {
    narrow: '窄版书页',
    comfortable: '适中宽幅',
    wide: '全宽铺满',
  };

  const supportsOutline = activeDocKind === 'markdown' || activeDocKind === 'code';

  const unmountedRecents = recentWorkspaces
    .filter((rw) => !currentRootPaths.some((cp) => pathsEqual(cp, rw)))
    .slice(0, 4);

  return (
    <header
      className="h-11 px-3 flex items-center justify-between border-b shrink-0 gap-2 select-none relative z-40"
      style={{
        backgroundColor: 'var(--dp-surface)',
        borderColor: 'var(--dp-border)',
      }}
    >
      {/* Left: Sidebar Toggle & File / Multi-Workspace Folder / Code Actions */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          title={sidebarOpen ? '收起左侧资源栏 (Ctrl+B)' : '展开左侧资源栏 (Ctrl+B)'}
          className="p-1.5 rounded-lg transition hover:opacity-80 shrink-0"
          style={{
            backgroundColor: sidebarOpen ? 'var(--dp-accent-soft)' : 'transparent',
            color: sidebarOpen ? 'var(--dp-accent)' : 'var(--dp-text-secondary)',
          }}
        >
          <PanelLeft className="w-4 h-4" />
        </button>

        {/* Smart Folder Button: Direct picker when empty, Multi-Workspace Menu when already mounted */}
        <div ref={folderMenuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              if (!hasMountedFolders) {
                onPickFolder();
              } else {
                setFolderMenuOpen((v) => !v);
              }
            }}
            title={
              hasMountedFolders
                ? '打开更多工作路径：支持「新工作空间秒切」或「当前空间追加并列目录」'
                : '打开本地工作区文件夹'
            }
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition shadow-sm text-white bg-blue-600 hover:bg-blue-700"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="hidden md:inline">打开文件夹</span>
            {hasMountedFolders && (
              <ChevronDown className="w-3 h-3 opacity-85 -ml-0.5" />
            )}
          </button>

          {folderMenuOpen && (
            <div
              className="absolute left-0 top-full mt-1.5 w-80 rounded-xl border shadow-2xl p-1.5 z-50 text-xs space-y-0.5"
              style={{
                backgroundColor: 'var(--dp-elevated)',
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-text)',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setFolderMenuOpen(false);
                  onPickFolderNewWorkspace();
                }}
                className="w-full text-left p-2 rounded-lg flex items-start gap-2.5 hover:bg-blue-500/10 transition"
              >
                <div className="w-7 h-7 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                  <Layers className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-blue-600 dark:text-sky-400">
                      在新工作空间中打开...
                    </span>
                    <kbd
                      className="px-1.5 py-0.2 rounded text-[10px] font-mono border shrink-0"
                      style={{
                        backgroundColor: 'var(--dp-sidebar)',
                        borderColor: 'var(--dp-border)',
                        color: 'var(--dp-text-muted)',
                      }}
                    >
                      Ctrl+Shift+O
                    </kbd>
                  </div>
                  <p
                    className="text-[11px] mt-0.5 leading-snug"
                    style={{ color: 'var(--dp-text-secondary)' }}
                  >
                    保留当前空间与打开的标签页，顶部栏一键 0ms 切换
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setFolderMenuOpen(false);
                  onPickParallelFolder();
                }}
                className="w-full text-left p-2 rounded-lg flex items-start gap-2.5 hover:bg-emerald-500/10 transition"
              >
                <div className="w-7 h-7 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                  <FolderPlus className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-emerald-700 dark:text-emerald-300">
                      追加为当前空间的并列路径...
                    </span>
                    <kbd
                      className="px-1.5 py-0.2 rounded text-[10px] font-mono border shrink-0"
                      style={{
                        backgroundColor: 'var(--dp-sidebar)',
                        borderColor: 'var(--dp-border)',
                        color: 'var(--dp-text-muted)',
                      }}
                    >
                      Ctrl+Alt+O
                    </kbd>
                  </div>
                  <p
                    className="text-[11px] mt-0.5 leading-snug"
                    style={{ color: 'var(--dp-text-secondary)' }}
                  >
                    在左侧目录树同时挂载两个以上工程路径，支持同屏对照
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setFolderMenuOpen(false);
                  onPickFolder();
                }}
                className="w-full text-left p-2 rounded-lg flex items-start gap-2.5 hover:bg-black/5 dark:hover:bg-white/5 transition"
              >
                <div
                  className="w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 mt-0.5"
                  style={{
                    backgroundColor: 'var(--dp-sidebar)',
                    borderColor: 'var(--dp-border)',
                    color: 'var(--dp-text-secondary)',
                  }}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold">替换当前空间主目录...</span>
                  <p
                    className="text-[11px] mt-0.5 leading-snug"
                    style={{ color: 'var(--dp-text-muted)' }}
                  >
                    将当前工作空间切换为另一个新的文件夹
                  </p>
                </div>
              </button>

              {unmountedRecents.length > 0 && (
                <>
                  <div
                    className="my-1 border-t"
                    style={{ borderColor: 'var(--dp-border)' }}
                  />
                  <div className="px-2 py-1">
                    <div
                      className="text-[10.5px] font-semibold mb-1"
                      style={{ color: 'var(--dp-text-muted)' }}
                    >
                      🕒 快速挂载最近工程路径
                    </div>
                    <div className="space-y-1">
                      {unmountedRecents.map((dir) => {
                        const base = getPathBasename(dir);
                        return (
                          <div
                            key={dir}
                            className="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setFolderMenuOpen(false);
                                onOpenRecentInNewWorkspace(dir);
                              }}
                              title={`在新工作空间中打开：${dir}`}
                              className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                            >
                              <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              <span className="truncate font-medium">{base}</span>
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  setFolderMenuOpen(false);
                                  onAppendRecentFolder(dir);
                                }}
                                title={`追加为并列路径：${dir}`}
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition"
                              >
                                +并列
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setFolderMenuOpen(false);
                                  onOpenRecentInNewWorkspace(dir);
                                }}
                                title={`在新空间打开：${dir}`}
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-sky-300 hover:bg-blue-500/25 transition"
                              >
                                新空间
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onPickFile}
          title="打开 Markdown / PDF / Python / JS / JSON / Rust 等文件 (Ctrl+O)"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition hover:opacity-85 shrink-0"
          style={{
            borderColor: 'var(--dp-border-strong)',
            backgroundColor: 'var(--dp-elevated)',
          }}
        >
          <FilePlus2 className="w-3.5 h-3.5" />
          <span className="hidden md:inline">打开文件</span>
        </button>

        <button
          type="button"
          onClick={onNewScratchpad}
          title="新建轻量代码页（支持 Python / JS / TS / PowerShell / Rust 即写即跑，Ctrl+N）"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition hover:opacity-90 shrink-0 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
        >
          <Code2 className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">新建代码</span>
        </button>
      </div>

      {/* Center: VS Code-style Quick Open & Command Palette Trigger */}
      <button
        type="button"
        onClick={onOpenQuickSearch}
        title="快速搜索所有挂载工作路径中的文件或输入 > 执行快捷命令 (Ctrl+P / Ctrl+Shift+P)"
        className="hidden sm:flex items-center justify-between gap-3 px-3 py-1 rounded-lg border text-xs transition hover:opacity-90 max-w-xs w-full mx-2"
        style={{
          backgroundColor: 'var(--dp-sidebar)',
          borderColor: 'var(--dp-border-strong)',
          color: 'var(--dp-text-muted)',
        }}
      >
        <span className="flex items-center gap-1.5 truncate">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">快速跳转文件或命令...</span>
        </span>
        <kbd
          className="px-1.5 py-0.2 rounded text-[10px] font-mono border shrink-0"
          style={{
            backgroundColor: 'var(--dp-surface)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          Ctrl+P
        </kbd>
      </button>

      {/* Right: Console, Split View, Zoom, Contextual Width, Theme & Outline */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onToggleConsole}
          title="打开/收起底部运行与命令终端 (Ctrl+`)"
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border transition"
          style={{
            borderColor: consoleOpen ? 'var(--dp-accent)' : 'var(--dp-border)',
            backgroundColor: consoleOpen ? 'var(--dp-accent-soft)' : 'transparent',
            color: consoleOpen ? 'var(--dp-accent)' : 'var(--dp-text-secondary)',
          }}
        >
          {isCodeRunning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-500" />
          ) : (
            <Terminal className="w-3.5 h-3.5" />
          )}
          <span className="hidden xl:inline">控制台</span>
        </button>

        <button
          type="button"
          onClick={onToggleSplit}
          title="开启双栏同屏对照（可把左侧不同工作路径的文件拖/点到左右双栏并排编辑阅读）"
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border transition"
          style={{
            borderColor: splitMode ? 'var(--dp-accent)' : 'var(--dp-border)',
            backgroundColor: splitMode ? 'var(--dp-accent-soft)' : 'transparent',
            color: splitMode ? 'var(--dp-accent)' : 'var(--dp-text-secondary)',
          }}
        >
          <Columns2 className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">{splitMode ? '退出分屏' : '双栏对照'}</span>
        </button>

        {/* Font size / Zoom controls */}
        <div
          className="flex items-center rounded-lg border px-1 py-0.5 text-xs"
          style={{ borderColor: 'var(--dp-border)' }}
          title="按住 Ctrl + 鼠标滚轮自由放大缩小"
        >
          <button
            type="button"
            onClick={() => onChangeFontSize(-1)}
            title="缩小显示 (Ctrl + - 或 Ctrl + 滚轮向下)"
            className="p-1 rounded hover:opacity-75"
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onResetFontSize}
            title="点击重置为 100% 默认大小 (16px / Ctrl+0)"
            className="px-1 font-mono text-[11px] min-w-[40px] text-center hover:opacity-80 cursor-pointer"
          >
            {Math.round((fontSize / 16) * 100)}%
          </button>
          <button
            type="button"
            onClick={() => onChangeFontSize(1)}
            title="放大显示 (Ctrl + + 或 Ctrl + 滚轮向上)"
            className="p-1 rounded hover:opacity-75"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Contextual Markdown Page Width Selector */}
        {activeDocKind === 'markdown' && (
          <button
            type="button"
            onClick={onCycleWidth}
            title="切换 Markdown 阅读版心宽度"
            className="hidden xl:inline-block px-2 py-1 rounded-lg text-xs border transition hover:opacity-80"
            style={{
              borderColor: 'var(--dp-border)',
              color: 'var(--dp-text-secondary)',
            }}
          >
            {widthLabels[contentWidth]}
          </button>
        )}

        {/* 3-Mode Eye-Care Theme Switcher */}
        <div
          className="flex items-center rounded-lg border p-0.5"
          style={{ borderColor: 'var(--dp-border)' }}
        >
          <button
            type="button"
            onClick={() => onChangeTheme('light')}
            title="晴空纸白主题"
            className="p-1 rounded-md transition"
            style={{
              backgroundColor: theme === 'light' ? 'var(--dp-accent-soft)' : 'transparent',
              color: theme === 'light' ? 'var(--dp-accent)' : 'var(--dp-text-muted)',
            }}
          >
            <Sun className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onChangeTheme('sepia')}
            title="暖阳羊皮纸护眼主题"
            className="p-1 rounded-md transition"
            style={{
              backgroundColor: theme === 'sepia' ? 'var(--dp-accent-soft)' : 'transparent',
              color: theme === 'sepia' ? 'var(--dp-accent)' : 'var(--dp-text-muted)',
            }}
          >
            <Sunset className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onChangeTheme('dark')}
            title="深空极夜暗色主题"
            className="p-1 rounded-md transition"
            style={{
              backgroundColor: theme === 'dark' ? 'var(--dp-accent-soft)' : 'transparent',
              color: theme === 'dark' ? 'var(--dp-accent)' : 'var(--dp-text-muted)',
            }}
          >
            <Moon className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleToc}
          title={
            supportsOutline
              ? '显示/隐藏右侧章节与代码符号大纲'
              : '切换到 Markdown 或代码/JSON 文件可查看章节与函数结构大纲'
          }
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border transition ${
            supportsOutline ? '' : 'opacity-50'
          }`}
          style={{
            borderColor:
              tocOpen && supportsOutline ? 'var(--dp-accent)' : 'var(--dp-border)',
            backgroundColor:
              tocOpen && supportsOutline ? 'var(--dp-accent-soft)' : 'transparent',
            color:
              tocOpen && supportsOutline ? 'var(--dp-accent)' : 'var(--dp-text-secondary)',
          }}
        >
          <ListTree className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">大纲</span>
        </button>
      </div>
    </header>
  );
};
