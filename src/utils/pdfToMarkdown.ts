import type { PdfAnnotation, PdfAnnotationColor } from '@/types';

export interface PdfRawTextItem {
  str: string;
  x: number;
  topY: number; // distance from top of page (px at scale=1)
  width: number;
  height: number;
  fontSize: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfExtractedPageInput {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfRawTextItem[];
}

export interface PdfOutlineHint {
  title: string;
  level: number;
  pageNumber?: number;
}

export interface PdfToMarkdownOptions {
  documentTitle?: string;
  outline?: PdfOutlineHint[];
  includePageMarkers?: boolean;
  annotations?: PdfAnnotation[];
}

interface ReconstructedCell {
  text: string;
  x: number;
  endX: number;
}

interface ReconstructedLine {
  pageNumber: number;
  text: string;
  cells: ReconstructedCell[];
  x: number;
  endX: number;
  topY: number;
  fontSize: number;
  isMono: boolean;
}

const COLOR_LABELS: Record<PdfAnnotationColor, string> = {
  amber: '🟡 重点高亮',
  emerald: '🟢 核心结论',
  sky: '🔵 方法细节',
  rose: '🔴 疑问待查',
  violet: '🟣 灵感批注',
};

function isCjkChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function isMonospaceFont(fontName?: string): boolean {
  if (!fontName) return false;
  return /mono|courier|consolas|menlo|fira|jetbrains|cmtt|sourcecode|typewriter/i.test(
    fontName
  );
}

function normalizeHeaderFooterFingerprint(text: string): string {
  return text
    .trim()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isStandalonePageNumber(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  return (
    /^(?:[-–—]?\s*)?\d+(?:\s*(?:\/|of)\s*\d+)?(?:\s*[-–—])?$/i.test(t) ||
    /^第\s*\d+\s*页(?:\s*[\/共]\s*\d+\s*页?)?$/.test(t) ||
    /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(t)
  );
}

function joinInlineRuns(prevText: string, nextText: string, gap: number, fontSize: number): string {
  if (!prevText) return nextText;
  if (!nextText) return prevText;

  const prevLast = prevText[prevText.length - 1];
  const nextFirst = nextText[0];

  if (/\s/.test(prevLast) || /\s/.test(nextFirst)) {
    return prevText + nextText;
  }

  // CJK characters adjacent with normal kerning -> no extra space
  if (isCjkChar(prevLast) && isCjkChar(nextFirst) && gap < fontSize * 0.72) {
    return prevText + nextText;
  }

  // CJK adjacent to CJK punctuation -> no extra space
  if (
    (isCjkChar(prevLast) || /[（【《“‘「『]/.test(prevLast)) &&
    /[，。！？；：、）】》”’」』]/.test(nextFirst) &&
    gap < fontSize * 0.85
  ) {
    return prevText + nextText;
  }

  if (gap > fontSize * 0.16) {
    return `${prevText} ${nextText}`;
  }

  return prevText + nextText;
}

function groupItemsIntoLines(items: PdfRawTextItem[], pageNumber: number): ReconstructedLine[] {
  const nonEmpty = items.filter((it) => it.str && it.str.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  // Sort primarily top-to-bottom, then left-to-right
  const sorted = [...nonEmpty].sort((a, b) => {
    const dy = a.topY - b.topY;
    const tol = Math.max(3.2, Math.min(a.fontSize, b.fontSize) * 0.42);
    if (Math.abs(dy) <= tol) return a.x - b.x;
    return dy;
  });

  const rawClusters: PdfRawTextItem[][] = [];
  for (const item of sorted) {
    const last = rawClusters[rawClusters.length - 1];
    if (!last) {
      rawClusters.push([item]);
      continue;
    }
    const avgY = last.reduce((acc, cur) => acc + cur.topY, 0) / last.length;
    const maxFs = last.reduce((acc, cur) => Math.max(acc, cur.fontSize), item.fontSize);
    if (Math.abs(item.topY - avgY) <= Math.max(3.5, maxFs * 0.42)) {
      last.push(item);
    } else {
      rawClusters.push([item]);
    }
  }

  const lines: ReconstructedLine[] = [];
  for (const cluster of rawClusters) {
    cluster.sort((a, b) => a.x - b.x);

    const cells: ReconstructedCell[] = [];
    let currentCell: ReconstructedCell | null = null;
    let lineText = '';
    let prevEnd = cluster[0].x;
    let maxFs = 0;
    let weightedFsSum = 0;
    let charWeightSum = 0;
    let monoCount = 0;

    for (let i = 0; i < cluster.length; i++) {
      const it = cluster[i];
      const fs = Math.max(6, it.fontSize || 12);
      maxFs = Math.max(maxFs, fs);
      const len = it.str.trim().length;
      weightedFsSum += fs * len;
      charWeightSum += len;
      if (isMonospaceFont(it.fontName)) monoCount += len;

      const gap = i === 0 ? 0 : it.x - prevEnd;
      const itemEnd = it.x + Math.max(it.width, it.str.length * fs * 0.45);

      // Wide horizontal gap indicates potential table column boundary
      if (!currentCell || gap > fs * 2.1) {
        if (currentCell) cells.push(currentCell);
        currentCell = {
          text: it.str.trim(),
          x: it.x,
          endX: itemEnd,
        };
      } else {
        currentCell.text = joinInlineRuns(currentCell.text, it.str.trim(), gap, fs);
        currentCell.endX = Math.max(currentCell.endX, itemEnd);
      }

      lineText =
        i === 0 ? it.str.trim() : joinInlineRuns(lineText, it.str.trim(), gap, fs);
      prevEnd = Math.max(prevEnd, itemEnd);
    }
    if (currentCell) cells.push(currentCell);

    const cleanedText = lineText.replace(/\s+/g, ' ').trim();
    if (!cleanedText) continue;

    lines.push({
      pageNumber,
      text: cleanedText,
      cells,
      x: cluster[0].x,
      endX: prevEnd,
      topY: cluster.reduce((acc, c) => acc + c.topY, 0) / cluster.length,
      fontSize: charWeightSum > 0 ? weightedFsSum / charWeightSum : maxFs || 12,
      isMono: charWeightSum > 0 && monoCount / charWeightSum >= 0.65,
    });
  }

  return lines;
}

function reconstructPageLines(page: PdfExtractedPageInput): ReconstructedLine[] {
  if (page.width <= 0 || page.items.length === 0) {
    return groupItemsIntoLines(page.items, page.pageNumber);
  }

  // Check if main body is cleanly split into 2 columns (common in academic papers)
  const midBand = page.items.filter(
    (it) =>
      it.str.trim().length > 0 &&
      it.topY > page.height * 0.14 &&
      it.topY < page.height * 0.88
  );
  const midX = page.width * 0.5;
  let leftCount = 0;
  let rightCount = 0;
  let crossingCount = 0;

  for (const it of midBand) {
    const endX = it.x + Math.max(it.width, it.fontSize);
    if (endX <= midX * 0.98) leftCount++;
    else if (it.x >= midX * 1.02) rightCount++;
    else if (it.width > page.width * 0.18) crossingCount++;
  }

  const isTwoColumn =
    leftCount >= 14 && rightCount >= 14 && crossingCount <= Math.max(2, midBand.length * 0.03);

  if (!isTwoColumn) {
    return groupItemsIntoLines(page.items, page.pageNumber);
  }

  // Partition into top full-width header/abstract, left column, right column, bottom full-width
  const topItems: PdfRawTextItem[] = [];
  const leftCol: PdfRawTextItem[] = [];
  const rightCol: PdfRawTextItem[] = [];
  const bottomItems: PdfRawTextItem[] = [];

  // Find Y where 2-column region begins
  const colCandidates = page.items.filter(
    (it) => it.str.trim().length > 0 && it.x >= midX * 1.02 && it.topY > page.height * 0.08
  );
  const colStartY =
    colCandidates.length > 0
      ? Math.min(...colCandidates.map((c) => c.topY)) - 6
      : page.height * 0.15;

  for (const it of page.items) {
    if (!it.str.trim()) continue;
    if (it.topY < colStartY) {
      topItems.push(it);
    } else if (it.topY > page.height * 0.92 && it.width > page.width * 0.5) {
      bottomItems.push(it);
    } else if (it.x < midX) {
      leftCol.push(it);
    } else {
      rightCol.push(it);
    }
  }

  return [
    ...groupItemsIntoLines(topItems, page.pageNumber),
    ...groupItemsIntoLines(leftCol, page.pageNumber),
    ...groupItemsIntoLines(rightCol, page.pageNumber),
    ...groupItemsIntoLines(bottomItems, page.pageNumber),
  ];
}

function stripRunningHeadersAndFooters(
  pageLinesList: ReconstructedLine[][],
  pages: PdfExtractedPageInput[]
): ReconstructedLine[][] {
  if (pageLinesList.length === 0) return pageLinesList;

  const headerCounts = new Map<string, number>();
  const footerCounts = new Map<string, number>();

  pageLinesList.forEach((lines, idx) => {
    const pageH = pages[idx]?.height || 800;
    if (lines.length === 0) return;
    const first = lines[0];
    if (first.topY < pageH * 0.1) {
      const fp = normalizeHeaderFooterFingerprint(first.text);
      if (fp) headerCounts.set(fp, (headerCounts.get(fp) || 0) + 1);
    }
    const last = lines[lines.length - 1];
    if (last.topY > pageH * 0.89) {
      const fp = normalizeHeaderFooterFingerprint(last.text);
      if (fp) footerCounts.set(fp, (footerCounts.get(fp) || 0) + 1);
    }
  });

  const minRepeat = pageLinesList.length >= 3 ? Math.max(2, Math.floor(pageLinesList.length * 0.4)) : 999;

  return pageLinesList.map((lines, idx) => {
    const pageH = pages[idx]?.height || 800;
    return lines.filter((ln, lineIdx) => {
      if (lineIdx === 0 && ln.topY < pageH * 0.1) {
        const fp = normalizeHeaderFooterFingerprint(ln.text);
        if (isStandalonePageNumber(ln.text) || (headerCounts.get(fp) || 0) >= minRepeat) {
          return false;
        }
      }
      if (lineIdx === lines.length - 1 && ln.topY > pageH * 0.89) {
        const fp = normalizeHeaderFooterFingerprint(ln.text);
        if (isStandalonePageNumber(ln.text) || (footerCounts.get(fp) || 0) >= minRepeat) {
          return false;
        }
      }
      return true;
    });
  });
}

function computeBodyFontSize(lines: ReconstructedLine[]): number {
  if (lines.length === 0) return 12;
  const buckets = new Map<number, number>();
  for (const ln of lines) {
    const rounded = Math.round(ln.fontSize * 2) / 2;
    buckets.set(rounded, (buckets.get(rounded) || 0) + ln.text.length);
  }
  let bestSize = 12;
  let bestWeight = -1;
  for (const [sz, weight] of buckets.entries()) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestSize = sz;
    }
  }
  return bestSize;
}

function classifyHeadingLevel(
  line: ReconstructedLine,
  bodyFontSize: number,
  outlineMap: Map<string, number>,
  hasEmittedH1: boolean
): number | null {
  const text = line.text.trim();
  if (!text || text.length > 95) return null;

  const normKey = text.replace(/\s+/g, ' ').toLowerCase();
  const outlineLevel = outlineMap.get(normKey);
  if (outlineLevel) {
    return Math.min(4, Math.max(1, outlineLevel));
  }

  // Sentences ending with regular comma/period are rarely headings
  if (/[，。；,]$/.test(text)) return null;

  const ratio = line.fontSize / Math.max(6, bodyFontSize);
  if (ratio >= 1.52) {
    return hasEmittedH1 ? 2 : 1;
  }
  if (ratio >= 1.26) {
    return 2;
  }
  if (ratio >= 1.13 && text.length <= 65) {
    return 3;
  }

  // Structural numbered section headings (e.g. "1 引言", "2.1 模型结构", "一、实验背景")
  if (
    ratio >= 0.98 &&
    text.length <= 52 &&
    /^(?:第[一二三四五六七八九十百\d]+[章节部分篇]|[一二三四五六七八九十]+、\s*\S+|(?:\d+\.)+\d*\s+\S+|\d+\s+[\u4e00-\u9fa5A-Z]\S*)/.test(
      text
    )
  ) {
    const dotCount = (text.split(/\s+/)[0].match(/\./g) || []).length;
    return dotCount >= 2 ? 4 : dotCount === 1 ? 3 : 2;
  }

  return null;
}

function formatSpeakerOrListLine(text: string): { kind: 'speaker' | 'list' | null; formatted: string } {
  // Dialogue / meeting transcript pattern: "• SPEAKER_00 | 00:01:45"
  const speakerMatch = text.match(
    /^[•●▪◦▸*-]?\s*(SPEAKER_\d+|Speaker\s*\d+|发言人\s*\w*)\s*\|\s*(\d{1,2}:\d{2}(?::\d{2})?.*)$/i
  );
  if (speakerMatch) {
    return {
      kind: 'speaker',
      formatted: `**🎙️ ${speakerMatch[1]}** · \`${speakerMatch[2].trim()}\``,
    };
  }

  const bulletMatch = text.match(/^[•●▪◦▸]\s*(.+)$/);
  if (bulletMatch) {
    return { kind: 'list', formatted: `- ${bulletMatch[1].trim()}` };
  }

  const dashMatch = text.match(/^[-*]\s+(.+)$/);
  if (dashMatch) {
    return { kind: 'list', formatted: `- ${dashMatch[1].trim()}` };
  }

  const orderedMatch = text.match(/^(\d+[.)])\s+(.+)$/);
  if (orderedMatch && orderedMatch[2].length <= 180) {
    return { kind: 'list', formatted: `${orderedMatch[1]} ${orderedMatch[2].trim()}` };
  }

