import React from 'react';
import {
  Clock,
  Code2,
  Columns2,
  Command,
  Cpu,
  FileCode2,
  FolderOpen,
  FolderPlus,
  Layers,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type { DocKind, RuntimeProfile } from '@/types';
import { pathsEqual } from '@/utils/workspaceUtils';
import { FileBadge } from './FileBadge';
import { PrismStudioLogo } from './PrismStudioLogo';

export type ScratchpadLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'powershell'
  | 'rust'
  | 'json'
  | 'markdown';

interface WelcomeWorkbenchProps {
  workspaceName: string | null;
  workspacePath: string | null;
  mountedRootPaths?: string[];
  workspaceFileCount: number;
  recentFiles: string[];
  recentWorkspaces: string[];
  runtimes: RuntimeProfile[];
  preferredPython: string | null;
  onNewScratchpad: (language?: ScratchpadLanguage) => void;
  onPickFolder: () => void;
  onPickFolderNewWorkspace?: () => void;
  onPickParallelFolder?: () => void;
  onPickFile: () => void;
  onOpenQuickSearch: (mode: 'files' | 'commands') => void;
  onOpenRecentFile: (filePath: string, inSplit?: boolean) => void;
  onSelectWorkspace: (folderPath: string) => void;
  onAppendRecentFolder?: (folderPath: string) => void;
  onOpenRecentInNewWorkspace?: (folderPath: string) => void;
  onToggleConsole: () => void;
}

const QUICK_LANGUAGES: Array<{
  lang: ScratchpadLanguage;
  badge: string;
  label: string;
  badgeClass: string;
}> = [
  {
    lang: 'python',
    badge: 'PY',
    label: 'Python 实验',
    badgeClass:
      'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  },
  {
    lang: 'typescript',
    badge: 'TS',
    label: 'TypeScript',
    badgeClass: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
  {
    lang: 'javascript',
    badge: 'JS',
    label: 'JavaScript',
    badgeClass:
      'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  },
  {
    lang: 'powershell',
    badge: 'PS1',
    label: 'PowerShell',
    badgeClass:
      'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  },
  {
    lang: 'rust',
    badge: 'RS',
    label: 'Rust 源码',
    badgeClass:
      'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  },
  {
    lang: 'json',
    badge: 'JSON',
    label: 'JSON 配置',
    badgeClass:
      'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30',
  },
  {
    lang: 'markdown',
    badge: 'MD',
    label: 'Markdown 笔记',
    badgeClass: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  },
];

function splitPathDisplay(rawPath: string): { name: string; parent: string } {
  const normalized = rawPath.replace(/\//g, '\\').replace(/\\+$/, '');
  const parts = normalized.split('\\').filter(Boolean);
  const name = parts[parts.length - 1] || rawPath;
  const parent =
    parts.length > 2
      ? `${parts[0]}\\…\\${parts[parts.length - 2]}`
      : parts.slice(0, -1).join('\\');
  return { name, parent };
}

function inferDocKindFromPath(filePath: string): Exclude<DocKind, 'folder'> {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  return 'code';
}

export const WelcomeWorkbench: React.FC<WelcomeWorkbenchProps> = ({
  workspaceName,
  workspacePath,
  mountedRootPaths = [],
  workspaceFileCount,
  recentFiles,
  recentWorkspaces,
  runtimes,
  preferredPython,
  onNewScratchpad,
  onPickFolder,
  onPickFolderNewWorkspace,
  onPickParallelFolder,
  onPickFile,
  onOpenQuickSearch,
  onOpenRecentFile,
  onSelectWorkspace,
  onAppendRecentFolder,
  onOpenRecentInNewWorkspace,
  onToggleConsole,
}) => {
  const pythonRuntimes = runtimes.filter((r) => r.language === 'python');
  const activePython =
    pythonRuntimes.find((r) => r.executable === preferredPython) ||
    pythonRuntimes[0] ||
    null;

  return (
    <div className="h-full w-full overflow-y-auto px-6 py-6 flex flex-col items-center select-none">
      <div className="my-auto w-full max-w-3xl space-y-4">
        {/* Hero Brand & Live Runtime Header */}
        <div
          className="rounded-2xl border p-4 sm:px-5 sm:py-4 flex flex-wrap items-center justify-between gap-4 relative overflow-hidden"
          style={{
            backgroundColor: 'var(--dp-sidebar)',
            borderColor: 'var(--dp-border)',
          }}
        >
          <div
            className="pointer-events-none absolute -right-12 -top-12 w-48 h-48 rounded-full opacity-20 blur-2xl"
            style={{
              background:
                'radial-gradient(circle, rgba(6,196,204,0.65) 0%, rgba(37,99,235,0) 70%)',
            }}
          />

          <div className="flex items-center gap-3.5 min-w-0 relative z-10">
            <PrismStudioLogo className="w-12 h-12 shrink-0 drop-shadow-sm" />
            <div className="min-w-0 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight">
                  棱镜工坊 PrismStudio
                </h1>
                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-gradient-to-r from-blue-600/15 to-cyan-500/15 text-blue-700 dark:text-cyan-300 border border-blue-500/25">
                  多工作空间秒切 · 并列路径工作台
                </span>
              </div>
              <p
                className="text-xs mt-1 leading-relaxed"
                style={{ color: 'var(--dp-text-secondary)' }}
              >
                单窗口开启多个独立工作空间或并列挂载多个工程路径，集智能代码补全、实时运行与 Markdown / PDF 双栏对照于一体
              </p>
            </div>
          </div>

          {/* Live Environment & Multi-Workspace Quick Pills */}
          <div className="flex flex-wrap items-center gap-1.5 relative z-10">
            {activePython && (
              <button
                type="button"
                onClick={onToggleConsole}
                title={`当前默认运行环境：${activePython.executable}\n点击展开/收起底部终端控制台 (Ctrl+\`)`}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition hover:opacity-90"
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border-strong)',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <Cpu className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className="truncate max-w-[140px]">
                  {activePython.label}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={onPickFolder}
              title={
                workspacePath
                  ? `当前挂载主路径：${workspacePath}\n点击管理或切换目录`
                  : '点击选择并挂载本地工程文件夹'
              }
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition hover:opacity-90"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
                color: workspaceName
                  ? 'var(--dp-accent)'
                  : 'var(--dp-text-secondary)',
              }}
            >
              <FolderOpen className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[165px]">
                {workspaceName
                  ? `${workspaceName}${
                      mountedRootPaths.length > 1
                        ? ` +${mountedRootPaths.length - 1}`
                        : ''
                    } (${workspaceFileCount})`
                  : '挂载工程目录'}
              </span>
            </button>
            {workspaceName && onPickParallelFolder && (
              <button
                type="button"
                onClick={onPickParallelFolder}
                title="向当前空间追加并列文件夹 (Ctrl+Alt+O)"
                className="flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 border-emerald-500/35 bg-emerald-500/10 hover:bg-emerald-500/20 transition"
              >
                <FolderPlus className="w-3 h-3" />
                <span>+并列目录</span>
              </button>
            )}
            {workspaceName && onPickFolderNewWorkspace && (
              <button
                type="button"
                onClick={onPickFolderNewWorkspace}
                title="在新工作空间中打开另一个工程文件夹 (Ctrl+Shift+O)"
                className="flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold text-blue-700 dark:text-sky-300 border-blue-500/35 bg-blue-500/10 hover:bg-blue-500/20 transition"
              >
                <Layers className="w-3 h-3" />
                <span>+新工作空间</span>
              </button>
            )}
          </div>
        </div>

        {/* 2x2 Primary Workbench Action Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left">
          <button
            type="button"
            onClick={() => onNewScratchpad('python')}
            className="group flex items-start gap-3 p-3.5 rounded-xl border text-left transition hover:border-emerald-500/50 hover:shadow-sm"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border)',
            }}
          >
            <div className="w-9 h-9 rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <Code2 className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">新建代码实验页</span>
                <kbd
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0"
                  style={{
                    backgroundColor: 'var(--dp-elevated)',
                    borderColor: 'var(--dp-border-strong)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  Ctrl+N
                </kbd>
              </div>
              <p
                className="text-[11px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--dp-text-secondary)' }}
              >
                零样板空白起步，内置科学计算智能补全、参数提示与 F5 即时运行
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              if (workspaceName && onPickFolderNewWorkspace) {
                onPickFolderNewWorkspace();
              } else {
                onPickFolder();
              }
            }}
            className="group flex items-start gap-3 p-3.5 rounded-xl border text-left transition hover:border-blue-500/50 hover:shadow-sm"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border)',
            }}
          >
            <div className="w-9 h-9 rounded-lg bg-blue-500/12 text-blue-600 dark:text-blue-400 border border-blue-500/25 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              {workspaceName ? (
                <Layers className="w-4.5 h-4.5" />
              ) : (
                <FolderOpen className="w-4.5 h-4.5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">
                  {workspaceName ? '开启第二个工作空间' : '打开项目工作区'}
                </span>
                <kbd
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0"
                  style={{
                    backgroundColor: 'var(--dp-elevated)',
                    borderColor: 'var(--dp-border-strong)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  {workspaceName ? 'Ctrl+Shift+O' : '工程目录'}
                </kbd>
              </div>
              <p
                className="text-[11px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--dp-text-secondary)' }}
              >
                {workspaceName
                  ? '单窗口同时管理多个项目路径，顶部栏 0ms 秒切且保留各自已开标签页'
                  : '管理目录树与新建文件，自动扫描工程符号、Python 环境与全文检索'}
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={onPickFile}
            className="group flex items-start gap-3 p-3.5 rounded-xl border text-left transition hover:border-indigo-500/50 hover:shadow-sm"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border)',
            }}
          >
            <div className="w-9 h-9 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border border-indigo-500/25 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <FileCode2 className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">打开代码或科研文档</span>
                <kbd
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0"
                  style={{
                    backgroundColor: 'var(--dp-elevated)',
                    borderColor: 'var(--dp-border-strong)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  Ctrl+O
                </kbd>
              </div>
              <p
                className="text-[11px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--dp-text-secondary)' }}
              >
                原生支持 .py / .ts / .rs / .ps1 / .json 代码及 .md / .pdf / .html 研读
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              onOpenQuickSearch(workspaceName ? 'files' : 'commands')
            }
            className="group flex items-start gap-3 p-3.5 rounded-xl border text-left transition hover:border-cyan-500/50 hover:shadow-sm"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border)',
            }}
          >
            <div className="w-9 h-9 rounded-lg bg-cyan-500/12 text-cyan-600 dark:text-cyan-400 border border-cyan-500/25 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <Command className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">快速跳转与命令面板</span>
                <kbd
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0"
                  style={{
                    backgroundColor: 'var(--dp-elevated)',
                    borderColor: 'var(--dp-border-strong)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  Ctrl+P
                </kbd>
              </div>
              <p
                className="text-[11px] mt-1 leading-snug line-clamp-2"
                style={{ color: 'var(--dp-text-secondary)' }}
              >
                跨所有挂载路径模糊定位工程文件、开启左右双栏对照或切换工作空间
              </p>
            </div>
          </button>
        </div>

        {/* Multi-Language Instant Blank Tab Bar */}
        <div
          className="rounded-xl border px-3.5 py-2.5 flex flex-wrap items-center gap-1.5"
          style={{
            backgroundColor: 'var(--dp-sidebar)',
            borderColor: 'var(--dp-border)',
          }}
        >
          <span
            className="text-[11px] font-semibold flex items-center gap-1 mr-1"
            style={{ color: 'var(--dp-text-secondary)' }}
          >
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span>快速新建：</span>
          </span>
          {QUICK_LANGUAGES.map((item) => (
            <button
              key={item.lang}
              type="button"
              onClick={() => onNewScratchpad(item.lang)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition hover:opacity-90 hover:shadow-xs"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
              }}
            >
              <span
                className={`px-1 rounded text-[9px] font-extrabold border leading-tight ${item.badgeClass}`}
              >
                {item.badge}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {/* Two-Column Recent Files & Recent Workspaces */}
        {(recentFiles.length > 0 || recentWorkspaces.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-left">
            {/* Recent Files */}
            <div
              className="rounded-xl border p-3.5 flex flex-col"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border)',
              }}
            >
              <div
                className="text-[11px] font-semibold mb-2 flex items-center justify-between"
                style={{ color: 'var(--dp-text-muted)' }}
              >
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                  <span>最近编辑与研读</span>
                </span>
                {recentFiles.length > 0 && (
                  <span className="text-[10px] opacity-75">点击秒开</span>
                )}
              </div>

              {recentFiles.length === 0 ? (
                <div
                  className="text-[11px] py-4 text-center rounded-lg border border-dashed"
                  style={{
                    borderColor: 'var(--dp-border)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  打开过的源码脚本与文档将记录在此，支持直接拖拽文件到窗口打开
                </div>
              ) : (
                <div className="space-y-1">
                  {recentFiles.slice(0, 5).map((fp) => {
                    const { name, parent } = splitPathDisplay(fp);
                    const kind = inferDocKindFromPath(fp);
                    return (
                      <div
                        key={fp}
                        className="group flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition"
                      >
                        <button
                          type="button"
                          onClick={(e) =>
                            onOpenRecentFile(fp, e.ctrlKey || e.metaKey)
                          }
                          title={`${fp}\n提示：按住 Ctrl 点击可在右侧分屏打开`}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          <FileBadge kind={kind} name={name} />
                          <span className="text-xs font-medium truncate">
                            {name}
                          </span>
                          {parent && (
                            <span
                              className="text-[10.5px] truncate ml-auto pl-2 opacity-75"
                              style={{ color: 'var(--dp-text-muted)' }}
                            >
                              {parent}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenRecentFile(fp, true)}
                          title="在右侧双栏对照中打开"
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition shrink-0"
                          style={{ color: 'var(--dp-text-muted)' }}
                        >
                          <Columns2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recent Workspaces with 1-Click Parallel / New Session Actions */}
            <div
              className="rounded-xl border p-3.5 flex flex-col"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border)',
              }}
            >
              <div
                className="text-[11px] font-semibold mb-2 flex items-center justify-between"
                style={{ color: 'var(--dp-text-muted)' }}
              >
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-cyan-500" />
                  <span>最近工程工作区</span>
                </span>
                <span className="text-[10px] opacity-75">
                  一键并列 / 新空间
                </span>
              </div>

              {recentWorkspaces.length === 0 ? (
                <div
                  className="text-[11px] py-4 text-center rounded-lg border border-dashed"
                  style={{
                    borderColor: 'var(--dp-border)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  点击上方「打开项目工作区」挂载常驻工程目录
                </div>
              ) : (
                <div className="space-y-1">
                  {recentWorkspaces.slice(0, 5).map((ws) => {
                    const { name, parent } = splitPathDisplay(ws);
                    const isMounted = mountedRootPaths.some((p) =>
                      pathsEqual(p, ws)
                    );
                    return (
                      <div
                        key={ws}
                        className="group flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition"
                      >
                        <button
                          type="button"
                          onClick={() => onSelectWorkspace(ws)}
                          title={`${ws}\n点击切换当前主目录`}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          <FolderOpen
                            className="w-3.5 h-3.5 shrink-0"
                            style={{
                              color: isMounted
                                ? 'var(--dp-accent)'
                                : 'var(--dp-text-secondary)',
                            }}
                          />
                          <span className="text-xs font-medium truncate">
                            {name}
                          </span>
                          {!isMounted && parent && (
                            <span
                              className="text-[10px] truncate ml-auto pl-1 opacity-70 group-hover:hidden"
                              style={{ color: 'var(--dp-text-muted)' }}
                            >
                              {parent}
                            </span>
                          )}
                        </button>

                        <div className="flex items-center gap-1 shrink-0">
                          {isMounted ? (
                            <span className="px-1.5 py-0.2 rounded text-[9.5px] font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400">
                              已挂载
                            </span>
                          ) : (
                            <>
                              {onAppendRecentFolder && (
                                <button
                                  type="button"
                                  onClick={() => onAppendRecentFolder(ws)}
                                  title={`追加为当前空间的并列路径：${ws}`}
                                  className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition"
                                >
                                  +并列
                                </button>
                              )}
                              {onOpenRecentInNewWorkspace && (
                                <button
                                  type="button"
                                  onClick={() => onOpenRecentInNewWorkspace(ws)}
                                  title={`在新工作空间中打开：${ws}`}
                                  className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-sky-300 hover:bg-blue-500/25 transition"
                                >
                                  新空间
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Compact Studio Shortcut Strip */}
        <div
          className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] px-4 py-2.5 rounded-xl border"
          style={{
            backgroundColor: 'var(--dp-sidebar)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          <span className="flex items-center gap-1.5">
            <span>新建空间</span>
            <kbd className="font-mono text-[10px] opacity-80">Ctrl+Shift+O</kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <span>并列挂载</span>
            <kbd className="font-mono text-[10px] opacity-80">Ctrl+Alt+O</kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <span>切换空间</span>
            <kbd className="font-mono text-[10px] opacity-80">Alt+1..9</kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <span>运行代码</span>
            <kbd className="font-mono text-[10px] opacity-80">F5</kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <span>全文检索</span>
            <kbd className="font-mono text-[10px] opacity-80">Ctrl+Shift+F</kbd>
          </span>
          <button
            type="button"
            onClick={onToggleConsole}
            className="flex items-center gap-1.5 hover:opacity-80 transition"
          >
            <Terminal className="w-3 h-3" />
            <span>终端面板</span>
            <kbd className="font-mono text-[10px] opacity-80">Ctrl+`</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
