import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { startCompletion } from '@codemirror/autocomplete';
import { redo, undo } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { openSearchPanel, search } from '@codemirror/search';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Eye,
  Lightbulb,
  Play,
  Redo2,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Square,
  Undo2,
  WrapText,
} from 'lucide-react';
import {
  formatCodeDocument,
  inspectPythonModule,
  pickSaveDocument,
  readMarkdownDocument,
  saveTextDocument,
  scanSiblingCodeSymbols,
} from '@/api/client';
import type { EditorCursorStatus } from '@/components/StatusBar';
import type { HeadingItem, RuntimeProfile, SaveResult, ThemeMode } from '@/types';
import {
  createIntelliSenseExtensions,
  extractImportedPythonModules,
  type IntelliSenseExternalContext,
} from '@/utils/codeCompletions';
import { extractCodeSymbols } from '@/utils/codeSymbols';
import { formatFileSize } from '@/utils/pathUtils';

export interface CodeJumpTarget {
  line: number;
  seq: number;
}

export interface CodeEditorPaneProps {
  tabId: string;
  filePath: string;
  initialLanguage?: string;
  isScratchpad?: boolean;
  initialContent?: string;
  theme: ThemeMode;
  fontSize: number;
  isActive: boolean;
  workspaceDir?: string | null;
  jumpTarget?: CodeJumpTarget | null;
  onHeadingsChange?: (items: HeadingItem[]) => void;
  onCursorStatusChange?: (status: EditorCursorStatus) => void;
  runtimes: RuntimeProfile[];
  preferredPython: string | null;
  onChangePreferredPython: (executable: string) => void;
  isRunning: boolean;
  onRunCode: (params: {
    language: string;
    code: string;
    filePath: string | null;
    isSavedFile: boolean;
  }) => void;
  onStopRun: () => void;
  onDirtyChange?: (tabId: string, isDirty: boolean) => void;
  onSavedAs?: (tabId: string, saved: SaveResult, language: string) => void;
  onSwitchToPreview?: () => void;
}

const RUNNABLE_SET = new Set([
  'python',
  'javascript',
  'typescript',
  'powershell',
  'batch',
  'rust',
]);

const LANGUAGE_OPTIONS: { value: string; label: string; defaultExt: string }[] = [
  { value: 'python', label: 'Python (.py)', defaultExt: 'py' },
  { value: 'javascript', label: 'JavaScript (.js)', defaultExt: 'js' },
  { value: 'typescript', label: 'TypeScript (.ts)', defaultExt: 'ts' },
  { value: 'powershell', label: 'PowerShell (.ps1)', defaultExt: 'ps1' },
  { value: 'batch', label: 'Batch CMD (.bat)', defaultExt: 'bat' },
  { value: 'rust', label: 'Rust (.rs)', defaultExt: 'rs' },
  { value: 'markdown', label: 'Markdown (.md)', defaultExt: 'md' },
  { value: 'json', label: 'JSON (.json)', defaultExt: 'json' },
  { value: 'toml', label: 'TOML / YAML', defaultExt: 'toml' },
  { value: 'cpp', label: 'C / C++', defaultExt: 'cpp' },
  { value: 'sql', label: 'SQL (.sql)', defaultExt: 'sql' },
  { value: 'text', label: '纯文本 (.txt)', defaultExt: 'txt' },
];

function getEditorPlaceholder(language: string): string {
  switch (language) {
    case 'python':
      return '# 直接开始编写 Python 代码（输入自动触发补全 · Tab 采纳 · F5 运行）\n\ndef main():\n    print("Hello PrismStudio!")\n\nif __name__ == "__main__":\n    main()';
    case 'javascript':
    case 'typescript':
      return '// 直接开始编写代码（输入自动触发补全 · Tab 采纳 · F5 运行）\nconsole.log("Hello PrismStudio!");';
    case 'rust':
      return '// 直接开始编写 Rust 代码（Tab 补全 · F5 编译运行）\nfn main() {\n    println!("Hello PrismStudio!");\n}';
    case 'powershell':
      return '# 直接开始编写 PowerShell 脚本（Tab 补全 · F5 运行）\nWrite-Host "Hello PrismStudio!" -ForegroundColor Cyan';
    case 'json':
      return '{\n  "key": "value"\n}';
    case 'markdown':
      return '# 在此输入 Markdown 标题...\n\n开始撰写正文内容。';
    default:
      return '直接输入内容即可开始编写...';
  }
}

