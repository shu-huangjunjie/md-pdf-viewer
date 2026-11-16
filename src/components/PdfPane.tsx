import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  Highlighter,
  Loader2,
  MapPin,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  MousePointer2,
  RefreshCw,
  RotateCw,
  Scan,
  Search,
  Sparkles,
  Underline,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  loadPdfAnnotations,
  revealInExplorer,
  savePdfAnnotations,
} from '@/api/client';
import type {
  PdfAnnotation,
  PdfAnnotationColor,
  PdfAnnotationDocument,
  PdfAnnotationType,
  PdfNormalizedRect,
} from '@/types';
import { buildAssetStreamUrl, formatFileSize } from '@/utils/pathUtils';
import {
  convertExtractedPdfToMarkdown,
  formatAnnotationsToMarkdown,
  type PdfExtractedPageInput,
  type PdfRawTextItem,
} from '@/utils/pdfToMarkdown';
import {
  PDF_COLOR_META,
  PDF_COLOR_ORDER,
  PdfAnnotationSidebar,
  type PdfOutlineEntry,
} from './PdfAnnotationSidebar';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfToolMode = 'select' | 'highlight' | 'underline' | 'rect' | 'pin';

export interface PdfPaneProps {
  filePath: string;
  slashPath: string;
  sizeBytes?: number;
  assetBaseUrl: string;
  isActive?: boolean;
  onOpenGeneratedMarkdown?: (params: {
    suggestedName: string;
    markdown: string;
    defaultSaveDir: string;
  }) => void;
}

interface PageGeometry {
  pageNumber: number;
  width: number; // at scale = 1, rotation = 0
  height: number;
}

interface SelectionPopoverState {
  pageNumber: number;
  selectedText: string;
  rects: PdfNormalizedRect[];
  anchorClientX: number;
  anchorClientY: number;
}

interface PdfSearchHit {
  pageNumber: number;
  snippet: string;
  matchIndexInPage: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function makeUid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAndMergeClientRects(
  clientRects: DOMRectList | DOMRect[],
  pageRect: DOMRect
): PdfNormalizedRect[] {
  if (pageRect.width <= 1 || pageRect.height <= 1) return [];
  const raw: PdfNormalizedRect[] = [];

  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i];
    if (r.width < 1.5 || r.height < 1.5) continue;
    const x1 = clamp01((r.left - pageRect.left) / pageRect.width);
    const y1 = clamp01((r.top - pageRect.top) / pageRect.height);
    const x2 = clamp01((r.right - pageRect.left) / pageRect.width);
    const y2 = clamp01((r.bottom - pageRect.top) / pageRect.height);
    if (x2 - x1 > 0.001 && y2 - y1 > 0.001) {
      raw.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
  }

  if (raw.length <= 1) return raw;

  // Sort top-to-bottom, then left-to-right, and merge adjacent/overlapping runs on same line
  raw.sort((a, b) => {
    const tol = Math.min(a.h, b.h) * 0.55;
    if (Math.abs(a.y - b.y) <= tol) return a.x - b.x;
    return a.y - b.y;
  });

  const merged: PdfNormalizedRect[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const cur = raw[i];
    const prev = merged[merged.length - 1];
    const sameLine = Math.abs(cur.y - prev.y) <= Math.min(cur.h, prev.h) * 0.55;
    const closeHoriz = cur.x <= prev.x + prev.w + 0.018;
    if (sameLine && closeHoriz) {
      const nx = Math.min(prev.x, cur.x);
      const ny = Math.min(prev.y, cur.y);
      const maxRight = Math.max(prev.x + prev.w, cur.x + cur.w);
      const maxBottom = Math.max(prev.y + prev.h, cur.y + cur.h);
      merged[merged.length - 1] = {
        x: nx,
        y: ny,
        w: maxRight - nx,
        h: maxBottom - ny,
      };
    } else {
      merged.push(cur);
    }
  }

  return merged;
}

async function resolveOutlineEntries(pdfDoc: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  try {
    const rawOutline = await pdfDoc.getOutline();
    if (!rawOutline || rawOutline.length === 0) return [];

    const entries: PdfOutlineEntry[] = [];
    let seq = 0;

    const walk = async (items: typeof rawOutline, level: number) => {
      for (const item of items) {
        let pageNumber = 1;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') {
            dest = await pdfDoc.getDestination(dest);
          }
          if (Array.isArray(dest) && dest[0]) {
            const pageIdx = await pdfDoc.getPageIndex(dest[0]);
            pageNumber = pageIdx + 1;
          }
        } catch {
          // Keep fallback page 1
        }
        seq += 1;
        if (item.title?.trim()) {
          entries.push({
            id: `pdf-bm-${seq}`,
            title: item.title.trim(),
            level,
            pageNumber,
          });
        }
        if (item.items && item.items.length > 0 && level < 4) {
          await walk(item.items, level + 1);
        }
      }
    };

    await walk(rawOutline, 1);
    return entries;
  } catch {
    return [];
  }
}

interface PdfPageViewProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  baseWidth: number;
  baseHeight: number;
  scale: number;
  rotation: number;
  shouldRender: boolean;
  tool: PdfToolMode;
  activeColor: PdfAnnotationColor;
  annotations: PdfAnnotation[];
  activeAnnotationId: string | null;
  flashingAnnotationId: string | null;
  onRegisterPageEl: (pageNumber: number, el: HTMLDivElement | null) => void;
  onCreateAnnotation: (
    draft: Omit<
      PdfAnnotation,
      'id' | 'createdAt' | 'updatedAt' | 'author' | 'replies'
    >,
    focusComment: boolean
  ) => void;
  onSelectAnnotation: (ann: PdfAnnotation) => void;
  onShowSelectionPopover: (state: SelectionPopoverState | null) => void;
}

