import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Pencil,
  Printer,
  RefreshCw,
  Save,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  isTauriRuntime,
  openInContextVault,
  pickSaveDocument,
  readMarkdownDocument,
  saveTextDocument,
} from '@/api/client';
import type {
  ContentWidth,
  HeadingItem,
  MarkdownDocument,
  RuntimeProfile,
  SaveResult,
  ThemeMode,
} from '@/types';
import { renderMarkdownToHtml } from '@/utils/markdownRenderer';
import { formatFileSize, slashToWindowsPath } from '@/utils/pathUtils';

const LazyCodeEditorPane = React.lazy(() => import('@/components/CodeEditorPane'));

interface MarkdownPaneProps {
  tabId: string;
  filePath: string;
  initialName?: string;
  isScratchpad?: boolean;
  initialContent?: string;
  defaultSaveDir?: string | null;
  assetBaseUrl: string;
  theme: ThemeMode;
  fontSize: number;
  contentWidth: ContentWidth;
  isActive: boolean;
  scrollTargetHeadingId?: string | null;
  onHeadingsChange?: (headings: HeadingItem[]) => void;
  onOpenLocalPath: (windowsPath: string, line?: number) => void;
  runtimes: RuntimeProfile[];
  preferredPython: string | null;
  onChangePreferredPython: (executable: string) => void;
  isRunning: boolean;
  onRunCode: (params: {
    language: string;
    code: string;
    filePath: string | null;
    workingDir?: string | null;
    isSavedFile: boolean;
  }) => void;
  onStopRun: () => void;
  onDirtyChange?: (tabId: string, isDirty: boolean) => void;
  onSavedAs?: (tabId: string, saved: SaveResult, language: string) => void;
}

// Cache rendered Mermaid SVGs in memory so tab switches & theme toggles are 0ms instant!
const mermaidSvgCache = new Map<string, string>();
let mermaidRenderSeq = 0;

interface ArticleBodyProps {
  html: string;
  onBodyClick: (e: React.MouseEvent<HTMLElement>) => void;
}

// Memoized inner DOM container so changing fontSize / width / search NEVER resets innerHTML or Mermaid SVGs!
const MemoizedArticleBody = React.memo<ArticleBodyProps>(
  ({ html, onBodyClick }) => (
    <article
      onClick={onBodyClick}
      className="dp-markdown-body pb-20"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ),
  (prev, next) => prev.html === next.html
);

function estimateWordStats(markdownText: string): { words: number; minutes: number } {
  const cleaned = markdownText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()!-]/g, ' ');
  const cjkCount = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (cleaned.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || [])
    .length;
  const total = cjkCount + latinWords;
  const minutes = Math.max(1, Math.ceil(total / 380));
  return { words: total, minutes };
}

