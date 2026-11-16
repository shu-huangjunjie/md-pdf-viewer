import React from 'react';
import {
  Cpu,
  FolderOpen,
  Layers,
  Loader2,
  Search,
  Terminal,
} from 'lucide-react';
import type { OpenTab, RuntimeProfile } from '@/types';
import { getPathBasename } from '@/utils/workspaceUtils';

export interface EditorCursorStatus {
  line: number;
  col: number;
  indentSize: number;
  wordWrap: boolean;
}

interface StatusBarProps {
  workspaceName: string | null;
  workspacePath: string | null;
  workspaceFileCount: number;
  workspaceSessionCount?: number;
  activeSessionIndex?: number;
  mountedFolderCount?: number;
  effectiveWorkingDir?: string | null;
  onCycleWorkspace?: () => void;
  activeTab: OpenTab | null;
  editorStatus: EditorCursorStatus | null;
  fontSize: number;
  onResetZoom: () => void;
  isRunning: boolean;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  runtimes: RuntimeProfile[];
  preferredPython: string | null;
  onChangePreferredPython: (executable: string) => void;
  onPickFolder: () => void;
  onOpenQuickSearch: () => void;
  onOpenFullTextSearch: () => void;
}

const KIND_LABELS: Record<string, string> = {
  markdown: 'Markdown 讲义阅读',
  pdf: 'PDF 文稿阅读',
  html: 'HTML 交互网页',
  code: '轻量代码编辑',
};