  return { kind: null, formatted: text };
}

function isTableBlockCandidate(lines: ReconstructedLine[], startIdx: number): number {
  const first = lines[startIdx];
  if (!first || first.cells.length < 2 || first.cells.length > 8) return 0;

  const colCount = first.cells.length;
  let endIdx = startIdx + 1;
  while (endIdx < lines.length) {
    const cur = lines[endIdx];
    if (cur.pageNumber !== first.pageNumber) break;
    if (cur.cells.length !== colCount) break;
    if (Math.abs(cur.topY - lines[endIdx - 1].topY) > first.fontSize * 3.2) break;
    endIdx++;
  }

  const rowCount = endIdx - startIdx;
  return rowCount >= 2 ? rowCount : 0;
}

function shouldMergeParagraphLines(prev: ReconstructedLine, next: ReconstructedLine, bodyFs: number): boolean {
  if (prev.pageNumber !== next.pageNumber) {
    // Allow cross-page merge only if previous line clearly ended mid-sentence
    return !/[。！？.!?：:；;”"）)\]】]$/.test(prev.text);
  }
  const dy = next.topY - prev.topY;
  if (dy < 0 || dy > Math.max(prev.fontSize, next.fontSize) * 2.1) {
    return false;
  }
  // Indented new paragraph or distinct X shift
  if (next.x - prev.x > bodyFs * 1.45) {
    return false;
  }
  // Previous line ends with strong terminal punctuation and is noticeably shorter than next/prev
  if (/[。！？!?：:]$/.test(prev.text) && prev.endX < next.endX - bodyFs * 2.5) {
    return false;
  }
  return true;
}

function mergeTwoParagraphStrings(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  // Hyphenated English line-break
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) {
    return a.slice(0, -1) + b;
  }
  const lastA = a[a.length - 1];
  const firstB = b[0];
  if (isCjkChar(lastA) || isCjkChar(firstB) || /[，。！？；：、（）【】《》“”]/.test(lastA + firstB)) {
    return a + b;
  }
  return `${a} ${b}`;
}

