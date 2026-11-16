import React, { useEffect, useRef, useState } from 'react';
import {
  Edit3,
  FolderPlus,
  Layers,
  Pin,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import {
  formatWorkspaceSessionLabel,
  getPathBasename,
  WORKSPACE_ACCENTS,
  type WorkspaceSession,
} from '@/utils/workspaceUtils';

interface WorkspaceBarProps {
  workspaces: WorkspaceSession[];
  activeWorkspaceId: string;
  effectiveWorkingDir: string | null;
  isCwdAuto: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onRenameWorkspace: (workspaceId: string, newName: string) => void;
  onCreateWorkspaceFromFolder: () => void;
  onCreateBlankWorkspace: () => void;
  onAddParallelFolder: (workspaceId?: string) => void;
  onRefreshWorkspace: (workspaceId: string) => void;
  onToggleConsole: () => void;
}

export const WorkspaceBar: React.FC<WorkspaceBarProps> = ({
  workspaces,
  activeWorkspaceId,
  effectiveWorkingDir,
  isCwdAuto,
  onSelectWorkspace,
  onCloseWorkspace,
  onRenameWorkspace,
  onCreateWorkspaceFromFolder,
  onCreateBlankWorkspace,
  onAddParallelFolder,
  onRefreshWorkspace,
  onToggleConsole,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    ws: WorkspaceSession;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renamingId]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  const startRename = (ws: WorkspaceSession) => {
    setRenamingId(ws.id);
    setRenameDraft(ws.name ?? formatWorkspaceSessionLabel(ws));
    setCtxMenu(null);
  };

  const commitRename = (wsId: string) => {
    onRenameWorkspace(wsId, renameDraft.trim());
    setRenamingId(null);
  };

  const cwdShort = effectiveWorkingDir
    ? getPathBasename(effectiveWorkingDir)
    : null;

  return (
    <div
      className="h-8 px-2.5 border-b flex items-center justify-between gap-2 select-none shrink-0 text-xs"
      style={{
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: 'var(--dp-border)',
      }}
    >
      {/* Left: Workspace Session Pills + Quick Multi-Workspace / Multi-Root Buttons */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar py-0.5">
        <span
          className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold shrink-0"
          style={{ color: 'var(--dp-text-muted)' }}
          title="多工作空间 0ms 秒切栏：无需重复打开多个窗口，支持独立标签组与并列多目录挂载"
        >
          <Layers className="w-3.5 h-3.5" style={{ color: 'var(--dp-accent)' }} />
          <span>空间</span>
        </span>

        {workspaces.map((ws, idx) => {
          const isActive = ws.id === activeWorkspaceId;
          const accent =
            WORKSPACE_ACCENTS[ws.accentIndex % WORKSPACE_ACCENTS.length];
          const label = formatWorkspaceSessionLabel(ws);
          const openTabCount = ws.leftTabs.length + ws.rightTabs.length;
          const hasDirty =
            ws.leftTabs.some((t) => t.isDirty) ||
            ws.rightTabs.some((t) => t.isDirty);
          const canCloseOrReset =
            workspaces.length > 1 ||
            ws.rootPaths.length > 0 ||
            openTabCount > 0;
          const shortcutHint = idx < 9 ? `Alt+${idx + 1}` : '';
          const rootsTooltip =
            ws.rootPaths.length > 0
              ? ws.rootPaths.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
              : '  (尚未挂载文件夹)';

          return (
            <div
              key={ws.id}
              onClick={() => onSelectWorkspace(ws.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(ws);
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && canCloseOrReset) {
                  e.preventDefault();
                  onCloseWorkspace(ws.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, ws });
              }}
              title={`工作空间：${label}${shortcutHint ? ` (${shortcutHint})` : ''}\n挂载路径：\n${rootsTooltip}\n\n提示：单击 0ms 切换空间 · 双击重命名 · 右键管理目录`}
              style={{
                backgroundColor: isActive ? 'var(--dp-surface)' : 'transparent',
                borderColor: isActive ? accent.border : 'var(--dp-border)',
                color: isActive ? 'var(--dp-text)' : 'var(--dp-text-secondary)',
                boxShadow: isActive ? `0 1px 2px rgba(0,0,0,0.06)` : undefined,
              }}
              className={`group flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg border cursor-pointer transition shrink-0 max-w-[230px] ${
                isActive
                  ? 'font-semibold'
                  : 'hover:bg-black/5 dark:hover:bg-white/5 opacity-85 hover:opacity-100'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: accent.dot }}
              />

              {renamingId === ws.id ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameDraft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(ws.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(ws.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  placeholder="输入空间名称..."
                  className="w-28 bg-transparent outline-none text-xs font-semibold border-b border-blue-500"
                />
              ) : (
                <span className="truncate text-[11.5px] leading-tight">
                  {label}
                </span>
              )}

              {ws.rootPaths.length > 1 && (
                <span
                  className="px-1 py-0.2 rounded text-[10px] font-bold shrink-0"
                  style={{
                    backgroundColor: accent.badgeBg,
                    color: accent.dot,
                  }}
                  title={`此空间已并列挂载 ${ws.rootPaths.length} 个工作路径`}
                >
                  +{ws.rootPaths.length - 1}目录
                </span>
              )}

              {hasDirty && (
                <span
                  className="text-[10px] text-amber-500 leading-none shrink-0"
                  title="此空间内有尚未保存的修改"
                >
                  ●
                </span>
              )}

              {openTabCount > 0 && (
                <span
                  className="text-[10px] font-mono px-1 rounded shrink-0 opacity-75"
                  style={{
                    backgroundColor: isActive
                      ? 'var(--dp-sidebar)'
                      : 'var(--dp-surface)',
                    color: 'var(--dp-text-muted)',
                  }}
                  title={`已打开 ${openTabCount} 个标签页`}
                >
                  {openTabCount}
                </span>
              )}

              {canCloseOrReset && (
                <button
                  type="button"
                  title={
                    workspaces.length > 1
                      ? '关闭此工作空间（不会删除本地文件）'
                      : '清空并重置当前工作空间'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseWorkspace(ws.id);
                  }}
                  className={`p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/15 transition shrink-0 ${
                    isActive
                      ? 'opacity-65 hover:opacity-100'
                      : 'opacity-0 group-hover:opacity-75 hover:!opacity-100'
                  }`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Direct Action: Open Folder in a Brand-New Workspace Session */}
        <button
          type="button"
          onClick={onCreateWorkspaceFromFolder}
          title="选择另一个项目文件夹并在「新工作空间」中独立打开（0ms 切换，绝不覆盖当前空间 · Ctrl+Shift+O）"
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg border border-dashed text-[11px] font-semibold transition hover:border-blue-500/60 hover:bg-blue-500/10 shrink-0"
          style={{
            borderColor: 'var(--dp-border-strong)',
            color: 'var(--dp-accent)',
          }}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新空间打开</span>
        </button>

        {/* Direct Action: Append Parallel Folder into Active Workspace */}
        <button
          type="button"
          onClick={() => onAddParallelFolder()}
          title="向当前工作空间「追加并列文件夹」：在左侧资源目录同时挂载多个路径，方便跨项目对照编辑 (Ctrl+Alt+O)"
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-medium transition hover:border-emerald-500/50 hover:bg-emerald-500/10 shrink-0"
          style={{
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          <FolderPlus className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          <span className="hidden md:inline">追加并列路径</span>
        </button>

        <button
          type="button"
          onClick={onCreateBlankWorkspace}
          title="新建一个纯净空白工作空间（用于临时实验脚本或草稿研读）"
          className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition shrink-0"
          style={{ color: 'var(--dp-text-muted)' }}
        >
          <Sparkles className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right: Smart Active Working Directory Indicator */}
      {cwdShort && (
        <button
          type="button"
          onClick={onToggleConsole}
          title={
            isCwdAuto
              ? `当前运行与终端工作目录：${effectiveWorkingDir}\n模式：⚡ 自动跟随当前聚焦文件所属根路径（点击可在底部终端栏手动切换/锁定路径）`
              : `当前运行与终端工作目录：${effectiveWorkingDir}\n模式：📌 已手动锁定为此路径（点击可在底部终端栏切换回自动跟随）`
          }
          className="hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] transition hover:opacity-90 shrink-0 max-w-[240px]"
          style={{
            backgroundColor: 'var(--dp-surface)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          {isCwdAuto ? (
            <Terminal className="w-3 h-3 text-emerald-500 shrink-0" />
          ) : (
            <Pin className="w-3 h-3 text-amber-500 shrink-0" />
          )}
          <span className="truncate font-mono">{cwdShort}</span>
          <span
            className="text-[9.5px] px-1 rounded shrink-0 font-semibold"
            style={{
              backgroundColor: isCwdAuto
                ? 'rgba(16,185,129,0.13)'
                : 'rgba(245,158,11,0.15)',
              color: isCwdAuto ? '#10b981' : '#f59e0b',
            }}
          >
            {isCwdAuto ? '自动跟随' : '固定路径'}
          </span>
        </button>
      )}

      {/* Workspace Pill Right-Click Context Menu */}
      {ctxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            left: `${Math.min(ctxMenu.x, window.innerWidth - 220)}px`,
            top: `${Math.min(ctxMenu.y, window.innerHeight - 180)}px`,
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
            color: 'var(--dp-text)',
          }}
          className="fixed z-50 w-52 py-1 rounded-xl border shadow-xl text-xs"
        >
          <button
            type="button"
            onClick={() => startRename(ctxMenu.ws)}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Edit3 className="w-3.5 h-3.5 opacity-75" />
            <span>重命名此工作空间...</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const targetId = ctxMenu.ws.id;
              setCtxMenu(null);
              onAddParallelFolder(targetId);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <FolderPlus className="w-3.5 h-3.5 text-emerald-500" />
            <span>追加并列文件夹...</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const targetId = ctxMenu.ws.id;
              setCtxMenu(null);
              onRefreshWorkspace(targetId);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <RefreshCw className="w-3.5 h-3.5 opacity-75" />
            <span>刷新此空间目录树</span>
          </button>
          {(workspaces.length > 1 ||
            ctxMenu.ws.rootPaths.length > 0 ||
            ctxMenu.ws.leftTabs.length + ctxMenu.ws.rightTabs.length > 0) && (
            <>
              <div
                className="my-1 border-t"
                style={{ borderColor: 'var(--dp-border)' }}
              />
              <button
                type="button"
                onClick={() => {
                  const targetId = ctxMenu.ws.id;
                  setCtxMenu(null);
                  onCloseWorkspace(targetId);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
              >
                <X className="w-3.5 h-3.5" />
                <span>
                  {workspaces.length > 1 ? '关闭此工作空间' : '清空重置当前空间'}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
