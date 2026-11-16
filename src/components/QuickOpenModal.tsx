import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Command, CornerDownLeft, Search, Sparkles } from 'lucide-react';
import { FileBadge } from '@/components/FileBadge';
import type { FileTreeNode } from '@/types';
import {
  type FlatMultiRootFileItem,
  flattenMultiRootFiles,
  getPathBasename,
} from '@/utils/workspaceUtils';

export interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  category?: string;
  action: () => void;
}

interface QuickOpenModalProps {
  open: boolean;
  initialMode: 'files' | 'commands';
  workspaceTrees: FileTreeNode[];
  recentFiles: string[];
  commands: CommandItem[];
  onOpenNode: (node: FileTreeNode, inSplitPane?: boolean) => void;
  onOpenRecentPath: (path: string, inSplitPane?: boolean) => void;
  onClose: () => void;
}

export const QuickOpenModal: React.FC<QuickOpenModalProps> = ({
  open,
  initialMode,
  workspaceTrees,
  recentFiles,
  commands,
  onOpenNode,
  onOpenRecentPath,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialMode === 'commands' ? '> ' : '');
      setSelectedIdx(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open, initialMode]);

  const flatFiles = useMemo(
    () => flattenMultiRootFiles(workspaceTrees),
    [workspaceTrees]
  );

  const isCommandMode = query.trimStart().startsWith('>');
  const cleanQuery = isCommandMode
    ? query.trimStart().slice(1).trim().toLowerCase()
    : query.trim().toLowerCase();

  const matchedCommands = useMemo(() => {
    if (!isCommandMode) return [];
    if (!cleanQuery) return commands;
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(cleanQuery) ||
        (cmd.category && cmd.category.toLowerCase().includes(cleanQuery))
    );
  }, [commands, isCommandMode, cleanQuery]);

  const matchedFiles = useMemo(() => {
    if (isCommandMode) return [];
    const recentOrder = new Map<string, number>();
    recentFiles.forEach((p, idx) => recentOrder.set(p.toLowerCase(), idx));

    if (!cleanQuery) {
      const sorted = flatFiles.slice().sort((a, b) => {
        const ra = recentOrder.get(a.node.path.toLowerCase()) ?? 9999;
        const rb = recentOrder.get(b.node.path.toLowerCase()) ?? 9999;
        if (ra !== rb) return ra - rb;
        return a.nameLower.localeCompare(b.nameLower, 'zh-CN');
      });
      return sorted.slice(0, 60);
    }

    const tokens = cleanQuery.split(/\s+/).filter(Boolean);
    const scored: { item: FlatMultiRootFileItem; score: number }[] = [];

    for (const item of flatFiles) {
      let allMatch = true;
      for (const tk of tokens) {
        if (!item.searchLower.includes(tk)) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;

      let score = 0;
      if (item.nameLower === cleanQuery) score += 100;
      else if (item.nameLower.startsWith(cleanQuery)) score += 60;
      else if (item.nameLower.includes(cleanQuery)) score += 35;
      else score += 10;

      if (recentOrder.has(item.node.path.toLowerCase())) {
        score += 15;
      }
      scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((s) => s.item);
  }, [flatFiles, isCommandMode, cleanQuery, recentFiles]);

  // Fallback recent external files when no workspace is open
  const fallbackRecents = useMemo(() => {
    if (isCommandMode || flatFiles.length > 0) return [];
    if (!cleanQuery) return recentFiles.slice(0, 20);
    return recentFiles
      .filter((p) => p.toLowerCase().includes(cleanQuery))
      .slice(0, 20);
  }, [isCommandMode, flatFiles.length, recentFiles, cleanQuery]);

  const totalCount = isCommandMode
    ? matchedCommands.length
    : flatFiles.length > 0
      ? matchedFiles.length
      : fallbackRecents.length;

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>(
      `[data-qidx="${selectedIdx}"]`
    );
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  if (!open) return null;

  const executeSelection = (idx: number, inSplit = false) => {
    if (isCommandMode) {
      const cmd = matchedCommands[idx];
      if (cmd) {
        onClose();
        cmd.action();
      }
      return;
    }

    if (flatFiles.length > 0) {
      const target = matchedFiles[idx];
      if (target) {
        onClose();
        onOpenNode(target.node, inSplit);
      }
      return;
    }

    const recentPath = fallbackRecents[idx];
    if (recentPath) {
      onClose();
      onOpenRecentPath(recentPath, inSplit);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (totalCount > 0) {
        setSelectedIdx((i) => (i + 1) % totalCount);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (totalCount > 0) {
        setSelectedIdx((i) => (i - 1 + totalCount) % totalCount);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeSelection(selectedIdx, e.ctrlKey || e.metaKey);
    }
  };

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] flex items-start justify-center pt-[10vh] px-4"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[68vh]"
        style={{
          backgroundColor: 'var(--dp-elevated)',
          borderColor: 'var(--dp-border-strong)',
          color: 'var(--dp-text)',
        }}
      >
        {/* Top Search Input */}
        <div
          className="px-3.5 py-2.5 border-b flex items-center gap-2.5 shrink-0"
          style={{ borderColor: 'var(--dp-border)' }}
        >
          {isCommandMode ? (
            <Command
              className="w-4 h-4 shrink-0"
              style={{ color: 'var(--dp-accent)' }}
            />
          ) : (
            <Search
              className="w-4 h-4 shrink-0"
              style={{ color: 'var(--dp-accent)' }}
            />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              workspaceTrees.length > 1
                ? '跨所有并列路径搜文件名（支持 路径名+文件名），或输入 > 执行命令...'
                : '输入文件名快速跳转，或输入 > 执行快捷命令...'
            }
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--dp-text)' }}
          />
          <button
            type="button"
            onClick={() =>
              setQuery((q) => (q.trimStart().startsWith('>') ? '' : '> '))
            }
            title="切换文件搜索 / 命令面板"
            className="px-2 py-0.5 rounded text-[11px] font-semibold border transition hover:opacity-85"
            style={{
              backgroundColor: isCommandMode
                ? 'var(--dp-accent-soft)'
                : 'var(--dp-sidebar)',
              borderColor: 'var(--dp-border-strong)',
              color: isCommandMode
                ? 'var(--dp-accent)'
                : 'var(--dp-text-secondary)',
            }}
          >
            {isCommandMode ? '搜文件' : '> 命令'}
          </button>
        </div>

        {/* Result List */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {totalCount === 0 ? (
            <div
              className="py-10 text-center text-xs"
              style={{ color: 'var(--dp-text-muted)' }}
            >
              {isCommandMode
                ? '没有匹配的命令'
                : workspaceTrees.length > 0
                  ? '已挂载路径内没有匹配的文件（试试输入 > 查看多工作空间快捷命令）'
                  : '尚未打开工作区文件夹，可输入 > 执行打开文件夹或新建工作空间命令'}
            </div>
          ) : isCommandMode ? (
            matchedCommands.map((cmd, idx) => {
              const selected = idx === selectedIdx;
              return (
                <button
                  key={cmd.id}
                  data-qidx={idx}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => executeSelection(idx)}
                  className="w-full text-left px-3 py-2 rounded-lg text-xs flex items-center justify-between gap-3 transition"
                  style={{
                    backgroundColor: selected
                      ? 'var(--dp-accent-soft)'
                      : 'transparent',
                    color: selected ? 'var(--dp-accent)' : 'var(--dp-text)',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Sparkles className="w-3.5 h-3.5 shrink-0 opacity-80" />
                    {cmd.category && (
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          backgroundColor: 'var(--dp-sidebar)',
                          color: 'var(--dp-text-muted)',
                        }}
                      >
                        {cmd.category}
                      </span>
                    )}
                    <span className="truncate font-medium">{cmd.label}</span>
                  </div>
                  {cmd.shortcut && (
                    <kbd
                      className="px-1.5 py-0.5 rounded text-[10.5px] font-mono border shrink-0"
                      style={{
                        backgroundColor: 'var(--dp-sidebar)',
                        borderColor: 'var(--dp-border-strong)',
                        color: 'var(--dp-text-secondary)',
                      }}
                    >
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              );
            })
          ) : flatFiles.length > 0 ? (
            matchedFiles.map((item, idx) => {
              const selected = idx === selectedIdx;
              return (
                <button
                  key={item.node.path}
                  data-qidx={idx}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={(e) =>
                    executeSelection(idx, e.ctrlKey || e.metaKey)
                  }
                  className="w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 transition"
                  style={{
                    backgroundColor: selected
                      ? 'var(--dp-accent-soft)'
                      : 'transparent',
                    color: selected ? 'var(--dp-accent)' : 'var(--dp-text)',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileBadge
                      kind={
                        item.node.kind as Exclude<
                          FileTreeNode['kind'],
                          'folder'
                        >
                      }
                      language={item.node.language}
                      name={item.node.name}
                    />
                    <span className="font-medium truncate">
                      {item.node.name}
                    </span>
                    {item.relDir && (
                      <span
                        className="text-[11px] truncate"
                        style={{ color: 'var(--dp-text-muted)' }}
                      >
                        {item.relDir}
                      </span>
                    )}
                  </div>
                  {selected && (
                    <span
                      className="text-[10.5px] shrink-0 flex items-center gap-1"
                      style={{ color: 'var(--dp-text-muted)' }}
                    >
                      <CornerDownLeft className="w-3 h-3" />
                      打开
                    </span>
                  )}
                </button>
              );
            })
          ) : (
            fallbackRecents.map((filePath, idx) => {
              const selected = idx === selectedIdx;
              const baseName = getPathBasename(filePath);
              return (
                <button
                  key={filePath}
                  data-qidx={idx}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={(e) =>
                    executeSelection(idx, e.ctrlKey || e.metaKey)
                  }
                  className="w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 transition"
                  style={{
                    backgroundColor: selected
                      ? 'var(--dp-accent-soft)'
                      : 'transparent',
                    color: selected ? 'var(--dp-accent)' : 'var(--dp-text)',
                  }}
                >
                  <span className="font-medium truncate">{baseName}</span>
                  <span
                    className="text-[11px] truncate max-w-[260px]"
                    style={{ color: 'var(--dp-text-muted)' }}
                  >
                    {filePath}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer Hints */}
        <div
          className="px-3.5 py-1.5 border-t text-[11px] flex items-center justify-between select-none shrink-0"
          style={{
            backgroundColor: 'var(--dp-sidebar)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-muted)',
          }}
        >
          <span>↑↓ 选择 · Enter 打开 · Ctrl+Enter 右侧分屏打开</span>
          <span>输入 &gt; 切换命令面板 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
};