export function formatAnnotationsToMarkdown(
  annotations: PdfAnnotation[],
  docTitle?: string
): string {
  const sorted = [...annotations].sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    const ay = a.rects[0]?.y ?? 0;
    const by = b.rects[0]?.y ?? 0;
    return ay - by;
  });

  const out: string[] = [];
  if (docTitle) {
    out.push(`# 📑 《${docTitle}》研读批注与讨论笔记`);
    out.push('');
    out.push(
      `> 共整理 **${sorted.length}** 处标注 · 导出时间：${new Date().toLocaleString('zh-CN')}`
    );
    out.push('');
  }

  if (sorted.length === 0) {
    out.push('_当前文档暂无批注记录。_');
    return out.join('\n');
  }

  let currentPage = -1;
  for (const ann of sorted) {
    if (ann.pageNumber !== currentPage) {
      currentPage = ann.pageNumber;
      out.push(`## 第 ${currentPage} 页`);
      out.push('');
    }

    const colorTag = COLOR_LABELS[ann.color] || '🟡 标注';
    const typeTag =
      ann.type === 'highlight'
        ? '高亮'
        : ann.type === 'underline'
          ? '下划线'
          : ann.type === 'rect'
            ? '区域框选'
            : '定点便签';
    const statusTag = ann.resolved ? ' · ✅ 已解决' : '';

    out.push(`### ${colorTag}（${typeTag}${statusTag}）`);
    out.push('');

    if (ann.selectedText?.trim()) {
      const quoted = ann.selectedText
        .trim()
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join('\n');
      out.push(quoted);
      out.push('');
    }

    if (ann.imageDataUrl) {
      out.push(`![第 ${ann.pageNumber} 页区域标注截图](${ann.imageDataUrl})`);
      out.push('');
    }

    if (ann.comment.trim()) {
      out.push(`- **批注（${ann.author || '我'}）**：${ann.comment.trim()}`);
    }

    if (ann.replies.length > 0) {
      for (const rep of ann.replies) {
        const timeStr = new Date(rep.createdAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        out.push(`  - 💬 **回复（${rep.author || '我'} · ${timeStr}）**：${rep.content.trim()}`);
      }
    }

    out.push('');
  }

  return out.join('\n').trim() + '\n';
}