const PdfPageView: React.FC<PdfPageViewProps> = React.memo(
  ({
    pdfDoc,
    pageNumber,
    baseWidth,
    baseHeight,
    scale,
    rotation,
    shouldRender,
    tool,
    activeColor,
    annotations,
    activeAnnotationId,
    flashingAnnotationId,
    onRegisterPageEl,
    onCreateAnnotation,
    onSelectAnnotation,
    onShowSelectionPopover,
  }) => {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textLayerRef = useRef<HTMLDivElement | null>(null);

    const [dragBox, setDragBox] = useState<PdfNormalizedRect | null>(null);
    const dragStartRef = useRef<{ x: number; y: number } | null>(null);

    const isSwapped = rotation % 180 !== 0;
    const cssWidth = Math.round((isSwapped ? baseHeight : baseWidth) * scale);
    const cssHeight = Math.round((isSwapped ? baseWidth : baseHeight) * scale);

    useEffect(() => {
      onRegisterPageEl(pageNumber, wrapperRef.current);
      return () => onRegisterPageEl(pageNumber, null);
    }, [onRegisterPageEl, pageNumber]);

    // Render HiDPI Canvas + Official PDF.js v4 TextLayer when visible
    useEffect(() => {
      if (!shouldRender) return;
      let cancelled = false;
      let renderTask: ReturnType<pdfjsLib.PDFPageProxy['render']> | null = null;
      let textLayerInstance: pdfjsLib.TextLayer | null = null;

      (async () => {
        try {
          const page = await pdfDoc.getPage(pageNumber);
          if (cancelled) return;

          const viewport = page.getViewport({ scale, rotation });
          const canvas = canvasRef.current;
          const textDiv = textLayerRef.current;
          if (!canvas || !textDiv) return;

          const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.round(viewport.width)}px`;
          canvas.style.height = `${Math.round(viewport.height)}px`;

          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) return;

          renderTask = page.render({
            canvasContext: ctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          });
          await renderTask.promise;
          if (cancelled) return;

          textDiv.innerHTML = '';
          const textContent = await page.getTextContent();
          if (cancelled) return;

          textLayerInstance = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport,
          });
          await textLayerInstance.render();
        } catch (err: unknown) {
          const name = (err as { name?: string })?.name;
          if (name !== 'RenderingCancelledException') {
            console.debug(`Page ${pageNumber} render skipped:`, err);
          }
        }
      })();

      return () => {
        cancelled = true;
        try {
          renderTask?.cancel();
        } catch {
          // ignore
        }
        try {
          textLayerInstance?.cancel();
        } catch {
          // ignore
        }
      };
    }, [pageNumber, pdfDoc, rotation, scale, shouldRender]);

    const handleMouseUpText = () => {
      if (tool === 'rect' || tool === 'pin') return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      const selectedText = sel.toString().trim();
      if (!selectedText) return;

      const range = sel.getRangeAt(0);
      const box = wrapperRef.current;
      if (!box || !box.contains(range.commonAncestorContainer)) return;

      const boxRect = box.getBoundingClientRect();
      const rects = normalizeAndMergeClientRects(range.getClientRects(), boxRect);
      if (rects.length === 0) return;

      if (tool === 'highlight' || tool === 'underline') {
        onCreateAnnotation(
          {
            pageNumber,
            type: tool,
            color: activeColor,
            rects,
            selectedText,
            comment: '',
          },
          false
        );
        sel.removeAllRanges();
        onShowSelectionPopover(null);
      } else {
        const firstRect = range.getBoundingClientRect();
        onShowSelectionPopover({
          pageNumber,
          selectedText,
          rects,
          anchorClientX: firstRect.left + firstRect.width / 2,
          anchorClientY: Math.max(64, firstRect.top),
        });
      }
    };

    const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const box = wrapperRef.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const nx = clamp01((e.clientX - rect.left) / rect.width);
      const ny = clamp01((e.clientY - rect.top) / rect.height);

      if (tool === 'pin') {
        e.preventDefault();
        e.stopPropagation();
        onCreateAnnotation(
          {
            pageNumber,
            type: 'pin',
            color: activeColor,
            rects: [{ x: nx, y: ny, w: 0.028, h: 0.028 }],
            comment: '',
          },
          true
        );
        return;
      }

      if (tool === 'rect') {
        e.preventDefault();
        e.stopPropagation();
        dragStartRef.current = { x: nx, y: ny };
        setDragBox({ x: nx, y: ny, w: 0, h: 0 });

        const onMove = (ev: MouseEvent) => {
          const start = dragStartRef.current;
          if (!start) return;
          const curX = clamp01((ev.clientX - rect.left) / rect.width);
          const curY = clamp01((ev.clientY - rect.top) / rect.height);
          setDragBox({
            x: Math.min(start.x, curX),
            y: Math.min(start.y, curY),
            w: Math.abs(curX - start.x),
            h: Math.abs(curY - start.y),
          });
        };

        const onUp = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          const start = dragStartRef.current;
          dragStartRef.current = null;
          setDragBox(null);
          if (!start) return;

          const curX = clamp01((ev.clientX - rect.left) / rect.width);
          const curY = clamp01((ev.clientY - rect.top) / rect.height);
          const finalBox: PdfNormalizedRect = {
            x: Math.min(start.x, curX),
            y: Math.min(start.y, curY),
            w: Math.abs(curX - start.x),
            h: Math.abs(curY - start.y),
          };
          if (
            finalBox.w * rect.width < 12 ||
            finalBox.h * rect.height < 12
          ) {
            return;
          }

          // Capture crisp cropped snapshot from page canvas
          let imageDataUrl: string | undefined;
          const srcCanvas = canvasRef.current;
          if (srcCanvas && srcCanvas.width > 0 && srcCanvas.height > 0) {
            try {
              const sx = Math.round(finalBox.x * srcCanvas.width);
              const sy = Math.round(finalBox.y * srcCanvas.height);
              const sw = Math.max(1, Math.round(finalBox.w * srcCanvas.width));
              const sh = Math.max(1, Math.round(finalBox.h * srcCanvas.height));
              const maxOutW = 620;
              const downScale = sw > maxOutW ? maxOutW / sw : 1;
              const outCanvas = document.createElement('canvas');
              outCanvas.width = Math.max(1, Math.round(sw * downScale));
              outCanvas.height = Math.max(1, Math.round(sh * downScale));
              const outCtx = outCanvas.getContext('2d');
              if (outCtx) {
                outCtx.drawImage(
                  srcCanvas,
                  sx,
                  sy,
                  sw,
                  sh,
                  0,
                  0,
                  outCanvas.width,
                  outCanvas.height
                );
                imageDataUrl = outCanvas.toDataURL('image/png');
              }
            } catch {
              // ignore snapshot error
            }
          }

          onCreateAnnotation(
            {
              pageNumber,
              type: 'rect',
              color: activeColor,
              rects: [finalBox],
              imageDataUrl,
              comment: '',
            },
            true
          );
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }
    };

    const isDrawingTool = tool === 'rect' || tool === 'pin';

    return (
      <div
        ref={wrapperRef}
        data-page-number={pageNumber}
        onMouseUp={handleMouseUpText}
        onMouseDown={isDrawingTool ? handleOverlayMouseDown : undefined}
        style={
          {
            width: `${cssWidth}px`,
            height: `${cssHeight}px`,
            '--scale-factor': scale,
          } as React.CSSProperties
        }
        className={`relative bg-white shadow-md rounded-xs shrink-0 mx-auto transition-shadow ${
          tool === 'rect'
            ? 'cursor-crosshair'
            : tool === 'pin'
              ? 'cursor-copy'
              : ''
        }`}
      >
        {shouldRender ? (
          <>
            <canvas ref={canvasRef} className="block pointer-events-none select-none" />
            <div
              ref={textLayerRef}
              className={`dp-pdf-text-layer ${isDrawingTool ? 'dp-tool-drawing' : ''}`}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-slate-400 select-none">
            第 {pageNumber} 页
          </div>
        )}

        {/* Saved Annotations Overlay */}
        <div className="absolute inset-0 pointer-events-none z-30">
          {annotations.map((ann) => {
            const meta = PDF_COLOR_META[ann.color] || PDF_COLOR_META.amber;
            const isSelected = ann.id === activeAnnotationId;
            const isFlashing = ann.id === flashingAnnotationId;
            const discussionCount =
              (ann.comment.trim() ? 1 : 0) + ann.replies.length;

            if (ann.type === 'pin') {
              const pt = ann.rects[0] || { x: 0.5, y: 0.5, w: 0.03, h: 0.03 };
              return (
                <button
                  key={ann.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectAnnotation(ann);
                  }}
                  title={ann.comment || '点击查看/回复此便签批注'}
                  style={{
                    left: `${pt.x * 100}%`,
                    top: `${pt.y * 100}%`,
                    backgroundColor: meta.hex,
                  }}
                  className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute px-1.5 py-0.5 rounded-full text-white text-[10.5px] font-bold shadow-md flex items-center gap-0.5 hover:scale-110 transition ${
                    isSelected ? 'ring-2 ring-offset-1 ring-slate-900 scale-110' : ''
                  } ${isFlashing ? 'dp-pdf-ann-flash' : ''}`}
                >
                  <MessageSquare className="w-3 h-3 fill-white/25" />
                  {discussionCount > 0 && <span>{discussionCount}</span>}
                </button>
              );
            }

            if (ann.type === 'rect') {
              const r = ann.rects[0];
              if (!r) return null;
              return (
                <div
                  key={ann.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectAnnotation(ann);
                  }}
                  title={ann.comment || '点击查看/回复此区域标注'}
                  style={{
                    left: `${r.x * 100}%`,
                    top: `${r.y * 100}%`,
                    width: `${r.w * 100}%`,
                    height: `${r.h * 100}%`,
                    borderColor: meta.hex,
                    backgroundColor: `${meta.hex}18`,
                  }}
                  className={`pointer-events-auto absolute border-2 rounded-xs cursor-pointer transition ${
                    isSelected ? 'ring-2 ring-blue-600/60' : 'hover:brightness-95'
                  } ${isFlashing ? 'dp-pdf-ann-flash' : ''}`}
                >
                  <span
                    style={{ backgroundColor: meta.hex }}
                    className="absolute -top-5 left-0 px-1.5 py-0.2 rounded text-[10px] font-bold text-white shadow-xs flex items-center gap-0.5 whitespace-nowrap"
                  >
                    <MessageSquare className="w-2.5 h-2.5" />
                    <span>{discussionCount > 0 ? `${discussionCount}` : '批注'}</span>
                  </span>
                </div>
              );
            }

            return (
              <React.Fragment key={ann.id}>
                {ann.rects.map((r, rIdx) => (
                  <div
                    key={`${ann.id}-${rIdx}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectAnnotation(ann);
                    }}
                    title={
                      ann.comment
                        ? `批注：${ann.comment}`
                        : '点击添加批注或回复'
                    }
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.w * 100}%`,
                      height: `${r.h * 100}%`,
                      backgroundColor:
                        ann.type === 'highlight' ? meta.bgFill : 'transparent',
                      borderBottom:
                        ann.type === 'underline'
                          ? `2.5px solid ${meta.hex}`
                          : isSelected
                            ? `1.5px solid ${meta.hex}`
                            : undefined,
                    }}
                    className={`pointer-events-auto absolute rounded-[2px] cursor-pointer transition ${
                      ann.type === 'highlight' ? 'dp-pdf-highlight-multiply' : 'hover:bg-black/5'
                    } ${isSelected ? 'ring-1 ring-blue-600/70' : ''} ${
                      isFlashing && rIdx === 0 ? 'dp-pdf-ann-flash' : ''
                    }`}
                  >
                    {rIdx === 0 && discussionCount > 0 && (
                      <span
                        style={{ backgroundColor: meta.hex }}
                        className="pointer-events-auto absolute -top-3.5 -right-2 px-1 rounded-full text-[9px] font-bold text-white shadow-xs leading-tight"
                      >
                        💬{discussionCount}
                      </span>
                    )}
                  </div>
                ))}
              </React.Fragment>
            );
          })}

          {/* Active Rubber-Band Area Drag Box */}
          {dragBox && (
            <div
              style={{
                left: `${dragBox.x * 100}%`,
                top: `${dragBox.y * 100}%`,
                width: `${dragBox.w * 100}%`,
                height: `${dragBox.h * 100}%`,
                borderColor: PDF_COLOR_META[activeColor].hex,
                backgroundColor: `${PDF_COLOR_META[activeColor].hex}24`,
              }}
              className="absolute border-2 border-dashed rounded-xs"
            />
          )}
        </div>

        {/* Subtle Page Corner Number */}
        <span className="absolute bottom-1.5 right-2.5 text-[10px] font-mono text-slate-400/80 pointer-events-none select-none">
          {pageNumber}
        </span>
      </div>
    );
  }
);

