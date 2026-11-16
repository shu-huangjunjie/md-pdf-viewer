//! Multi-language zero-dependency code formatter (Python PEP-8 AST-verified, JSON, Rust, JS/TS/C++/PS1).

use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::runner::discover_runtimes;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatCodeResult {
    pub formatted: String,
    pub changed: bool,
    pub engine: String,
}

/// Built-in zero-dependency Python PEP-8 formatter using Python's official `tokenize` + `ast`
/// modules: expands 1/2-space compact indentation to 4 spaces, splits top-level `;` and single-line
/// compound suites (`def f():return 1`, `if c:x=1`), normalizes operator spacing, preserves 100%
/// of `#` comments and Python 3.12+ f-strings, and mathematically verifies `ast.dump` equivalence!
const PYTHON_PEP8_SCRIPT: &str = r#"
import ast, io, sys, token, tokenize

COMPOUND_KW = {'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'match', 'case'}
ASSIGN_OPS = {'=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '>>=', '<<=', ':='}
CMP_OPS = {'==', '!=', '<=', '>=', '<', '>'}
WORD_KEYWORDS = {
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
    'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
    'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
}
FSTRING_START = getattr(token, 'FSTRING_START', -1)
FSTRING_END = getattr(token, 'FSTRING_END', -2)

def reindent_only(norm: str, indent_size: int) -> str:
    tokens = list(tokenize.generate_tokens(io.StringIO(norm).readline))
    lines = norm.splitlines()
    line_indents = {}
    level = 0
    for tok in tokens:
        if tok.type == token.INDENT:
            level += 1
        elif tok.type == token.DEDENT:
            level = max(0, level - 1)
        elif tok.type not in (tokenize.NL, token.NEWLINE, tokenize.ENCODING, token.ENDMARKER):
            row = tok.start[0] - 1
            if row not in line_indents:
                line_indents[row] = level
    unit = ' ' * indent_size
    out = []
    last_lvl = 0
    for idx, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        if not stripped:
            out.append('')
            continue
        lvl = line_indents.get(idx, last_lvl)
        last_lvl = lvl
        out.append((unit * lvl) + stripped)
    return '\n'.join(out).rstrip() + '\n'

def format_python_pep8(src: str, indent_size: int = 4) -> str:
    if not src.strip():
        return src
    norm = src.replace('\r\n', '\n').replace('\r', '\n')
    if not norm.endswith('\n'):
        norm += '\n'

    tokens = list(tokenize.generate_tokens(io.StringIO(norm).readline))
    unit = ' ' * indent_size

    out_lines = []
    cur_parts = []
    indent_level = 0
    extra_suite_indents = 0
    paren_depth = 0
    line_start_paren_depth = 0
    fstring_depth = 0
    stmt_first_kw = None
    seen_async = False
    lambda_depths = []
    prev_tok = None
    prev_end = None
    last_ended_block_type = None
    bracket_stack = []
    prev_unary = False

    def flush_line(force_blank=False):
        nonlocal cur_parts, last_ended_block_type, line_start_paren_depth
        text = ''.join(cur_parts).rstrip()
        cur_parts = []
        if text:
            total_indent = indent_level + extra_suite_indents + (1 if line_start_paren_depth > 0 else 0)
            out_lines.append((unit * total_indent) + text)
            last_ended_block_type = 'decorator' if text.lstrip().startswith('@') else 'code'
        elif force_blank:
            if out_lines and out_lines[-1] != '':
                out_lines.append('')
                last_ended_block_type = 'blank'
        line_start_paren_depth = paren_depth

    def maybe_blank_before_def():
        nonlocal last_ended_block_type
        if not out_lines or last_ended_block_type == 'decorator':
            return
        blanks = 0
        idx = len(out_lines) - 1
        while idx >= 0 and out_lines[idx] == '':
            blanks += 1
            idx -= 1
        if idx < 0 or out_lines[idx].lstrip().startswith('#') or out_lines[idx].lstrip().endswith(':'):
            return
        target = 2 if indent_level == 0 else 1
        while blanks < target:
            out_lines.append('')
            blanks += 1
        last_ended_block_type = 'blank'

    def needs_space_between(prev, curr_type, curr_str):
        if prev is None:
            return False
        p_type, p_str = prev
        if p_type == token.OP and p_str in ('(', '[', '{', '.', '~'):
            return False
        if p_type == token.OP and p_str in ('+', '-', '*', '**') and prev_unary:
            return False
        if curr_type == token.OP and curr_str in (')', ']', '}', ',', ';', '.', ':'):
            return False
        if curr_type == token.OP and curr_str in ('(', '[') and (p_type in (token.NAME, token.NUMBER, token.STRING) or p_str in (')', ']', '}')):
            return p_type == token.NAME and p_str in WORD_KEYWORDS
        if p_type == token.OP and p_str == '@':
            if len(cur_parts) == 1 and cur_parts[0] == '@':
                return False
            return True
        if p_type == token.OP and p_str == ',':
            return True
        if p_type == token.OP and p_str == ':':
            if bracket_stack and bracket_stack[-1] == '[':
                return False
            return True
        if (curr_type == token.OP and curr_str in CMP_OPS) or (p_type == token.OP and p_str in CMP_OPS):
            return True
        if curr_type == token.OP and curr_str in ASSIGN_OPS:
            return not (curr_str == '=' and paren_depth > 0)
        if p_type == token.OP and p_str in ASSIGN_OPS:
            return not (p_str == '=' and paren_depth > 0)
        if (curr_type == token.OP and curr_str == '->') or (p_type == token.OP and p_str == '->'):
            return True
        p_is_word = p_type in (token.NAME, token.NUMBER, token.STRING) or p_type == FSTRING_END
        c_is_word = curr_type in (token.NAME, token.NUMBER, token.STRING) or curr_type == FSTRING_START
        if p_is_word and c_is_word:
            return True
        if (p_type == token.NAME and p_str in WORD_KEYWORDS) or (curr_type == token.NAME and curr_str in WORD_KEYWORDS):
            return True
        return False

    i = 0
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        t_type, t_str = tok.type, tok.string

        if t_type in (tokenize.ENCODING, token.ENDMARKER):
            i += 1
            continue

        if fstring_depth > 0:
            if prev_end is not None and tok.start[0] == prev_end[0] and tok.start[1] > prev_end[1]:
                cur_parts.append(' ' * (tok.start[1] - prev_end[1]))
            elif prev_end is not None and tok.start[0] > prev_end[0]:
                cur_parts.append('\n')
            cur_parts.append(t_str)
            prev_end = tok.end
            if t_type == FSTRING_START:
                fstring_depth += 1
            elif t_type == FSTRING_END:
                fstring_depth -= 1
                prev_tok = (FSTRING_END, t_str)
                prev_unary = False
            i += 1
            continue

        if t_type == FSTRING_START:
            if needs_space_between(prev_tok, t_type, t_str):
                cur_parts.append(' ')
            cur_parts.append(t_str)
            fstring_depth = 1
            prev_end = tok.end
            i += 1
            continue

        if t_type == token.INDENT:
            indent_level += 1
            i += 1
            continue
        if t_type == token.DEDENT:
            indent_level = max(0, indent_level - 1)
            i += 1
            continue
        if t_type == token.NEWLINE:
            flush_line(force_blank=False)
            extra_suite_indents = 0
            stmt_first_kw = None
            seen_async = False
            lambda_depths.clear()
            prev_tok = None
            prev_unary = False
            i += 1
            continue
        if t_type == tokenize.NL:
            flush_line(force_blank=not bool(cur_parts))
            prev_tok = None
            prev_unary = False
            i += 1
            continue
        if t_type == tokenize.COMMENT:
            cur_parts.append(('  ' + t_str) if cur_parts else t_str)
            prev_tok = (t_type, t_str)
            i += 1
            continue

        if not cur_parts and paren_depth == 0:
            if t_type == token.OP and t_str == '@':
                maybe_blank_before_def()
            elif t_type == token.NAME and t_str in ('def', 'class', 'async'):
                if t_str in ('def', 'class') or (i + 1 < n and tokens[i + 1].string == 'def'):
                    maybe_blank_before_def()

        if paren_depth == 0 and stmt_first_kw is None:
            if t_type == token.NAME:
                if t_str == 'async' and not seen_async:
                    seen_async = True
                else:
                    stmt_first_kw = t_str
            elif t_type != tokenize.COMMENT:
                stmt_first_kw = '__expr__'

        if t_type == token.NAME and t_str == 'lambda':
            lambda_depths.append(paren_depth)

        if t_type == token.OP and t_str == ';' and paren_depth == 0:
            flush_line(force_blank=False)
            stmt_first_kw = None
            seen_async = False
            prev_tok = None
            prev_unary = False
            i += 1
            continue

        if t_type == token.OP and t_str in ('(', '[', '{'):
            if needs_space_between(prev_tok, t_type, t_str):
                cur_parts.append(' ')
            cur_parts.append(t_str)
            paren_depth += 1
            bracket_stack.append(t_str)
            prev_tok = (t_type, t_str)
            prev_unary = False
            i += 1
            continue

        if t_type == token.OP and t_str in (')', ']', '}'):
            paren_depth = max(0, paren_depth - 1)
            if bracket_stack:
                bracket_stack.pop()
            cur_parts.append(t_str)
            prev_tok = (t_type, t_str)
            prev_unary = False
            i += 1
            continue

        if t_type == token.OP and t_str == ':' and paren_depth == 0:
            if lambda_depths and lambda_depths[-1] == 0:
                lambda_depths.pop()
                cur_parts.append(': ')
                prev_tok = None
                prev_unary = False
                i += 1
                continue
            cur_parts.append(':')
            if stmt_first_kw in COMPOUND_KW:
                j = i + 1
                if j < n and tokens[j].type not in (token.NEWLINE, tokenize.NL, tokenize.COMMENT, token.ENDMARKER):
                    flush_line(force_blank=False)
                    extra_suite_indents += 1
                    stmt_first_kw = None
                    seen_async = False
                    prev_tok = None
                    prev_unary = False
                    i += 1
                    continue
            prev_tok = (t_type, t_str)
            prev_unary = False
            i += 1
            continue

        is_unary = False
        if t_type == token.OP and t_str in ('+', '-', '*', '**'):
            if prev_tok is None or (prev_tok[0] == token.OP and prev_tok[1] not in (')', ']', '}')) or (prev_tok[0] == token.NAME and prev_tok[1] in WORD_KEYWORDS):
                is_unary = True

        is_decorator_at = (t_type == token.OP and t_str == '@' and not cur_parts)

        if needs_space_between(prev_tok, t_type, t_str):
            cur_parts.append(' ')
        elif not is_unary and not is_decorator_at and t_type == token.OP and t_str in ('+', '-', '*', '/', '//', '%', '**', '@', '|', '&', '^') and prev_tok is not None:
            cur_parts.append(' ')
        elif prev_tok is not None and prev_tok[0] == token.OP and prev_tok[1] in ('+', '-', '*', '/', '//', '%', '**', '|', '&', '^') and not prev_unary:
            cur_parts.append(' ')

        cur_parts.append(t_str)
        prev_tok = (t_type, t_str)
        prev_unary = is_unary
        i += 1

    if cur_parts:
        flush_line(force_blank=False)

    res = '\n'.join(out_lines).rstrip() + '\n'
    return res

def main():
    indent_sz = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    raw = sys.stdin.buffer.read().decode('utf-8', errors='replace')
    norm = raw.replace('\r\n', '\n').replace('\r', '\n')
    if not norm.endswith('\n'):
        norm += '\n'

    orig_dump = None
    try:
        orig_dump = ast.dump(ast.parse(norm))
    except Exception:
        pass

    try:
        formatted = format_python_pep8(norm, indent_sz)
        if orig_dump is not None:
            if ast.dump(ast.parse(formatted)) == orig_dump:
                sys.stdout.buffer.write(formatted.encode('utf-8'))
                return
            fallback = reindent_only(norm, indent_sz)
            if ast.dump(ast.parse(fallback)) == orig_dump:
                sys.stdout.buffer.write(fallback.encode('utf-8'))
                return
        else:
            sys.stdout.buffer.write(formatted.encode('utf-8'))
            return
    except Exception:
        if orig_dump is not None:
            try:
                fallback = reindent_only(norm, indent_sz)
                if ast.dump(ast.parse(fallback)) == orig_dump:
                    sys.stdout.buffer.write(fallback.encode('utf-8'))
                    return
            except Exception:
                pass

    # Last resort: convert tabs to spaces & trim trailing spaces
    unit = ' ' * indent_sz
    cleaned = '\n'.join(line.replace('\t', unit).rstrip() for line in norm.splitlines()).rstrip() + '\n'
    sys.stdout.buffer.write(cleaned.encode('utf-8'))

if __name__ == '__main__':
    main()
"#;

pub fn format_code(
    language: &str,
    code: &str,
    indent_size: usize,
    custom_python: Option<&str>,
) -> Result<FormatCodeResult, String> {
    let indent = indent_size.clamp(2, 8);
    let lang = language.trim().to_ascii_lowercase();

    let (formatted, engine) = match lang.as_str() {
        "python" | "py" => format_python(code, indent, custom_python)?,
        "json" => (format_json(code, indent)?, "JSON Pretty".to_string()),
        "rust" | "rs" => format_rust(code, indent),
        "javascript" | "js" | "typescript" | "ts" | "cpp" | "c" | "powershell" | "ps1" => (
            format_brace_language(code, indent),
            "PrismStudio Brace Formatter".to_string(),
        ),
        _ => (
            normalize_whitespace(code, indent),
            "Whitespace Normalizer".to_string(),
        ),
    };

    let norm_orig = code.replace("\r\n", "\n");
    let norm_new = formatted.replace("\r\n", "\n");
    let changed = norm_orig != norm_new;

    Ok(FormatCodeResult {
        formatted: norm_new,
        changed,
        engine,
    })
}

fn format_python(
    code: &str,
    indent_size: usize,
    custom_python: Option<&str>,
) -> Result<(String, String), String> {
    let py_exe = custom_python
        .filter(|s| !s.trim().is_empty() && Path::new(s).is_file())
        .map(|s| s.to_string())
        .or_else(|| {
            discover_runtimes(None)
                .into_iter()
                .find(|r| r.language == "python")
                .map(|r| r.executable)
        });

    if let Some(exe) = py_exe {
        let mut cmd = Command::new(&exe);
        cmd.args(["-I", "-c", PYTHON_PEP8_SCRIPT, &indent_size.to_string()])
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(mut child) = cmd.spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(code.as_bytes());
            }
            if let Ok(output) = child.wait_with_output() {
                if output.status.success() && !output.stdout.is_empty() {
                    let text = String::from_utf8_lossy(&output.stdout).into_owned();
                    return Ok((text, "Python PEP-8 (AST Verified)".to_string()));
                }
            }
        }
    }

    Ok((
        format_python_fallback_rust(code, indent_size),
        "Python Indent Normalizer".to_string(),
    ))
}

