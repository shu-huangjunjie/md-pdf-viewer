use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{State, WebviewWindow};

use crate::asset_server::AssetServer;
use crate::formatter::{format_code, FormatCodeResult};
use crate::paths::{normalize_windows_path, to_slash_path, AppPaths, UserPreferences};
use crate::runner::{discover_runtimes, RunCodeRequest, RuntimeProfile};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub asset_base_url: String,
    pub is_portable: bool,
    pub preferences: UserPreferences,
    pub cli_files: Vec<String>,
    pub runtimes: Vec<RuntimeProfile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub slash_path: String,
    pub kind: String, // "folder" | "markdown" | "pdf" | "html" | "code"
    pub language: Option<String>,
    pub size_bytes: u64,
    pub children: Vec<FileTreeNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentPayload {
    pub name: String,
    pub path: String,
    pub slash_path: String,
    pub parent_slash_path: String,
    pub language: String,
    pub content: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub name: String,
    pub path: String,
    pub slash_path: String,
    pub kind: String, // "folder" | "markdown" | "pdf" | "html" | "code"
    pub language: Option<String>,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub slash_path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchHit {
    pub path: String,
    pub slash_path: String,
    pub name: String,
    pub kind: String,
    pub language: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionSymbolItem {
    pub label: String,
    pub kind: String, // "function" | "class" | "variable" | "module" | "property" | "constant"
    pub detail: Option<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModuleSymbols {
    pub module_name: String,
    pub file_path: String,
    pub symbols: Vec<CompletionSymbolItem>,
}

async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("后台任务执行异常：{e}"))?
}

/// Returns `(kind, language)` if the file is supported in the workspace explorer.
fn classify_extension(path: &Path) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => Some(("markdown", "markdown")),
        "pdf" => Some(("pdf", "pdf")),
        "html" | "htm" => Some(("html", "html")),
        "py" | "pyw" => Some(("code", "python")),
        "js" | "mjs" | "cjs" | "jsx" => Some(("code", "javascript")),
        "ts" | "tsx" => Some(("code", "typescript")),
        "ps1" => Some(("code", "powershell")),
        "bat" | "cmd" => Some(("code", "batch")),
        "sh" | "bash" => Some(("code", "shell")),
        "rs" => Some(("code", "rust")),
        "json" | "jsonl" => Some(("code", "json")),
        "toml" | "yaml" | "yml" | "ini" | "cfg" => Some(("code", "toml")),
        "c" | "cpp" | "cc" | "h" | "hpp" => Some(("code", "cpp")),
        "sql" => Some(("code", "sql")),
        "txt" => Some(("code", "text")),
        _ => None,
    }
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | ".cargo"
            | ".playwright-mcp"
            | "releases"
    ) || name.starts_with('.')
}

#[tauri::command]
pub async fn get_bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let paths: AppPaths = state.paths.clone();
    let server: AssetServer = state.asset_server.clone();

    run_blocking(move || {
        let prefs = paths.load_preferences();
        if let Some(ref ws) = prefs.last_workspace {
            let p = PathBuf::from(ws);
            if p.is_dir() {
                server.authorize_dir(&p);
            }
        }
        for b in &prefs.bookmarks {
            let p = PathBuf::from(b);
            if p.is_dir() {
                server.authorize_dir(&p);
            }
        }

        let mut cli_files = Vec::new();
        let raw_args: Vec<String> = std::env::args().collect();
        let mut arg_idx = 1;
        while arg_idx < raw_args.len() {
            let arg = &raw_args[arg_idx];
            if arg == "--bridge-handoff" {
                arg_idx += 2;
                continue;
            }
            if arg.starts_with('-') {
                arg_idx += 1;
                continue;
            }
            let cleaned = normalize_windows_path(arg);
            let p = PathBuf::from(&cleaned);
            if p.exists() {
                if p.is_file() && classify_extension(&p).is_some() {
                    server.authorize_file_context(&p);
                    cli_files.push(cleaned);
                } else if p.is_dir() {
                    server.authorize_dir(&p);
                    cli_files.push(cleaned);
                }
            }
            arg_idx += 1;
        }

        let runtimes = discover_runtimes(prefs.last_workspace.as_deref());

        Ok(BootstrapPayload {
            asset_base_url: server.base_url(),
            is_portable: paths.is_portable,
            preferences: prefs,
            cli_files,
            runtimes,
        })
    })
    .await
}

#[tauri::command]
pub async fn list_runtimes(workspace_dir: Option<String>) -> Result<Vec<RuntimeProfile>, String> {
    run_blocking(move || Ok(discover_runtimes(workspace_dir.as_deref()))).await
}

#[tauri::command]
pub async fn start_code_run(
    window: WebviewWindow,
    request: RunCodeRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.runner.start_run(window, request)
}

