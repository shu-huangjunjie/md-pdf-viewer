import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Columns2,
  ExternalLink,
  Folder,
  Loader2,
  MessageSquare,
  Pin,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  getAiSessionMarkdown,
  openInContextVault,
  queryAiSessions,
} from '@/api/client';
import type { AiSessionMarkdownPayload, AiSessionSummary } from '@/types';
import { getPathBasename } from '@/utils/workspaceUtils';

interface AiSessionsPanelProps {
  rootPaths: string[];
  onOpenSessionNote: (payload: AiSessionMarkdownPayload, inSplitPane?: boolean) => void;
}

function formatShortTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(
    dt.getMinutes()
  )}`;
}

function sourceBadgeMeta(sourceKind: string): {
  label: string;
  className: string;
} {
  if (sourceKind === 'antigravity') {
    return {
      label: 'Antigravity',
      className:
        'bg-purple-500/12 text-purple-600 dark:text-purple-400 border-purple-500/25',
    };
  }
  if (sourceKind === 'claude') {
    return {
      label: 'Claude',
      className:
        'bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25',
    };
  }
  return {
    label: 'Codex',
    className:
      'bg-blue-500/12 text-blue-600 dark:text-sky-400 border-blue-500/25',
  };
}

export const AiSessionsPanel: React.FC<AiSessionsPanelProps> = ({
  rootPaths,
  onOpenSessionNote,
}) => {
  const [scopeAll, setScopeAll] = useState<boolean>(() => rootPaths.length === 0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [vaultRunning, setVaultRunning] = useState(false);
  const [totalMatched, setTotalMatched] = useState(0);
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);

  const rootKey = useMemo(() => rootPaths.join('\n'), [rootPaths]);

  useEffect(() => {
    if (rootPaths.length > 0 && scopeAll && !query.trim()) {
      setScopeAll(false);
    } else if (rootPaths.length === 0 && !scopeAll) {
      setScopeAll(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey]);

  const fetchSessions = useCallback(
    async (searchText: string, includeAll: boolean) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await queryAiSessions({
          rootPaths,
          query: searchText,
          limit: 80,
          includeAllProjects: includeAll || rootPaths.length === 0,
        });
        if (seq !== reqSeqRef.current) return;
        setAvailable(res.available);
        setVaultRunning(res.vaultRunning);
        setTotalMatched(res.totalMatched);
        setSessions(res.sessions);
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        setError(String(err));
      } finally {
        if (seq === reqSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [rootPaths]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchSessions(query, scopeAll);
    }, query.trim() ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [fetchSessions, query, scopeAll]);

  const handleOpenNote = async (sessionId: string, inSplit: boolean) => {
    if (loadingId) return;
    setLoadingId(sessionId);
    setError(null);
    try {
      const payload = await getAiSessionMarkdown(sessionId);
      onOpenSessionNote(payload, inSplit);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingId(null);
    }
  };

  const handleJumpVault = async (sessionId?: string | null, projPath?: string | null) => {
    setError(null);
    try {
      await openInContextVault(sessionId ?? null, projPath ?? rootPaths[0] ?? null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top Controls */}
      <div
        className="p-2.5 border-b space-y-2 shrink-0"
        style={{ borderColor: 'var(--dp-border)' }}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="inline-flex items-center p-0.5 rounded-md bg-black/5 dark:bg-white/5 text-[11px] font-medium">
            <button
              type="button"
              disabled={rootPaths.length === 0}
              onClick={() => setScopeAll(false)}
              className={`px-2 py-0.5 rounded transition ${
                !scopeAll && rootPaths.length > 0
                  ? 'bg-white dark:bg-slate-800 shadow-sm font-semibold'
                  : 'opacity-70 hover:opacity-100 disabled:opacity-35'
              }`}
              style={{
                color:
                  !scopeAll && rootPaths.length > 0
                    ? 'var(--dp-accent)'
                    : 'var(--dp-text-secondary)',
              }}
            >
              当前空间{rootPaths.length > 1 ? ` (${rootPaths.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setScopeAll(true)}
              className={`px-2 py-0.5 rounded transition ${
                scopeAll || rootPaths.length === 0
                  ? 'bg-white dark:bg-slate-800 shadow-sm font-semibold'
                  : 'opacity-70 hover:opacity-100'
              }`}
              style={{
                color:
                  scopeAll || rootPaths.length === 0
                    ? 'var(--dp-accent)'
                    : 'var(--dp-text-secondary)',
              }}
            >
              全库会话
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void fetchSessions(query, scopeAll)}
              title="刷新 Context Vault 会话列表"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 opacity-75 ${loading ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => void handleJumpVault(null, rootPaths[0] ?? null)}
              title={
                vaultRunning
                  ? '切换到已运行的 Context Vault 窗口'
                  : '启动 Context Vault 会话管理器'
              }
              className="px-2 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 border transition hover:opacity-90"
              style={{
                borderColor: 'var(--dp-border)',
                backgroundColor: 'var(--dp-surface)',
                color: 'var(--dp-accent)',
              }}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  vaultRunning ? 'bg-emerald-500' : 'bg-slate-400'
                }`}
              />
              <span>Vault</span>
              <ExternalLink className="w-3 h-3 opacity-80" />
            </button>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 opacity-45 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 AI 会话标题或内容 (FTS5)..."
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border)',
              color: 'var(--dp-text)',
            }}
            className="w-full pl-7 pr-6 py-1.5 text-xs rounded-md border outline-none focus:ring-1"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 opacity-60 hover:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div
          className="flex items-center justify-between text-[11px]"
          style={{ color: 'var(--dp-text-muted)' }}
        >
          <span>
            {scopeAll || rootPaths.length === 0
              ? `全库共匹配 ${totalMatched} 条会话`
              : `当前工程关联 ${totalMatched} 条会话`}
          </span>
          <span>点击精排 · 右侧可双栏对照</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {error && (
          <div className="p-2.5 rounded-lg text-xs bg-rose-500/10 border border-rose-500/25 text-rose-600 dark:text-rose-300 leading-relaxed">
            {error}
          </div>
        )}

        {!available ? (
          <div
            className="py-10 px-4 text-center space-y-2 text-xs"
            style={{ color: 'var(--dp-text-secondary)' }}
          >
            <Bot className="w-8 h-8 mx-auto opacity-40" />
            <p className="font-semibold">尚未检测到 Context Vault</p>
            <p className="text-[11px] opacity-75 leading-relaxed">
              请先构建或运行一次 ai-session-tools (Context-Vault.exe)，即可在此自动联动 Codex / Antigravity / Claude 历史会话。
            </p>
          </div>
        ) : loading && sessions.length === 0 ? (
          <div
            className="py-12 flex items-center justify-center gap-2 text-xs"
            style={{ color: 'var(--dp-text-secondary)' }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>正在读取 AI 会话库...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div
            className="py-10 px-4 text-center space-y-2.5 text-xs"
            style={{ color: 'var(--dp-text-secondary)' }}
          >
            <MessageSquare className="w-7 h-7 mx-auto opacity-35" />
            <p>
              {!scopeAll && rootPaths.length > 0
                ? '当前工作空间下暂无关联的 AI 会话'
                : '没有找到匹配的 AI 会话'}
            </p>
            {!scopeAll && rootPaths.length > 0 && (
              <button
                type="button"
                onClick={() => setScopeAll(true)}
                className="px-3 py-1 rounded-md text-[11px] font-semibold border transition hover:opacity-90"
                style={{
                  borderColor: 'var(--dp-border)',
                  backgroundColor: 'var(--dp-surface)',
                  color: 'var(--dp-accent)',
                }}
              >
                查看全库全部会话
              </button>
            )}
          </div>
        ) : (
          sessions.map((item) => {
            const badge = sourceBadgeMeta(item.sourceKind);
            const isOpening = loadingId === item.id;
            return (
              <div
                key={item.id}
                onClick={() => void handleOpenNote(item.id, false)}
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border)',
                }}
                className="group p-2.5 rounded-lg border cursor-pointer transition hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span
                        className={`px-1.5 py-0.2 rounded text-[10px] font-semibold border inline-flex items-center gap-1 ${badge.className}`}
                      >
                        {item.sourceKind === 'antigravity' && (
                          <Sparkles className="w-2.5 h-2.5" />
                        )}
                        {badge.label}
                      </span>
                      {item.pinnedAt && (
                        <Pin className="w-3 h-3 text-blue-500 shrink-0" />
                      )}
                      {item.projectPath && (scopeAll || rootPaths.length > 1) && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/5 truncate max-w-[130px]"
                          title={item.projectPath}
                          style={{ color: 'var(--dp-text-secondary)' }}
                        >
                          <Folder className="w-2.5 h-2.5 shrink-0 opacity-70" />
                          <span className="truncate">
                            {getPathBasename(item.projectPath)}
                          </span>
                        </span>
                      )}
                    </div>

                    <div
                      className="text-xs font-semibold leading-snug line-clamp-2"
                      title={item.title}
                      style={{ color: 'var(--dp-text)' }}
                    >
                      {item.title}
                    </div>
                  </div>

                  {isOpening && (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin shrink-0 mt-0.5"
                      style={{ color: 'var(--dp-accent)' }}
                    />
                  )}
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: 'var(--dp-text-muted)' }}
                  >
                    {item.messageCount} 条 · {formatShortTime(item.updatedAt)}
                  </span>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleOpenNote(item.id, true);
                      }}
                      title="在右侧双栏对照打开此会话精排笔记"
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold flex items-center gap-0.5 bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/20"
                    >
                      <Columns2 className="w-3 h-3" />
                      <span>双栏</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleJumpVault(item.id, item.projectPath);
                      }}
                      title="在 Context Vault 中定位并管理此会话"
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold flex items-center gap-0.5 bg-sky-500/12 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Vault</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
