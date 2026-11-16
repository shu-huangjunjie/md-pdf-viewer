import React from 'react';
import { Code2, FileCode2, FileText } from 'lucide-react';
import type { DocKind } from '@/types';

export const SCRIPT_LANGUAGES = new Set([
  'python',
  'javascript',
  'typescript',
  'powershell',
  'batch',
  'shell',
  'rust',
  'cpp',
  'sql',
]);

export const CONFIG_LANGUAGES = new Set(['json', 'toml', 'text']);

export function isConfigLanguage(lang?: string | null): boolean {
  return Boolean(lang && CONFIG_LANGUAGES.has(lang));
}

export function isScriptLanguage(lang?: string | null): boolean {
  if (!lang) return true;
  return SCRIPT_LANGUAGES.has(lang);
}

interface FileBadgeProps {
  kind: Exclude<DocKind, 'folder'>;
  language?: string | null;
  name?: string;
}

export const FileBadge: React.FC<FileBadgeProps> = ({ kind, language, name }) => {
  if (kind === 'pdf') {
    return (
      <span className="shrink-0 px-1 py-0.2 rounded text-[9.5px] font-extrabold bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 leading-tight">
        PDF
      </span>
    );
  }
  if (kind === 'html') {
    return <FileCode2 className="w-3.5 h-3.5 shrink-0 text-teal-600 dark:text-teal-400" />;
  }
  if (kind === 'markdown') {
    return <FileText className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />;
  }

  const ext = name?.split('.').pop()?.toLowerCase() || '';
  const lang = language || ext;

  switch (lang) {
    case 'python':
    case 'py':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 leading-tight">
          PY
        </span>
      );
    case 'javascript':
    case 'js':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 leading-tight">
          JS
        </span>
      );
    case 'typescript':
    case 'ts':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 leading-tight">
          TS
        </span>
      );
    case 'rust':
    case 'rs':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30 leading-tight">
          RS
        </span>
      );
    case 'powershell':
    case 'ps1':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 leading-tight">
          PS1
        </span>
      );
    case 'batch':
    case 'bat':
    case 'cmd':
    case 'shell':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 leading-tight">
          BAT
        </span>
      );
    case 'json':
    case 'jsonl':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 leading-tight">
          JSON
        </span>
      );
    case 'toml':
    case 'yaml':
    case 'yml':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border border-cyan-500/30 leading-tight">
          CFG
        </span>
      );
    case 'cpp':
    case 'c':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/30 leading-tight">
          C++
        </span>
      );
    case 'sql':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-pink-500/15 text-pink-700 dark:text-pink-400 border border-pink-500/30 leading-tight">
          SQL
        </span>
      );
    case 'text':
    case 'txt':
      return (
        <span className="shrink-0 px-1 rounded text-[9.5px] font-extrabold bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/30 leading-tight">
          TXT
        </span>
      );
    default:
      return <Code2 className="w-3.5 h-3.5 shrink-0 text-indigo-500" />;
  }
};
