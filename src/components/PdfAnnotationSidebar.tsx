import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  CheckCircle2,
  Circle,
  CornerDownRight,
  FileDown,
  MessageSquarePlus,
  Search,
  Send,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type {
  PdfAnnotation,
  PdfAnnotationColor,
  PdfAnnotationType,
} from '@/types';

export interface PdfOutlineEntry {
  id: string;
  title: string;
  level: number;
  pageNumber: number;
}

export const PDF_COLOR_META: Record<
  PdfAnnotationColor,
  {
    label: string;
    hex: string;
    bgFill: string;
    borderHex: string;
    dotClass: string;
  }
> = {
  amber: {
    label: '重点黄',
    hex: '#f59e0b',
    bgFill: 'rgba(253, 224, 71, 0.46)',
    borderHex: '#eab308',
    dotClass: 'bg-amber-400',
  },
  emerald: {
    label: '核心绿',
    hex: '#10b981',
    bgFill: 'rgba(110, 231, 183, 0.45)',
    borderHex: '#10b981',
    dotClass: 'bg-emerald-400',
  },
  sky: {
    label: '方法蓝',
    hex: '#0ea5e9',
    bgFill: 'rgba(125, 211, 252, 0.45)',
    borderHex: '#0ea5e9',
    dotClass: 'bg-sky-400',
  },
  rose: {
    label: '疑问红',
    hex: '#f43f5e',
    bgFill: 'rgba(253, 164, 175, 0.44)',
    borderHex: '#f43f5e',
    dotClass: 'bg-rose-400',
  },
  violet: {
    label: '灵感紫',
    hex: '#8b5cf6',
    bgFill: 'rgba(196, 181, 253, 0.46)',
    borderHex: '#8b5cf6',
    dotClass: 'bg-violet-400',
  },
};

export const PDF_COLOR_ORDER: PdfAnnotationColor[] = [
  'amber',
  'emerald',
  'sky',
  'rose',
  'violet',
];

const TYPE_LABELS: Record<PdfAnnotationType, string> = {
  highlight: '高亮',
  underline: '下划线',
  rect: '区域框选',
  pin: '定点便签',
};

