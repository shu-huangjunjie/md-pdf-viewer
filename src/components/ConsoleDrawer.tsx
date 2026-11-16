import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  CornerDownLeft,
  FolderOpen,
  Loader2,
  Square,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { ConsoleChunk, RunDoneEvent, RuntimeProfile } from '@/types';
import { getPathBasename } from '@/utils/workspaceUtils';

export interface WorkingDirOption {
  path: string;
  label: string;
}

export interface ConsoleDrawerProps {
  open: boolean;
  onClose: () => void;
  isRunning: boolean;
  runLabel: string;
  chunks: ConsoleChunk[];
  lastDone: RunDoneEvent | null;
  onStopRun: () => void;
  onClear: () => void;
  onRunCommand?: (command: string) => void;
  workspaceDir?: string | null;
  cwdMode?: string; // 'auto' or explicit directory path
  availableDirs?: WorkingDirOption[];
  onChangeCwdMode?: (nextMode: string) => void;
  runtimes: RuntimeProfile[];
  preferredPython: string | null;
  onChangePreferredPython: (executable: string) => void;
  fontSize?: number;
}

export const ConsoleDrawer: React.FC<ConsoleDrawerProps> = ({
  open,
  onClose,
  isRunning,
  runLabel,
  chunks,
  lastDone,
  onStopRun,
  onClear,
  onRunCommand,
  workspaceDir,
  cwdMode = 'auto',
  availableDirs = [],
  onChangeCwdMode,
  runtimes,
  preferredPython,
  onChangePreferredPython,
  fontSize = 16,
}) => {
  const [height, setHeight] = useState<number>(240);
  const [copied, setCopied] = useState(false);
  const [cmdInput, setCmdInput] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new output chunks
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [chunks, open]);

  if (!open) return null;

  const pythonRuntimes = runtimes.filter((r) => r.language === 'python');
  const activePythonExe =
    preferredPython &&
    pythonRuntimes.some((r) => r.executable === preferredPython)
      ? preferredPython
      : pythonRuntimes[0]?.executable || '';

  const workspaceShort = workspaceDir
    ? getPathBasename(workspaceDir)
    : '本地目录';

  const isAutoCwd = !cwdMode || cwdMode === 'auto';

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.min(560, Math.max(140, startHeight + delta));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleCopyAll = async () => {
    const fullText = chunks.map((c) => c.text).join('');
    await navigator.clipboard.writeText(fullText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const submitCommand = () => {
    const trimmed = cmdInput.trim();
    if (!trimmed || !onRunCommand) return;
    setCmdHistory((prev) =>
      [trimmed, ...prev.filter((c) => c !== trimmed)].slice(0, 40)
    );
    setHistoryIdx(-1);
    setCmdInput('');
    onRunCommand(trimmed);
  };

  const renderStatusBadge = () => {
    if (isRunning) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 text-[11px] font-semibold">
          <Loader2 className="w-3 h-3 animate-spin" />
          正在运行...
        </span>
      );
    }
    if (!lastDone) {
      return (
        <span className="hidden xl:inline text-[11px] text-slate-400">
          就绪 · 自动匹配当前文件所属根路径
        </span>
      );
    }
    const sec = (lastDone.durationMs / 1000).toFixed(2);
    if (lastDone.killed) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-semibold">
          ⏹ 已手动停止 ({sec}s)
        </span>
      );
    }
    if (lastDone.exitCode === 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold">
          <CheckCircle2 className="w-3 h-3" />
          执行成功 ({sec}s)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 text-[11px] font-semibold">
        <XCircle className="w-3 h-3" />
        退出码 {lastDone.exitCode ?? -1} ({sec}s)
      </span>
    );
  };

  return (
    <div
      style={{ height: `${height}px` }}
      className="shrink-0 flex flex-col bg-[#0d1117] text-slate-200 border-t border-slate-700 select-text z-20"
    >
      {/* Top Drag Resize Handle */}
      <div
        onMouseDown={startResize}
        title="上下拖拽调整运行控制台高度"
        className="h-1.5 w-full cursor-row-resize hover:bg-sky-500/60 transition shrink-0"
      />

      {/* Console Header */}
      <div className="h-8 px-3 bg-[#161b22] border-b border-slate-800 flex items-center justify-between gap-2 text-xs select-none shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 font-bold text-slate-100 shrink-0">
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>运行与终端控制台</span>
          </div>
          {runLabel && (
            <span
              className="text-slate-400 truncate max-w-[220px]"
              title={runLabel}
            >
              {runLabel}
            </span>
          )}
          {renderStatusBadge()}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Smart Multi-Root Working Directory Switcher */}
          {onChangeCwdMode && availableDirs.length > 0 && (
            <div
              className="hidden md:flex items-center gap-1 bg-slate-800/90 border border-slate-700 rounded px-1.5 py-0.5"
              title={`当前执行工作路径：${workspaceDir || '默认'}\n可选择「⚡ 自动跟随当前文件所属根路径」或手动锁定到指定工程目录`}
            >
              <FolderOpen className="w-3 h-3 text-amber-400 shrink-0" />
              <select
                value={
                  isAutoCwd ||
                  availableDirs.some((d) => d.path === cwdMode)
                    ? cwdMode
                    : 'auto'
                }
                onChange={(e) => onChangeCwdMode(e.target.value)}
                className="bg-transparent text-slate-200 text-[11px] max-w-[215px] truncate outline-none cursor-pointer"
              >
                <option value="auto" className="bg-[#161b22] text-slate-100">
                  ⚡ 自动跟随当前文件 ({workspaceShort})
                </option>
                {availableDirs.map((d) => (
                  <option
                    key={d.path}
                    value={d.path}
                    className="bg-[#161b22] text-slate-100"
                  >
                    📌 锁定路径：{d.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {pythonRuntimes.length > 0 && (
            <select
              value={activePythonExe}
              onChange={(e) => onChangePreferredPython(e.target.value)}
              title="切换默认 Python 解释器（用于 Markdown 代码块与 Python 脚本运行）"
              className="hidden sm:block bg-slate-800 text-slate-200 border border-slate-700 rounded px-2 py-0.5 text-[11px] max-w-[200px] truncate outline-none cursor-pointer"
            >
              {pythonRuntimes.map((rt) => (
                <option key={rt.id} value={rt.executable}>
                  {rt.label}
                </option>
              ))}
            </select>
          )}

          {isRunning && (
            <button
              type="button"
              onClick={onStopRun}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-semibold text-[11px] transition"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>停止进程</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleCopyAll()}
            title="复制全部输出"
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-300 text-[11px] transition"
          >
            <Copy className="w-3 h-3" />
            <span>{copied ? '已复制' : '复制'}</span>
          </button>

          <button
            type="button"
            onClick={onClear}
            title="清空输出日志"
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-800 text-slate-300 text-[11px] transition"
          >
            <Trash2 className="w-3 h-3" />
            <span>清空</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            title="收起控制台 (Ctrl+`)"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Streaming Console Body */}
      <div
        ref={scrollRef}
        style={{ fontSize: `${Math.max(10, Math.round(fontSize * 0.82))}px` }}
        className="flex-1 overflow-y-auto px-4 py-2 font-mono leading-relaxed min-h-0"
      >
        {chunks.length === 0 ? (
          <div className="text-slate-500 text-xs py-2">
            点击编辑器右上角「运行 (F5)」、Markdown 代码块上的「▶ 运行代码」，或在下方输入 PowerShell 命令回车执行（工作路径会自动跟随当前文件所属工程目录，也可在右上角手动锁定）。
          </div>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono">
            {chunks.map((chunk, i) => (
              <span
                key={i}
                className={
                  chunk.stream === 'stderr'
                    ? 'text-rose-400'
                    : chunk.stream === 'system'
                      ? 'text-sky-400 font-semibold'
                      : 'text-slate-200'
                }
              >
                {chunk.text}
              </span>
            ))}
          </pre>
        )}
      </div>

      {/* Interactive Bottom Command Bar */}
      {onRunCommand && (
        <div className="h-8 px-3 bg-[#161b22] border-t border-slate-800 flex items-center gap-2 text-xs font-mono shrink-0">
          <span
            className="text-emerald-400 font-semibold flex items-center gap-1 shrink-0 select-none"
            title={
              workspaceDir
                ? `当前命令执行目录：${workspaceDir} (${isAutoCwd ? '自动跟随当前文件' : '手动锁定'})`
                : '默认工作目录'
            }
          >
            <span>PS {workspaceShort}</span>
            {!isAutoCwd && (
              <span className="text-[9.5px] px-1 rounded bg-amber-500/20 text-amber-300 font-sans">
                锁定
              </span>
            )}
            <ChevronRight className="w-3.5 h-3.5" />
          </span>
          <input
            type="text"
            value={cmdInput}
            onChange={(e) => setCmdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitCommand();
              } else if (e.key === 'ArrowUp') {
                if (cmdHistory.length > 0) {
                  e.preventDefault();
                  const next = Math.min(cmdHistory.length - 1, historyIdx + 1);
                  setHistoryIdx(next);
                  setCmdInput(cmdHistory[next]);
                }
              } else if (e.key === 'ArrowDown') {
                if (historyIdx > 0) {
                  e.preventDefault();
                  const next = historyIdx - 1;
                  setHistoryIdx(next);
                  setCmdInput(cmdHistory[next]);
                } else if (historyIdx === 0) {
                  e.preventDefault();
                  setHistoryIdx(-1);
                  setCmdInput('');
                }
              }
            }}
            placeholder="输入命令回车执行（如 python --version、pip list、git status），↑↓ 历史记录..."
            className="flex-1 bg-transparent text-slate-100 placeholder-slate-500 outline-none text-xs"
          />
          <button
            type="button"
            onClick={submitCommand}
            disabled={!cmdInput.trim()}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-[11px] flex items-center gap-1 transition select-none"
          >
            <CornerDownLeft className="w-3 h-3" />
            <span>执行</span>
          </button>
        </div>
      )}
    </div>
  );
};