function inferLanguageFromPath(p: string, fallback: string): string {
  const ext = p.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'py':
    case 'pyw':
      return 'python';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'ps1':
      return 'powershell';
    case 'bat':
    case 'cmd':
      return 'batch';
    case 'rs':
      return 'rust';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'json':
    case 'jsonl':
      return 'json';
    case 'toml':
    case 'yaml':
    case 'yml':
      return 'toml';
    default:
      return fallback;
  }
}

/**
 * Automatically detects whether a file uses 2-space or 4-space indentation so
 * 2-space JSON / JS / TS files show crisp 2-space vertical indent guides immediately!
 */
function detectIndentStep(content: string, lang: string): 2 | 4 {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let mod2Only = 0;
  let mod4 = 0;
  const limit = Math.min(lines.length, 350);

  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    let spaces = 0;
    while (spaces < line.length && line.charCodeAt(spaces) === 32) {
      spaces += 1;
    }
    if (spaces === 0 || spaces >= line.length) continue;
    if (spaces % 4 === 2) {
      mod2Only += 1;
    } else if (spaces % 4 === 0) {
      mod4 += 1;
    }
  }

  if (mod2Only >= 2 && mod2Only * 1.5 >= mod4) {
    return 2;
  }
  if (
    mod4 === 0 &&
    (lang === 'json' || lang === 'javascript' || lang === 'typescript' || lang === 'toml')
  ) {
    return 2;
  }
  return 4;
}

/**
 * Detects compacted / non-standard-indent files (e.g. 1-space indented Python with `;` or
 * minified single-line JSON/JS) so DocPrism can automatically expand them into standard 4-space
 * indented view on open without altering the disk file!
 */
function detectCompactUnindentedCode(content: string, lang: string): boolean {
  if (!content || content.length < 40) return false;
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  if (lang === 'python') {
    let oneSpaceLines = 0;
    let fourSpaceLines = 0;
    let semicolonCodeLines = 0;
    let nonEmptyCodeLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      nonEmptyCodeLines += 1;
      if (/^ [^ ]/.test(line)) oneSpaceLines += 1;
      if (/^    [^ ]/.test(line)) fourSpaceLines += 1;
      if (trimmed.includes(';') || /^(def |if |for |with |elif |else:).*:\s*\S/.test(trimmed)) {
        semicolonCodeLines += 1;
      }
    }
    if (oneSpaceLines >= 2 && fourSpaceLines === 0) return true;
    if (nonEmptyCodeLines >= 5 && semicolonCodeLines / nonEmptyCodeLines >= 0.3) return true;
    return false;
  }

  if (lang === 'json' || lang === 'javascript' || lang === 'typescript') {
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (content.length > 180 && nonEmpty.length <= 3) return true;
  }

  return false;
}

const indentGuideMark = Decoration.mark({ class: 'dp-indent-guide' });

