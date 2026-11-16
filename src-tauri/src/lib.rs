pub mod asset_server;
pub mod bridge;
pub mod commands;
pub mod formatter;
pub mod paths;
pub mod runner;

#[cfg(windows)]
pub mod dialogs;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use asset_server::AssetServer;
use paths::AppPaths;
use runner::RunnerManager;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    pub paths: AppPaths,
    pub asset_server: AssetServer,
    pub runner: RunnerManager,
    pub bridge_queue: Arc<bridge::PrismBridgeQueue>,
    pub webview_slot_lock: Mutex<Option<File>>,
}

fn initialize(initial_actions: Vec<bridge::PrismBridgeAction>) -> Result<AppState, String> {
    let paths = AppPaths::discover()?;
    let asset_server = AssetServer::start()?;
    let runner = RunnerManager::default();
    let bridge_queue = Arc::new(bridge::PrismBridgeQueue::default());
    for act in initial_actions {
        bridge_queue.push(act);
    }
    Ok(AppState {
        paths,
        asset_server,
        runner,
        bridge_queue,
        webview_slot_lock: Mutex::new(None),
    })
}

#[cfg(windows)]
fn try_lock_slot(slot_dir: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    let _ = std::fs::create_dir_all(slot_dir);
    let lock_path = slot_dir.join(".slot.lock");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0) // Exclusive OS handle lock; auto-released on exit/crash
        .open(lock_path)
        .ok()
}

#[cfg(not(windows))]
fn try_lock_slot(slot_dir: &Path) -> Option<File> {
    let _ = std::fs::create_dir_all(slot_dir);
    let lock_path = slot_dir.join(".slot.lock");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .ok()
}

fn build_main_window_with_dir(
    app: &tauri::App,
    webview_data_dir: PathBuf,
) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("棱镜工坊 PrismStudio")
        .inner_size(1460.0, 920.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .resizable(true)
        .decorations(true)
        .zoom_hotkeys_enabled(true)
        .data_directory(webview_data_dir);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon)?;
    }
    builder.build()
}

fn create_resilient_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let base_data_dir = app.state::<AppState>().paths.data_dir.clone();
    let slots_root = base_data_dir.join("webview-slots");
    let _ = std::fs::create_dir_all(&slots_root);

    let mut last_err: Option<tauri::Error> = None;

    // Try reusable slots 0..6 so single-window launches reuse warm cache while multi-window
    // or cross-privilege launches never collide with HRESULT(0x800700AA) ERROR_BUSY!
    for idx in 0..6 {
        let slot_dir = slots_root.join(format!("slot-{idx}"));
        if let Some(lock_file) = try_lock_slot(&slot_dir) {
            match build_main_window_with_dir(app, slot_dir) {
                Ok(_win) => {
                    if let Ok(mut guard) = app.state::<AppState>().webview_slot_lock.lock() {
                        *guard = Some(lock_file);
                    }
                    return Ok(());
                }
                Err(err) => {
                    last_err = Some(err);
                }
            }
        }
    }

    // Ultimate fallback: unique per-PID WebView2 profile in %TEMP%
    let fallback_dir = std::env::temp_dir()
        .join("PrismStudioWebView")
        .join(format!("pid-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&fallback_dir);
    match build_main_window_with_dir(app, fallback_dir) {
        Ok(_win) => Ok(()),
        Err(err) => Err(Box::new(last_err.unwrap_or(err))),
    }
}

fn report_startup_error(message: &str) {
    let log = std::env::temp_dir().join("prismstudio-startup-error.log");
    let _ = std::fs::write(&log, message);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName PresentationFramework; \
                 [System.Windows.MessageBox]::Show($env:DP_MSG, '棱镜工坊 PrismStudio 启动失败', 'OK', 'Error') | Out-Null",
            ])
            .env("DP_MSG", message)
            .creation_flags(0x08000000)
            .status();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_actions = match bridge::parse_startup_or_forward_to_running_prism() {
        Ok(actions) => actions,
        Err(()) => return,
    };

    let state = match initialize(initial_actions) {
        Ok(s) => s,
        Err(msg) => {
            report_startup_error(&msg);
            return;
        }
    };

    let bridge_paths = state.paths.clone();
    let bridge_queue = state.bridge_queue.clone();

    if let Err(e) = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(move |app| {
            create_resilient_main_window(app)?;
            bridge::start_prism_bridge_server(app.handle().clone(), &bridge_paths, bridge_queue);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::list_runtimes,
            commands::start_code_run,
            commands::stop_code_run,
            commands::format_code_document,
            commands::pick_workspace_folder,
            commands::pick_document_file,
            commands::pick_save_document,
            commands::inspect_path,
            commands::scan_workspace,
            commands::read_markdown_document,
            commands::save_text_document,
            commands::save_preferences,
            commands::reveal_in_explorer,
            commands::create_workspace_item,
            commands::rename_workspace_item,
            commands::delete_workspace_item,
            commands::search_in_workspace,
            commands::scan_sibling_code_symbols,
            commands::inspect_python_module,
            commands::load_pdf_annotations,
            commands::save_pdf_annotations,
            commands::drain_prism_bridge_actions,
            commands::query_ai_sessions,
            commands::get_ai_session_markdown,
            commands::open_in_context_vault,
        ])
        .run(tauri::generate_context!())
    {
        report_startup_error(&format!("无法启动应用窗口：\n{e}"));
    }
}