export const StatusBar: React.FC<StatusBarProps> = ({
  workspaceName,
  workspacePath,
  workspaceFileCount,
  workspaceSessionCount = 1,
  activeSessionIndex = 0,
  mountedFolderCount = 0,
  effectiveWorkingDir,
  onCycleWorkspace,
  activeTab,
  editorStatus,
  fontSize,
  onResetZoom,
  isRunning,
  consoleOpen,
  onToggleConsole,
  runtimes,
  preferredPython,
  onChangePreferredPython,
  onPickFolder,
  onOpenQuickSearch,
  onOpenFullTextSearch,
}) => {
  const pythonRuntimes = runtimes.filter((r) => r.language === 'python');
  const activePythonExe =
    preferredPython &&
    pythonRuntimes.some((r) => r.executable === preferredPython)
      ? preferredPython
      : pythonRuntimes[0]?.executable || '';

  const zoomPct = Math.round((fontSize / 16) * 100);
  const effectiveShort = effectiveWorkingDir
    ? getPathBasename(effectiveWorkingDir)
    : null;

  return (
    <footer
      className="h-6 px-2.5 border-t flex items-center justify-between text-[11px] select-none shrink-0 z-30 gap-3"
      style={{
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: 'var(--dp-border)',
        color: 'var(--dp-text-secondary)',
      }}
    >
      {/* Left: Multi-Workspace Indicator, Active Folder, Search, Active Document Info */}
      <div className="flex items-center gap-2 min-w-0">
        {workspaceSessionCount > 1 && (
          <button
            type="button"
            onClick={onCycleWorkspace}
            title={`共开启 ${workspaceSessionCount} 个工作空间（点击循环切换，或按 Alt+1..9 秒切）`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/12 text-blue-600 dark:text-sky-400 font-semibold hover:bg-blue-500/20 transition shrink-0"
          >
            <Layers className="w-3 h-3" />
            <span>
              空间 {activeSessionIndex + 1}/{workspaceSessionCount}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onPickFolder}
          title={
            workspacePath
              ? `当前空间主路径：${workspacePath}${
                  mountedFolderCount > 1
                    ? `（共并列挂载 ${mountedFolderCount} 个目录）`
                    : ''
                }`
              : '点击打开本地工作区文件夹'
          }
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition truncate max-w-[240px] font-medium"
          style={{
            color: workspaceName ? 'var(--dp-accent)' : 'var(--dp-text-muted)',
          }}
        >
          <FolderOpen className="w-3 h-3 shrink-0" />
          <span className="truncate">
            {workspaceName
              ? `${workspaceName}${
                  mountedFolderCount > 1 ? ` +${mountedFolderCount - 1}` : ''
                } (${workspaceFileCount})`
              : '未打开工作区'}
          </span>
        </button>

        {mountedFolderCount > 1 && effectiveShort && (
          <span
            className="hidden lg:inline px-1.5 py-0.5 rounded font-mono text-[10.5px]"
            style={{
              backgroundColor: 'var(--dp-surface)',
              color: 'var(--dp-text-secondary)',
            }}
            title={`当前运行根路径：${effectiveWorkingDir}`}
          >
            ⚡ {effectiveShort}
          </span>
        )}

        {workspaceName && (
          <button
            type="button"
            onClick={onOpenFullTextSearch}
            title="在已挂载的所有工作路径中全文搜索 (Ctrl+Shift+F)"
            className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition"
          >
            <Search className="w-3 h-3" />
            <span>全文检索</span>
          </button>
        )}

        {activeTab && (
          <span
            className="hidden md:inline truncate"
            style={{ color: 'var(--dp-text-muted)' }}
          >
            {activeTab.kind === 'code'
              ? `${(activeTab.language || 'code').toUpperCase()} · UTF-8`
              : KIND_LABELS[activeTab.kind] || activeTab.kind}
          </span>
        )}

        {activeTab?.kind === 'code' && editorStatus && (
          <span
            className="hidden xl:inline font-mono"
            style={{ color: 'var(--dp-text-secondary)' }}
          >
            行 {editorStatus.line}, 列 {editorStatus.col} · 空格:{' '}
            {editorStatus.indentSize} ·{' '}
            {editorStatus.wordWrap ? '自动换行' : '不换行'}
          </span>
        )}
      </div>

      {/* Right: Python Env, Console, Zoom, Quick Open */}
      <div className="flex items-center gap-2.5 shrink-0">
        {pythonRuntimes.length > 0 && (
          <div
            className="hidden md:flex items-center gap-1"
            title="全局默认 Python 运行环境（点击切换）"
          >
            <Cpu className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <select
              value={activePythonExe}
              onChange={(e) => onChangePreferredPython(e.target.value)}
              className="bg-transparent text-[11px] outline-none cursor-pointer max-w-[165px] truncate"
              style={{ color: 'var(--dp-text-secondary)' }}
            >
              {pythonRuntimes.map((rt) => (
                <option
                  key={rt.id}
                  value={rt.executable}
                  style={{
                    backgroundColor: 'var(--dp-surface)',
                    color: 'var(--dp-text)',
                  }}
                >
                  {rt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          type="button"
          onClick={onToggleConsole}
          title="展开/收起底部运行与命令控制台 (Ctrl+`)"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition"
          style={{
            color: isRunning
              ? '#10b981'
              : consoleOpen
                ? 'var(--dp-accent)'
                : 'var(--dp-text-secondary)',
          }}
        >
          {isRunning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Terminal className="w-3 h-3" />
          )}
          <span>{isRunning ? '运行中...' : '终端控制台'}</span>
        </button>

        <button
          type="button"
          onClick={onResetZoom}
          title="按住 Ctrl + 鼠标滚轮缩放视图，点击重置为 100% (Ctrl+0)"
          className="px-1.5 py-0.5 rounded font-mono hover:bg-black/5 dark:hover:bg-white/5 transition"
        >
          缩放 {zoomPct}%
        </button>

        <button
          type="button"
          onClick={onOpenQuickSearch}
          title="快速搜索文件或执行命令 (Ctrl+P)"
          className="hidden sm:inline px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition"
          style={{ color: 'var(--dp-text-muted)' }}
        >
          Ctrl+P 速开
        </button>
      </div>
    </footer>
  );
};