function buildIndentDecorations(view: EditorView, step: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      let leadingSpaces = 0;
      while (leadingSpaces < text.length && text.charCodeAt(leadingSpaces) === 32) {
        leadingSpaces += 1;
      }
      if (leadingSpaces >= step && leadingSpaces < text.length) {
        for (let col = 0; col + step <= leadingSpaces; col += step) {
          builder.add(line.from + col, line.from + col + step, indentGuideMark);
        }
      }
      if (line.to >= doc.length) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function createIndentGuideExtension(step: number) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildIndentDecorations(view, step);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildIndentDecorations(update.view, step);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export const CodeEditorPane: React.FC<CodeEditorPaneProps> = ({
  tabId,
  filePath,
  initialLanguage = 'python',
  isScratchpad = false,
  initialContent = '',
  theme,
  fontSize,
  isActive,
  workspaceDir,
  jumpTarget,
  onHeadingsChange,
  onCursorStatusChange,
  runtimes,
  preferredPython,
  onChangePreferredPython,
  isRunning,
  onRunCode,
  onStopRun,
  onDirtyChange,
  onSavedAs,
  onSwitchToPreview,
}) => {
  const [code, setCode] = useState<string>(initialContent);
  const [savedCode, setSavedCode] = useState<string>(initialContent);
  const [rawCompactBackup, setRawCompactBackup] = useState<string | null>(null);
  const [formattedBackup, setFormattedBackup] = useState<string | null>(null);
  const [showingAutoFormatted, setShowingAutoFormatted] = useState<boolean>(false);
  const [hasManualEdit, setHasManualEdit] = useState<boolean>(false);

  const [language, setLanguage] = useState<string>(initialLanguage);
  const [indentSize, setIndentSize] = useState<number>(() =>
    detectIndentStep(initialContent, initialLanguage)
  );
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({
    line: 1,
    col: 1,
  });

  const [sizeBytes, setSizeBytes] = useState<number>(initialContent.length);
  const [loading, setLoading] = useState<boolean>(!isScratchpad);
  const [isFormatting, setIsFormatting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const editorViewRef = useRef<EditorView | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastAppliedJumpSeqRef = useRef<number>(-1);
  const intelliSenseCtxRef = useRef<IntelliSenseExternalContext>({
    siblingModules: [],
    runtimePythonModules: {},
  });
  const inspectedPyModulesRef = useRef<Set<string>>(new Set());

  const showToast = useCallback((msg: string) => {
    setStatusToast(msg);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setStatusToast(null), 2000);
  }, []);

  const pythonRuntimes = useMemo(
    () => runtimes.filter((r) => r.language === 'python'),
    [runtimes]
  );

  const activePythonExe = useMemo(() => {
    if (
      preferredPython &&
      pythonRuntimes.some((r) => r.executable === preferredPython)
    ) {
      return preferredPython;
    }
    return pythonRuntimes[0]?.executable || '';
  }, [preferredPython, pythonRuntimes]);

  // Only mark tab with amber dirty dot when user manually edited (not merely auto-beautified view)
  const isDirty = isScratchpad
    ? hasManualEdit && code.trim().length > 0
    : hasManualEdit && code !== savedCode;

  useEffect(() => {
    onDirtyChange?.(tabId, isDirty);
  }, [tabId, isDirty, onDirtyChange]);

  // Report live cursor/indent status to global StatusBar when active
  useEffect(() => {
    if (!isActive || !onCursorStatusChange) return;
    onCursorStatusChange({
      line: cursorPos.line,
      col: cursorPos.col,
      indentSize,
      wordWrap,
    });
  }, [isActive, cursorPos, indentSize, wordWrap, onCursorStatusChange]);

  // Emit Code & JSON Outline symbols to right-hand OutlineToc when active
  useEffect(() => {
    if (!isActive || !onHeadingsChange || loading) return;
    const timer = window.setTimeout(() => {
      onHeadingsChange(extractCodeSymbols(code, language));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [isActive, code, language, loading, onHeadingsChange]);

  // Scan sibling / workspace code modules (< 3ms) so local imports complete immediately
  useEffect(() => {
    let cancelled = false;
    scanSiblingCodeSymbols(isScratchpad ? null : filePath, workspaceDir ?? null)
      .then((modules) => {
        if (!cancelled) {
          intelliSenseCtxRef.current.siblingModules = modules;
        }
      })
      .catch(() => {
        // Ignore scan error in browser fallback
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, isScratchpad, workspaceDir, reloadTick]);

  // Background cached Python module introspection for imported 3rd-party / stdlib modules
  useEffect(() => {
    if (language !== 'python' || loading) return;
    const BUILTIN_CURATED = new Set([
      'numpy',
      'torch',
      'torch.nn',
      'torch.nn.functional',
      'torch.optim',
      'torch.fft',
      'matplotlib',
      'matplotlib.pyplot',
      'pandas',
      'os',
      'os.path',
      'pathlib',
      'json',
      'math',
      'sys',
      're',
      'time',
      'typing',
    ]);

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const imported = extractImportedPythonModules(code);
      const siblingSet = new Set(
        intelliSenseCtxRef.current.siblingModules.map((m) => m.moduleName)
      );
      const pending = imported
        .filter((mod) => {
          const cacheKey = `${activePythonExe}::${mod}`;
          return (
            !BUILTIN_CURATED.has(mod) &&
            !siblingSet.has(mod) &&
            !inspectedPyModulesRef.current.has(cacheKey)
          );
        })
        .slice(0, 6);

      if (pending.length === 0) return;

      void (async () => {
        for (const mod of pending) {
          if (cancelled) break;
          const cacheKey = `${activePythonExe}::${mod}`;
          inspectedPyModulesRef.current.add(cacheKey);
          try {
            const syms = await inspectPythonModule(
              mod,
              activePythonExe || null,
              isScratchpad ? null : filePath,
              workspaceDir ?? null
            );
            if (!cancelled && syms.length > 0) {
              intelliSenseCtxRef.current.runtimePythonModules[mod] = syms;
            }
          } catch {
            // Non-blocking background reflection
          }
        }
      })();
    }, 650);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [language, code, loading, activePythonExe, filePath, isScratchpad, workspaceDir]);

  // Load file from disk and auto-detect indentation / auto-expand compacted code
  useEffect(() => {
    if (isScratchpad) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRawCompactBackup(null);
    setFormattedBackup(null);
    setShowingAutoFormatted(false);
    setHasManualEdit(false);

    readMarkdownDocument(filePath)
      .then(async (doc) => {
        if (cancelled) return;
        const detectedLang =
          doc.language || inferLanguageFromPath(doc.path, initialLanguage);
        setLanguage(detectedLang);
        setSavedCode(doc.content);
        setSizeBytes(doc.sizeBytes);

        if (detectCompactUnindentedCode(doc.content, detectedLang)) {
          try {
            const targetStep = detectedLang === 'json' ? 2 : 4;
            const fmt = await formatCodeDocument(
              detectedLang,
              doc.content,
              targetStep,
              activePythonExe || null
            );
            if (!cancelled && fmt.changed) {
              setIndentSize(targetStep);
              setRawCompactBackup(doc.content);
              setFormattedBackup(fmt.formatted);
              setCode(fmt.formatted);
              setShowingAutoFormatted(true);
              setLoading(false);
              return;
            }
          } catch {
            // Fall through to raw content if formatting fails
          }
        }

        if (!cancelled) {
          setIndentSize(detectIndentStep(doc.content, detectedLang));
          setCode(doc.content);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isScratchpad, reloadTick, initialLanguage]);

  // Apply jump-to-line from OutlineToc or Workspace Full-Text Search
  useEffect(() => {
    if (!isActive || loading || !jumpTarget) return;
    if (lastAppliedJumpSeqRef.current === jumpTarget.seq) return;

    const timer = window.setTimeout(() => {
      const view = editorViewRef.current;
      if (!view) return;
      lastAppliedJumpSeqRef.current = jumpTarget.seq;
      const clampedLine = Math.max(1, Math.min(view.state.doc.lines, jumpTarget.line));
      const lineObj = view.state.doc.line(clampedLine);
      view.dispatch({
        selection: { anchor: lineObj.from, head: lineObj.to },
        effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
      });
      view.focus();
    }, 30);

    return () => window.clearTimeout(timer);
  }, [isActive, loading, jumpTarget]);

  const cursorTracker = useMemo(
    () =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const lineObj = update.state.doc.lineAt(head);
          const nextLine = lineObj.number;
          const nextCol = head - lineObj.from + 1;
          setCursorPos((prev) =>
            prev.line === nextLine && prev.col === nextCol
              ? prev
              : { line: nextLine, col: nextCol }
          );
        }
      }),
    []
  );

  const extensions = useMemo(() => {
    const exts = [
      EditorState.tabSize.of(indentSize),
      indentUnit.of(' '.repeat(indentSize)),
      createIndentGuideExtension(indentSize),
      search({ top: true }),
      cursorTracker,
      ...createIntelliSenseExtensions(language, () => intelliSenseCtxRef.current),
    ];

    if (wordWrap) {
      exts.push(EditorView.lineWrapping);
    }

    switch (language) {
      case 'python':
        exts.push(python());
        break;
      case 'javascript':
        exts.push(javascript({ jsx: true }));
        break;
      case 'typescript':
        exts.push(javascript({ jsx: true, typescript: true }));
        break;
      case 'rust':
        exts.push(rust());
        break;
      case 'json':
        exts.push(json());
        break;
      case 'markdown':
        exts.push(markdown());
        break;
      default:
        break;
    }
    return exts;
  }, [language, indentSize, wordWrap, cursorTracker]);

  const handleFormatCode = useCallback(async () => {
    if (isFormatting || !code.trim()) return;
    setIsFormatting(true);
    setError(null);
    try {
      const res = await formatCodeDocument(
        language,
        code,
        indentSize,
        activePythonExe || null
      );
      if (res.changed) {
        setCode(res.formatted);
        setHasManualEdit(true);
        showToast(`已规范为 ${indentSize} 空格缩进`);
      } else {
        showToast('缩进与排版已符合规范');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsFormatting(false);
    }
  }, [activePythonExe, code, indentSize, isFormatting, language, showToast]);

  const handleSave = useCallback(async () => {
    try {
      let targetPath = filePath;
      if (isScratchpad) {
        const ext =
          LANGUAGE_OPTIONS.find((o) => o.value === language)?.defaultExt || 'py';
        const picked = await pickSaveDocument(
          workspaceDir ?? null,
          `script.${ext}`
        );
        if (!picked) return;
        targetPath = picked;
      }

      const res = await saveTextDocument(targetPath, code);
      setSavedCode(code);
      setHasManualEdit(false);
      setRawCompactBackup(null);
      setFormattedBackup(null);
      setShowingAutoFormatted(false);
      setSizeBytes(res.sizeBytes);
      const nextLang = inferLanguageFromPath(res.path, language);
      setLanguage(nextLang);
      if (isScratchpad && onSavedAs) {
        onSavedAs(tabId, res, nextLang);
      }
      showToast('已保存');
    } catch (err) {
      setError(`保存失败：${String(err)}`);
    }
  }, [code, filePath, isScratchpad, language, onSavedAs, showToast, tabId, workspaceDir]);

  const canRun = RUNNABLE_SET.has(language);

  const handleTriggerRun = useCallback(() => {
    if (!canRun) return;
    onRunCode({
      language,
      code,
      filePath: isScratchpad ? null : filePath,
      isSavedFile: !isScratchpad && code === savedCode,
    });
  }, [canRun, code, filePath, isScratchpad, language, onRunCode, savedCode]);

  // Keyboard shortcuts when active:
  // Ctrl+S: Save | Shift+Alt+F: Format | Alt+Z: Toggle Word Wrap | F5 / Ctrl+Enter: Run
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void handleFormatCode();
      } else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setWordWrap((w) => !w);
      } else if (
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && e.key === 'Enter')
      ) {
        if (canRun) {
          e.preventDefault();
          handleTriggerRun();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, canRun, handleFormatCode, handleSave, handleTriggerRun]);

  // Breadcrumb segments relative to workspaceDir
  const breadcrumbs = useMemo(() => {
    if (isScratchpad) return ['临时代码台'];
    if (
      workspaceDir &&
      filePath.toLowerCase().startsWith(workspaceDir.toLowerCase())
    ) {
      const wsName = workspaceDir.split('\\').pop() || workspaceDir;
      const rel = filePath.slice(workspaceDir.length).replace(/^\\+/, '');
      return [wsName, ...rel.split('\\').filter(Boolean)];
    }
    const parts = filePath.split('\\').filter(Boolean);
    return parts.length > 3 ? ['...', ...parts.slice(-3)] : parts;
  }, [filePath, isScratchpad, workspaceDir]);

  if (loading) {
    return (
      <div className="p-8 text-xs" style={{ color: 'var(--dp-text-muted)' }}>
        正在加载并解析代码格式...
      </div>
    );
  }

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--dp-surface)' }}
    >
      {/* Editor Top Toolbar with Breadcrumbs & Studio Actions */}
      <div
        className="px-3 py-1.5 border-b flex flex-wrap items-center justify-between gap-2 text-xs shrink-0"
        style={{
          backgroundColor: 'var(--dp-sidebar)',
          borderColor: 'var(--dp-border)',
        }}
      >
        {/* Left: Breadcrumbs, File Size, Dirty & Toast Badges */}
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className="flex items-center gap-0.5 min-w-0 truncate"
            title={isScratchpad ? '尚未保存到磁盘的临时代码草稿' : filePath}
          >
            {breadcrumbs.map((seg, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <React.Fragment key={`${seg}-${idx}`}>
                  {idx > 0 && (
                    <ChevronRight
                      className="w-3 h-3 shrink-0 opacity-50"
                      style={{ color: 'var(--dp-text-muted)' }}
                    />
                  )}
                  <span
                    className={isLast ? 'font-semibold truncate' : 'truncate hidden sm:inline'}
                    style={{
                      color: isLast ? 'var(--dp-text)' : 'var(--dp-text-muted)',
                    }}
                  >
                    {seg}
                  </span>
                </React.Fragment>
              );
            })}
          </div>

          {!isScratchpad && (
            <>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(filePath);
                  showToast('路径已复制');
                }}
                title="复制文件完整路径"
                className="p-0.5 rounded opacity-55 hover:opacity-100 transition shrink-0"
              >
                <Copy className="w-3 h-3" />
              </button>
              <span
                className="shrink-0 hidden md:inline"
                style={{ color: 'var(--dp-text-muted)' }}
              >
                · {formatFileSize(sizeBytes)}
              </span>
            </>
          )}

          {isDirty && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold text-[11px] shrink-0">
              ● 未保存
            </span>
          )}
          {statusToast && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold text-[11px] shrink-0">
              <Check className="w-3 h-3" />
              {statusToast}
            </span>
          )}
        </div>

        {/* Right Controls: Edit Tools, Language, Python Env, Indent, Format, Save, Run */}
        <div className="flex items-center gap-1 flex-wrap">
          {/* Undo / Redo / Search */}
          <div
            className="flex items-center rounded-md border p-0.5"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (editorViewRef.current) undo(editorViewRef.current);
              }}
              title="撤销 (Ctrl+Z)"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition"
              style={{ color: 'var(--dp-text-secondary)' }}
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (editorViewRef.current) redo(editorViewRef.current);
              }}
              title="重做 (Ctrl+Y)"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition"
              style={{ color: 'var(--dp-text-secondary)' }}
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (editorViewRef.current) {
                  openSearchPanel(editorViewRef.current);
                }
              }}
              title="页内查找与替换 (Ctrl+F)"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition"
              style={{ color: 'var(--dp-text-secondary)' }}
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            {language !== 'text' && (
              <button
                type="button"
                onClick={() => {
                  if (editorViewRef.current) {
                    editorViewRef.current.focus();
                    startCompletion(editorViewRef.current);
                  }
                }}
                title="智能代码提示与补全（输入自动提示 · Tab/Enter 采纳 · Alt+/ 或 Ctrl+Space 手动唤起）"
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition text-amber-600 dark:text-amber-400"
              >
                <Lightbulb className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="切换语法高亮与格式化语言"
            className="px-2 py-1 rounded-md border text-xs outline-none cursor-pointer"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
              color: 'var(--dp-text)',
            }}
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {language === 'python' && pythonRuntimes.length > 0 && (
            <div
              className="hidden xl:flex items-center gap-1 px-2 py-0.5 rounded-md border"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
              }}
              title="选择执行与格式化 Python 代码的本地环境"
            >
              <Cpu className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <select
                value={activePythonExe}
                onChange={(e) => onChangePreferredPython(e.target.value)}
                className="bg-transparent text-xs outline-none max-w-[165px] truncate cursor-pointer py-0.5"
                style={{ color: 'var(--dp-text)' }}
              >
                {pythonRuntimes.map((rt) => (
                  <option key={rt.id} value={rt.executable}>
                    {rt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Indent Step Pill (2 spaces / 4 spaces) */}
          <button
            type="button"
            onClick={() => setIndentSize((s) => (s === 4 ? 2 : 4))}
            title="点击切换缩进参考线与格式化步长 (2 空格 / 4 空格)"
            className="px-2 py-1 rounded-md border text-[11px] font-mono transition hover:opacity-85"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
              color: 'var(--dp-text-secondary)',
            }}
          >
            {indentSize}空格
          </button>

          {/* One-Click Format Code Button */}
          <button
            type="button"
            disabled={isFormatting}
            onClick={() => void handleFormatCode()}
            title="一键规范缩进与代码格式化 (快捷键: Shift+Alt+F)"
            className="flex items-center gap-1 px-2 py-1 rounded-md border font-semibold transition hover:opacity-90 text-indigo-600 dark:text-indigo-300 border-indigo-500/40 bg-indigo-500/10"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isFormatting ? '排版中' : '格式化'}</span>
          </button>

          {/* Word Wrap Toggle */}
          <button
            type="button"
            onClick={() => setWordWrap((w) => !w)}
            title="切换长代码行自动换行 (快捷键: Alt+Z)"
            className="p-1 rounded-md border transition hover:opacity-85"
            style={{
              backgroundColor: wordWrap ? 'var(--dp-accent-soft)' : 'var(--dp-surface)',
              borderColor: wordWrap ? 'var(--dp-accent)' : 'var(--dp-border-strong)',
              color: wordWrap ? 'var(--dp-accent)' : 'var(--dp-text-secondary)',
            }}
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>

          {onSwitchToPreview && (
            <button
              type="button"
              onClick={onSwitchToPreview}
              title="返回渲染后的 Markdown 阅读视图"
              className="flex items-center gap-1 px-2 py-1 rounded-md border font-semibold transition hover:opacity-85"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-accent)',
              }}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>阅读预览</span>
            </button>
          )}

          {!isScratchpad && (
            <button
              type="button"
              onClick={() => setReloadTick((t) => t + 1)}
              title="从磁盘重新读取内容"
              className="p-1 rounded-md border transition hover:opacity-80"
              style={{
                backgroundColor: 'var(--dp-surface)',
                borderColor: 'var(--dp-border-strong)',
                color: 'var(--dp-text-secondary)',
              }}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleSave()}
            title="保存文件到磁盘 (Ctrl+S)"
            className="flex items-center gap-1 px-2 py-1 rounded-md border font-semibold transition hover:opacity-85"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
              color: 'var(--dp-text)',
            }}
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isScratchpad ? '另存为' : '保存'}</span>
          </button>

          {canRun &&
            (isRunning ? (
              <button
                type="button"
                onClick={onStopRun}
                title="强制终止当前运行进程树"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md font-bold text-white bg-rose-600 hover:bg-rose-700 shadow-sm transition"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleTriggerRun}
                title="立即运行代码 (F5 或 Ctrl+Enter)"
                className="flex items-center gap-1 px-2.5 py-1 rounded-md font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>运行 (F5)</span>
              </button>
            ))}
        </div>
      </div>

      {/* Auto-Formatted Compact Code Notice Banner */}
      {rawCompactBackup && !hasManualEdit && (
        <div
          className="px-3 py-1 border-b text-[11.5px] flex items-center justify-between gap-2 shrink-0"
          style={{
            backgroundColor: 'var(--dp-accent-soft)',
            borderColor: 'var(--dp-border)',
            color: 'var(--dp-text-secondary)',
          }}
        >
          <span>
            {showingAutoFormatted
              ? `✨ 原文件使用紧凑/单行语法，已自动展开为标准 ${indentSize} 空格缩进视图（未改动原磁盘文件，按 Ctrl+S 可保存）`
              : '📄 当前正在查看磁盘原始紧凑格式'}
          </span>
          <button
            type="button"
            onClick={() => {
              if (showingAutoFormatted) {
                setCode(rawCompactBackup);
                setShowingAutoFormatted(false);
              } else if (formattedBackup) {
                setCode(formattedBackup);
                setShowingAutoFormatted(true);
              }
            }}
            className="px-2 py-0.5 rounded border text-[11px] font-semibold shrink-0 hover:opacity-85"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
              color: 'var(--dp-accent)',
            }}
          >
            {showingAutoFormatted ? '查看原紧凑源码' : '恢复标准缩进视图'}
          </button>
        </div>
      )}

      {error && (
        <div className="px-4 py-1.5 bg-rose-500/10 border-b border-rose-500/30 text-rose-600 text-xs flex items-center justify-between shrink-0">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="underline ml-2"
          >
            关闭
          </button>
        </div>
      )}

      {/* CodeMirror 6 Editor Surface */}
      <div
        className="dp-cm-host flex-1 min-h-0 overflow-hidden"
        style={{ fontSize: `${Math.max(9, fontSize - 1)}px` }}
      >
        <CodeMirror
          value={code}
          height="100%"
          className="h-full"
          placeholder={getEditorPlaceholder(language)}
          indentWithTab={true}
          theme={theme === 'dark' ? oneDark : 'light'}
          extensions={extensions}
          onCreateEditor={(view) => {
            editorViewRef.current = view;
          }}
          onChange={(val) => {
            setCode(val);
            setHasManualEdit(true);
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightActiveLine: true,
            foldGutter: true,
            searchKeymap: true,
            autocompletion: false,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
            tabSize: indentSize,
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditorPane;
