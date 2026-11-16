import { Marked, Renderer } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import type { HeadingItem } from '@/types';
import {
  buildAssetStreamUrl,
  isExternalUrl,
  resolveRelativeSlashPath,
} from '@/utils/pathUtils';

export interface RenderedMarkdownResult {
  html: string;
  headings: HeadingItem[];
}

const ALERT_META: Record<
  string,
  { title: string; className: string; badgeIcon: string }
> = {
  NOTE: { title: '说明 Note', className: 'dp-alert-note', badgeIcon: 'ℹ️' },
  TIP: { title: '提示 Tip', className: 'dp-alert-tip', badgeIcon: '💡' },
  IMPORTANT: {
    title: '重点 Important',
    className: 'dp-alert-important',
    badgeIcon: '📌',
  },
  WARNING: { title: '注意 Warning', className: 'dp-alert-warning', badgeIcon: '⚠️' },
  CAUTION: { title: '警告 Caution', className: 'dp-alert-caution', badgeIcon: '🚨' },
};

const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'ascii']);
const RUNNABLE_LANGS: Record<string, string> = {
  python: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  batch: 'batch',
  rust: 'rust',
  rs: 'rust',
};

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Protects code blocks & inline code first, extracts LaTeX math ($...$, $$...$$, \(...\), \[...\])
 * so Markdown never mangles underscores/asterisks inside formulas, then runs Marked + fast Highlight.js.
 */