interface PdfAnnotationSidebarProps {
  tabMode: 'annotations' | 'outline';
  onChangeTabMode: (mode: 'annotations' | 'outline') => void;
  annotations: PdfAnnotation[];
  outline: PdfOutlineEntry[];
  activeAnnotationId: string | null;
  focusCommentRequestSeq: number;
  defaultAuthor: string;
  onChangeDefaultAuthor: (author: string) => void;
  onSelectAnnotation: (ann: PdfAnnotation) => void;
  onUpdateComment: (id: string, comment: string) => void;
  onChangeColor: (id: string, color: PdfAnnotationColor) => void;
  onToggleResolved: (id: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onAddReply: (annotationId: string, content: string) => void;
  onDeleteReply: (annotationId: string, replyId: string) => void;
  onJumpToPage: (pageNumber: number) => void;
  onExportAnnotationsMd: () => void;
  onClose: () => void;
}

function formatShortTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export const PdfAnnotationSidebar: React.FC<PdfAnnotationSidebarProps> = ({
  tabMode,
  onChangeTabMode,
  annotations,
  outline,
  activeAnnotationId,
  focusCommentRequestSeq,
  defaultAuthor,
  onChangeDefaultAuthor,
  onSelectAnnotation,
  onUpdateComment,
  onChangeColor,
  onToggleResolved,
  onDeleteAnnotation,
  onAddReply,
  onDeleteReply,
  onJumpToPage,
  onExportAnnotationsMd,
  onClose,
}) => {
  const [width, setWidth] = useState<number>(316);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [colorFilter, setColorFilter] = useState<PdfAnnotationColor | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [expandedReplyBoxId, setExpandedReplyBoxId] = useState<string | null>(null);
  const [editingAuthor, setEditingAuthor] = useState(false);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const commentRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  // Scroll active card into view when selected from PDF canvas
  useEffect(() => {
    if (!activeAnnotationId || tabMode !== 'annotations') return;
    const el = cardRefs.current[activeAnnotationId];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeAnnotationId, tabMode]);

  // Focus comment textarea when user clicks "添加批注" or drops a pin/rect
  useEffect(() => {
    if (!activeAnnotationId || focusCommentRequestSeq === 0) return;
    const timer = window.setTimeout(() => {
      const textarea = commentRefs.current[activeAnnotationId];
      if (textarea) {
        textarea.focus();
        textarea.selectionStart = textarea.value.length;
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeAnnotationId, focusCommentRequestSeq]);

  const sortedAnnotations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...annotations]
      .filter((ann) => {
        if (statusFilter === 'open' && ann.resolved) return false;
        if (statusFilter === 'resolved' && !ann.resolved) return false;
        if (colorFilter !== 'all' && ann.color !== colorFilter) return false;
        if (q) {
          const hay = [
            ann.selectedText || '',
            ann.comment || '',
            ann.author || '',
            ...ann.replies.map((r) => `${r.author} ${r.content}`),
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
        return (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0);
      });
  }, [annotations, colorFilter, searchQuery, statusFilter]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setWidth(Math.min(460, Math.max(250, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const submitReply = (annotationId: string) => {
    const draft = (replyDrafts[annotationId] || '').trim();
    if (!draft) return;
    onAddReply(annotationId, draft);
    setReplyDrafts((prev) => ({ ...prev, [annotationId]: '' }));
  };

  return (
    <aside
      style={{
        width: `${width}px`,
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: 'var(--dp-border)',
      }}
      className="shrink-0 border-l h-full flex select-none relative z-20"
    >
      {/* Drag Resize Handle */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(316)}
        title="左右拖拽调整面板宽度（双击恢复默认）"
        className="w-1 h-full cursor-col-resize hover:bg-blue-500/50 transition shrink-0"
      />

      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Top Mode Tabs */}
        <div
          className="px-2.5 pt-2 pb-1.5 border-b flex items-center justify-between gap-1"
          style={{ borderColor: 'var(--dp-border)' }}
        >
          <div
            className="flex items-center p-0.5 rounded-lg border text-[11.5px] font-semibold"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            <button
              type="button"
              onClick={() => onChangeTabMode('annotations')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                tabMode === 'annotations'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'opacity-75 hover:opacity-100'
              }`}
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              <span>批注与回复 ({annotations.length})</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeTabMode('outline')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                tabMode === 'outline'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'opacity-75 hover:opacity-100'
              }`}
            >
              <BookMarked className="w-3.5 h-3.5" />
              <span>目录 ({outline.length})</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="收起右侧批注栏"
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-70 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {tabMode === 'outline' ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {outline.length === 0 ? (
              <div
                className="p-6 text-xs text-center leading-relaxed"
                style={{ color: 'var(--dp-text-muted)' }}
              >
                该 PDF 未内嵌章节书签目录。
                <br />
                可使用「✨ PDF 转 MD」自动识别标题层级。
              </div>
            ) : (
              outline.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onJumpToPage(item.pageNumber)}
                  style={{
                    paddingLeft: `${8 + Math.max(0, item.level - 1) * 12}px`,
                  }}
                  className="w-full flex items-center justify-between gap-2 py-1.5 pr-2 rounded-md text-xs hover:bg-black/5 dark:hover:bg-white/5 transition text-left"
                >
                  <span
                    className={`truncate ${
                      item.level === 1 ? 'font-bold' : 'font-normal opacity-90'
                    }`}
                  >
                    {item.title}
                  </span>
                  <span
                    className="text-[10.5px] font-mono shrink-0"
                    style={{ color: 'var(--dp-text-muted)' }}
                  >
                    P.{item.pageNumber}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            {/* Author + Export + Filter Controls */}
            <div
              className="px-2.5 py-2 border-b space-y-2 text-[11px]"
              style={{ borderColor: 'var(--dp-border)' }}
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1 min-w-0">
                  <User className="w-3 h-3 shrink-0 opacity-65" />
                  {editingAuthor ? (
                    <input
                      type="text"
                      autoFocus
                      value={defaultAuthor}
                      onChange={(e) => onChangeDefaultAuthor(e.target.value)}
                      onBlur={() => setEditingAuthor(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setEditingAuthor(false);
                      }}
                      placeholder="批注署名"
                      className="w-24 px-1.5 py-0.5 rounded border bg-transparent outline-none text-[11px]"
                      style={{ borderColor: 'var(--dp-accent)' }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingAuthor(true)}
                      title="点击修改批注与回复的默认署名"
                      className="truncate max-w-[110px] px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 font-medium"
                    >
                      署名：{defaultAuthor || '我'}
                    </button>
                  )}
                </div>

                {annotations.length > 0 && (
                  <button
                    type="button"
                    onClick={onExportAnnotationsMd}
                    title="将所有高亮、截图、批注与回复汇总导出为 Markdown 笔记"
                    className="flex items-center gap-1 px-2 py-0.5 rounded border font-semibold text-blue-600 dark:text-sky-400 border-blue-500/30 bg-blue-500/10 hover:opacity-90 transition shrink-0"
                  >
                    <FileDown className="w-3 h-3" />
                    <span>导出批注 MD</span>
                  </button>
                )}
              </div>

              {/* Filter Row */}
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1">
                  {(
                    [
                      ['all', '全部'],
                      ['open', '待处理'],
                      ['resolved', '已解决'],
                    ] as const
                  ).map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setStatusFilter(val)}
                      className={`px-1.5 py-0.5 rounded text-[10.5px] transition ${
                        statusFilter === val
                          ? 'bg-blue-600/15 text-blue-600 dark:text-sky-300 font-semibold'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setColorFilter('all')}
                    title="显示全部颜色"
                    className={`px-1 rounded text-[10px] border ${
                      colorFilter === 'all'
                        ? 'border-blue-500 font-bold'
                        : 'border-transparent opacity-60'
                    }`}
                  >
                    全色
                  </button>
                  {PDF_COLOR_ORDER.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColorFilter((cur) => (cur === c ? 'all' : c))}
                      title={`筛选${PDF_COLOR_META[c].label}`}
                      className={`w-3.5 h-3.5 rounded-full ${PDF_COLOR_META[c].dotClass} transition ${
                        colorFilter === c
                          ? 'ring-2 ring-offset-1 ring-blue-500 scale-110'
                          : 'opacity-75 hover:opacity-100'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {annotations.length > 2 && (
                <div
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md border"
                  style={{
                    backgroundColor: 'var(--dp-surface)',
                    borderColor: 'var(--dp-border-strong)',
                  }}
                >
                  <Search className="w-3 h-3 opacity-50 shrink-0" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="检索原文摘录、批注或回复..."
                    className="w-full bg-transparent outline-none text-[11px]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="opacity-60 hover:opacity-100"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Annotation Cards List */}
            <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 select-text">
              {sortedAnnotations.length === 0 ? (
                <div
                  className="p-5 rounded-xl border border-dashed text-center text-xs space-y-1.5"
                  style={{
                    borderColor: 'var(--dp-border-strong)',
                    color: 'var(--dp-text-muted)',
                  }}
                >
                  {annotations.length === 0 ? (
                    <>
                      <p className="font-semibold" style={{ color: 'var(--dp-text-secondary)' }}>
                        暂无标注记录
                      </p>
                      <p className="leading-relaxed text-[11px]">
                        • 鼠标划选 PDF 文字即可<b>高亮 / 下划线 / 写批注</b>
                        <br />• 切换顶部<b>「框选」</b>可框选公式图表截图批注
                        <br />• 切换顶部<b>「便签」</b>可在任意位置打点评论与多轮回复
                      </p>
                    </>
                  ) : (
                    <p>没有符合当前筛选条件的批注</p>
                  )}
                </div>
              ) : (
                sortedAnnotations.map((ann) => {
                  const isActive = ann.id === activeAnnotationId;
                  const meta = PDF_COLOR_META[ann.color] || PDF_COLOR_META.amber;
                  const showReplyBox =
                    isActive ||
                    expandedReplyBoxId === ann.id ||
                    Boolean(replyDrafts[ann.id]);

                  return (
                    <div
                      key={ann.id}
                      ref={(el) => {
                        cardRefs.current[ann.id] = el;
                      }}
                      onClick={() => onSelectAnnotation(ann)}
                      className={`rounded-xl border p-2.5 transition cursor-pointer ${
                        isActive ? 'ring-2 ring-blue-500/40 shadow-sm' : 'hover:shadow-xs'
                      } ${ann.resolved ? 'opacity-75' : ''}`}
                      style={{
                        backgroundColor: 'var(--dp-surface)',
                        borderColor: isActive ? meta.hex : 'var(--dp-border-strong)',
                      }}
                    >
                      {/* Card Header */}
                      <div className="flex items-center justify-between gap-1.5 mb-1.5 text-[11px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="px-1.5 py-0.2 rounded font-mono font-bold text-[10px]"
                            style={{
                              backgroundColor: `${meta.hex}22`,
                              color: meta.hex,
                            }}
                          >
                            P.{ann.pageNumber}
                          </span>
                          <span className="font-semibold truncate">
                            {TYPE_LABELS[ann.type]}
                          </span>
                          <span
                            className="text-[10px] truncate"
                            style={{ color: 'var(--dp-text-muted)' }}
                          >
                            · {formatShortTime(ann.createdAt)}
                          </span>
                        </div>

                        <div
                          className="flex items-center gap-1 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Quick Color Dots */}
                          {isActive &&
                            PDF_COLOR_ORDER.map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => onChangeColor(ann.id, c)}
                                title={`切换为${PDF_COLOR_META[c].label}`}
                                className={`w-3 h-3 rounded-full ${PDF_COLOR_META[c].dotClass} ${
                                  ann.color === c ? 'ring-1 ring-offset-1 ring-slate-500' : 'opacity-60 hover:opacity-100'
                                }`}
                              />
                            ))}

                          <button
                            type="button"
                            onClick={() => onToggleResolved(ann.id)}
                            title={ann.resolved ? '重新打开此批注讨论' : '标记为已解决'}
                            className={`p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 ${
                              ann.resolved ? 'text-emerald-500' : 'opacity-60 hover:opacity-100'
                            }`}
                          >
                            {ann.resolved ? (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : (
                              <Circle className="w-3.5 h-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => onDeleteAnnotation(ann.id)}
                            title="删除此条标注与回复"
                            className="p-0.5 rounded hover:bg-rose-500/15 text-rose-500 opacity-70 hover:opacity-100"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Quoted Selected Text */}
                      {ann.selectedText && (
                        <blockquote
                          className="text-[11.5px] pl-2 py-0.5 mb-2 border-l-2 line-clamp-3 leading-relaxed"
                          style={{
                            borderColor: meta.hex,
                            color: 'var(--dp-text-secondary)',
                          }}
                        >
                          {ann.selectedText}
                        </blockquote>
                      )}

                      {/* Cropped Area Snapshot */}
                      {ann.imageDataUrl && (
                        <div
                          className="mb-2 rounded-lg overflow-hidden border bg-white p-1"
                          style={{ borderColor: 'var(--dp-border)' }}
                        >
                          <img
                            src={ann.imageDataUrl}
                            alt="区域框选截图"
                            className="max-h-32 w-auto mx-auto object-contain rounded"
                          />
                        </div>
                      )}

                      {/* Main Comment Input */}
                      <div onClick={(e) => e.stopPropagation()}>
                        <textarea
                          ref={(el) => {
                            commentRefs.current[ann.id] = el;
                          }}
                          rows={ann.comment ? Math.min(4, Math.max(1, ann.comment.split('\n').length)) : 1}
                          value={ann.comment}
                          onChange={(e) => onUpdateComment(ann.id, e.target.value)}
                          placeholder="添加批注说明..."
                          className="w-full text-xs px-2 py-1.5 rounded-lg border bg-transparent outline-none resize-y leading-relaxed focus:border-blue-500"
                          style={{
                            borderColor: 'var(--dp-border)',
                            color: 'var(--dp-text)',
                          }}
                        />
                      </div>

                      {/* Threaded Replies List */}
                      {ann.replies.length > 0 && (
                        <div
                          className="mt-2 pt-2 border-t space-y-1.5"
                          style={{ borderColor: 'var(--dp-border)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {ann.replies.map((rep) => (
                            <div
                              key={rep.id}
                              className="group flex items-start justify-between gap-1.5 px-2 py-1.5 rounded-lg text-[11.5px]"
                              style={{ backgroundColor: 'var(--dp-elevated)' }}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 text-[10.5px]">
                                  <CornerDownRight className="w-3 h-3 opacity-55 shrink-0" />
                                  <span className="font-bold text-blue-600 dark:text-sky-400">
                                    {rep.author || '我'}
                                  </span>
                                  <span style={{ color: 'var(--dp-text-muted)' }}>
                                    {formatShortTime(rep.createdAt)}
                                  </span>
                                </div>
                                <p className="mt-0.5 whitespace-pre-wrap break-words leading-snug">
                                  {rep.content}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => onDeleteReply(ann.id, rep.id)}
                                title="删除此条回复"
                                className="opacity-0 group-hover:opacity-80 hover:!opacity-100 p-0.5 rounded text-rose-500 shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Reply Input Trigger / Box */}
                      <div
                        className="mt-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {showReplyBox ? (
                          <div className="flex items-end gap-1 mt-1">
                            <textarea
                              rows={1}
                              value={replyDrafts[ann.id] || ''}
                              onChange={(e) =>
                                setReplyDrafts((prev) => ({
                                  ...prev,
                                  [ann.id]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  submitReply(ann.id);
                                }
                              }}
                              placeholder={`以「${defaultAuthor || '我'}」身份回复 (Enter 发送)...`}
                              className="flex-1 text-[11.5px] px-2 py-1 rounded-lg border bg-transparent outline-none resize-none focus:border-blue-500"
                              style={{
                                borderColor: 'var(--dp-border-strong)',
                                color: 'var(--dp-text)',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => submitReply(ann.id)}
                              disabled={!(replyDrafts[ann.id] || '').trim()}
                              title="发送回复 (Enter)"
                              className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition shrink-0"
                            >
                              <Send className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setExpandedReplyBoxId(ann.id)}
                            className="text-[11px] flex items-center gap-1 opacity-70 hover:opacity-100 text-blue-600 dark:text-sky-400 font-medium"
                          >
                            <CornerDownRight className="w-3 h-3" />
                            <span>回复 ({ann.replies.length})</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