#[tauri::command]
pub async fn stop_code_run(run_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let runner = state.runner.clone();
    run_blocking(move || runner.stop_run(&run_id)).await
}

#[tauri::command]
pub async fn format_code_document(
    language: String,
    code: String,
    indent_size: Option<usize>,
    custom_python: Option<String>,
) -> Result<FormatCodeResult, String> {
    run_blocking(move || {
        format_code(
            &language,
            &code,
            indent_size.unwrap_or(4),
            custom_python.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn pick_workspace_folder(
    window: WebviewWindow,
    initial_dir: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let dir = initial_dir.unwrap_or_default();
        let server = state.asset_server.clone();
        run_blocking(move || {
            let picked = crate::dialogs::pick_folder(hwnd, dir)?;
            if let Some(ref folder) = picked {
                server.authorize_dir(Path::new(folder));
            }
            Ok(picked)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, initial_dir, state);
        Err("当前仅支持 Windows 原生对话框".into())
    }
}

#[tauri::command]
pub async fn pick_document_file(
    window: WebviewWindow,
    initial_dir: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<FileDescriptor>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let dir = initial_dir.unwrap_or_default();
        let server = state.asset_server.clone();
        run_blocking(move || {
            let picked = crate::dialogs::pick_document(hwnd, dir)?;
            match picked {
                Some(path_str) => inspect_file_internal(&path_str, &server).map(Some),
                None => Ok(None),
            }
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, initial_dir, state);
        Err("当前仅支持 Windows 原生对话框".into())
    }
}

#[tauri::command]
pub async fn pick_save_document(
    window: WebviewWindow,
    initial_dir: Option<String>,
    default_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let dir = initial_dir.unwrap_or_default();
        let def_name = default_name.unwrap_or_else(|| "untitled.py".into());
        let server = state.asset_server.clone();
        run_blocking(move || {
            let picked = crate::dialogs::pick_save_file(hwnd, dir, def_name)?;
            if let Some(ref p) = picked {
                server.authorize_file_context(Path::new(p));
            }
            Ok(picked)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, initial_dir, default_name, state);
        Err("当前仅支持 Windows 原生对话框".into())
    }
}

#[tauri::command]
pub async fn inspect_path(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<FileDescriptor>, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let cleaned = normalize_windows_path(&path);
        let p = Path::new(&cleaned);
        if !p.exists() {
            return Ok(None);
        }
        if p.is_dir() {
            server.authorize_dir(p);
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&cleaned)
                .to_string();
            let slash_path = to_slash_path(p);
            return Ok(Some(FileDescriptor {
                name,
                path: cleaned,
                slash_path,
                kind: "folder".to_string(),
                language: None,
                size_bytes: 0,
                modified_ms: 0,
            }));
        }
        inspect_file_internal(&cleaned, &server).map(Some)
    })
    .await
}

fn inspect_file_internal(path_str: &str, server: &AssetServer) -> Result<FileDescriptor, String> {
    let cleaned = normalize_windows_path(path_str);
    let p = Path::new(&cleaned);
    if !p.is_file() {
        return Err(format!("文件不存在：{}", cleaned));
    }
    let (kind, lang) = classify_extension(p).unwrap_or(("code", "text"));
    server.authorize_file_context(p);

    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取文件信息：{e}"))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&cleaned)
        .to_string();
    let slash_path = to_slash_path(p);

    Ok(FileDescriptor {
        name,
        path: cleaned,
        slash_path,
        kind: kind.to_string(),
        language: Some(lang.to_string()),
        size_bytes: meta.len(),
        modified_ms,
    })
}

#[tauri::command]
pub async fn scan_workspace(
    folder_path: String,
    state: State<'_, AppState>,
) -> Result<FileTreeNode, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let cleaned = normalize_windows_path(&folder_path);
        let root = Path::new(&cleaned);
        if !root.is_dir() {
            return Err(format!("文件夹不存在：{}", cleaned));
        }
        server.authorize_dir(root);
        let mut budget: usize = 10000;
        let children = scan_dir_recursive(root, 0, &mut budget);
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cleaned)
            .to_string();
        let slash_path = to_slash_path(root);

        Ok(FileTreeNode {
            name,
            path: cleaned,
            slash_path,
            kind: "folder".to_string(),
            language: None,
            size_bytes: 0,
            children,
        })
    })
    .await
}

