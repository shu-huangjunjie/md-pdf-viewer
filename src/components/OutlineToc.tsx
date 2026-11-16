import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { DocKind, HeadingItem } from '@/types';

interface OutlineTocProps {
  headings: HeadingItem[];
  docKind?: Exclude<DocKind, 'folder'> | null;
  onSelectItem: (item: HeadingItem) => void;
  onClose?: () => void;
}

export const OutlineToc: React.FC<OutlineTocProps> = ({
  headings,
  docKind,
  onSelectItem,
  onClose,
}) => {
  const [width, setWidth] = useState<number>(256);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter((h) => h.text.toLowerCase().includes(q));
  }, [headings, filter]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setWidth(Math.min(400, Math.max(190, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const renderSymbolBadge = (kind?: HeadingItem['symbolKind']) => {
    if (kind === 'class') {
      return (
        <span className="shrink-0 w-4 h-4 rounded text-[9.5px] font-extrabold bg-amber-500/15 text-amber-600 dark:text-amber-400 inline-flex items-center justify-center">
          C
        </span>
      );
    }
    if (kind === 'function') {
      return (
        <span className="shrink-0 w-4 h-4 rounded text-[9.5px] font-extrabold bg-purple-500/15 text-purple-600 dark:text-purple-400 inline-flex items-center justify-center">
          ƒ
        </span>
      );
    }
    if (kind === 'property') {
      return (
        <span className="shrink-0 w-4 h-4 rounded text-[9.5px] font-extrabold bg-sky-500/15 text-sky-600 dark:text-sky-400 inline-flex items-center justify-center">
          K
        </span>
      );
    }
    return null;
  };

  const isCode = docKind === 'code';

  return (
    <aside
      style={{
        width: `${width}px`,
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: 'var(--dp-border)',
      }}
      className="shrink-0 border-l h-full flex select-none relative"
    >
      {/* Left Drag Resize Handle */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(256)}
        title="左右拖拽调整大纲栏宽度（双击恢复默认）"
        className="w-1 h-full cursor-col-resize hover:bg-blue-500/50 transition shrink-0"
      />

      <div className="flex-1 flex flex-col min-w-0 h-full">
        <div
          className="px-3 py-2 border-b space-y-2"
          style={{ borderColor: 'var(--dp-border)' }}
        >
          <div className="text-xs font-bold flex items-center justify-between">
            <span>{isCode ? '🧭 代码符号大纲' : '📑 章节大纲目录'}</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] opacity-60">{headings.length} 项</span>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  title="关闭大纲栏"
                  className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-65 hover:opacity-100"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {headings.length > 4 && (
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
              }}
            >
              <Search className="w-3 h-3 opacity-50 shrink-0" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={isCode ? '过滤函数 / 类 / 字段...' : '过滤章节标题...'}
                className="w-full bg-transparent outline-none text-[11.5px]"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  className="opacity-60 hover:opacity-100"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {filtered.length === 0 ? (
            <p
              className="p-4 text-xs text-center leading-relaxed"
              style={{ color: 'var(--dp-text-muted)' }}
            >
              {headings.length === 0
                ? isCode
                  ? '当前代码/配置文件未提取到结构符号'
                  : '当前文档暂无章节标题'
                : '没有匹配的大纲项'}
            </p>
          ) : (
            filtered.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => onSelectItem(h)}
                style={{
                  paddingLeft: `${8 + Math.max(0, h.level - 1) * 12}px`,
                }}
                className="w-full flex items-center justify-between gap-1.5 py-1.5 pr-2 rounded-md text-xs transition hover:bg-black/5 dark:hover:bg-white/5 text-left"
                title={h.line ? `${h.text} (第 ${h.line} 行)` : h.text}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {renderSymbolBadge(h.symbolKind)}
                  <span
                    className={`truncate ${
                      h.level === 1
                        ? 'font-bold'
                        : h.level === 2
                          ? 'font-semibold'
                          : 'opacity-85'
                    }`}
                  >
                    {h.text}
                  </span>
                </span>
                {h.line !== undefined && (
                  <span className="text-[10px] font-mono opacity-45 shrink-0">
                    L{h.line}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};
