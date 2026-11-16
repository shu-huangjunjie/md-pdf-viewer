use chrono::Local;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::paths::{normalize_windows_path, AppPaths};

pub const BRIDGE_DIR_NAME: &str = "PrismContextBridge";
pub const PRISM_INSTANCE_FILE: &str = "prism-studio.json";
pub const VAULT_INSTANCE_FILE: &str = "context-vault.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInstanceRecord {
    pub app: String,
    pub exe_path: String,
    pub data_root: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum PrismBridgeAction {
    #[serde(rename_all = "camelCase")]
    OpenWorkspace {
        path: String,
        /// "new-workspace" | "parallel-root"
        mode: String,
    },
    #[serde(rename_all = "camelCase")]
    OpenFile {
        path: String,
        #[serde(default)]
        line: Option<u32>,
        #[serde(default)]
        project_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    OpenCodeSnippet {
        language: String,
        code: String,
        title: String,
        #[serde(default)]
        project_path: Option<String>,
        #[serde(default)]
        auto_run: bool,
    },
    #[serde(rename_all = "camelCase")]
    OpenMarkdownNote {
        title: String,
        markdown: String,
        #[serde(default)]
        project_path: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrismWireEnvelope {
    token: String,
    kind: String,
    #[serde(default)]
    payload: Option<PrismBridgeAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum VaultRpcRequest {
    Ping,
    #[serde(rename_all = "camelCase")]
    Focus {
        #[serde(skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    QuerySessions {
        root_paths: Vec<String>,
        query: String,
        limit: usize,
        include_all_projects: bool,
    },
    #[serde(rename_all = "camelCase")]
    GetSessionMarkdown {
        conversation_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultWireEnvelope {
    token: String,
    #[serde(flatten)]
    request: VaultRpcRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFocusHandoff {
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSummary {
    pub id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub source_kind: String,
    pub message_count: i64,
    pub updated_at: String,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawQuerySessionsPayload {
    pub total_matched: usize,
    pub sessions: Vec<AiSessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionsQueryResult {
    pub available: bool,
    pub vault_running: bool,
    pub total_matched: usize,
    pub sessions: Vec<AiSessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMarkdownPayload {
    pub id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub source_kind: String,
    pub markdown: String,
}

#[derive(Default)]
pub struct PrismBridgeQueue {
    pending: Mutex<Vec<PrismBridgeAction>>,
}

impl PrismBridgeQueue {
    pub fn push(&self, action: PrismBridgeAction) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.push(action);
        }
    }

    pub fn drain(&self) -> Vec<PrismBridgeAction> {
        if let Ok(mut guard) = self.pending.lock() {
            std::mem::take(&mut *guard)
        } else {
            Vec::new()
        }
    }
}

pub fn shared_bridge_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(env::temp_dir);
    let dir = base.join(BRIDGE_DIR_NAME);
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn read_instance_record(filename: &str) -> Option<BridgeInstanceRecord> {
    let path = shared_bridge_dir().join(filename);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_instance_record(filename: &str, record: &BridgeInstanceRecord) {
    let path = shared_bridge_dir().join(filename);
    if let Ok(json) = serde_json::to_string_pretty(record) {
        let _ = fs::write(path, json);
    }
}

fn send_json_line<T: Serialize>(
    port: u16,
    payload: &T,
    timeout_ms: u64,
) -> Result<BridgeResponse, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(timeout_ms);
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("连接桥接端口失败: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms.max(1500))));
    let _ = stream.set_write_timeout(Some(timeout));

    let mut line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("发送桥接指令失败: {e}"))?;
    let _ = stream.flush();

    let mut reader = BufReader::new(stream);
    let mut resp_line = String::new();
    reader
        .read_line(&mut resp_line)
        .map_err(|e| format!("读取桥接响应失败: {e}"))?;
    serde_json::from_str::<BridgeResponse>(resp_line.trim())
        .map_err(|e| format!("解析桥接响应失败: {e}"))
}

fn focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Parses `--bridge-handoff <json>` and any CLI file/folder paths, and if an existing
/// `PrismStudio` window is already running, forwards the actions to it and signals `Err(())`
/// so this process exits cleanly without spawning a duplicate window.
pub fn parse_startup_or_forward_to_running_prism() -> Result<Vec<PrismBridgeAction>, ()> {
    let args: Vec<String> = env::args().collect();
    let mut handoff_actions: Vec<PrismBridgeAction> = Vec::new();
    let mut cli_actions: Vec<PrismBridgeAction> = Vec::new();
    let mut i = 1;

    while i < args.len() {
        let raw = &args[i];
        if raw == "--bridge-handoff" && i + 1 < args.len() {
            let handoff_path = PathBuf::from(&args[i + 1]);
            if let Ok(content) = fs::read_to_string(&handoff_path) {
                let _ = fs::remove_file(&handoff_path);
                if let Ok(act) = serde_json::from_str::<PrismBridgeAction>(&content) {
                    handoff_actions.push(act);
                }
            }
            i += 2;
            continue;
        }
        if !raw.starts_with('-') {
            let norm = normalize_windows_path(raw);
            let p = Path::new(&norm);
            if p.is_dir() {
                cli_actions.push(PrismBridgeAction::OpenWorkspace {
                    path: norm,
                    mode: "new-workspace".to_string(),
                });
            } else if p.is_file() {
                cli_actions.push(PrismBridgeAction::OpenFile {
                    path: norm,
                    line: None,
                    project_path: None,
                });
            }
        }
        i += 1;
    }

    if let Some(record) = read_instance_record(PRISM_INSTANCE_FILE) {
        if record.pid != std::process::id() {
            let mut forward_list = handoff_actions.clone();
            forward_list.extend(cli_actions);
            if forward_list.is_empty() {
                let ping = PrismWireEnvelope {
                    token: record.token,
                    kind: "focus".to_string(),
                    payload: None,
                };
                if matches!(send_json_line(record.port, &ping, 250), Ok(resp) if resp.ok) {
                    return Err(());
                }
            } else {
                let mut all_sent = true;
                for act in &forward_list {
                    let env = PrismWireEnvelope {
                        token: record.token.clone(),
                        kind: "dispatch".to_string(),
                        payload: Some(act.clone()),
                    };
                    if !matches!(send_json_line(record.port, &env, 350), Ok(resp) if resp.ok) {
                        all_sent = false;
                        break;
                    }
                }
                if all_sent {
                    return Err(());
                }
            }
        }
    }

    Ok(handoff_actions)
}

pub fn start_prism_bridge_server(
    app: AppHandle,
    paths: &AppPaths,
    queue: Arc<PrismBridgeQueue>,
) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    let token = Uuid::new_v4().to_string();
    let exe_path = env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    write_instance_record(
        PRISM_INSTANCE_FILE,
        &BridgeInstanceRecord {
            app: "prism-studio".to_string(),
            exe_path,
            data_root: paths.data_dir.to_string_lossy().to_string(),
            port,
            token: token.clone(),
            pid: std::process::id(),
            updated_at: Local::now().to_rfc3339(),
        },
    );

    std::thread::spawn(move || {
        for incoming in listener.incoming().flatten() {
            let app_clone = app.clone();
            let queue_clone = queue.clone();
            let expected_token = token.clone();
            std::thread::spawn(move || {
                let _ = incoming.set_read_timeout(Some(Duration::from_millis(2000)));
                let _ = incoming.set_write_timeout(Some(Duration::from_millis(2000)));
                let mut reader = BufReader::new(&incoming);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                    return;
                }
                let resp = match serde_json::from_str::<PrismWireEnvelope>(line.trim()) {
                    Ok(env) if env.token == expected_token => {
                        match env.kind.as_str() {
                            "ping" => BridgeResponse {
                                ok: true,
                                error: None,
                                data: None,
                            },
                            "focus" => {
                                focus_main_window(&app_clone);
                                BridgeResponse {
                                    ok: true,
                                    error: None,
                                    data: None,
                                }
                            }
                            "dispatch" => {
                                if let Some(action) = env.payload {
                                    queue_clone.push(action.clone());
                                    focus_main_window(&app_clone);
                                    let _ = app_clone.emit("prism://bridge-action", action);
                                    BridgeResponse {
                                        ok: true,
                                        error: None,
                                        data: None,
                                    }
                                } else {
                                    BridgeResponse {
                                        ok: false,
                                        error: Some("缺少动作参数".to_string()),
                                        data: None,
                                    }
                                }
                            }
                            _ => BridgeResponse {
                                ok: false,
                                error: Some("未知桥接指令".to_string()),
                                data: None,
                            },
                        }
                    }
                    Ok(_) => BridgeResponse {
                        ok: false,
                        error: Some("桥接令牌不匹配".to_string()),
                        data: None,
                    },
                    Err(e) => BridgeResponse {
                        ok: false,
                        error: Some(format!("解析失败: {e}")),
                        data: None,
                    },
                };

                if let Ok(mut json) = serde_json::to_string(&resp) {
                    json.push('\n');
                    let mut writer = incoming;
                    let _ = writer.write_all(json.as_bytes());
                    let _ = writer.flush();
                }
            });
        }
    });
}

/// Discovers `Context-Vault.exe` (`ai-session-tools`) automatically.
pub fn discover_context_vault_exe() -> Option<PathBuf> {
    if let Ok(env_exe) = env::var("CONTEXT_VAULT_EXE") {
        let p = PathBuf::from(env_exe);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Some(record) = read_instance_record(VAULT_INSTANCE_FILE) {
        let p = PathBuf::from(&record.exe_path);
        if p.is_file() {
            return Some(p);
        }
    }

    let mut search_roots = Vec::new();
    if let Ok(cur_exe) = env::current_exe() {
        for ancestor in cur_exe.ancestors().skip(1).take(5) {
            search_roots.push(ancestor.to_path_buf());
        }
    }
    if let Ok(cwd) = env::current_dir() {
        for ancestor in cwd.ancestors().take(4) {
            search_roots.push(ancestor.to_path_buf());
        }
    }

    let relative_candidates = [
        r"ai-session-tools\releases\desktop\Context-Vault.exe",
        r"ai-session-tools\releases\portable\Context-Vault.exe",
        r"Context-Vault\Context-Vault.exe",
        r"Context-Vault.exe",
    ];

    for root in search_roots {
        for rel in relative_candidates {
            let candidate = root.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn call_vault_rpc_or_headless(req: VaultRpcRequest) -> Result<(BridgeResponse, bool), String> {
    if let Some(record) = read_instance_record(VAULT_INSTANCE_FILE) {
        let env = VaultWireEnvelope {
            token: record.token,
            request: req.clone(),
        };
        if let Ok(resp) = send_json_line(record.port, &env, 400) {
            if resp.ok {
                return Ok((resp, true));
            }
        }
    }

    let exe_path = discover_context_vault_exe().ok_or_else(|| {
        "未检测到 Context Vault (Context-Vault.exe)。请先构建或启动一次 ai-session-tools。"
            .to_string()
    })?;

    let req_path = shared_bridge_dir().join(format!("cv-query-{}.json", Uuid::new_v4()));
    let req_json = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    fs::write(&req_path, req_json).map_err(|e| format!("写入查询参数失败: {e}"))?;

    let mut cmd = Command::new(&exe_path);
    cmd.arg("--headless-bridge-query").arg(&req_path);
    if let Some(parent) = exe_path.parent() {
        cmd.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("执行 Context Vault 无界面查询失败: {e}"))?;
    let _ = fs::remove_file(&req_path);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let last_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim().starts_with('{'))
        .unwrap_or("")
        .trim();

    if last_line.is_empty() {
        return Err("Context Vault 未返回查询数据（请确认已重新编译最新版 Context-Vault.exe）"
            .to_string());
    }

    let parsed = serde_json::from_str::<BridgeResponse>(last_line)
        .map_err(|e| format!("解析 Context Vault 数据失败: {e}"))?;
    Ok((parsed, false))
}

pub fn query_vault_sessions(
    root_paths: Vec<String>,
    query: String,
    limit: usize,
    include_all_projects: bool,
) -> Result<AiSessionsQueryResult, String> {
    let req = VaultRpcRequest::QuerySessions {
        root_paths,
        query,
        limit: limit.clamp(10, 200),
        include_all_projects,
    };

    match call_vault_rpc_or_headless(req) {
        Ok((resp, vault_running)) => {
            if !resp.ok {
                return Err(resp.error.unwrap_or_else(|| "查询会话失败".to_string()));
            }
            let payload: RawQuerySessionsPayload = resp
                .data
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(RawQuerySessionsPayload {
                    total_matched: 0,
                    sessions: Vec::new(),
                });
            Ok(AiSessionsQueryResult {
                available: true,
                vault_running,
                total_matched: payload.total_matched,
                sessions: payload.sessions,
            })
        }
        Err(_) if discover_context_vault_exe().is_none() => Ok(AiSessionsQueryResult {
            available: false,
            vault_running: false,
            total_matched: 0,
            sessions: Vec::new(),
        }),
        Err(e) => Err(e),
    }
}

pub fn get_vault_session_markdown(conversation_id: String) -> Result<AiSessionMarkdownPayload, String> {
    let req = VaultRpcRequest::GetSessionMarkdown { conversation_id };
    let (resp, _) = call_vault_rpc_or_headless(req)?;
    if !resp.ok {
        return Err(resp.error.unwrap_or_else(|| "读取会话内容失败".to_string()));
    }
    let data = resp.data.ok_or_else(|| "返回内容为空".to_string())?;
    serde_json::from_value::<AiSessionMarkdownPayload>(data)
        .map_err(|e| format!("解析会话 Markdown 失败: {e}"))
}

pub fn open_in_context_vault(
    conversation_id: Option<String>,
    project_path: Option<String>,
) -> Result<String, String> {
    if let Some(record) = read_instance_record(VAULT_INSTANCE_FILE) {
        let env = VaultWireEnvelope {
            token: record.token,
            request: VaultRpcRequest::Focus {
                conversation_id: conversation_id.clone(),
                project_path: project_path.clone(),
            },
        };
        if let Ok(resp) = send_json_line(record.port, &env, 350) {
            if resp.ok {
                return Ok("reused-window".to_string());
            }
        }
    }

    let exe_path = discover_context_vault_exe().ok_or_else(|| {
        "未找到 Context Vault (Context-Vault.exe)。请先构建或启动一次 ai-session-tools。"
            .to_string()
    })?;

    let handoff = VaultFocusHandoff {
        conversation_id,
        project_path,
    };
    let handoff_path = shared_bridge_dir().join(format!("cv-handoff-{}.json", Uuid::new_v4()));
    let json = serde_json::to_string_pretty(&handoff).map_err(|e| e.to_string())?;
    fs::write(&handoff_path, json).map_err(|e| format!("写入交接文件失败: {e}"))?;

    let mut cmd = Command::new(&exe_path);
    cmd.arg("--bridge-handoff").arg(&handoff_path);
    if let Some(parent) = exe_path.parent() {
        cmd.current_dir(parent);
    }
    cmd.spawn()
        .map_err(|e| format!("启动 Context Vault 失败: {e}"))?;

    Ok("launched-new".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prism_bridge_action_serializes_symmetrically_with_context_vault() {
        let json = r#"{
            "action": "open-file",
            "path": "D:\\proj\\main.py",
            "line": 42,
            "projectPath": "D:\\proj"
        }"#;
        let parsed: PrismBridgeAction = serde_json::from_str(json).expect("valid action");
        match parsed {
            PrismBridgeAction::OpenFile {
                path,
                line,
                project_path,
            } => {
                assert_eq!(path, r"D:\proj\main.py");
                assert_eq!(line, Some(42));
                assert_eq!(project_path.as_deref(), Some(r"D:\proj"));
            }
            _ => panic!("expected OpenFile"),
        }
    }

    #[test]
    fn bridge_queue_drains_cleanly() {
        let q = PrismBridgeQueue::default();
        q.push(PrismBridgeAction::OpenWorkspace {
            path: r"D:\proj".to_string(),
            mode: "new-workspace".to_string(),
        });
        let items = q.drain();
        assert_eq!(items.len(), 1);
        assert!(q.drain().is_empty());
    }
}