/// Pure-Rust fallback if no Python interpreter exists on the machine:
/// Detects indent step (e.g. 1-space or 2-space) and rescales leading indentation to `indent_size`.
fn format_python_fallback_rust(code: &str, indent_size: usize) -> String {
    let unit = " ".repeat(indent_size);
    let normalized = code.replace("\r\n", "\n").replace('\t', &unit);
    let lines: Vec<&str> = normalized.lines().collect();

    // Detect minimum positive leading space count (e.g., 1 for 1-space indented files)
    let mut min_indent: Option<usize> = None;
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let spaces = line.bytes().take_while(|&b| b == b' ').count();
        if spaces > 0 {
            min_indent = Some(min_indent.map_or(spaces, |m| m.min(spaces)));
        }
    }

    let step = min_indent.unwrap_or(indent_size).max(1);
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let spaces = trimmed.bytes().take_while(|&b| b == b' ').count();
        let rest = &trimmed[spaces..];
        let level = if step < indent_size {
            spaces / step
        } else {
            spaces / indent_size
        };
        out.push(format!("{}{}", unit.repeat(level), rest));
    }
    let mut res = out.join("\n");
    res.push('\n');
    res
}

fn format_json(code: &str, indent_size: usize) -> Result<String, String> {
    let val: serde_json::Value =
        serde_json::from_str(code).map_err(|e| format!("JSON 语法有误，无法格式化：{e}"))?;
    let indent_bytes = vec![b' '; indent_size];
    let formatter = serde_json::ser::PrettyFormatter::with_indent(&indent_bytes);
    let mut buf = Vec::with_capacity(code.len() + 64);
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(&val, &mut ser)
        .map_err(|e| format!("序列化 JSON 失败：{e}"))?;
    let mut out = String::from_utf8(buf).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

fn format_rust(code: &str, indent_size: usize) -> (String, String) {
    let mut cmd = Command::new("rustfmt");
    cmd.args([
        "--edition",
        "2021",
        "--config",
        &format!("tab_spaces={indent_size}"),
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(mut child) = cmd.spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(code.as_bytes());
        }
        if let Ok(out) = child.wait_with_output() {
            if out.status.success() && !out.stdout.is_empty() {
                return (
                    String::from_utf8_lossy(&out.stdout).into_owned(),
                    "rustfmt".to_string(),
                );
            }
        }
    }

    (
        format_brace_language(code, indent_size),
        "PrismStudio Brace Formatter".to_string(),
    )
}

/// Token-aware brace & semicolon formatter for JS / TS / C / C++ / PowerShell.
pub fn format_brace_language(code: &str, indent_size: usize) -> String {
    let unit = " ".repeat(indent_size);
    let src = code.replace("\r\n", "\n").replace('\r', "\n");
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();

    // Pass 1: expand compacted `{`, `}`, and top-level `;` outside strings/comments
    let mut expanded = String::with_capacity(src.len() + 128);
    let mut i = 0;
    let mut paren_depth: usize = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();

        if in_line_comment {
            expanded.push(c);
            if c == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            expanded.push(c);
            if c == '*' && next == Some('/') {
                expanded.push('/');
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if in_single {
            expanded.push(c);
            if c == '\\' && next.is_some() {
                expanded.push(next.unwrap());
                i += 2;
                continue;
            }
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            expanded.push(c);
            if c == '\\' && next.is_some() {
                expanded.push(next.unwrap());
                i += 2;
                continue;
            }
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if in_backtick {
            expanded.push(c);
            if c == '\\' && next.is_some() {
                expanded.push(next.unwrap());
                i += 2;
                continue;
            }
            if c == '`' {
                in_backtick = false;
            }
            i += 1;
            continue;
        }

        if c == '/' && next == Some('/') {
            in_line_comment = true;
            expanded.push_str("//");
            i += 2;
            continue;
        }
        if c == '/' && next == Some('*') {
            in_block_comment = true;
            expanded.push_str("/*");
            i += 2;
            continue;
        }
        if c == '\'' {
            in_single = true;
            expanded.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            in_double = true;
            expanded.push(c);
            i += 1;
            continue;
        }
        if c == '`' {
            in_backtick = true;
            expanded.push(c);
            i += 1;
            continue;
        }

        if c == '(' || c == '[' {
            paren_depth += 1;
            expanded.push(c);
            i += 1;
            continue;
        }
        if c == ')' || c == ']' {
            paren_depth = paren_depth.saturating_sub(1);
            expanded.push(c);
            i += 1;
            continue;
        }

        if c == '{' && paren_depth == 0 {
            if next == Some('}') {
                expanded.push_str("{}");
                i += 2;
                continue;
            }
            if !expanded.ends_with(' ') && !expanded.ends_with('\n') && !expanded.is_empty() {
                expanded.push(' ');
            }
            expanded.push('{');
            if next != Some('\n') {
                expanded.push('\n');
            }
            i += 1;
            continue;
        }

        if c == '}' && paren_depth == 0 {
            if !expanded.ends_with('\n') {
                expanded.push('\n');
            }
            expanded.push('}');
            if let Some(nc) = next {
                if nc != '\n' && nc != ';' && nc != ',' && nc != ')' {
                    expanded.push('\n');
                }
            }
            i += 1;
            continue;
        }

        if c == ';' && paren_depth == 0 {
            expanded.push(';');
            if let Some(nc) = next {
                if nc != '\n' && nc != '/' {
                    expanded.push('\n');
                }
            }
            i += 1;
            continue;
        }

        expanded.push(c);
        i += 1;
    }

    // Pass 2: indent each line cleanly by brace depth
    let mut depth: usize = 0;
    let mut out_lines: Vec<String> = Vec::new();
    for raw_line in expanded.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            if out_lines.last().map(|s| !s.is_empty()).unwrap_or(false) {
                out_lines.push(String::new());
            }
            continue;
        }

        let leading_closers = trimmed
            .chars()
            .take_while(|&ch| ch == '}' || ch == ')' || ch == ']')
            .count();
        let line_depth = depth.saturating_sub(leading_closers);
        out_lines.push(format!("{}{}", unit.repeat(line_depth), trimmed));

        // Update depth for next line (ignoring braces inside quotes/comments)
        let net = count_net_braces(trimmed);
        if net >= 0 {
            depth = depth.saturating_add(net as usize);
        } else {
            depth = depth.saturating_sub((-net) as usize);
        }
    }

    let mut res = out_lines.join("\n").trim_end().to_string();
    res.push('\n');
    res
}

fn count_net_braces(line: &str) -> isize {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut delta: isize = 0;
    let mut in_q: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if let Some(q) = in_q {
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == q {
                in_q = None;
            }
            i += 1;
            continue;
        }
        if c == '/' && next == Some('/') {
            break;
        }
        if c == '\'' || c == '"' || c == '`' {
            in_q = Some(c);
            i += 1;
            continue;
        }
        if c == '{' {
            delta += 1;
        } else if c == '}' {
            delta -= 1;
        }
        i += 1;
    }
    delta
}

