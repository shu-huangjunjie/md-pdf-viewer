import React, { useEffect, useState } from 'react';
import { Columns2, Copy, ExternalLink, FolderSearch, X } from 'lucide-react';
import { revealInExplorer } from '@/api/client';
import { FileBadge } from '@/components/FileBadge';
import type { OpenTab } from '@/types';

interface TabStripProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  isFocusedPane: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOthers?: (id: string) => void;
  onCloseAll?: () => void;
  onOpenInSplit?: (tab: OpenTab) => void;
}

interface TabMenuState {
  x: number;
  y: number;
  tab: OpenTab;
}

export const TabStrip: React.FC<TabStripProps> = ({
  tabs,
  activeTabId,
  isFocusedPane,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onOpenInSplit,
}) => {
  const [ctxMenu, setCtxMenu] = useState<TabMenuState | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  if (tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      className="h-9 flex items-center justify-between border-b px-1.5 gap-2 shrink-0 select-none relative"
      style={{
        backgroundColor: 'var(--dp-sidebar)',
        borderColor: isFocusedPane ? 'var(--dp-accent)' : 'var(--dp-border)',
      }}
    >
      <div className="flex items-center gap-1 overflow-x-auto h-full pt-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({
                  x: Math.min(e.clientX, window.innerWidth - 190),
                  y: Math.min(e.clientY, window.innerHeight - 220),
                  tab,
                });
              }}
              title={
                tab.isScratchpad
                  ? `${tab.name}（尚未保存到磁盘的临时代码页，右键查看更多操作）`
                  : `${tab.path}\n（中键点击关闭，右键菜单更多操作）`
              }
              className="group flex items-center gap-1.5 px-2.5 h-full rounded-t-md text-xs cursor-pointer max-w-[230px] transition shrink-0 border-x border-t"
              style={{
                backgroundColor: isActive ? 'var(--dp-surface)' : 'transparent',
                borderColor: isActive ? 'var(--dp-border-strong)' : 'transparent',
                boxShadow: isActive ? 'inset 0 2px 0 var(--dp-accent)' : 'none',
                color: isActive ? 'var(--dp-text)' : 'var(--dp-text-secondary)',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              <FileBadge kind={tab.kind} language={tab.language} name={tab.name} />
              <span className="truncate">{tab.name}</span>
              {tab.isDirty && (
                <span
                  title="有未保存的修改"
                  className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                />
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title="关闭标签页 (Ctrl+W / 鼠标中键)"
                className={`p-0.5 rounded transition ${
                  isActive
                    ? 'opacity-70 hover:opacity-100'
                    : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
                } hover:bg-black/10 dark:hover:bg-white/10`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {activeTab && onOpenInSplit && (
          <button
            type="button"
            onClick={() => onOpenInSplit(activeTab)}
            title="将当前标签页放到右侧分屏对照"
            className="p-1 rounded text-xs opacity-65 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition"
          >
            <Columns2 className="w-3.5 h-3.5" />
          </button>
        )}
        {activeTab && !activeTab.isScratchpad && (
          <button
            type="button"
            onClick={() => void revealInExplorer(activeTab.path)}
            title="在 Windows 资源管理器中定位此文件"
            className="p-1 rounded text-xs opacity-65 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition"
          >
            <FolderSearch className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Tab Right-Click Context Menu */}
      {ctxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            left: `${ctxMenu.x}px`,
            top: `${ctxMenu.y}px`,
            backgroundColor: 'var(--dp-elevated)',
            borderColor: 'var(--dp-border-strong)',
            color: 'var(--dp-text)',
          }}
          className="fixed z-50 w-44 rounded-xl border shadow-xl py-1 text-xs"
        >
          {onOpenInSplit && (
            <button
              type="button"
              onClick={() => {
                onOpenInSplit(ctxMenu.tab);
                setCtxMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
            >
              <Columns2 className="w-3.5 h-3.5" />
              <span>右侧分屏打开</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onCloseTab(ctxMenu.tab.id);
              setCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="w-3.5 h-3.5" />
            <span>关闭当前标签</span>
          </button>
          {onCloseOthers && tabs.length > 1 && (
            <button
              type="button"
              onClick={() => {
                onCloseOthers(ctxMenu.tab.id);
                setCtxMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
            >
              <X className="w-3.5 h-3.5 opacity-60" />
              <span>关闭其他标签</span>
            </button>
          )}
          {onCloseAll && (
            <button
              type="button"
              onClick={() => {
                onCloseAll();
                setCtxMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
            >
              <X className="w-3.5 h-3.5 text-rose-500" />
              <span>关闭全部标签</span>
            </button>
          )}

          {!ctxMenu.tab.isScratchpad && (
            <>
              <div
                className="my-1 border-t"
                style={{ borderColor: 'var(--dp-border)' }}
              />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(ctxMenu.tab.path);
                  setCtxMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>复制完整路径</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void revealInExplorer(ctxMenu.tab.path);
                  setCtxMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>资源管理器定位</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