export function renderMarkdownToHtml(
  rawMarkdown: string,
  parentSlashPath: string,
  assetBaseUrl: string
): RenderedMarkdownResult {
  const codeProtections: string[] = [];
  const mathTokens: string[] = [];
  const headings: HeadingItem[] = [];

  // 1. Protect fenced code blocks (3 or 4+ backticks/tildes) and inline code spans
  let text = rawMarkdown.replace(/\r\n/g, '\n');

  text = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (match, lead) => {
    const idx = codeProtections.length;
    codeProtections.push(match.slice(lead.length));
    return `${lead}@@DP_CODE_BLOCK_${idx}@@`;
  });

  text = text.replace(/(`+)([^`\n]+?)\1/g, (match) => {
    const idx = codeProtections.length;
    codeProtections.push(match);
    return `@@DP_CODE_INLINE_${idx}@@`;
  });

  // 2. Protect escaped literal \$
  const ESCAPED_DOLLAR_TOKEN = '@@DP_LITERAL_DOLLAR@@';
  text = text.replace(/\\\$/g, ESCAPED_DOLLAR_TOKEN);

  // 3. Render Display Math: $$...$$ and \[...\]
  const pushMath = (tex: string, displayMode: boolean): string => {
    const idx = mathTokens.length;
    try {
      const rendered = katex.renderToString(tex.trim(), {
        displayMode,
        throwOnError: false,
        strict: false,
      });
      mathTokens.push(
        displayMode ? `<div class="dp-math-block">${rendered}</div>` : rendered
      );
    } catch {
      mathTokens.push(`<code>${escapeHtml(tex)}</code>`);
    }
    return displayMode ? `\n\n@@DP_MATH_${idx}@@\n\n` : `@@DP_MATH_${idx}@@`;
  };

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => pushMath(tex, true));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => pushMath(tex, true));

  // 4. Render Inline Math: \(...\) and $...$
  text = text.replace(/\\\(([^\n]+?)\\\)/g, (_, tex) => pushMath(tex, false));
  text = text.replace(
    /(^|[^0-9A-Za-z\\])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![0-9A-Za-z])/g,
    (_, prefix, tex) => `${prefix}${pushMath(tex, false)}`
  );

  // 5. Restore protected code blocks & inline code before running Marked
  text = text.replace(/@@DP_CODE_INLINE_(\d+)@@/g, (_, i) => codeProtections[Number(i)]);
  text = text.replace(/@@DP_CODE_BLOCK_(\d+)@@/g, (_, i) => codeProtections[Number(i)]);

  // 6. Configure Marked instance with custom renderer
  const markedInstance = new Marked({ gfm: true, breaks: false });
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const innerHtml = this.parser.parseInline(tokens);
    const restoredForToc = innerHtml.replace(/@@DP_MATH_(\d+)@@/g, (_, i) =>
      stripHtmlTags(mathTokens[Number(i)] || '')
    );
    const plainText = stripHtmlTags(restoredForToc).replaceAll(ESCAPED_DOLLAR_TOKEN, '$');
    const id = `dp-h-${headings.length}`;
    headings.push({ id, text: plainText || `章节 ${headings.length + 1}`, level: depth });
    return `<h${depth} id="${id}" class="dp-heading dp-h${depth}">${innerHtml}</h${depth}>`;
  };

  renderer.code = function ({ text: codeText, lang }) {
    const cleanLang = (lang || '').trim().split(/\s+/)[0].toLowerCase();
    if (cleanLang === 'mermaid') {
      const encoded = encodeURIComponent(codeText);
      return `<div class="dp-mermaid-wrapper" data-mermaid="${encoded}">
        <div class="dp-mermaid-loading">正在渲染流程图...</div>
      </div>`;
    }

    let highlighted = escapeHtml(codeText);
    const displayLang = cleanLang || 'text';
    // Avoid expensive highlightAuto across all grammars — only highlight known languages!
    if (!PLAIN_LANGS.has(cleanLang) && hljs.getLanguage(cleanLang)) {
      try {
        highlighted = hljs.highlight(codeText, {
          language: cleanLang,
          ignoreIllegals: true,
        }).value;
      } catch {
        highlighted = escapeHtml(codeText);
      }
    }

    const encodedRaw = encodeURIComponent(codeText);
    const runnableLang = RUNNABLE_LANGS[cleanLang];
    const runBtnHtml = runnableLang
      ? `<button type="button" class="dp-run-btn" data-run-lang="${runnableLang}" data-run-code="${encodedRaw}">▶ 运行代码</button>`
      : '';
    return `<div class="dp-code-card">
      <div class="dp-code-header">
        <span class="dp-code-lang">${escapeHtml(displayLang)}</span>
        <div class="dp-code-actions">${runBtnHtml}<button type="button" class="dp-copy-btn" data-copy-code="${encodedRaw}">复制代码</button></div>
      </div>
      <pre><code class="hljs language-${escapeHtml(displayLang)}">${highlighted}</code></pre>
    </div>`;
  };

  renderer.blockquote = function ({ tokens }) {
    const inner = this.parser.parse(tokens);
    const alertMatch = inner.match(
      /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>|\n)?([\s\S]*)/i
    );
    if (alertMatch) {
      const kind = alertMatch[1].toUpperCase();
      const meta = ALERT_META[kind] || ALERT_META.NOTE;
      const restHtml = `<p>${alertMatch[2]}`;
      return `<div class="dp-alert ${meta.className}">
        <div class="dp-alert-title"><span>${meta.badgeIcon}</span><span>${meta.title}</span></div>
        <div class="dp-alert-body">${restHtml}</div>
      </div>`;
    }
    return `<blockquote class="dp-blockquote">${inner}</blockquote>`;
  };

  renderer.image = function ({ href, title, text: altText }) {
    const resolvedSrc =
      !href || isExternalUrl(href)
        ? href || ''
        : buildAssetStreamUrl(
            assetBaseUrl,
            resolveRelativeSlashPath(parentSlashPath, href)
          );
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const caption = altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : '';
    return `<figure class="dp-figure">
      <img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(altText || '')}"${titleAttr} class="dp-zoomable-img" decoding="async" loading="lazy" />
      ${caption}
    </figure>`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const labelHtml = this.parser.parseInline(tokens);
    const rawHref = (href || '').trim();
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';

    if (rawHref.startsWith('#')) {
      return `<a href="${escapeHtml(rawHref)}" data-anchor-href="${escapeHtml(rawHref)}"${titleAttr} class="dp-link">${labelHtml}</a>`;
    }
    if (/^conversation:\/\//i.test(rawHref)) {
      const convId = rawHref.replace(/^conversation:\/\/+/i, '').trim();
      return `<a href="#" data-conv-id="${escapeHtml(convId)}"${titleAttr} class="dp-link dp-link-local">${labelHtml}</a>`;
    }
    if (isExternalUrl(rawHref)) {
      return `<a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer"${titleAttr} class="dp-link dp-link-ext">${labelHtml}</a>`;
    }

    const hashPart = rawHref.includes('#') ? rawHref.slice(rawHref.indexOf('#')) : '';
    const resolvedSlash = resolveRelativeSlashPath(parentSlashPath, rawHref);
    return `<a href="#" data-local-doc="${escapeHtml(resolvedSlash)}" data-local-hash="${escapeHtml(hashPart)}"${titleAttr} class="dp-link dp-link-local">${labelHtml}</a>`;
  };

  markedInstance.use({ renderer });
  let html = markedInstance.parse(text) as string;

  html = html.replace(
    /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (full, pre, srcVal, post) => {
      if (isExternalUrl(srcVal) || srcVal.startsWith('http://127.0.0.1:')) {
        return full;
      }
      const resolved = buildAssetStreamUrl(
        assetBaseUrl,
        resolveRelativeSlashPath(parentSlashPath, srcVal)
      );
      return `${pre}${escapeHtml(resolved)}${post}`;
    }
  );

  // 7. Restore Math HTML & escaped literal dollars
  html = html.replace(/@@DP_MATH_(\d+)@@/g, (_, i) => mathTokens[Number(i)] || '');
  html = html.replaceAll(ESCAPED_DOLLAR_TOKEN, '$');

  return { html, headings };
}
