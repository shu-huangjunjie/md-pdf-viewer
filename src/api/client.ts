import { invoke } from '@tauri-apps/api/core';
import type {
  AiSessionMarkdownPayload,
  AiSessionsQueryResult,
  BootstrapPayload,
  CompletionSymbolItem,
  ExternalModuleSymbols,
  FileDescriptor,
  FileTreeNode,
  FormatCodeResult,
  MarkdownDocument,
  PdfAnnotationDocument,
  PrismBridgeAction,
  RunCodeRequest,
  RuntimeProfile,
  SaveResult,
  UserPreferences,
  WorkspaceSearchHit,
} from '@/types';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const DEFAULT_PREFS: UserPreferences = {
  theme: 'light',
  fontSize: 16,
  contentWidth: 'comfortable',
  lastWorkspace: null,
  recentWorkspaces: [],
  recentFiles: [],
  bookmarks: [],
  preferredPython: null,
};

const DEMO_MD = `# 欢迎使用 棱镜工坊 PrismStudio 代码与科研文档工作台

> [!TIP]
> 现已支持直接打开并运行 **Python / JS / TS / PowerShell / Rust** 代码文件，文档内的代码块也可一键运行！

\`\`\`python
import math
for k in range(1, 5):
    print(f"第 {k} 阶傅里叶正弦波 sin({k}πx) 在 x=0.25 处的值 = {math.sin(k * math.pi * 0.25):.4f}")
\`\`\`
`;

export async function getBootstrap(): Promise<BootstrapPayload> {
  if (!isTauriRuntime()) {
    return {
      assetBaseUrl: '',
      isPortable: false,
      preferences: DEFAULT_PREFS,
      cliFiles: [],
      runtimes: [],
    };
  }
  return invoke<BootstrapPayload>('get_bootstrap');
}

export async function listRuntimes(workspaceDir?: string | null): Promise<RuntimeProfile[]> {
  if (!isTauriRuntime()) return [];
  return invoke<RuntimeProfile[]>('list_runtimes', {
    workspaceDir: workspaceDir ?? null,
  });
}

export async function startCodeRun(request: RunCodeRequest): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>('start_code_run', { request });
}

export async function stopCodeRun(runId: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>('stop_code_run', { runId });
}

export async function formatCodeDocument(
  language: string,
  code: string,
  indentSize = 4,
  customPython?: string | null
): Promise<FormatCodeResult> {
  if (!isTauriRuntime()) {
    return { formatted: code, changed: false, engine: 'Browser Fallback' };
  }
  return invoke<FormatCodeResult>('format_code_document', {
    language,
    code,
    indentSize,
    customPython: customPython ?? null,
  });
}

export async function pickWorkspaceFolder(initialDir?: string | null): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return invoke<string | null>('pick_workspace_folder', {
    initialDir: initialDir ?? null,
  });
}

export async function pickDocumentFile(
  initialDir?: string | null
): Promise<FileDescriptor | null> {
  if (!isTauriRuntime()) return null;
  return invoke<FileDescriptor | null>('pick_document_file', {
    initialDir: initialDir ?? null,
  });
}

export async function pickSaveDocument(
  initialDir?: string | null,
  defaultName?: string
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return invoke<string | null>('pick_save_document', {
    initialDir: initialDir ?? null,
    defaultName: defaultName ?? 'untitled.py',
  });
}

export async function inspectPath(path: string): Promise<FileDescriptor | null> {
  if (!isTauriRuntime()) return null;
  return invoke<FileDescriptor | null>('inspect_path', { path });
}

export async function scanWorkspace(folderPath: string): Promise<FileTreeNode> {
  if (!isTauriRuntime()) {
    return {
      name: '示例工作区',
      path: 'demo',
      slashPath: 'demo',
      kind: 'folder',
      sizeBytes: 0,
      children: [
        {
          name: '欢迎使用说明.md',
          path: 'demo/welcome.md',
          slashPath: 'demo/welcome.md',
          kind: 'markdown',
          language: 'markdown',
          sizeBytes: DEMO_MD.length,
          children: [],
        },
      ],
    };
  }
  return invoke<FileTreeNode>('scan_workspace', { folderPath });
}

export async function readMarkdownDocument(filePath: string): Promise<MarkdownDocument> {
  if (!isTauriRuntime()) {
    return {
      name: '欢迎使用说明.md',
      path: filePath,
      slashPath: filePath,
      parentSlashPath: 'demo',
      language: 'markdown',
      content: DEMO_MD,
      sizeBytes: DEMO_MD.length,
      modifiedMs: Date.now(),
    };
  }
  return invoke<MarkdownDocument>('read_markdown_document', { filePath });
}

