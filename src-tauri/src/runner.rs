//! Lightweight multi-language code execution engine (Python, Node JS/TS, PowerShell, Batch, Rust)
//! with real-time UTF-8/GBK dual-encoding output streaming and process-tree termination.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Emitter, WebviewWindow};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfile {
    pub id: String,
    pub language: String, // "python" | "javascript" | "powershell" | "batch" | "rust"
    pub label: String,
    pub executable: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCodeRequest {
    pub run_id: String,
    pub language: String,
    pub code: String,
    pub file_path: Option<String>,
    pub working_dir: Option<String>,
    pub custom_executable: Option<String>,
    pub is_saved_file: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutputEvent {
    pub run_id: String,
    pub stream: String, // "stdout" | "stderr" | "system"
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDoneEvent {
    pub run_id: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub killed: bool,
}

struct ActiveRun {
    pid: u32,
    killed: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct RunnerManager {
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
}

pub fn is_valid_python_exe(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let lower = p.to_string_lossy().to_ascii_lowercase();
    // Skip Microsoft Store zero-byte / redirector alias stub!
    !lower.contains(r"\microsoft\windowsapps\")
}

pub fn decode_console_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return utf8.to_string();
    }
    // Fallback to GBK (CP936) for native Chinese Windows system commands (dir, ping, cmd, etc.)
    let (cow, _, _) = encoding_rs::GBK.decode(bytes);
    cow.into_owned()
}

pub fn discover_runtimes(workspace_dir: Option<&str>) -> Vec<RuntimeProfile> {
    let mut list = Vec::new();
    let mut seen_execs = std::collections::HashSet::new();

    let mut add_profile = |language: &str, label: String, path: PathBuf| {
        if !path.is_file() {
            return;
        }
        let exec_str = path.to_string_lossy().replace('/', r"\");
        let key = format!("{}::{}", language, exec_str.to_ascii_lowercase());
        if seen_execs.insert(key) {
            list.push(RuntimeProfile {
                id: format!("{}-{}", language, list.len()),
                language: language.to_string(),
                label,
                executable: exec_str,
            });
        }
    };

    // 1. Python discovery (Workspace .venv -> D:\huangjunjie\.env -> Conda/Local -> PATH)
    if let Some(ws) = workspace_dir {
        let ws_path = Path::new(ws);
        let ws_name = ws_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("当前工作区");
        for rel in [r".venv\Scripts\python.exe", r"venv\Scripts\python.exe"] {
            let cand = ws_path.join(rel);
            if is_valid_python_exe(&cand) {
                add_profile("python", format!("Python · {ws_name} (.venv)"), cand);
            }
        }
    }

    let known_pythons = [
        (
            r"D:\huangjunjie\.env\train_env\python.exe",
            "Python · train_env (PyTorch / GPU)",
        ),
        (r"D:\huangjunjie\.env\hjj_env\python.exe", "Python · hjj_env"),
    ];
    for (p_str, lbl) in known_pythons {
        let p = PathBuf::from(p_str);
        if is_valid_python_exe(&p) {
            add_profile("python", lbl.to_string(), p);
        }
    }

    if let Some(home) = dirs::home_dir() {
        for (rel, lbl) in [
            (r"miniconda3\python.exe", "Python · Miniconda3 (base)"),
            (r"anaconda3\python.exe", "Python · Anaconda3 (base)"),
        ] {
            let p = home.join(rel);
            if is_valid_python_exe(&p) {
                add_profile("python", lbl.to_string(), p);
            }
        }
    }
    if let Some(local_app) = dirs::data_local_dir() {
        let py_root = local_app.join(r"Programs\Python");
        if let Ok(entries) = std::fs::read_dir(py_root) {
            for e in entries.flatten() {
                let p = e.path().join("python.exe");
                if is_valid_python_exe(&p) {
                    let folder_name = e.file_name().to_string_lossy().into_owned();
                    add_profile("python", format!("Python · {folder_name}"), p);
                }
            }
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join("python.exe");
            if is_valid_python_exe(&p) {
                add_profile("python", format!("Python · 系统环境 ({})", dir.display()), p);
            }
        }
    }

    // 2. Node.js (JavaScript & TypeScript)
    for (p_str, lbl) in [
        (r"D:\huangjunjie\.env\web_node\node.exe", "Node.js · web_node 便携环境"),
        (r"C:\Program Files\nodejs\node.exe", "Node.js · 系统环境"),
    ] {
        let p = PathBuf::from(p_str);
        if p.is_file() {
            add_profile("javascript", lbl.to_string(), p);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join("node.exe");
            if p.is_file() {
                add_profile("javascript", "Node.js · PATH".into(), p);
            }
        }
    }

    // 3. PowerShell
    let ps = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    if ps.is_file() {
        add_profile("powershell", "Windows PowerShell".into(), ps);
    }

    // 4. CMD / Batch
    let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
    if cmd.is_file() {
        add_profile("batch", "Windows CMD 批处理".into(), cmd);
    }

    // 5. Rust single-file compiler (rustc)
    if let Some(home) = dirs::home_dir() {
        let rustc = home.join(r".cargo\bin\rustc.exe");
        if rustc.is_file() {
            add_profile("rust", "Rust · rustc 单文件编译运行".into(), rustc);
        }
    }

    list
}

impl RunnerManager {
    pub fn start_run(&self, window: WebviewWindow, req: RunCodeRequest) -> Result<(), String> {
        let active_map = Arc::clone(&self.active);

        std::thread::Builder::new()
            .name(format!("prismstudio-run-{}", req.run_id))
            .spawn(move || {
                execute_task(window, req, active_map);
            })
            .map_err(|e| format!("无法启动代码运行线程：{e}"))?;

        Ok(())
    }

    pub fn stop_run(&self, run_id: &str) -> Result<bool, String> {
        let maybe_proc = self
            .active
            .lock()
            .map_err(|_| "进程表锁定失败".to_string())?
            .get(run_id)
            .map(|r| (r.pid, Arc::clone(&r.killed)));

        if let Some((pid, killed_flag)) = maybe_proc {
            killed_flag.store(true, Ordering::SeqCst);
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill.exe")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

fn emit_out(window: &WebviewWindow, run_id: &str, stream: &str, text: impl Into<String>) {
    let _ = window.emit(
        "code-run-output",
        RunOutputEvent {
            run_id: run_id.to_string(),
            stream: stream.to_string(),
            text: text.into(),
        },
    );
}

fn execute_task(
    window: WebviewWindow,
    req: RunCodeRequest,
    active_map: Arc<Mutex<HashMap<String, ActiveRun>>>,
) {
    let start_ts = Instant::now();
    let run_id = req.run_id.clone();
    let lang = req.language.trim().to_ascii_lowercase();

    // Determine working directory: honor explicit/auto-resolved workspace root first,
    // then fall back to the script's parent directory or temp dir.
    let script_parent_dir: Option<PathBuf> = req
        .file_path
        .as_deref()
        .and_then(|fp| Path::new(fp).parent().map(|p| p.to_path_buf()))
        .filter(|p| p.is_dir());

    let work_dir: PathBuf = req
        .working_dir
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| script_parent_dir.clone())
        .unwrap_or_else(std::env::temp_dir);

    // Prepare script path (use saved file directly if clean, otherwise write temp UTF-8 file)
    let temp_dir = std::env::temp_dir().join("prismstudio_runs");
    let _ = std::fs::create_dir_all(&temp_dir);

    let ext = match lang.as_str() {
        "python" | "py" => "py",
        "typescript" | "ts" => "ts",
        "javascript" | "js" | "node" => "mjs",
        "powershell" | "ps1" | "pwsh" => "ps1",
        "batch" | "bat" | "cmd" | "sh" | "bash" => "bat",
        "rust" | "rs" => "rs",
        _ => "py",
    };

    let mut temp_files_to_clean: Vec<PathBuf> = Vec::new();
    let script_path: PathBuf = if req.is_saved_file {
        if let Some(ref fp) = req.file_path {
            let p = PathBuf::from(fp);
            if p.is_file() {
                p
            } else {
                let tp = temp_dir.join(format!("snippet_{}.{}", uuid::Uuid::new_v4().simple(), ext));
                if let Err(e) = write_script_file(&tp, ext, &req.code) {
                    emit_out(&window, &run_id, "stderr", format!("写入临时脚本失败：{e}\n"));
                    finish_run(&window, &run_id, Some(1), start_ts, false);
                    return;
                }
                temp_files_to_clean.push(tp.clone());
                tp
            }
        } else {
            let tp = temp_dir.join(format!("snippet_{}.{}", uuid::Uuid::new_v4().simple(), ext));
            if let Err(e) = write_script_file(&tp, ext, &req.code) {
                emit_out(&window, &run_id, "stderr", format!("写入临时脚本失败：{e}\n"));
                finish_run(&window, &run_id, Some(1), start_ts, false);
                return;
            }
            temp_files_to_clean.push(tp.clone());
            tp
        }
    } else {
        let tp = temp_dir.join(format!("snippet_{}.{}", uuid::Uuid::new_v4().simple(), ext));
        if let Err(e) = write_script_file(&tp, ext, &req.code) {
            emit_out(&window, &run_id, "stderr", format!("写入临时脚本失败：{e}\n"));
            finish_run(&window, &run_id, Some(1), start_ts, false);
            return;
        }
        temp_files_to_clean.push(tp.clone());
        tp
    };

    let runtimes = discover_runtimes(work_dir.to_str());

    // Build Command according to language
    let mut cmd: Command = match ext {
        "py" => {
            let py_exe = req
                .custom_executable
                .clone()
                .filter(|s| !s.trim().is_empty() && Path::new(s).is_file())
                .or_else(|| {
                    runtimes
                        .iter()
                        .find(|r| r.language == "python")
                        .map(|r| r.executable.clone())
                });

            let Some(py_bin) = py_exe else {
                emit_out(
                    &window,
                    &run_id,
                    "stderr",
                    "未检测到可用的 Python 解释器！请在顶栏选择或指定 python.exe 路径。\n",
                );
                cleanup_files(&temp_files_to_clean);
                finish_run(&window, &run_id, Some(127), start_ts, false);
                return;
            };

            emit_out(
                &window,
                &run_id,
                "system",
                format!(
                    "▶ [Python] {} \"{}\"  (cwd: {})\n",
                    py_bin,
                    script_path.display(),
                    work_dir.display()
                ),
            );

            let mut c = Command::new(&py_bin);
            c.arg("-u").arg(&script_path);
            c.env("PYTHONUTF8", "1");
            c.env("PYTHONIOENCODING", "utf-8");
            c.env("PYTHONUNBUFFERED", "1");

            // Ensure both the script's own folder and the active workspace root are importable!
            let mut py_paths: Vec<String> = Vec::new();
            if let Some(ref sp) = script_parent_dir {
                py_paths.push(sp.display().to_string());
            }
            let wd_str = work_dir.display().to_string();
            if !py_paths.iter().any(|p| p.eq_ignore_ascii_case(&wd_str)) {
                py_paths.push(wd_str);
            }
            if let Ok(existing_pp) = std::env::var("PYTHONPATH") {
                if !existing_pp.trim().is_empty() {
                    py_paths.push(existing_pp);
                }
            }
            if !py_paths.is_empty() {
                c.env("PYTHONPATH", py_paths.join(";"));
            }

            // Prepend Python's own directory, Scripts, and Library\bin for Conda/PyTorch DLL resolution!
            if let Some(py_dir) = Path::new(&py_bin).parent() {
                let scripts_dir = py_dir.join("Scripts");
                let lib_bin_dir = py_dir.join(r"Library\bin");
                let orig_path = std::env::var("PATH").unwrap_or_default();
                let new_path = format!(
                    "{};{};{};{}",
                    py_dir.display(),
                    scripts_dir.display(),
                    lib_bin_dir.display(),
                    orig_path
                );
                c.env("PATH", new_path);
                if py_bin.to_ascii_lowercase().contains(r"\.env\") {
                    c.env("PYTHONNOUSERSITE", "1");
                }
            }
            c
        }
        "mjs" | "ts" => {
            let node_exe = req
                .custom_executable
                .clone()
                .filter(|s| !s.trim().is_empty() && Path::new(s).is_file())
                .or_else(|| {
                    runtimes
                        .iter()
                        .find(|r| r.language == "javascript")
                        .map(|r| r.executable.clone())
                });

            let Some(node_bin) = node_exe else {
                emit_out(&window, &run_id, "stderr", "未检测到可用的 Node.js 环境！\n");
                cleanup_files(&temp_files_to_clean);
                finish_run(&window, &run_id, Some(127), start_ts, false);
                return;
            };

            emit_out(
                &window,
                &run_id,
                "system",
                format!("▶ [Node.js] {} \"{}\"\n", node_bin, script_path.display()),
            );
            let mut c = Command::new(&node_bin);
            if ext == "ts" {
                c.arg("--experimental-strip-types");
            }
            c.arg(&script_path);
            c
        }
        "ps1" => {
            emit_out(
                &window,
                &run_id,
                "system",
                format!("▶ [PowerShell] \"{}\"\n", script_path.display()),
            );
            let mut c = Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &format!(
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '{}'",
                    script_path.display().to_string().replace('\'', "''")
                ),
            ]);
            c
        }
        "bat" => {
            emit_out(
                &window,
                &run_id,
                "system",
                format!("▶ [CMD] \"{}\"\n", script_path.display()),
            );
            let mut c = Command::new("cmd.exe");
            c.args(["/c", &script_path.to_string_lossy()]);
            c
        }
        "rs" => {
            let rustc_exe = runtimes
                .iter()
                .find(|r| r.language == "rust")
                .map(|r| r.executable.clone())
                .unwrap_or_else(|| "rustc".to_string());
            let out_bin = temp_dir.join(format!("rs_bin_{}.exe", uuid::Uuid::new_v4().simple()));
            temp_files_to_clean.push(out_bin.clone());

            emit_out(
                &window,
                &run_id,
                "system",
                format!("⚙ [Rust] 正在编译 {} ...\n", script_path.display()),
            );
            let mut build_cmd = Command::new(&rustc_exe);
            build_cmd.arg(&script_path).arg("-o").arg(&out_bin);
            #[cfg(windows)]
            build_cmd.creation_flags(CREATE_NO_WINDOW);

            match build_cmd.output() {
                Ok(out) if out.status.success() => {
                    emit_out(&window, &run_id, "system", "▶ 编译成功，开始运行：\n");
                    Command::new(&out_bin)
                }
                Ok(out) => {
                    let err_txt = decode_console_bytes(&out.stderr);
                    emit_out(&window, &run_id, "stderr", err_txt);
                    cleanup_files(&temp_files_to_clean);
                    finish_run(&window, &run_id, out.status.code(), start_ts, false);
                    return;
                }
                Err(e) => {
                    emit_out(&window, &run_id, "stderr", format!("调用 rustc 失败：{e}\n"));
                    cleanup_files(&temp_files_to_clean);
                    finish_run(&window, &run_id, Some(1), start_ts, false);
                    return;
                }
            }
        }
        _ => unreachable!(),
    };

    cmd.current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            emit_out(&window, &run_id, "stderr", format!("启动进程失败：{e}\n"));
            cleanup_files(&temp_files_to_clean);
            finish_run(&window, &run_id, Some(1), start_ts, false);
            return;
        }
    };

    let pid = child.id();
    let killed_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = active_map.lock() {
        guard.insert(
            run_id.clone(),
            ActiveRun {
                pid,
                killed: Arc::clone(&killed_flag),
            },
        );
    }

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let win_out = window.clone();
    let id_out = run_id.clone();
    let t_out = std::thread::spawn(move || {
        if let Some(pipe) = stdout_pipe {
            stream_pipe(pipe, &win_out, &id_out, "stdout");
        }
    });

    let win_err = window.clone();
    let id_err = run_id.clone();
    let t_err = std::thread::spawn(move || {
        if let Some(pipe) = stderr_pipe {
            stream_pipe(pipe, &win_err, &id_err, "stderr");
        }
    });

    let wait_res = child.wait();
    let _ = t_out.join();
    let _ = t_err.join();

    if let Ok(mut guard) = active_map.lock() {
        guard.remove(&run_id);
    }
    cleanup_files(&temp_files_to_clean);

    let exit_code = wait_res.ok().and_then(|s| s.code());
    let was_killed = killed_flag.load(Ordering::SeqCst);
    finish_run(&window, &run_id, exit_code, start_ts, was_killed);
}

fn stream_pipe<R: Read>(mut reader: R, window: &WebviewWindow, run_id: &str, stream_name: &str) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // Avoid splitting a multi-byte UTF-8 sequence right at buffer boundary
                let valid_cut = find_safe_char_boundary(&pending);
                if valid_cut > 0 {
                    let text = decode_console_bytes(&pending[..valid_cut]);
                    emit_out(window, run_id, stream_name, text);
                    pending.drain(..valid_cut);
                }
            }
            Err(_) => break,
        }
    }
    if !pending.is_empty() {
        let text = decode_console_bytes(&pending);
        emit_out(window, run_id, stream_name, text);
    }
}