export const MarkdownPane: React.FC<MarkdownPaneProps> = ({
  tabId,
  filePath,
  initialName,
  isScratchpad = false,
  initialContent,
  defaultSaveDir,
  assetBaseUrl,
  theme,
  fontSize,
  contentWidth,
  isActive,
  scrollTargetHeadingId,
  onHeadingsChange,
  onOpenLocalPath,
  runtimes,
  preferredPython,
  onChangePreferredPython,
  isRunning,
  onRunCode,
  onStopRun,
  onDirtyChange,
  onSavedAs,
}) => {
  const [doc, setDoc] = useState<MarkdownDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [isEditingSource, setIsEditingSource] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);

  // Reading UX enhancements: progress bar, back-to-top, copy toast, in-page search
  const [scrollProgress, setScrollProgress] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [copiedSource, setCopiedSource] = useState(false);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findActiveIdx, setFindActiveIdx] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findRangesRef = useRef<Range[]>([]);

  // Keep latest callback refs so MemoizedArticleBody never needs a new click function
  const openLocalRef = useRef(onOpenLocalPath);
  openLocalRef.current = onOpenLocalPath;

  const runCodeRef = useRef(onRunCode);
  runCodeRef.current = onRunCode;

  const parentDirRef = useRef<string | null>(null);
  parentDirRef.current = doc ? slashToWindowsPath(doc.parentSlashPath) : null;

  useEffect(() => {
    if (isScratchpad) {
      const content = initialContent ?? '';
      const slashDir = (defaultSaveDir || '').replace(/\\/g, '/');
      setError(null);
      setDoc({
        name: initialName || '转换预览.md',
        path: filePath,
        slashPath: filePath,
        parentSlashPath: slashDir,
        language: 'markdown',
        content,
        sizeBytes: new Blob([content]).size,
        modifiedMs: Date.now(),
      });
      return;
    }

    let cancelled = false;
    setError(null);
    readMarkdownDocument(filePath)
      .then((loaded) => {
        if (!cancelled) setDoc(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [defaultSaveDir, filePath, initialContent, initialName, isScratchpad, reloadTick]);

  const handleSaveScratchpadAs = useCallback(async () => {
    if (!doc) return;
    const picked = await pickSaveDocument(defaultSaveDir ?? null, doc.name);
    if (!picked) return;
    const saved = await saveTextDocument(picked, doc.content);
    onDirtyChange?.(tabId, false);
    onSavedAs?.(tabId, saved, 'markdown');
  }, [defaultSaveDir, doc, onDirtyChange, onSavedAs, tabId]);

  const rendered = useMemo(() => {
    if (!doc) return { html: '', headings: [] };
    return renderMarkdownToHtml(doc.content, doc.parentSlashPath, assetBaseUrl);
  }, [doc, assetBaseUrl]);

  const wordStats = useMemo(
    () => (doc ? estimateWordStats(doc.content) : { words: 0, minutes: 1 }),
    [doc]
  );

  useEffect(() => {
    if (isActive && !isEditingSource && onHeadingsChange) {
      onHeadingsChange(rendered.headings);
    }
  }, [isActive, isEditingSource, rendered.headings, onHeadingsChange]);

  // Ctrl+F shortcut to open non-destructive in-page search when MarkdownPane is active
  useEffect(() => {
    if (!isActive || isEditingSource) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        });
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, isEditingSource, findOpen]);

  // Zero-DOM-mutation text search using WebView2 CSS Custom Highlight API
  useEffect(() => {
    const cssAny = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight;

    if (!findOpen || !findQuery.trim() || !containerRef.current || isEditingSource) {
      findRangesRef.current = [];
      setFindCount(0);
      setFindActiveIdx(0);
      cssAny?.highlights?.delete('dp-md-find');
      cssAny?.highlights?.delete('dp-md-find-active');
      return;
    }

    const articleEl = containerRef.current.querySelector('.dp-markdown-body');
    if (!articleEl) return;

    const q = findQuery.trim().toLowerCase();
    const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT);
    const ranges: Range[] = [];
    let currentNode = walker.nextNode();

    while (currentNode && ranges.length < 500) {
      const text = currentNode.nodeValue || '';
      const lower = text.toLowerCase();
      let startIdx = 0;
      while (startIdx < lower.length) {
        const hit = lower.indexOf(q, startIdx);
        if (hit === -1) break;
        const r = document.createRange();
        r.setStart(currentNode, hit);
        r.setEnd(currentNode, hit + q.length);
        ranges.push(r);
        startIdx = hit + q.length;
      }
      currentNode = walker.nextNode();
    }

    findRangesRef.current = ranges;
    setFindCount(ranges.length);
    setFindActiveIdx(0);

    if (cssAny?.highlights && HighlightCtor) {
      if (ranges.length > 0) {
        cssAny.highlights.set('dp-md-find', new HighlightCtor(...ranges));
        cssAny.highlights.set('dp-md-find-active', new HighlightCtor(ranges[0]));
        ranges[0].startContainer.parentElement?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      } else {
        cssAny.highlights.delete('dp-md-find');
        cssAny.highlights.delete('dp-md-find-active');
      }
    }

    return () => {
      cssAny?.highlights?.delete('dp-md-find');
      cssAny?.highlights?.delete('dp-md-find-active');
    };
  }, [findOpen, findQuery, rendered.html, isEditingSource]);

  const stepFindMatch = (delta: number) => {
    const ranges = findRangesRef.current;
    if (ranges.length === 0) return;
    const nextIdx = (findActiveIdx + delta + ranges.length) % ranges.length;
    setFindActiveIdx(nextIdx);
    const targetRange = ranges[nextIdx];

    const cssAny = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight;
    if (cssAny?.highlights && HighlightCtor) {
      cssAny.highlights.set('dp-md-find-active', new HighlightCtor(targetRange));
    }
    targetRange.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  };

  // Scroll to heading when clicked in Outline TOC
  useEffect(() => {
    if (!isActive || isEditingSource || !scrollTargetHeadingId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`#${CSS.escape(scrollTargetHeadingId)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isActive, isEditingSource, scrollTargetHeadingId]);

  // Lazy-load Mermaid on demand & cache rendered SVGs
  useEffect(() => {
    if (isEditingSource) return;
    const root = containerRef.current;
    if (!root || !rendered.html) return;

    const wrappers = Array.from(
      root.querySelectorAll<HTMLElement>('.dp-mermaid-wrapper[data-mermaid]')
    );
    if (wrappers.length === 0) return;

    const mermaidTheme = theme === 'dark' ? 'dark' : 'default';

    // Fast path: fill any cached diagrams synchronously!
    const uncached: HTMLElement[] = [];
    for (const box of wrappers) {
      const rawCode = decodeURIComponent(box.dataset.mermaid || '');
      const cacheKey = `${mermaidTheme}::${rawCode}`;
      const hit = mermaidSvgCache.get(cacheKey);
      if (hit) {
        box.innerHTML = hit;
      } else if (rawCode.trim()) {
        uncached.push(box);
      }
    }
    if (uncached.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: mermaidTheme,
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        });

        for (const box of uncached) {
          if (cancelled) break;
          const rawCode = decodeURIComponent(box.dataset.mermaid || '');
          const cacheKey = `${mermaidTheme}::${rawCode}`;
          try {
            mermaidRenderSeq += 1;
            const svgId = `dp-mmd-svg-${mermaidRenderSeq}`;
            const { svg } = await mermaid.render(svgId, rawCode);
            mermaidSvgCache.set(cacheKey, svg);
            if (!cancelled) {
              box.innerHTML = svg;
            }
          } catch (err) {
            if (!cancelled) {
              box.innerHTML = `<pre class="text-xs text-rose-500 whitespace-pre-wrap">${rawCode}</pre>`;
              console.warn('Mermaid render warning:', err);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to load Mermaid module:', err);
      }
    }, 16);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rendered.html, theme, isEditingSource]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll > 40) {
      setScrollProgress(Math.min(100, Math.max(0, (el.scrollTop / maxScroll) * 100)));
    } else {
      setScrollProgress(0);
    }
    setShowBackToTop(el.scrollTop > 380);
  };

  const handleBodyClick = useCallback(async (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;

    const runBtn = target.closest<HTMLButtonElement>('button[data-run-code]');
    if (runBtn) {
      const lang = runBtn.dataset.runLang || 'python';
      const code = decodeURIComponent(runBtn.dataset.runCode || '');
      runCodeRef.current({
        language: lang,
        code,
        filePath: null,
        workingDir: parentDirRef.current,
        isSavedFile: false,
      });
      return;
    }

    const copyBtn = target.closest<HTMLButtonElement>('button[data-copy-code]');
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.dataset.copyCode || '');
      await navigator.clipboard.writeText(code);
      const prev = copyBtn.textContent;
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => {
        copyBtn.textContent = prev || '复制代码';
      }, 1500);
      return;
    }

    const imgEl = target.closest<HTMLImageElement>('img.dp-zoomable-img');
    if (imgEl && imgEl.src) {
      setLightboxZoom(1);
      setLightboxSrc(imgEl.src);
      return;
    }

    const anchorEl = target.closest<HTMLAnchorElement>('a[data-anchor-href]');
    if (anchorEl) {
      e.preventDefault();
      const rawHash = decodeURIComponent(
        (anchorEl.dataset.anchorHref || '').replace(/^#/, '')
      );
      if (containerRef.current && rawHash) {
        const byId = containerRef.current.querySelector(`#${CSS.escape(rawHash)}`);
        if (byId) {
          byId.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        const allHeadings = Array.from(
          containerRef.current.querySelectorAll('.dp-heading')
        );
        const found = allHeadings.find((h) =>
          (h.textContent || '').trim().toLowerCase().includes(rawHash.toLowerCase())
        );
        found?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    const convLink = target.closest<HTMLAnchorElement>('a[data-conv-id]');
    if (convLink) {
      e.preventDefault();
      const convId = convLink.dataset.convId || '';
      if (convId) {
        await openInContextVault(convId, parentDirRef.current);
      }
      return;
    }

    const localDocLink = target.closest<HTMLAnchorElement>('a[data-local-doc]');
    if (localDocLink) {
      e.preventDefault();
      const slashTarget = localDocLink.dataset.localDoc || '';
      const rawHash = localDocLink.dataset.localHash || '';
      const lineMatch = rawHash.match(/^#L(\d+)/i);
      const jumpLine = lineMatch ? Number(lineMatch[1]) : undefined;
      if (slashTarget) {
        openLocalRef.current(slashToWindowsPath(slashTarget), jumpLine);
      }
      return;
    }

    const extLink = target.closest<HTMLAnchorElement>('a.dp-link-ext');
    if (extLink && extLink.href) {
      if (isTauriRuntime()) {
        e.preventDefault();
        await shellOpen(extLink.href);
      }
    }
  }, []);

  if (isEditingSource) {
    return (
      <Suspense
        fallback={
          <div className="p-8 text-xs" style={{ color: 'var(--dp-text-muted)' }}>
            正在初始化轻量源码编辑器...
          </div>
        }
      >
        <LazyCodeEditorPane
          tabId={tabId}
          filePath={filePath}
          initialLanguage="markdown"
          isScratchpad={isScratchpad}
          initialContent={isScratchpad ? doc?.content ?? initialContent ?? '' : undefined}
          workspaceDir={defaultSaveDir ?? undefined}
          theme={theme}
          fontSize={fontSize}
          isActive={isActive}
          runtimes={runtimes}
          preferredPython={preferredPython}
          onChangePreferredPython={onChangePreferredPython}
          isRunning={isRunning}
          onRunCode={onRunCode}
          onStopRun={onStopRun}
          onDirtyChange={onDirtyChange}
          onSavedAs={(id, saved, lang) => {
            setIsEditingSource(false);
            onSavedAs?.(id, saved, lang);
          }}
          onSwitchToPreview={() => {
            onDirtyChange?.(tabId, false);
            setReloadTick((t) => t + 1);
            setIsEditingSource(false);
          }}
        />
      </Suspense>
    );
  }

  const maxWidthClass =
    contentWidth === 'narrow'
      ? 'max-w-3xl'
      : contentWidth === 'comfortable'
        ? 'max-w-4xl'
        : 'max-w-none';

  if (error) {
    return (
      <div className="p-8 text-sm text-rose-500">
        无法读取 Markdown 文档：{error}
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="p-8 text-xs" style={{ color: 'var(--dp-text-muted)' }}>
        正在加载文档...
      </div>
    );
  }

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden relative"
      style={{ backgroundColor: 'var(--dp-surface)' }}
    >
      {/* Top 2px Reading Progress Indicator */}
      <div className="h-0.5 w-full shrink-0 bg-transparent dp-no-print">
        <div
          className="h-full transition-all duration-100"
          style={{
            width: `${scrollProgress}%`,
            backgroundColor: 'var(--dp-accent)',
          }}
        />
      </div>

      {/* Floating In-Page Search Bar (Ctrl+F) */}
      {findOpen && (
        <div
          className="absolute top-3 right-6 z-30 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border shadow-lg text-xs dp-no-print"
          style={{
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
          }}
        >
          <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--dp-text-muted)' }} />
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFindMatch(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                setFindOpen(false);
              }
            }}
            placeholder="在讲义中查找..."
            className="w-40 bg-transparent outline-none text-xs"
            style={{ color: 'var(--dp-text)' }}
          />
          <span
            className="font-mono text-[11px] min-w-[38px] text-center"
            style={{ color: 'var(--dp-text-muted)' }}
          >
            {findQuery.trim()
              ? findCount > 0
                ? `${findActiveIdx + 1}/${findCount}`
                : '0/0'
              : ''}
          </span>
          <button
            type="button"
            onClick={() => stepFindMatch(-1)}
            disabled={findCount === 0}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => stepFindMatch(1)}
            disabled={findCount === 0}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-35"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setFindOpen(false)}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Scrollable Reading Container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 sm:px-10 py-6 relative dp-print-scroll"
      >
        <div
          className={`${maxWidthClass} mx-auto mb-5 pb-2.5 border-b flex flex-wrap items-center justify-between gap-2 text-xs dp-no-print`}
          style={{
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-muted)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span className="truncate" title={doc.path}>
              📄 {doc.name}
            </span>
            <span>· {formatFileSize(doc.sizeBytes)}</span>
            <span className="hidden sm:inline">
              · 约 {wordStats.words.toLocaleString()} 字 · 预计 {wordStats.minutes} 分钟读完
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isScratchpad && (
              <button
                type="button"
                onClick={() => void handleSaveScratchpadAs()}
                title="将此 Markdown 文档保存到本地磁盘"
                className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 shadow-xs transition"
              >
                <Save className="w-3 h-3" />
                <span>保存 .md</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setFindOpen((v) => !v);
                requestAnimationFrame(() => findInputRef.current?.focus());
              }}
              title="页内查找关键词 (Ctrl+F)"
              className="flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 transition"
              style={{
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-text-secondary)',
              }}
            >
              <Search className="w-3 h-3" />
              <span className="hidden md:inline">查找</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(doc.content);
                setCopiedSource(true);
                window.setTimeout(() => setCopiedSource(false), 1600);
              }}
              title="复制全文 Markdown 源码"
              className="flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 transition"
              style={{
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-text-secondary)',
              }}
            >
              {copiedSource ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              <span className="hidden md:inline">{copiedSource ? '已复制' : '复制'}</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              title="打印或导出为 PDF"
              className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 transition"
              style={{
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-text-secondary)',
              }}
            >
              <Printer className="w-3 h-3" />
              <span className="hidden lg:inline">打印</span>
            </button>

            <button
              type="button"
              onClick={() => setIsEditingSource(true)}
              title="切换至 Markdown 源码编辑模式"
              className="flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 transition"
              style={{
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-accent)',
              }}
            >
              <Pencil className="w-3 h-3" />
              <span>编辑源码</span>
            </button>

            {!isScratchpad && (
              <button
                type="button"
                onClick={() => setReloadTick((t) => t + 1)}
                title="从磁盘刷新最新内容"
                className="p-1 rounded border hover:opacity-85 shrink-0 transition"
                style={{
                  borderColor: 'var(--dp-border-strong)',
                  color: 'var(--dp-text-secondary)',
                }}
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div className={`${maxWidthClass} mx-auto`} style={{ fontSize: `${fontSize}px` }}>
          <MemoizedArticleBody html={rendered.html} onBodyClick={handleBodyClick} />
        </div>
      </div>

      {/* Floating Back-to-Top Button */}
      {showBackToTop && (
        <button
          type="button"
          onClick={() =>
            containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          }
          title="回到文章顶部"
          className="absolute bottom-5 right-6 z-20 p-2 rounded-full border shadow-md transition hover:scale-105 dp-no-print"
          style={{
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      )}

      {lightboxSrc && (
        <div
          data-lightbox-modal="true"
          onClick={() => setLightboxSrc(null)}
          onWheel={(e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15;
            setLightboxZoom((z) => Math.min(4.5, Math.max(0.3, z + delta)));
          }}
          className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-6 dp-no-print"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-2 mb-3 px-4 py-1.5 rounded-full bg-slate-900 text-white text-xs border border-slate-700"
          >
            <button
              type="button"
              onClick={() => setLightboxZoom((z) => Math.max(0.5, z - 0.25))}
              className="p-1 hover:text-sky-400"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="font-mono min-w-[48px] text-center">
              {Math.round(lightboxZoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setLightboxZoom((z) => Math.min(3.5, z + 0.25))}
              className="p-1 hover:text-sky-400"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setLightboxSrc(null)}
              className="ml-2 p-1 hover:text-rose-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-[85vh] overflow-auto bg-white rounded-xl p-3 shadow-2xl"
          >
            <img
              src={lightboxSrc}
              alt="放大预览"
              style={{
                transform: `scale(${lightboxZoom})`,
                transformOrigin: 'top center',
              }}
              className="max-w-full h-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
};