fn normalize_whitespace(code: &str, indent_size: usize) -> String {
    let unit = " ".repeat(indent_size);
    let mut out: Vec<String> = code
        .replace("\r\n", "\n")
        .lines()
        .map(|l| l.replace('\t', &unit).trim_end().to_string())
        .collect();
    while out.last().map(|s| s.is_empty()).unwrap_or(false) {
        out.pop();
    }
    let mut res = out.join("\n");
    res.push('\n');
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_json_cleanly() {
        let raw = r#"{"name":"DocPrism","list":[1,2,3]}"#;
        let res = format_code("json", raw, 4, None).unwrap();
        assert!(res.changed);
        assert!(res.formatted.contains("    \"name\": \"DocPrism\""));
    }

    #[test]
    fn formats_compacted_js_braces_and_semicolons() {
        let raw = "function add(a,b){const s=a+b;if(s>0){return s;}return 0;}";
        let res = format_code("javascript", raw, 4, None).unwrap();
        assert!(res.changed);
        assert!(res.formatted.contains("    const s=a+b;\n    if(s>0) {\n        return s;\n    }"));
    }

    #[test]
    fn formats_compacted_1space_python_with_ast_verification() {
        let raw = "def f(x):\n y=x+1;z=y*2\n if z>0:return z\n return 0\n";
        let res = format_code("python", raw, 4, None).unwrap();
        assert!(res.changed);
        assert!(res.formatted.contains("    y = x + 1\n    z = y * 2\n    if z > 0:\n        return z"));
    }
}