export function convertExtractedPdfToMarkdown(
  pages: PdfExtractedPageInput[],
  options: PdfToMarkdownOptions = {}
): string {
  const perPageLines = pages.map((p) => reconstructPageLines(p));
  const cleanedPerPage = stripRunningHeadersAndFooters(perPageLines, pages);
  const allLines = cleanedPerPage.flat();

  const blocks: string[] = [];
  const docTitle = options.documentTitle?.trim();

  if (allLines.length === 0) {
    if (docTitle) blocks.push(`# ${docTitle}`);
    blocks.push(
      '> [!WARNING]\n> 未能从该 PDF 中提取到可选择的文本层（可能是纯扫描图片版 PDF）。你仍可使用「框选标注」截取图表并在批注栏记录笔记。'
    );
    if (options.annotations && options.annotations.length > 0) {
      blocks.push('---\n\n' + formatAnnotationsToMarkdown(options.annotations));
    }
    return blocks.join('\n\n') + '\n';
  }

  const bodyFontSize = computeBodyFontSize(allLines);
  const outlineMap = new Map<string, number>();
  for (const item of options.outline || []) {
    const key = item.title.trim().replace(/\s+/g, ' ').toLowerCase();
    if (key && !outlineMap.has(key)) {
      outlineMap.set(key, item.level);
    }
  }

  let hasEmittedH1 = false;
  if (docTitle) {
    // Emit document title as H1 unless first line is already the exact same title
    const firstNorm = allLines[0].text.replace(/\s+/g, '').toLowerCase();
    const titleNorm = docTitle.replace(/\s+/g, '').toLowerCase();
    if (firstNorm !== titleNorm) {
      blocks.push(`# ${docTitle}`);
      hasEmittedH1 = true;
    }
  }

  let idx = 0;
  let lastPageEmitted = allLines[0].pageNumber;

  while (idx < allLines.length) {
    const ln = allLines[idx];

    if (options.includePageMarkers && ln.pageNumber !== lastPageEmitted) {
      blocks.push(`<!-- 第 ${ln.pageNumber} 页 -->`);
      lastPageEmitted = ln.pageNumber;
    }

    // 1. Monospace code block
    if (ln.isMono) {
      const codeLines: string[] = [ln.text];
      idx++;
      while (idx < allLines.length && allLines[idx].isMono) {
        codeLines.push(allLines[idx].text);
        idx++;
      }
      blocks.push('```\n' + codeLines.join('\n') + '\n```');
      continue;
    }

    // 2. Multi-column aligned GFM table
    const tableRows = isTableBlockCandidate(allLines, idx);
    if (tableRows >= 2) {
      const slice = allLines.slice(idx, idx + tableRows);
      const escapeCell = (s: string) => s.replace(/\|/g, '\\|').trim();
      const header = `| ${slice[0].cells.map((c) => escapeCell(c.text)).join(' | ')} |`;
      const divider = `| ${slice[0].cells.map(() => '---').join(' | ')} |`;
      const body = slice
        .slice(1)
        .map((r) => `| ${r.cells.map((c) => escapeCell(c.text)).join(' | ')} |`);
      blocks.push([header, divider, ...body].join('\n'));
      idx += tableRows;
      continue;
    }

    // 3. Heading
    const headingLv = classifyHeadingLevel(ln, bodyFontSize, outlineMap, hasEmittedH1);
    if (headingLv !== null) {
      if (headingLv === 1) hasEmittedH1 = true;
      blocks.push(`${'#'.repeat(headingLv)} ${ln.text}`);
      idx++;
      continue;
    }

    // 4. Speaker turn or Bullet/Ordered list item
    const listCheck = formatSpeakerOrListLine(ln.text);
    if (listCheck.kind === 'speaker') {
      blocks.push(listCheck.formatted);
      idx++;
      continue;
    }
    if (listCheck.kind === 'list') {
      const listItems: string[] = [listCheck.formatted];
      idx++;
      while (idx < allLines.length) {
        const nextCheck = formatSpeakerOrListLine(allLines[idx].text);
        if (nextCheck.kind === 'list') {
          listItems.push(nextCheck.formatted);
          idx++;
        } else {
          break;
        }
      }
      blocks.push(listItems.join('\n'));
      continue;
    }

    // 5. Regular prose paragraph (merge soft-wrapped consecutive lines)
    let para = ln.text;
    let prevLine = ln;
    idx++;

    while (idx < allLines.length) {
      const cand = allLines[idx];
      if (cand.isMono) break;
      if (isTableBlockCandidate(allLines, idx) >= 2) break;
      if (classifyHeadingLevel(cand, bodyFontSize, outlineMap, hasEmittedH1) !== null) break;
      if (formatSpeakerOrListLine(cand.text).kind !== null) break;
      if (!shouldMergeParagraphLines(prevLine, cand, bodyFontSize)) break;

      para = mergeTwoParagraphStrings(para, cand.text);
      prevLine = cand;
      idx++;
    }

    blocks.push(para);
  }

  if (options.annotations && options.annotations.length > 0) {
    blocks.push('---');
    blocks.push(
      '## 📑 附：文档研读批注与回复记录\n\n' +
        formatAnnotationsToMarkdown(options.annotations)
    );
  }

  return blocks.join('\n\n').trim() + '\n';
}
