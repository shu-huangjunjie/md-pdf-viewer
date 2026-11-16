import { describe, expect, it } from 'vitest';
import {
  convertExtractedPdfToMarkdown,
  formatAnnotationsToMarkdown,
  type PdfExtractedPageInput,
} from './pdfToMarkdown';
import type { PdfAnnotation } from '@/types';

describe('pdfToMarkdown engine', () => {
  it('reconstructs headings, CJK char runs, and strips repeated headers/footers', () => {
    const pages: PdfExtractedPageInput[] = [1, 2, 3].map((pageNum) => ({
      pageNumber: pageNum,
      width: 600,
      height: 840,
      items: [
        // Repeated running header
        { str: '连铸课题组技术报告', x: 60, topY: 32, width: 120, height: 10, fontSize: 9 },
        ...(pageNum === 1
          ? [
              {
                str: '铜板温度预测模型微调方案',
                x: 120,
                topY: 110,
                width: 260,
                height: 22,
                fontSize: 20,
              },
              {
                str: '1. 实验背景与目标',
                x: 60,
                topY: 165,
                width: 160,
                height: 16,
                fontSize: 15,
              },
            ]
          : []),
        // Character-by-character CJK runs
        { str: '工', x: 60, topY: 210, width: 12, height: 12, fontSize: 12 },
        { str: '艺', x: 72, topY: 210, width: 12, height: 12, fontSize: 12 },
        { str: '参', x: 84, topY: 210, width: 12, height: 12, fontSize: 12 },
        { str: '数', x: 96, topY: 210, width: 12, height: 12, fontSize: 12 },
        { str: '保持稳定。', x: 108, topY: 210, width: 60, height: 12, fontSize: 12 },
        // Standalone page number footer
        { str: `${pageNum} / 3`, x: 280, topY: 805, width: 40, height: 10, fontSize: 9 },
      ],
    }));

    const md = convertExtractedPdfToMarkdown(pages);
    expect(md).toContain('# 铜板温度预测模型微调方案');
    expect(md).toContain('## 1. 实验背景与目标');
    expect(md).toContain('工艺参数保持稳定。');
    expect(md).not.toContain('连铸课题组技术报告');
    expect(md).not.toContain('1 / 3');
  });

  it('formats meeting transcript speaker turns cleanly', () => {
    const pages: PdfExtractedPageInput[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        items: [
          {
            str: '• SPEAKER_00 | 00:01:45',
            x: 60,
            topY: 120,
            width: 180,
            height: 12,
            fontSize: 12,
          },
          {
            str: '工艺参数没有变化。',
            x: 60,
            topY: 146,
            width: 140,
            height: 12,
            fontSize: 12,
          },
        ],
      },
    ];

    const md = convertExtractedPdfToMarkdown(pages, { documentTitle: '会议纪要' });
    expect(md).toContain('# 会议纪要');
    expect(md).toContain('**🎙️ SPEAKER_00** · `00:01:45`');
    expect(md).toContain('工艺参数没有变化。');
  });

  it('detects multi-column aligned rows as GFM tables', () => {
    const pages: PdfExtractedPageInput[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        items: [
          { str: '拉速', x: 60, topY: 200, width: 30, height: 12, fontSize: 12 },
          { str: '过热度', x: 200, topY: 200, width: 40, height: 12, fontSize: 12 },
          { str: '液面波动', x: 360, topY: 200, width: 50, height: 12, fontSize: 12 },
          { str: '1.45 m/min', x: 60, topY: 224, width: 65, height: 12, fontSize: 12 },
          { str: '24 °C', x: 200, topY: 224, width: 40, height: 12, fontSize: 12 },
          { str: '±1.8 mm', x: 360, topY: 224, width: 50, height: 12, fontSize: 12 },
        ],
      },
    ];

    const md = convertExtractedPdfToMarkdown(pages);
    expect(md).toContain('| 拉速 | 过热度 | 液面波动 |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| 1.45 m/min | 24 °C | ±1.8 mm |');
  });

  it('exports annotations and threaded replies to Markdown', () => {
    const annotations: PdfAnnotation[] = [
      {
        id: 'ann-1',
        pageNumber: 2,
        type: 'highlight',
        color: 'amber',
        rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
        selectedText: '工艺参数没有变化。',
        comment: '确认前 300 帧工况恒定',
        author: '黄俊杰',
        resolved: false,
        replies: [
          {
            id: 'rep-1',
            author: '复核记录',
            content: '已与现场 PLC 日志核对一致',
            createdAt: 1763168400000,
          },
        ],
        createdAt: 1763168000000,
        updatedAt: 1763168400000,
      },
    ];

    const md = formatAnnotationsToMarkdown(annotations, '铜板温度讨论');
    expect(md).toContain('# 📑 《铜板温度讨论》研读批注与讨论笔记');
    expect(md).toContain('## 第 2 页');
    expect(md).toContain('> 工艺参数没有变化。');
    expect(md).toContain('确认前 300 帧工况恒定');
    expect(md).toContain('已与现场 PLC 日志核对一致');
  });
});