export async function saveTextDocument(
  filePath: string,
  content: string
): Promise<SaveResult> {
  return invoke<SaveResult>('save_text_document', { filePath, content });
}

export async function savePreferences(preferences: UserPreferences): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>('save_preferences', { preferences });
}

export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>('reveal_in_explorer', { path });
}

export async function createWorkspaceItem(
  parentDir: string,
  name: string,
  isDir: boolean
): Promise<FileDescriptor> {
  return invoke<FileDescriptor>('create_workspace_item', {
    parentDir,
    name,
    isDir,
  });
}

export async function renameWorkspaceItem(
  oldPath: string,
  newName: string
): Promise<FileDescriptor> {
  return invoke<FileDescriptor>('rename_workspace_item', {
    oldPath,
    newName,
  });
}

export async function deleteWorkspaceItem(path: string): Promise<void> {
  return invoke<void>('delete_workspace_item', { path });
}

export async function searchInWorkspace(
  folderPath: string,
  query: string,
  caseSensitive = false
): Promise<WorkspaceSearchHit[]> {
  if (!isTauriRuntime() || !query.trim()) return [];
  return invoke<WorkspaceSearchHit[]>('search_in_workspace', {
    folderPath,
    query,
    caseSensitive,
  });
}

export async function scanSiblingCodeSymbols(
  filePath?: string | null,
  workspaceDir?: string | null
): Promise<ExternalModuleSymbols[]> {
  if (!isTauriRuntime()) return [];
  return invoke<ExternalModuleSymbols[]>('scan_sibling_code_symbols', {
    filePath: filePath ?? null,
    workspaceDir: workspaceDir ?? null,
  });
}

export async function inspectPythonModule(
  moduleName: string,
  customPython?: string | null,
  filePath?: string | null,
  workspaceDir?: string | null
): Promise<CompletionSymbolItem[]> {
  if (!isTauriRuntime() || !moduleName.trim()) return [];
  return invoke<CompletionSymbolItem[]>('inspect_python_module', {
    moduleName,
    customPython: customPython ?? null,
    filePath: filePath ?? null,
    workspaceDir: workspaceDir ?? null,
  });
}

export async function loadPdfAnnotations(
  filePath: string
): Promise<PdfAnnotationDocument | null> {
  try {
    if (!isTauriRuntime()) {
      const raw = window.localStorage.getItem(`ps_pdf_ann_${filePath}`);
      return raw ? (JSON.parse(raw) as PdfAnnotationDocument) : null;
    }
    const raw = await invoke<string | null>('load_pdf_annotations', { filePath });
    if (!raw) return null;
    return JSON.parse(raw) as PdfAnnotationDocument;
  } catch (err) {
    console.warn('Failed to load PDF annotations:', err);
    return null;
  }
}

export async function savePdfAnnotations(
  filePath: string,
  doc: PdfAnnotationDocument
): Promise<void> {
  const jsonData = JSON.stringify(doc, null, 2);
  if (!isTauriRuntime()) {
    window.localStorage.setItem(`ps_pdf_ann_${filePath}`, jsonData);
    return;
  }
  await invoke<void>('save_pdf_annotations', { filePath, jsonData });
}

export async function drainPrismBridgeActions(): Promise<PrismBridgeAction[]> {
  if (!isTauriRuntime()) return [];
  return invoke<PrismBridgeAction[]>('drain_prism_bridge_actions');
}

export async function queryAiSessions(params: {
  rootPaths: string[];
  query?: string;
  limit?: number;
  includeAllProjects?: boolean;
}): Promise<AiSessionsQueryResult> {
  if (!isTauriRuntime()) {
    return {
      available: true,
      vaultRunning: false,
      totalMatched: 0,
      sessions: [],
    };
  }
  return invoke<AiSessionsQueryResult>('query_ai_sessions', {
    rootPaths: params.rootPaths,
    query: params.query ?? '',
    limit: params.limit ?? 60,
    includeAllProjects: params.includeAllProjects ?? false,
  });
}

export async function getAiSessionMarkdown(
  conversationId: string
): Promise<AiSessionMarkdownPayload> {
  return invoke<AiSessionMarkdownPayload>('get_ai_session_markdown', {
    conversationId,
  });
}

export async function openInContextVault(
  conversationId?: string | null,
  projectPath?: string | null
): Promise<string> {
  if (!isTauriRuntime()) return 'mock';
  return invoke<string>('open_in_context_vault', {
    conversationId: conversationId ?? null,
    projectPath: projectPath ?? null,
  });
}