fn scan_dir_recursive(dir: &Path, depth: usize, budget: &mut usize) -> Vec<FileTreeNode> {
    if depth > 12 || *budget == 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        let path = entry.path();
        let Some(name_str) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if should_skip_dir(name_str) {
                continue;
            }
            *budget = budget.saturating_sub(1);
            let children = scan_dir_recursive(&path, depth + 1, budget);
            nodes.push(FileTreeNode {
                name: name_str.to_string(),
                path: normalize_windows_path(&path.to_string_lossy()),
                slash_path: to_slash_path(&path),
                kind: "folder".to_string(),
                language: None,
                size_bytes: 0,
                children,
            });
        } else if ft.is_file() {
            if let Some((kind, lang)) = classify_extension(&path) {
                *budget = budget.saturating_sub(1);
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                nodes.push(FileTreeNode {
                    name: name_str.to_string(),
                    path: normalize_windows_path(&path.to_string_lossy()),
                    slash_path: to_slash_path(&path),
                    kind: kind.to_string(),
                    language: Some(lang.to_string()),
                    size_bytes,
                    children: Vec::new(),
                });
            }
        }
    }

    nodes.sort_by(|a, b| {
        let a_is_dir = a.kind == "folder";
        let b_is_dir = b.kind == "folder";
        match (a_is_dir, b_is_dir) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    nodes
}

#[tauri::command]
pub async fn read_markdown_document(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<TextDocumentPayload, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let cleaned = normalize_windows_path(&file_path);
        let path = Path::new(&cleaned);
        if !path.is_file() {
            return Err(format!("找不到文件：{}", cleaned));
        }
        server.authorize_file_context(path);

        let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
        let slice = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        let content = crate::runner::decode_console_bytes(slice);

        let meta = std::fs::metadata(path).map_err(|e| format!("读取元数据失败：{e}"))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let (_, lang) = classify_extension(path).unwrap_or(("code", "text"));
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cleaned)
            .to_string();
        let parent_slash = path.parent().map(to_slash_path).unwrap_or_default();
        let slash_path = to_slash_path(path);

        Ok(TextDocumentPayload {
            name,
            path: cleaned,
            slash_path,
            parent_slash_path: parent_slash,
            language: lang.to_string(),
            content,
            size_bytes: meta.len(),
            modified_ms,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_text_document(
    file_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<SaveResult, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let cleaned = normalize_windows_path(&file_path);
        let path = Path::new(&cleaned);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        std::fs::write(path, content.as_bytes()).map_err(|e| format!("保存文件失败：{e}"))?;
        server.authorize_file_context(path);

        let meta = std::fs::metadata(path).map_err(|e| format!("读取保存结果失败：{e}"))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cleaned)
            .to_string();
        let slash_path = to_slash_path(path);

        Ok(SaveResult {
            path: cleaned,
            slash_path,
            name,
            size_bytes: meta.len(),
            modified_ms,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_preferences(
    preferences: UserPreferences,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let paths = state.paths.clone();
    run_blocking(move || paths.save_preferences(&preferences)).await
}

#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    run_blocking(move || {
        let cleaned = normalize_windows_path(&path);
        let p = Path::new(&cleaned);
        #[cfg(windows)]
        {
            if p.is_dir() {
                std::process::Command::new("explorer.exe")
                    .arg(&cleaned)
                    .spawn()
                    .map_err(|e| format!("无法打开资源管理器：{e}"))?;
            } else {
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,{}", cleaned))
                    .spawn()
                    .map_err(|e| format!("无法定位文件：{e}"))?;
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = p;
            Ok(())
        }
    })
    .await
}

fn validate_single_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".into());
    }
    if trimmed.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || trimmed == "." || trimmed == ".." {
        return Err("名称包含非法字符".into());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn create_workspace_item(
    parent_dir: String,
    name: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<FileDescriptor, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let valid_name = validate_single_name(&name)?;
        let parent_clean = normalize_windows_path(&parent_dir);
        let parent_path = Path::new(&parent_clean);
        if !parent_path.is_dir() {
            return Err(format!("目标目录不存在：{parent_clean}"));
        }
        let target = parent_path.join(&valid_name);
        if target.exists() {
            return Err(format!("已存在同名文件或文件夹：{valid_name}"));
        }
        if is_dir {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败：{e}"))?;
            server.authorize_dir(&target);
            let target_clean = normalize_windows_path(&target.to_string_lossy());
            let slash_path = to_slash_path(&target);
            Ok(FileDescriptor {
                name: valid_name,
                path: target_clean,
                slash_path,
                kind: "folder".to_string(),
                language: None,
                size_bytes: 0,
                modified_ms: 0,
            })
        } else {
            // Create a clean 0-byte empty file; the editor displays a non-intrusive gray placeholder
            std::fs::write(&target, b"").map_err(|e| format!("创建文件失败：{e}"))?;
            inspect_file_internal(&target.to_string_lossy(), &server)
        }
    })
    .await
}

#[tauri::command]
pub async fn rename_workspace_item(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<FileDescriptor, String> {
    let server = state.asset_server.clone();
    run_blocking(move || {
        let valid_name = validate_single_name(&new_name)?;
        let old_clean = normalize_windows_path(&old_path);
        let old_p = Path::new(&old_clean);
        if !old_p.exists() {
            return Err(format!("原路径不存在：{old_clean}"));
        }
        let parent = old_p.parent().ok_or_else(|| "无法重命名根目录".to_string())?;
        let new_p = parent.join(&valid_name);
        if new_p.exists() && new_p != old_p {
            return Err(format!("已存在同名项：{valid_name}"));
        }
        std::fs::rename(old_p, &new_p).map_err(|e| format!("重命名失败：{e}"))?;
        if new_p.is_dir() {
            server.authorize_dir(&new_p);
            let new_clean = normalize_windows_path(&new_p.to_string_lossy());
            let slash_path = to_slash_path(&new_p);
            Ok(FileDescriptor {
                name: valid_name,
                path: new_clean,
                slash_path,
                kind: "folder".to_string(),
                language: None,
                size_bytes: 0,
                modified_ms: 0,
            })
        } else {
            inspect_file_internal(&new_p.to_string_lossy(), &server)
        }
    })
    .await
}

#[tauri::command]
pub async fn delete_workspace_item(path: String) -> Result<(), String> {
    run_blocking(move || {
        let cleaned = normalize_windows_path(&path);
        let p = Path::new(&cleaned);
        if !p.exists() {
            return Ok(());
        }
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| format!("删除文件夹失败：{e}"))?;
        } else {
            std::fs::remove_file(p).map_err(|e| format!("删除文件失败：{e}"))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn search_in_workspace(
    folder_path: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<Vec<WorkspaceSearchHit>, String> {
    run_blocking(move || {
        let q_trimmed = query.trim();
        if q_trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let cleaned = normalize_windows_path(&folder_path);
        let root = Path::new(&cleaned);
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let cs = case_sensitive.unwrap_or(false);
        let q_cmp = if cs {
            q_trimmed.to_string()
        } else {
            q_trimmed.to_lowercase()
        };
        let mut hits = Vec::new();
        let mut file_budget: usize = 2500;
        search_dir_recursive(root, 0, &q_cmp, cs, &mut file_budget, &mut hits);
        Ok(hits)
    })
    .await
}

fn search_dir_recursive(
    dir: &Path,
    depth: usize,
    q_cmp: &str,
    case_sensitive: bool,
    file_budget: &mut usize,
    hits: &mut Vec<WorkspaceSearchHit>,
) {
    if depth > 10 || *file_budget == 0 || hits.len() >= 200 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *file_budget == 0 || hits.len() >= 200 {
            break;
        }
        let path = entry.path();
        let Some(name_str) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if should_skip_dir(name_str) {
                continue;
            }
            search_dir_recursive(&path, depth + 1, q_cmp, case_sensitive, file_budget, hits);
        } else if ft.is_file() {
            let Some((kind, lang)) = classify_extension(&path) else {
                continue;
            };
            if kind == "pdf" {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > 2 * 1024 * 1024 {
                continue;
            }
            *file_budget = file_budget.saturating_sub(1);
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.iter().take(512).any(|&b| b == 0) {
                continue;
            }
            let content = crate::runner::decode_console_bytes(&bytes);
            let clean_path = normalize_windows_path(&path.to_string_lossy());
            let slash_path = to_slash_path(&path);

            for (idx, line_text) in content.lines().enumerate() {
                let matched = if case_sensitive {
                    line_text.contains(q_cmp)
                } else {
                    line_text.to_lowercase().contains(q_cmp)
                };
                if matched {
                    let preview: String = line_text.trim().chars().take(120).collect();
                    hits.push(WorkspaceSearchHit {
                        path: clean_path.clone(),
                        slash_path: slash_path.clone(),
                        name: name_str.to_string(),
                        kind: kind.to_string(),
                        language: lang.to_string(),
                        line: idx + 1,
                        preview,
                    });
                    if hits.len() >= 200 {
                        break;
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn scan_sibling_code_symbols(
    file_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<Vec<ExternalModuleSymbols>, String> {
    run_blocking(move || Ok(scan_sibling_code_symbols_sync(file_path, workspace_dir))).await
}

fn scan_sibling_code_symbols_sync(
    file_path: Option<String>,
    workspace_dir: Option<String>,
) -> Vec<ExternalModuleSymbols> {
    let mut dirs_to_scan: Vec<PathBuf> = Vec::new();
    let mut seen_dirs: HashSet<String> = HashSet::new();

    let mut push_dir = |d: &Path| {
        if d.is_dir() {
            let key = normalize_windows_path(&d.to_string_lossy()).to_ascii_lowercase();
            if seen_dirs.insert(key) {
                dirs_to_scan.push(d.to_path_buf());
            }
        }
    };

    let active_clean = file_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| normalize_windows_path(s).to_ascii_lowercase());

    if let Some(ref fp) = file_path {
        let cleaned = normalize_windows_path(fp);
        if let Some(parent) = Path::new(&cleaned).parent() {
            push_dir(parent);
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten().take(20) {
                    let sub = entry.path();
                    if sub.is_dir() {
                        if let Some(name) = sub.file_name().and_then(|n| n.to_str()) {
                            if !should_skip_dir(name) {
                                push_dir(&sub);
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(ref ws) = workspace_dir {
        let cleaned = normalize_windows_path(ws);
        let root = Path::new(&cleaned);
        push_dir(root);
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten().take(25) {
                let sub = entry.path();
                if sub.is_dir() {
                    if let Some(name) = sub.file_name().and_then(|n| n.to_str()) {
                        if !should_skip_dir(name) {
                            push_dir(&sub);
                        }
                    }
                }
            }
        }
    }

    let mut results: Vec<ExternalModuleSymbols> = Vec::new();
    let mut seen_modules: HashSet<String> = HashSet::new();
    let mut file_budget: usize = 65;

    for dir in dirs_to_scan {
        if file_budget == 0 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if file_budget == 0 {
                break;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()) else {
                continue;
            };
            if !matches!(
                ext.as_str(),
                "py" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "rs"
            ) {
                continue;
            }
            let clean_file = normalize_windows_path(&path.to_string_lossy());
            if let Some(ref active) = active_clean {
                if clean_file.to_ascii_lowercase() == *active {
                    continue;
                }
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > 512 * 1024 {
                continue;
            }

            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let module_name = if stem == "__init__" {
                path.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .unwrap_or("__init__")
                    .to_string()
            } else {
                stem.to_string()
            };
            if module_name.starts_with('_') && stem != "__init__" {
                continue;
            }
            if !seen_modules.insert(module_name.clone()) {
                continue;
            }

            file_budget = file_budget.saturating_sub(1);
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let content = crate::runner::decode_console_bytes(&bytes);
            let symbols = extract_file_completion_symbols(&content, &ext);
            results.push(ExternalModuleSymbols {
                module_name,
                file_path: clean_file,
                symbols,
            });
        }
    }

    results
}

fn extract_file_completion_symbols(content: &str, ext: &str) -> Vec<CompletionSymbolItem> {
    let mut items: Vec<CompletionSymbolItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let lines: Vec<&str> = content.lines().collect();

    if ext == "py" {
        let mut i = 0;
        while i < lines.len() && items.len() < 160 {
            let line = lines[i];
            let trimmed = line.trim();
            // Only extract top-level definitions (0 leading indent)
            let is_top_level = !line.starts_with(' ') && !line.starts_with('\t');
            if is_top_level && !trimmed.is_empty() && !trimmed.starts_with('#') {
                if let Some(rest) = trimmed
                    .strip_prefix("def ")
                    .or_else(|| trimmed.strip_prefix("async def "))
                {
                    if let Some(open_idx) = rest.find('(') {
                        let name = rest[..open_idx].trim();
                        if !name.is_empty() && !name.starts_with('_') && seen.insert(name.to_string()) {
                            let mut sig_buf = rest[open_idx..].to_string();
                            let mut look = i + 1;
                            while !sig_buf.contains(')') && look < lines.len() && look <= i + 5 {
                                sig_buf.push(' ');
                                sig_buf.push_str(lines[look].trim());
                                look += 1;
                            }
                            let detail = if let Some(close_idx) = sig_buf.find(')') {
                                sig_buf[..=close_idx].chars().take(90).collect::<String>()
                            } else {
                                "()".to_string()
                            };
                            let doc = extract_python_docstring(&lines, look);
                            items.push(CompletionSymbolItem {
                                label: name.to_string(),
                                kind: "function".to_string(),
                                detail: Some(detail),
                                doc,
                            });
                        }
                    }
                } else if let Some(rest) = trimmed.strip_prefix("class ") {
                    let end_idx = rest.find(['(', ':']).unwrap_or(rest.len());
                    let name = rest[..end_idx].trim();
                    if !name.is_empty() && !name.starts_with('_') && seen.insert(name.to_string()) {
                        let detail = rest
                            .trim_end_matches(':')
                            .trim()
                            .chars()
                            .take(80)
                            .collect::<String>();
                        let doc = extract_python_docstring(&lines, i + 1);
                        items.push(CompletionSymbolItem {
                            label: name.to_string(),
                            kind: "class".to_string(),
                            detail: Some(format!("class {detail}")),
                            doc,
                        });
                    }
                } else if let Some(eq_idx) = trimmed.find('=') {
                    if !trimmed[..eq_idx].contains(['(', ')', '.', '[', ':', '!', '<', '>']) {
                        let lhs = trimmed[..eq_idx].trim();
                        if !lhs.is_empty()
                            && !lhs.starts_with('_')
                            && lhs.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                            && seen.insert(lhs.to_string())
                        {
                            let rhs_preview: String = trimmed[eq_idx + 1..]
                                .trim()
                                .chars()
                                .take(50)
                                .collect();
                            let kind = if lhs.chars().any(|c| c.is_ascii_uppercase())
                                && !lhs.chars().any(|c| c.is_ascii_lowercase())
                            {
                                "constant"
                            } else {
                                "variable"
                            };
                            items.push(CompletionSymbolItem {
                                label: lhs.to_string(),
                                kind: kind.to_string(),
                                detail: Some(rhs_preview),
                                doc: None,
                            });
                        }
                    }
                }
            }
            i += 1;
        }
    } else if matches!(ext, "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx") {
        for line in &lines {
            if items.len() >= 160 {
                break;
            }
            let t = line.trim().trim_start_matches("export ").trim_start_matches("default ").trim();
            if let Some(rest) = t.strip_prefix("function ").or_else(|| t.strip_prefix("async function ")) {
                if let Some(open_idx) = rest.find(['(', '<']) {
                    let name = rest[..open_idx].trim();
                    if !name.is_empty() && seen.insert(name.to_string()) {
                        let sig = rest[open_idx..]
                            .trim_end_matches('{')
                            .trim()
                            .chars()
                            .take(80)
                            .collect::<String>();
                        items.push(CompletionSymbolItem {
                            label: name.to_string(),
                            kind: "function".to_string(),
                            detail: Some(sig),
                            doc: None,
                        });
                    }
                }
            } else if let Some(rest) = t.strip_prefix("class ").or_else(|| t.strip_prefix("interface ")) {
                let end = rest.find([' ', '{', '<']).unwrap_or(rest.len());
                let name = rest[..end].trim();
                if !name.is_empty() && seen.insert(name.to_string()) {
                    items.push(CompletionSymbolItem {
                        label: name.to_string(),
                        kind: "class".to_string(),
                        detail: Some(format!("class {name}")),
                        doc: None,
                    });
                }
            } else if let Some(rest) = t.strip_prefix("const ").or_else(|| t.strip_prefix("let ")) {
                let end = rest.find([':', '=', ' ']).unwrap_or(rest.len());
                let name = rest[..end].trim();
                if !name.is_empty()
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
                    && seen.insert(name.to_string())
                {
                    items.push(CompletionSymbolItem {
                        label: name.to_string(),
                        kind: "variable".to_string(),
                        detail: None,
                        doc: None,
                    });
                }
            }
        }
    } else if ext == "rs" {
        for line in &lines {
            if items.len() >= 160 {
                break;
            }
            let t = line.trim().trim_start_matches("pub ").trim_start_matches("async ").trim();
            if let Some(rest) = t.strip_prefix("fn ") {
                if let Some(open_idx) = rest.find(['(', '<']) {
                    let name = rest[..open_idx].trim();
                    if !name.is_empty() && seen.insert(name.to_string()) {
                        let sig = rest[open_idx..]
                            .trim_end_matches('{')
                            .trim()
                            .chars()
                            .take(80)
                            .collect::<String>();
                        items.push(CompletionSymbolItem {
                            label: name.to_string(),
                            kind: "function".to_string(),
                            detail: Some(sig),
                            doc: None,
                        });
                    }
                }
            } else if let Some(rest) = t
                .strip_prefix("struct ")
                .or_else(|| t.strip_prefix("enum "))
                .or_else(|| t.strip_prefix("trait "))
            {
                let end = rest.find([' ', '{', '<', '(']).unwrap_or(rest.len());
                let name = rest[..end].trim();
                if !name.is_empty() && seen.insert(name.to_string()) {
                    items.push(CompletionSymbolItem {
                        label: name.to_string(),
                        kind: "class".to_string(),
                        detail: Some(name.to_string()),
                        doc: None,
                    });
                }
            }
        }
    }

    items
}

fn extract_python_docstring(lines: &[&str], start_line: usize) -> Option<String> {
    for idx in start_line..lines.len().min(start_line + 3) {
        let t = lines[idx].trim();
        if t.is_empty() {
            continue;
        }
        for quote in ["\"\"\"", "'''"] {
            if let Some(rest) = t.strip_prefix(quote) {
                let clean = rest.trim_end_matches(quote).trim();
                if !clean.is_empty() {
                    return Some(clean.chars().take(120).collect());
                }
                if idx + 1 < lines.len() {
                    let next_clean = lines[idx + 1].trim().trim_end_matches(quote).trim();
                    if !next_clean.is_empty() {
                        return Some(next_clean.chars().take(120).collect());
                    }
                }
                return None;
            }
        }
        break;
    }
    None
}

static PYTHON_MODULE_CACHE: OnceLock<Mutex<HashMap<String, Vec<CompletionSymbolItem>>>> =
    OnceLock::new();

const PY_INSPECT_SNIPPET: &str = r#"
import sys, io, json, importlib, inspect

mod_name = sys.argv[1]
extra_dirs = [p for p in sys.argv[2:] if p]
for p in reversed(extra_dirs):
    if p not in sys.path:
        sys.path.insert(0, p)

_orig_out = sys.stdout
sys.stdout = io.StringIO()
try:
    mod = importlib.import_module(mod_name)
except Exception:
    _orig_out.write("__DP_SYM__[]")
    sys.exit(0)
finally:
    sys.stdout = _orig_out

items = []
for name in dir(mod):
    if name.startswith("_"):
        continue
    try:
        obj = getattr(mod, name)
    except Exception:
        continue
    kind = "property"
    detail = None
    doc = None
    if inspect.isclass(obj):
        kind = "class"
    elif callable(obj):
        kind = "function"
    elif inspect.ismodule(obj):
        kind = "module"
    elif name.isupper():
        kind = "constant"
    if kind in ("function", "class"):
        try:
            detail = str(inspect.signature(obj))[:90]
        except Exception:
            detail = "()" if kind == "function" else f"class {name}"
    else:
        detail = type(obj).__name__
    try:
        raw_doc = inspect.getdoc(obj)
        if raw_doc:
            first = next((ln.strip() for ln in raw_doc.splitlines() if ln.strip()), "")
            if first:
                doc = first[:120]
    except Exception:
        pass
    items.append({"label": name, "kind": kind, "detail": detail, "doc": doc})
    if len(items) >= 240:
        break

_orig_out.write("__DP_SYM__" + json.dumps(items, ensure_ascii=False))
"#;

#[tauri::command]
pub async fn inspect_python_module(
    module_name: String,
    custom_python: Option<String>,
    file_path: Option<String>,
    workspace_dir: Option<String>,
) -> Result<Vec<CompletionSymbolItem>, String> {
    run_blocking(move || {
        let trimmed = module_name.trim();
        if trimmed.is_empty()
            || trimmed.len() > 80
            || trimmed.starts_with('.')
            || trimmed.ends_with('.')
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
        {
            return Ok(Vec::new());
        }

        let py_exe = custom_python
            .filter(|p| !p.trim().is_empty() && crate::runner::is_valid_python_exe(Path::new(p)))
            .or_else(|| {
                discover_runtimes(workspace_dir.as_deref())
                    .into_iter()
                    .find(|r| r.language == "python")
                    .map(|r| r.executable)
            });

        let Some(py_exe) = py_exe else {
            return Ok(Vec::new());
        };

        let cache = PYTHON_MODULE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let cache_key = format!("{}::{}", py_exe.to_ascii_lowercase(), trimmed);
        if let Ok(guard) = cache.lock() {
            if let Some(cached) = guard.get(&cache_key) {
                return Ok(cached.clone());
            }
        }

        let mut cmd = std::process::Command::new(&py_exe);
        cmd.args(["-B", "-c", PY_INSPECT_SNIPPET, trimmed]);
        if let Some(ref fp) = file_path {
            let cleaned = normalize_windows_path(fp);
            if let Some(parent) = Path::new(&cleaned).parent() {
                cmd.arg(parent.to_string_lossy().as_ref());
            }
        }
        if let Some(ref ws) = workspace_dir {
            let cleaned = normalize_windows_path(ws);
            cmd.arg(cleaned);
        }
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let Ok(mut child) = cmd.spawn() else {
            return Ok(Vec::new());
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(4500);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Ok(Vec::new());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(_) => return Ok(Vec::new()),
            }
        }

        let Ok(output) = child.wait_with_output() else {
            return Ok(Vec::new());
        };
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let parsed: Vec<CompletionSymbolItem> = if let Some(idx) = stdout_str.find("__DP_SYM__") {
            let json_part = &stdout_str[idx + "__DP_SYM__".len()..];
            serde_json::from_str(json_part).unwrap_or_default()
        } else {
            Vec::new()
        };

        if let Ok(mut guard) = cache.lock() {
            guard.insert(cache_key, parsed.clone());
        }
        Ok(parsed)
    })
    .await
}

fn pdf_annotation_storage_path(data_dir: &Path, pdf_file_path: &str) -> PathBuf {
    let norm = normalize_windows_path(pdf_file_path).to_lowercase();
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in norm.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let stem: String = Path::new(&norm)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "pdf".to_string())
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(36)
        .collect();
    let safe_stem = if stem.is_empty() { "doc" } else { &stem };
    data_dir
        .join("pdf_annotations")
        .join(format!("{safe_stem}_{hash:016x}.json"))
}

#[tauri::command]
pub fn load_pdf_annotations(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Option<String>, String> {
    let store_path = pdf_annotation_storage_path(&state.paths.data_dir, &file_path);
    if !store_path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&store_path)
        .map_err(|e| format!("读取 PDF 批注数据失败：{e}"))?;
    Ok(Some(raw))
}

#[tauri::command]
pub fn save_pdf_annotations(
    state: State<'_, AppState>,
    file_path: String,
    json_data: String,
) -> Result<(), String> {
    let store_path = pdf_annotation_storage_path(&state.paths.data_dir, &file_path);
    if let Some(parent) = store_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建 PDF 批注目录：{e}"))?;
    }
    std::fs::write(&store_path, json_data.as_bytes())
        .map_err(|e| format!("保存 PDF 批注失败：{e}"))
}

#[tauri::command]
pub fn drain_prism_bridge_actions(
    state: State<'_, AppState>,
) -> Vec<crate::bridge::PrismBridgeAction> {
    let actions = state.bridge_queue.drain();
    for act in &actions {
        match act {
            crate::bridge::PrismBridgeAction::OpenWorkspace { path, .. } => {
                let p = PathBuf::from(path);
                if p.is_dir() {
                    state.asset_server.authorize_dir(&p);
                }
            }
            crate::bridge::PrismBridgeAction::OpenFile {
                path, project_path, ..
            } => {
                let p = PathBuf::from(path);
                if p.is_file() {
                    state.asset_server.authorize_file_context(&p);
                }
                if let Some(ref proj) = project_path {
                    let pp = PathBuf::from(proj);
                    if pp.is_dir() {
                        state.asset_server.authorize_dir(&pp);
                    }
                }
            }
            crate::bridge::PrismBridgeAction::OpenCodeSnippet {
                project_path: Some(proj),
                ..
            }
            | crate::bridge::PrismBridgeAction::OpenMarkdownNote {
                project_path: Some(proj),
                ..
            } => {
                let pp = PathBuf::from(proj);
                if pp.is_dir() {
                    state.asset_server.authorize_dir(&pp);
                }
            }
            _ => {}
        }
    }
    actions
}

#[tauri::command]
pub async fn query_ai_sessions(
    root_paths: Vec<String>,
    query: Option<String>,
    limit: Option<usize>,
    include_all_projects: Option<bool>,
) -> Result<crate::bridge::AiSessionsQueryResult, String> {
    run_blocking(move || {
        crate::bridge::query_vault_sessions(
            root_paths,
            query.unwrap_or_default(),
            limit.unwrap_or(60),
            include_all_projects.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn get_ai_session_markdown(
    conversation_id: String,
) -> Result<crate::bridge::AiSessionMarkdownPayload, String> {
    run_blocking(move || crate::bridge::get_vault_session_markdown(conversation_id)).await
}

#[tauri::command]
pub async fn open_in_context_vault(
    conversation_id: Option<String>,
    project_path: Option<String>,
) -> Result<String, String> {
    run_blocking(move || crate::bridge::open_in_context_vault(conversation_id, project_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_newly_created_empty_folders_in_workspace_scan() {
        let tmp_root = std::env::temp_dir().join(format!(
            "docprism_empty_dir_test_{}",
            uuid::Uuid::new_v4()
        ));
        let empty_sub = tmp_root.join("新建文件夹");
        std::fs::create_dir_all(&empty_sub).expect("create empty subfolder");

        let mut budget = 1000;
        let nodes = scan_dir_recursive(&tmp_root, 0, &mut budget);
        let _ = std::fs::remove_dir_all(&tmp_root);

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "新建文件夹");
        assert_eq!(nodes[0].kind, "folder");
        assert!(nodes[0].children.is_empty());
    }

    #[test]
    fn extracts_sibling_python_symbols_for_intellisense() {
        let tmp_root = std::env::temp_dir().join(format!(
            "docprism_sibling_sym_test_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&tmp_root).expect("create temp dir");
        let core_py = tmp_root.join("core_solver.py");
        let app_py = tmp_root.join("app.py");
        std::fs::write(
            &core_py,
            "MAX_ITER = 500\n\nclass HeatField:\n    \"\"\"二维热流场求解器\"\"\"\n    pass\n\ndef solve_step(grid, dt=0.01):\n    \"\"\"推进单个时间步\"\"\"\n    return grid\n",
        )
        .expect("write core_solver.py");
        std::fs::write(&app_py, "import core_solver\n").expect("write app.py");

        let modules = scan_sibling_code_symbols_sync(
            Some(app_py.to_string_lossy().to_string()),
            Some(tmp_root.to_string_lossy().to_string()),
        );
        let _ = std::fs::remove_dir_all(&tmp_root);

        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].module_name, "core_solver");
        let labels: Vec<&str> = modules[0].symbols.iter().map(|s| s.label.as_str()).collect();
        assert!(labels.contains(&"MAX_ITER"));
        assert!(labels.contains(&"HeatField"));
        assert!(labels.contains(&"solve_step"));
        let solve_sym = modules[0]
            .symbols
            .iter()
            .find(|s| s.label == "solve_step")
            .unwrap();
        assert_eq!(solve_sym.detail.as_deref(), Some("(grid, dt=0.01)"));
        assert_eq!(solve_sym.doc.as_deref(), Some("推进单个时间步"));
    }
}
