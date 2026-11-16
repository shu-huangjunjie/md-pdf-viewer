export type ThemeMode = 'light' | 'sepia' | 'dark';
export type ContentWidth = 'narrow' | 'comfortable' | 'wide';
export type DocKind = 'folder' | 'markdown' | 'pdf' | 'html' | 'code';

export interface SavedWorkspaceSession {
  id: string;
  name?: string | null;
  rootPaths: string[];
}

export interface UserPreferences {
  theme: ThemeMode;
  fontSize: number;
  contentWidth: ContentWidth;
  lastWorkspace: string | null;
  recentWorkspaces: string[];
  recentFiles: string[];
  bookmarks: string[];
  preferredPython?: string | null;
  savedWorkspaces?: SavedWorkspaceSession[];
  activeWorkspaceId?: string | null;
}

export interface RuntimeProfile {
  id: string;
  language: string; // "python" | "javascript" | "powershell" | "batch" | "rust"
  label: string;
  executable: string;
}

export interface BootstrapPayload {
  assetBaseUrl: string;
  isPortable: boolean;
  preferences: UserPreferences;
  cliFiles: string[];
  runtimes: RuntimeProfile[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  slashPath: string;
  kind: DocKind;
  language?: string | null;
  sizeBytes: number;
  children: FileTreeNode[];
}

export interface MarkdownDocument {
  name: string;
  path: string;
  slashPath: string;
  parentSlashPath: string;
  language: string;
  content: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface FileDescriptor {
  name: string;
  path: string;
  slashPath: string;
  kind: DocKind;
  language?: string | null;
  sizeBytes: number;
  modifiedMs: number;
}

export interface SaveResult {
  path: string;
  slashPath: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface FormatCodeResult {
  formatted: string;
  changed: boolean;
  engine: string;
}

export interface OpenTab {
  id: string;
  name: string;
  path: string;
  slashPath: string;
  kind: Exclude<DocKind, 'folder'>;
  language?: string;
  sizeBytes?: number;
  isScratchpad?: boolean;
  initialContent?: string;
  defaultSaveDir?: string;
  isDirty?: boolean;
}

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
  line?: number;
  symbolKind?: 'heading' | 'class' | 'function' | 'property';
}

export interface WorkspaceSearchHit {
  path: string;
  slashPath: string;
  name: string;
  kind: Exclude<DocKind, 'folder'>;
  language: string;
  line: number;
  preview: string;
}

export interface RunCodeRequest {
  runId: string;
  language: string;
  code: string;
  filePath?: string | null;
  workingDir?: string | null;
  customExecutable?: string | null;
  isSavedFile: boolean;
}

export interface RunOutputEvent {
  runId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface RunDoneEvent {
  runId: string;
  exitCode: number | null;
  durationMs: number;
  killed: boolean;
}

export interface ConsoleChunk {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface CompletionSymbolItem {
  label: string;
  kind: 'function' | 'class' | 'variable' | 'module' | 'property' | 'constant' | string;
  detail?: string | null;
  doc?: string | null;
}

export interface ExternalModuleSymbols {
  moduleName: string;
  filePath: string;
  symbols: CompletionSymbolItem[];
}

export type PdfAnnotationType = 'highlight' | 'underline' | 'rect' | 'pin';
export type PdfAnnotationColor = 'amber' | 'emerald' | 'sky' | 'rose' | 'violet';

export interface PdfNormalizedRect {
  x: number; // 0..1 relative to unrotated/viewport page width
  y: number; // 0..1 relative to unrotated/viewport page height
  w: number; // 0..1
  h: number; // 0..1
}

export interface PdfAnnotationReply {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
}

export interface PdfAnnotation {
  id: string;
  pageNumber: number; // 1-indexed
  type: PdfAnnotationType;
  color: PdfAnnotationColor;
  rects: PdfNormalizedRect[];
  selectedText?: string;
  imageDataUrl?: string; // cropped figure/formula snapshot for rect annotations
  comment: string;
  author: string;
  resolved?: boolean;
  replies: PdfAnnotationReply[];
  createdAt: number;
  updatedAt: number;
}

export interface PdfAnnotationDocument {
  version: 1;
  filePath: string;
  defaultAuthor?: string;
  annotations: PdfAnnotation[];
}

export type PrismBridgeAction =
  | {
      action: 'open-workspace';
      path: string;
      mode: 'new-workspace' | 'parallel-root' | string;
    }
  | {
      action: 'open-file';
      path: string;
      line?: number | null;
      projectPath?: string | null;
    }
  | {
      action: 'open-code-snippet';
      language: string;
      code: string;
      title: string;
      projectPath?: string | null;
      autoRun?: boolean;
    }
  | {
      action: 'open-markdown-note';
      title: string;
      markdown: string;
      projectPath?: string | null;
    };

export interface AiSessionSummary {
  id: string;
  title: string;
  projectPath?: string | null;
  sourceKind: string;
  messageCount: number;
  updatedAt: string;
  pinnedAt?: string | null;
}

export interface AiSessionsQueryResult {
  available: boolean;
  vaultRunning: boolean;
  totalMatched: number;
  sessions: AiSessionSummary[];
}

export interface AiSessionMarkdownPayload {
  id: string;
  title: string;
  projectPath?: string | null;
  sourceKind: string;
  markdown: string;
}
