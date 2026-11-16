import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './markdownRenderer';
import { resolveRelativeSlashPath } from './pathUtils';

describe('markdownRenderer', () => {
  it('renders inline and display LaTeX math with multiple underscores without italic mangling', () => {
    const md = `公式测试：$u(y) = b_1 t_1(y) + b_2 t_2(y)$\n\n$$\n\\mathcal{G}_\\theta(a)(y)\n$$`;
    const res = renderMarkdownToHtml(md, 'D:/docs/notes', 'http://127.0.0.1:9999/fs/tok');
    expect(res.html).toContain('katex');
    expect(res.html).toContain('dp-math-block');
    expect(res.html).not.toContain('<em>1 t</em>');
  });

  it('keeps dollar signs inside inline code and fenced code untouched', () => {
    const md = '环境变量 `$HOME` 与价格 \\$100：\n```bash\necho $PATH $USER\n```';
    const res = renderMarkdownToHtml(md, 'D:/docs', 'http://127.0.0.1:9999/fs/tok');
    expect(res.html).toContain('$HOME');
    expect(res.html).toContain('$100');
    expect(res.html).toContain('$PATH');
  });

  it('transforms GitHub [!IMPORTANT] alerts and Mermaid blocks', () => {
    const md = `> [!IMPORTANT]\n> 神经算子支持跨网格预测！\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``;
    const res = renderMarkdownToHtml(md, 'D:/docs', 'http://127.0.0.1:9999/fs/tok');
    expect(res.html).toContain('dp-alert-important');
    expect(res.html).toContain('dp-mermaid-wrapper');
  });

  it('resolves relative SVG images with Chinese folder names cleanly', () => {
    const resolved = resolveRelativeSlashPath(
      'D:/huangjunjie/gemini/神经算子',
      './tutorial_images/01_function.svg'
    );
    expect(resolved).toBe('D:/huangjunjie/gemini/神经算子/tutorial_images/01_function.svg');

    const md = '![原理图](./tutorial_images/01_function.svg)';
    const res = renderMarkdownToHtml(
      md,
      'D:/huangjunjie/gemini/神经算子',
      'http://127.0.0.1:12345/fs/abc'
    );
    expect(res.html).toContain(
      'http://127.0.0.1:12345/fs/abc/D:/huangjunjie/gemini/%E7%A5%9E%E7%BB%8F%E7%AE%97%E5%AD%90/tutorial_images/01_function.svg'
    );
  });

  it('adds inline run buttons for runnable languages like Python and Rust', () => {
    const md = '```python\nprint("hello")\n```\n\n```json\n{"a": 1}\n```';
    const res = renderMarkdownToHtml(md, 'D:/docs', 'http://127.0.0.1:9999/fs/tok');
    expect(res.html).toContain('class="dp-run-btn"');
    expect(res.html).toContain('data-run-lang="python"');
    // Only Python block should get a run button, JSON block should not
    const runMatches = res.html.match(/class="dp-run-btn"/g) || [];
    expect(runMatches.length).toBe(1);
  });

  it('renders file:/// line anchors and conversation:// deep links for AI session linkage', () => {
    const md =
      '请查看 [train.py](file:///D:/project/src/train.py#L42-L50) 与历史记录 [ai-session](conversation://39eb79da-49da-4152-ab74-a5373256e6e3)';
    const res = renderMarkdownToHtml(md, 'D:/project', 'http://127.0.0.1:9999/fs/tok');
    expect(res.html).toContain('data-local-doc="D:/project/src/train.py"');
    expect(res.html).toContain('data-local-hash="#L42-L50"');
    expect(res.html).toContain('data-conv-id="39eb79da-49da-4152-ab74-a5373256e6e3"');
  });
});
