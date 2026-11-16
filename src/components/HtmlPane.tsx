import React, { useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { ExternalLink, FolderSearch, Minus, Plus, RefreshCw } from 'lucide-react';
import { isTauriRuntime, revealInExplorer } from '@/api/client';
import { buildAssetStreamUrl } from '@/utils/pathUtils';

interface HtmlPaneProps {
  filePath: string;
  slashPath: string;
  assetBaseUrl: string;
}

export const HtmlPane: React.FC<HtmlPaneProps> = ({
  filePath,
  slashPath,
  assetBaseUrl,
}) => {
  const [reloadKey, setReloadKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const streamUrl = buildAssetStreamUrl(assetBaseUrl, slashPath);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div
        className="h-9 px-3 flex items-center justify-between text-xs border-b shrink-0 gap-2"
        style={{
          backgroundColor: 'var(--dp-sidebar)',
          borderColor: 'var(--dp-border)',
          color: 'var(--dp-text-secondary)',
        }}
      >
        <span className="truncate font-medium" title={filePath}>
          🧪 交互式网页讲义：{filePath}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          <div
            className="flex items-center rounded border px-1 py-0.5"
            style={{
              borderColor: 'var(--dp-border-strong)',
              backgroundColor: 'var(--dp-surface)',
            }}
          >
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
              title="缩小网页预览"
              className="p-0.5 hover:opacity-75"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="点击重置 100%"
              className="px-1.5 font-mono text-[11px] min-w-[42px] text-center"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.1).toFixed(2))))}
              title="放大网页预览"
              className="p-0.5 hover:opacity-75"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {isTauriRuntime() && (
            <>
              <button
                type="button"
                onClick={() => void shellOpen(filePath)}
                title="使用系统默认浏览器打开"
                className="flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 transition"
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border-strong)',
                }}
              >
                <ExternalLink className="w-3 h-3" />
                <span className="hidden sm:inline">外部浏览器</span>
              </button>
              <button
                type="button"
                onClick={() => void revealInExplorer(filePath)}
                title="在资源管理器中定位"
                className="p-1 rounded border hover:opacity-85 transition"
                style={{
                  backgroundColor: 'var(--dp-surface)',
                  borderColor: 'var(--dp-border-strong)',
                }}
              >
                <FolderSearch className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="flex items-center gap-1 px-2 py-0.5 rounded border hover:opacity-85 shrink-0 transition"
            style={{
              backgroundColor: 'var(--dp-surface)',
              borderColor: 'var(--dp-border-strong)',
            }}
          >
            <RefreshCw className="w-3 h-3" />
            <span>重载</span>
          </button>
        </div>
      </div>

      <div className="flex-1 w-full min-h-0 overflow-auto bg-white">
        <iframe
          key={`${slashPath}-${reloadKey}`}
          src={streamUrl}
          title={filePath}
          style={{
            zoom,
          }}
          className="w-full h-full border-0 bg-white"
        />
      </div>
    </div>
  );
};