fn find_safe_char_boundary(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => {
            if e.error_len().is_none() {
                // Incomplete UTF-8 sequence at the very end (1~3 trailing bytes): wait for next read!
                e.valid_up_to()
            } else {
                // Genuinely non-UTF8 (e.g. GBK): flush up to newline or full chunk if > 64 bytes
                if let Some(nl) = bytes.iter().rposition(|&b| b == b'\n') {
                    nl + 1
                } else if bytes.len() >= 128 {
                    bytes.len()
                } else {
                    0
                }
            }
        }
    }
}

fn write_script_file(path: &Path, ext: &str, code: &str) -> std::io::Result<()> {
    if ext == "ps1" {
        // PowerShell 5.1 requires UTF-8 with BOM to parse Chinese string literals in .ps1 files!
        let mut content = Vec::with_capacity(code.len() + 3);
        content.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        content.extend_from_slice(code.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
        std::fs::write(path, content)
    } else if ext == "bat" {
        let crlf = format!(
            "@echo off\r\nchcp 65001 >nul\r\n{}",
            code.replace("\r\n", "\n").replace('\n', "\r\n")
        );
        std::fs::write(path, crlf.as_bytes())
    } else {
        std::fs::write(path, code.as_bytes())
    }
}

fn cleanup_files(files: &[PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

fn finish_run(
    window: &WebviewWindow,
    run_id: &str,
    exit_code: Option<i32>,
    start_ts: Instant,
    killed: bool,
) {
    let _ = window.emit(
        "code-run-done",
        RunDoneEvent {
            run_id: run_id.to_string(),
            exit_code,
            duration_ms: start_ts.elapsed().as_millis() as u64,
            killed,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_windows_apps_python_stub() {
        let fake = Path::new(r"C:\Users\alice\AppData\Local\Microsoft\WindowsApps\python.exe");
        assert!(!is_valid_python_exe(fake));
    }

    #[test]
    fn decodes_utf8_and_gbk_cleanly() {
        let utf8_bytes = "你好，神经算子！".as_bytes();
        assert_eq!(decode_console_bytes(utf8_bytes), "你好，神经算子！");

        let (gbk_cow, _, _) = encoding_rs::GBK.encode("中文GBK测试");
        assert_eq!(decode_console_bytes(&gbk_cow), "中文GBK测试");
    }
}