export const PdfPane: React.FC<PdfPaneProps> = ({
  filePath,
  slashPath,
  sizeBytes,
  assetBaseUrl,
  isActive = true,
  onOpenGeneratedMarkdown,
}) => {
  const rawStreamUrl = useMemo(
    () => buildAssetStreamUrl(assetBaseUrl, slashPath),
    [assetBaseUrl, slashPath]
  );

  const [useNativeIframe, setUseNativeIframe] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pagesMeta, setPagesMeta] = useState<PageGeometry[]>([]);
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [scale, setScale] = useState<number>(1.2);
  const [rotation, setRotation] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInput, setPageInput] = useState<string>('1');
  const [visiblePageSet, setVisiblePageSet] = useState<Set<number>>(
    () => new Set([1, 2, 3])
  );

  // Annotation Studio State
  const [tool, setTool] = useState<PdfToolMode>('select');
  const [activeColor, setActiveColor] = useState<PdfAnnotationColor>('amber');
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [defaultAuthor, setDefaultAuthor] = useState<string>('我');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [sidebarTab, setSidebarTab] = useState<'annotations' | 'outline'>('annotations');
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [flashingAnnotationId, setFlashingAnnotationId] = useState<string | null>(null);
  const [focusCommentSeq, setFocusCommentSeq] = useState<number>(0);
  const [selectionPopover, setSelectionPopover] =
    useState<SelectionPopoverState | null>(null);

  // In-PDF Search State
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<PdfSearchHit[]>([]);
  const [activeHitIdx, setActiveHitIdx] = useState(0);

  // PDF -> Markdown Conversion State
  const [convertingMd, setConvertingMd] = useState(false);
  const [convertProgress, setConvertProgress] = useState<string>('');

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageElMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const annotationsLoadedRef = useRef<boolean>(false);

  const registerPageEl = useCallback(
    (pageNumber: number, el: HTMLDivElement | null) => {
      if (el) pageElMapRef.current.set(pageNumber, el);
      else pageElMapRef.current.delete(pageNumber);
    },
    []
  );

  // Load persisted annotations for this PDF
  useEffect(() => {
    let cancelled = false;
    annotationsLoadedRef.current = false;
    loadPdfAnnotations(filePath)
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          setAnnotations(Array.isArray(stored.annotations) ? stored.annotations : []);
          if (stored.defaultAuthor) setDefaultAuthor(stored.defaultAuthor);
        } else {
          setAnnotations([]);
        }
        annotationsLoadedRef.current = true;
      })
      .catch(() => {
        if (!cancelled) {
          setAnnotations([]);
          annotationsLoadedRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Debounced auto-save of PDF annotations + replies
  const persistAnnotationStore = useCallback(
    (nextAnnotations: PdfAnnotation[], nextAuthor: string) => {
      if (!annotationsLoadedRef.current) return;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        const doc: PdfAnnotationDocument = {
          version: 1,
          filePath,
          defaultAuthor: nextAuthor,
          annotations: nextAnnotations,
        };
        void savePdfAnnotations(filePath, doc);
      }, 280);
    },
    [filePath]
  );

  // Load PDF Document via PDF.js
  useEffect(() => {
    if (!rawStreamUrl || useNativeIframe) return;
    let cancelled = false;
    setLoadingPdf(true);
    setLoadError(null);

    const loadingTask = pdfjsLib.getDocument({
      url: rawStreamUrl,
      cMapUrl: './pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './pdfjs/standard_fonts/',
    });

    loadingTask.promise
      .then(async (doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdfDoc(doc);

        // Probe page 1 geometry immediately (and any differing page sizes lazily/fast)
        const firstPage = await doc.getPage(1);
        const firstVp = firstPage.getViewport({ scale: 1, rotation: 0 });
        const metas: PageGeometry[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          metas.push({
            pageNumber: p,
            width: firstVp.width,
            height: firstVp.height,
          });
        }
        if (cancelled) return;
        setPagesMeta(metas);
        setCurrentPage(1);
        setPageInput('1');
        setVisiblePageSet(new Set([1, 2, 3]));
        setLoadingPdf(false);

        // Fit width automatically if container is ready
        const hostW = scrollContainerRef.current?.clientWidth || 0;
        if (hostW > 240 && firstVp.width > 0) {
          const ideal = Math.min(1.65, Math.max(0.75, (hostW - 64) / firstVp.width));
          setScale(Math.round(ideal * 100) / 100);
        }

        // Resolve PDF outline bookmarks in background
        const bm = await resolveOutlineEntries(doc);
        if (!cancelled) setOutline(bm);

        // Refine exact page geometries if document mixes portrait & landscape pages
        if (doc.numPages <= 80) {
          const exactMetas: PageGeometry[] = [];
          let differs = false;
          for (let p = 1; p <= doc.numPages; p++) {
            if (cancelled) return;
            const pg = await doc.getPage(p);
            const vp = pg.getViewport({ scale: 1, rotation: 0 });
            if (
              Math.abs(vp.width - firstVp.width) > 2 ||
              Math.abs(vp.height - firstVp.height) > 2
            ) {
              differs = true;
            }
            exactMetas.push({ pageNumber: p, width: vp.width, height: vp.height });
          }
          if (!cancelled && differs) {
            setPagesMeta(exactMetas);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(String(err));
          setLoadingPdf(false);
        }
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [rawStreamUrl, reloadTick, useNativeIframe]);

  // Track visible pages & current page number during scroll
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || pagesMeta.length === 0) return;
    setSelectionPopover(null);

    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    const viewCenter = viewTop + container.clientHeight * 0.35;

    let bestPage = 1;
    let bestDist = Infinity;
    const nextVisible = new Set<number>();

    for (const [pNum, el] of pageElMapRef.current.entries()) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom >= viewTop - 900 && top <= viewBottom + 900) {
        nextVisible.add(pNum);
      }
      const centerDist = Math.abs(top + el.offsetHeight * 0.35 - viewCenter);
      if (centerDist < bestDist) {
        bestDist = centerDist;
        bestPage = pNum;
      }
    }

    // Always include ±1 neighbors of bestPage for seamless scrolling
    for (let d = -1; d <= 2; d++) {
      const p = bestPage + d;
      if (p >= 1 && p <= pagesMeta.length) nextVisible.add(p);
    }

    setCurrentPage((prev) => {
      if (prev !== bestPage) setPageInput(String(bestPage));
      return bestPage;
    });
    setVisiblePageSet((prev) => {
      if (prev.size === nextVisible.size) {
        let identical = true;
        for (const v of nextVisible) {
          if (!prev.has(v)) {
            identical = false;
            break;
          }
        }
        if (identical) return prev;
      }
      return nextVisible;
    });
  }, [pagesMeta.length]);

  const jumpToPage = useCallback(
    (targetPage: number, normY?: number) => {
      if (pagesMeta.length === 0) return;
      const clamped = Math.min(pagesMeta.length, Math.max(1, Math.round(targetPage)));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      setVisiblePageSet((prev) => new Set([...prev, clamped, clamped + 1]));

      const container = scrollContainerRef.current;
      const pageEl = pageElMapRef.current.get(clamped);
      if (container && pageEl) {
        const yOffset =
          normY !== undefined ? Math.max(0, normY * pageEl.offsetHeight - 80) : 0;
        container.scrollTo({
          top: Math.max(0, pageEl.offsetTop + yOffset - 16),
          behavior: 'smooth',
        });
      }
    },
    [pagesMeta.length]
  );

  const adjustScale = useCallback((delta: number) => {
    setScale((prev) =>
      Math.round(Math.min(3.2, Math.max(0.5, prev + delta)) * 100) / 100
    );
  }, []);

  const fitWidth = useCallback(() => {
    const container = scrollContainerRef.current;
    const first = pagesMeta[0];
    if (!container || !first) return;
    const baseW = rotation % 180 !== 0 ? first.height : first.width;
    if (baseW <= 0) return;
    const next = Math.min(2.4, Math.max(0.55, (container.clientWidth - 56) / baseW));
    setScale(Math.round(next * 100) / 100);
  }, [pagesMeta, rotation]);

  // Ctrl + Mouse Wheel smooth PDF canvas zoom & Ctrl+F in-PDF search
  useEffect(() => {
    if (!isActive || useNativeIframe) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key === 'Escape') {
        setSelectionPopover(null);
        if (tool !== 'select') setTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, tool, useNativeIframe]);

  const handleWheelZoom = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY === 0) return;
      adjustScale(e.deltaY < 0 ? 0.1 : -0.1);
    },
    [adjustScale]
  );

  // Annotation CRUD Handlers
  const handleCreateAnnotation = useCallback(
    (
      draft: Omit<
        PdfAnnotation,
        'id' | 'createdAt' | 'updatedAt' | 'author' | 'replies'
      >,
      focusComment: boolean
    ) => {
      const now = Date.now();
      const created: PdfAnnotation = {
        ...draft,
        id: makeUid('ann'),
        author: defaultAuthor || '我',
        replies: [],
        createdAt: now,
        updatedAt: now,
      };
      setAnnotations((prev) => {
        const next = [...prev, created];
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
      setActiveAnnotationId(created.id);
      if (focusComment) {
        setSidebarOpen(true);
        setSidebarTab('annotations');
        setFocusCommentSeq((s) => s + 1);
      }
      if (draft.type === 'rect' || draft.type === 'pin') {
        setTool('select');
      }
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleSelectAnnotation = useCallback(
    (ann: PdfAnnotation) => {
      setActiveAnnotationId(ann.id);
      setSidebarOpen(true);
      setSidebarTab('annotations');
      jumpToPage(ann.pageNumber, ann.rects[0]?.y);
      setFlashingAnnotationId(ann.id);
      window.setTimeout(() => {
        setFlashingAnnotationId((cur) => (cur === ann.id ? null : cur));
      }, 1800);
    },
    [jumpToPage]
  );

  const handleUpdateComment = useCallback(
    (id: string, comment: string) => {
      setAnnotations((prev) => {
        const next = prev.map((a) =>
          a.id === id ? { ...a, comment, updatedAt: Date.now() } : a
        );
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleChangeAnnotationColor = useCallback(
    (id: string, color: PdfAnnotationColor) => {
      setAnnotations((prev) => {
        const next = prev.map((a) =>
          a.id === id ? { ...a, color, updatedAt: Date.now() } : a
        );
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleToggleResolved = useCallback(
    (id: string) => {
      setAnnotations((prev) => {
        const next = prev.map((a) =>
          a.id === id ? { ...a, resolved: !a.resolved, updatedAt: Date.now() } : a
        );
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleDeleteAnnotation = useCallback(
    (id: string) => {
      setAnnotations((prev) => {
        const next = prev.filter((a) => a.id !== id);
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
      setActiveAnnotationId((cur) => (cur === id ? null : cur));
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleAddReply = useCallback(
    (annotationId: string, content: string) => {
      const now = Date.now();
      setAnnotations((prev) => {
        const next = prev.map((a) =>
          a.id === annotationId
            ? {
                ...a,
                updatedAt: now,
                replies: [
                  ...a.replies,
                  {
                    id: makeUid('rep'),
                    author: defaultAuthor || '我',
                    content,
                    createdAt: now,
                  },
                ],
              }
            : a
        );
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleDeleteReply = useCallback(
    (annotationId: string, replyId: string) => {
      setAnnotations((prev) => {
        const next = prev.map((a) =>
          a.id === annotationId
            ? {
                ...a,
                updatedAt: Date.now(),
                replies: a.replies.filter((r) => r.id !== replyId),
              }
            : a
        );
        persistAnnotationStore(next, defaultAuthor);
        return next;
      });
    },
    [defaultAuthor, persistAnnotationStore]
  );

  const handleChangeAuthor = useCallback(
    (author: string) => {
      setDefaultAuthor(author);
      persistAnnotationStore(annotations, author);
    },
    [annotations, persistAnnotationStore]
  );

  // Group annotations by page for O(1) lookup per page
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const ann of annotations) {
      const list = map.get(ann.pageNumber);
      if (list) list.push(ann);
      else map.set(ann.pageNumber, [ann]);
    }
    return map;
  }, [annotations]);

  // Full-PDF Keyword Search
  const runPdfSearch = useCallback(
    async (query: string) => {
      const q = query.trim().toLowerCase();
      if (!pdfDoc || !q) {
        setSearchHits([]);
        setActiveHitIdx(0);
        return;
      }
      setSearching(true);
      const hits: PdfSearchHit[] = [];
      try {
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          const page = await pdfDoc.getPage(p);
          const tc = await page.getTextContent();
          const fullText = tc.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ');
          const lower = fullText.toLowerCase();
          let pos = 0;
          let idxInPage = 0;
          while (pos < lower.length) {
            const found = lower.indexOf(q, pos);
            if (found === -1) break;
            const start = Math.max(0, found - 18);
            const end = Math.min(fullText.length, found + q.length + 26);
            hits.push({
              pageNumber: p,
              snippet:
                (start > 0 ? '…' : '') +
                fullText.slice(start, end) +
                (end < fullText.length ? '…' : ''),
              matchIndexInPage: idxInPage,
            });
            idxInPage += 1;
            pos = found + Math.max(1, q.length);
            if (hits.length >= 200) break;
          }
          if (hits.length >= 200) break;
        }
        setSearchHits(hits);
        setActiveHitIdx(0);
        if (hits.length > 0) {
          jumpToPage(hits[0].pageNumber);
        }
      } finally {
        setSearching(false);
      }
    },
    [jumpToPage, pdfDoc]
  );

  const stepSearchHit = (delta: number) => {
    if (searchHits.length === 0) return;
    const nextIdx = (activeHitIdx + delta + searchHits.length) % searchHits.length;
    setActiveHitIdx(nextIdx);
    jumpToPage(searchHits[nextIdx].pageNumber);
  };

  // PDF -> Markdown Conversion Engine Trigger
  const pdfBaseStem = useMemo(() => {
    const fileName = filePath.replace(/\//g, '\\').split('\\').pop() || '文档.pdf';
    return fileName.replace(/\.pdf$/i, '');
  }, [filePath]);

  const pdfParentDir = useMemo(() => {
    const norm = filePath.replace(/\//g, '\\');
    const idx = norm.lastIndexOf('\\');
    return idx > 0 ? norm.slice(0, idx) : '';
  }, [filePath]);

  const handleConvertPdfToMarkdown = useCallback(async () => {
    if (!pdfDoc || convertingMd) return;
    setConvertingMd(true);
    try {
      const extractedPages: PdfExtractedPageInput[] = [];
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        setConvertProgress(`${p}/${pdfDoc.numPages}`);
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        const tc = await page.getTextContent();
        const rawItems: PdfRawTextItem[] = [];

        for (const item of tc.items) {
          if (!('str' in item) || !item.str) continue;
          const [a, b, c, d, tx, ty] = item.transform;
          const [vx, vy] = vp.convertToViewportPoint(tx, ty);
          const fs = Math.max(
            6,
            Math.hypot(a, b) || Math.hypot(c, d) || item.height || 12
          );
          rawItems.push({
            str: item.str,
            x: vx,
            topY: vy - fs * 0.85,
            width: item.width || 0,
            height: item.height || fs,
            fontSize: fs,
            fontName: item.fontName,
            hasEOL: item.hasEOL,
          });
        }

        extractedPages.push({
          pageNumber: p,
          width: vp.width,
          height: vp.height,
          items: rawItems,
        });
      }

      const md = convertExtractedPdfToMarkdown(extractedPages, {
        documentTitle: pdfBaseStem,
        outline: outline.map((o) => ({
          title: o.title,
          level: o.level,
          pageNumber: o.pageNumber,
        })),
        annotations: annotations.length > 0 ? annotations : undefined,
      });

      onOpenGeneratedMarkdown?.({
        suggestedName: `${pdfBaseStem}_转MD.md`,
        markdown: md,
        defaultSaveDir: pdfParentDir,
      });
    } finally {
      setConvertingMd(false);
      setConvertProgress('');
    }
  }, [annotations, convertingMd, onOpenGeneratedMarkdown, outline, pdfBaseStem, pdfDoc, pdfParentDir]);

  const handleExportAnnotationsMarkdown = useCallback(() => {
    const md = formatAnnotationsToMarkdown(annotations, pdfBaseStem);
    onOpenGeneratedMarkdown?.({
      suggestedName: `${pdfBaseStem}_批注笔记.md`,
      markdown: md,
      defaultSaveDir: pdfParentDir,
    });
  }, [annotations, onOpenGeneratedMarkdown, pdfBaseStem, pdfParentDir]);

  if (useNativeIframe) {
    const nativeUrl = `${rawStreamUrl}#view=FitH`;
    return (
      <div className="h-full w-full flex flex-col bg-slate-800">
        <div
          className="h-9 px-3 flex items-center justify-between text-xs border-b shrink-0 gap-2"
          style={{
            backgroundColor: 'var(--dp-surface)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          <span className="truncate" title={filePath}>
            📕 {pdfBaseStem}.pdf {sizeBytes ? `(${formatFileSize(sizeBytes)})` : ''} · 原生阅读与系统打印模式
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setUseNativeIframe(false)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition"
            >
              <Highlighter className="w-3.5 h-3.5" />
              <span>返回批注研读模式</span>
            </button>
            <button
              type="button"
              onClick={() => revealInExplorer(filePath)}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>定位</span>
            </button>
          </div>
        </div>
        <iframe
          key={`${slashPath}-${reloadTick}`}
          src={nativeUrl}
          title={filePath}
          className="flex-1 w-full h-full border-0 bg-neutral-700"
        />
      </div>
    );
  }

  return (
    <div
      data-pdf-zoom-host="true"
      onWheel={handleWheelZoom}
      className="h-full w-full flex flex-col overflow-hidden relative"
      style={{ backgroundColor: 'var(--dp-surface)' }}
    >
      {/* Studio PDF Top Toolbar */}
      <div
        className="min-h-9 px-2.5 py-1 border-b flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 select-none z-20"
        style={{
          backgroundColor: 'var(--dp-surface)',
          borderColor: 'var(--dp-border)',
          color: 'var(--dp-text-secondary)',
        }}
      >
        {/* Left: Page Nav + Zoom */}
        <div className="flex items-center gap-1.5">
          <div
            className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg border"
            style={{
              backgroundColor: 'var(--dp-sidebar)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            <button
              type="button"
              onClick={() => jumpToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              title="上一页"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <input
              type="text"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const n = parseInt(pageInput, 10);
                  if (!Number.isNaN(n)) jumpToPage(n);
                }
              }}
              onBlur={() => {
                const n = parseInt(pageInput, 10);
                if (!Number.isNaN(n)) jumpToPage(n);
                else setPageInput(String(currentPage));
              }}
              className="w-8 text-center font-mono text-[11px] bg-transparent outline-none"
              style={{ color: 'var(--dp-text)' }}
            />
            <span className="text-[11px] font-mono opacity-65 pr-1">
              / {pagesMeta.length || '-'}
            </span>
            <button
              type="button"
              onClick={() => jumpToPage(currentPage + 1)}
              disabled={currentPage >= pagesMeta.length}
              title="下一页"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div
            className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg border"
            style={{
              backgroundColor: 'var(--dp-sidebar)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            <button
              type="button"
              onClick={() => adjustScale(-0.15)}
              title="缩小 (Ctrl+滚轮向下)"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setScale(1.0)}
              title="点击重置为 100%"
              className="px-1 font-mono text-[11px] min-w-[40px] text-center"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              onClick={() => adjustScale(0.15)}
              title="放大 (Ctrl+滚轮向上)"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={fitWidth}
              title="适应窗口宽度"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              title="顺时针旋转 90°"
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Center: Annotation Tools + Color Swatches */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <div
            className="flex items-center p-0.5 rounded-lg border"
            style={{
              backgroundColor: 'var(--dp-sidebar)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            {(
              [
                ['select', MousePointer2, '划词', '划词选择文字弹出高亮/批注菜单 (默认)'],
                ['highlight', Highlighter, '高亮', '荧光笔连刷模式：划选文字直接高亮'],
                ['underline', Underline, '下划线', '下划线连刷模式：划选文字直接添加下划线'],
                ['rect', Scan, '框选', '区域框选标注：拖拽框选公式/图表截图并添加批注'],
                ['pin', MapPin, '便签', '定点便签：在页面任意位置点击插入评论钉'],
              ] as const
            ).map(([mode, Icon, label, tip]) => {
              const active = tool === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTool(mode)}
                  title={tip}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition ${
                    active
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'hover:bg-black/5 dark:hover:bg-white/10'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">{label}</span>
                </button>
              );
            })}
          </div>

          {/* 5 Marker Colors */}
          <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg border" style={{ borderColor: 'var(--dp-border)' }}>
            {PDF_COLOR_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setActiveColor(c)}
                title={`标注颜色：${PDF_COLOR_META[c].label}`}
                className={`w-3.5 h-3.5 rounded-full ${PDF_COLOR_META[c].dotClass} transition ${
                  activeColor === c
                    ? 'ring-2 ring-offset-1 ring-blue-600 scale-110'
                    : 'opacity-70 hover:opacity-100'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Right: PDF -> MD + Search + Annotation Drawer + Native Mode */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!pdfDoc || convertingMd}
            onClick={() => void handleConvertPdfToMarkdown()}
            title="智能识别标题、列表、表格与段落，一键转换为 Markdown 并在双栏中对照预览"
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold bg-gradient-to-r from-blue-600 to-cyan-600 text-white hover:opacity-95 disabled:opacity-50 shadow-xs transition"
          >
            {convertingMd ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>转 MD {convertProgress}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>PDF 转 MD</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title="全文搜索 PDF 内容 (Ctrl+F)"
            className={`p-1 rounded-lg border transition ${
              searchOpen ? 'bg-blue-600/15 text-blue-600 border-blue-500/40' : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            style={{ borderColor: searchOpen ? undefined : 'var(--dp-border-strong)' }}
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title="展开/收起右侧批注、回复与目录栏"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] font-medium transition ${
              sidebarOpen
                ? 'bg-blue-600/12 text-blue-600 dark:text-sky-300 border-blue-500/40'
                : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            style={{ borderColor: sidebarOpen ? undefined : 'var(--dp-border-strong)' }}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>批注 ({annotations.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setUseNativeIframe(true)}
            title="切换至系统原生 PDF 视图（支持系统级打印对话框）"
            className="p-1 rounded-lg border hover:bg-black/5 dark:hover:bg-white/10"
            style={{ borderColor: 'var(--dp-border-strong)' }}
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setReloadTick((k) => k + 1)}
            title="重新加载 PDF"
            className="p-1 rounded-lg border hover:bg-black/5 dark:hover:bg-white/10"
            style={{ borderColor: 'var(--dp-border-strong)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => revealInExplorer(filePath)}
            title={`在资源管理器中定位：${filePath}`}
            className="p-1 rounded-lg border hover:bg-black/5 dark:hover:bg-white/10"
            style={{ borderColor: 'var(--dp-border-strong)' }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Floating Search Bar */}
      {searchOpen && (
        <div
          className="absolute top-12 left-4 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-xl border shadow-lg text-xs"
          style={{
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
          }}
        >
          <Search className="w-3.5 h-3.5 opacity-60 shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (searchHits.length > 0) {
                  stepSearchHit(e.shiftKey ? -1 : 1);
                } else {
                  void runPdfSearch(searchQuery);
                }
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
              }
            }}
            placeholder="输入关键词按 Enter 检索全文..."
            className="w-48 bg-transparent outline-none text-xs"
            style={{ color: 'var(--dp-text)' }}
          />
          <button
            type="button"
            onClick={() => void runPdfSearch(searchQuery)}
            className="px-2 py-0.5 rounded bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700"
          >
            {searching ? '...' : '查找'}
          </button>
          {searchHits.length > 0 && (
            <span className="font-mono text-[11px] px-1 opacity-75">
              {activeHitIdx + 1}/{searchHits.length} (P.{searchHits[activeHitIdx]?.pageNumber})
            </span>
          )}
          <button
            type="button"
            disabled={searchHits.length === 0}
            onClick={() => stepSearchHit(-1)}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={searchHits.length === 0}
            onClick={() => stepSearchHit(1)}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setSearchHits([]);
            }}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Floating Text Selection Quick-Action Toolbar */}
      {selectionPopover && (
        <div
          style={{
            left: `${Math.max(160, Math.min(window.innerWidth - 200, selectionPopover.anchorClientX))}px`,
            top: `${Math.max(54, selectionPopover.anchorClientY - 44)}px`,
          }}
          className="fixed -translate-x-1/2 z-50 flex items-center gap-1 px-2 py-1.5 rounded-xl border shadow-xl text-xs select-none"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div
            className="absolute inset-0 rounded-xl -z-10"
            style={{
              backgroundColor: 'var(--dp-elevated)',
              border: '1px solid var(--dp-border-strong)',
            }}
          />

          {PDF_COLOR_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setActiveColor(c);
                handleCreateAnnotation(
                  {
                    pageNumber: selectionPopover.pageNumber,
                    type: 'highlight',
                    color: c,
                    rects: selectionPopover.rects,
                    selectedText: selectionPopover.selectedText,
                    comment: '',
                  },
                  false
                );
                window.getSelection()?.removeAllRanges();
                setSelectionPopover(null);
              }}
              title={`用${PDF_COLOR_META[c].label}高亮`}
              className={`w-4 h-4 rounded-full ${PDF_COLOR_META[c].dotClass} hover:scale-115 transition`}
            />
          ))}

          <span className="w-px h-4 mx-0.5 bg-slate-300 dark:bg-slate-600" />

          <button
            type="button"
            onClick={() => {
              handleCreateAnnotation(
                {
                  pageNumber: selectionPopover.pageNumber,
                  type: 'underline',
                  color: activeColor,
                  rects: selectionPopover.rects,
                  selectedText: selectionPopover.selectedText,
                  comment: '',
                },
                false
              );
              window.getSelection()?.removeAllRanges();
              setSelectionPopover(null);
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 font-medium"
          >
            <Underline className="w-3.5 h-3.5" />
            <span>下划线</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleCreateAnnotation(
                {
                  pageNumber: selectionPopover.pageNumber,
                  type: 'highlight',
                  color: activeColor,
                  rects: selectionPopover.rects,
                  selectedText: selectionPopover.selectedText,
                  comment: '',
                },
                true
              );
              window.getSelection()?.removeAllRanges();
              setSelectionPopover(null);
            }}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>写批注</span>
          </button>

          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(selectionPopover.selectedText);
              window.getSelection()?.removeAllRanges();
              setSelectionPopover(null);
            }}
            title="复制选中文本"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>复制</span>
          </button>
        </div>
      )}

      {/* Main Content Area: PDF Scroll Viewport + Collapsible Annotation/Outline Sidebar */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectionPopover(null);
            }
          }}
          className="flex-1 overflow-auto py-5 px-4 space-y-5 bg-slate-200/75 dark:bg-slate-900/90"
        >
          {loadingPdf ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
              <span>正在解析 PDF 文档页面与矢量文字层...</span>
            </div>
          ) : loadError ? (
            <div className="max-w-md mx-auto mt-16 p-6 rounded-2xl border bg-white dark:bg-slate-800 text-center space-y-3">
              <FileText className="w-8 h-8 text-rose-500 mx-auto" />
              <p className="text-xs text-rose-500 font-medium">
                批注视图加载异常：{loadError}
              </p>
              <button
                type="button"
                onClick={() => setUseNativeIframe(true)}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold"
              >
                切换至原生 PDF 预览器打开
              </button>
            </div>
          ) : (
            pdfDoc &&
            pagesMeta.map((meta) => (
              <PdfPageView
                key={meta.pageNumber}
                pdfDoc={pdfDoc}
                pageNumber={meta.pageNumber}
                baseWidth={meta.width}
                baseHeight={meta.height}
                scale={scale}
                rotation={rotation}
                shouldRender={visiblePageSet.has(meta.pageNumber)}
                tool={tool}
                activeColor={activeColor}
                annotations={annotationsByPage.get(meta.pageNumber) || []}
                activeAnnotationId={activeAnnotationId}
                flashingAnnotationId={flashingAnnotationId}
                onRegisterPageEl={registerPageEl}
                onCreateAnnotation={handleCreateAnnotation}
                onSelectAnnotation={handleSelectAnnotation}
                onShowSelectionPopover={setSelectionPopover}
              />
            ))
          )}
        </div>

        {sidebarOpen && (
          <PdfAnnotationSidebar
            tabMode={sidebarTab}
            onChangeTabMode={setSidebarTab}
            annotations={annotations}
            outline={outline}
            activeAnnotationId={activeAnnotationId}
            focusCommentRequestSeq={focusCommentSeq}
            defaultAuthor={defaultAuthor}
            onChangeDefaultAuthor={handleChangeAuthor}
            onSelectAnnotation={handleSelectAnnotation}
            onUpdateComment={handleUpdateComment}
            onChangeColor={handleChangeAnnotationColor}
            onToggleResolved={handleToggleResolved}
            onDeleteAnnotation={handleDeleteAnnotation}
            onAddReply={handleAddReply}
            onDeleteReply={handleDeleteReply}
            onJumpToPage={(p) => jumpToPage(p)}
            onExportAnnotationsMd={handleExportAnnotationsMarkdown}
            onClose={() => setSidebarOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

export default PdfPane;
