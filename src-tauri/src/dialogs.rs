//! Native Windows Explorer folder & document picker on a dedicated STA thread.

use windows::{
    core::{w, HRESULT, HSTRING, PCWSTR},
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FileOpenDialog, FileSaveDialog, IFileOpenDialog,
            IFileSaveDialog, IShellItem, SHCreateItemFromParsingName, FOS_FILEMUSTEXIST,
            FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
            FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        },
    },
};

use crate::paths::normalize_windows_path;

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn pick_folder(owner: isize, initial_dir: String) -> Result<Option<String>, String> {
    std::thread::Builder::new()
        .name("docprism-folder-picker".into())
        .spawn(move || {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|e| format!("无法初始化文件夹选择窗口：{e}"))?;
            let _apt = ComApartment;
            show_folder_dialog(owner, &initial_dir).map_err(|e| format!("选择文件夹失败：{e}"))
        })
        .map_err(|e| format!("无法启动文件夹选择线程：{e}"))?
        .join()
        .map_err(|_| "文件夹选择窗口异常退出".to_string())?
}

pub fn pick_document(owner: isize, initial_dir: String) -> Result<Option<String>, String> {
    std::thread::Builder::new()
        .name("docprism-file-picker".into())
        .spawn(move || {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|e| format!("无法初始化文件选择窗口：{e}"))?;
            let _apt = ComApartment;
            show_file_dialog(owner, &initial_dir).map_err(|e| format!("选择文件失败：{e}"))
        })
        .map_err(|e| format!("无法启动文件选择线程：{e}"))?
        .join()
        .map_err(|_| "文件选择窗口异常退出".to_string())?
}

fn show_folder_dialog(owner: isize, initial_dir: &str) -> windows::core::Result<Option<String>> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | FOS_PICKFOLDERS
                | FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_NOCHANGEDIR,
        )?;
        dialog.SetTitle(w!("选择项目工作区文件夹（自动索引代码与文档）"))?;
        dialog.SetOkButtonLabel(w!("打开此工作区"))?;
        set_initial_folder(&dialog, initial_dir);

        if let Err(err) = dialog.Show(Some(HWND(owner as *mut _))) {
            return if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(err)
            };
        }
        extract_result_path(&dialog)
    }
}

fn show_file_dialog(owner: isize, initial_dir: &str) -> windows::core::Result<Option<String>> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | FOS_FORCEFILESYSTEM
                | FOS_PATHMUSTEXIST
                | FOS_FILEMUSTEXIST
                | FOS_NOCHANGEDIR,
        )?;
        dialog.SetTitle(w!("打开代码脚本或科研文档"))?;

        let filters = [
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(w!("支持的文档与代码 (*.md;*.pdf;*.py;*.js;*.ts;*.ps1;*.rs;*.html)").as_ptr()),
                pszSpec: PCWSTR(w!("*.md;*.markdown;*.mdx;*.pdf;*.py;*.js;*.mjs;*.ts;*.ps1;*.bat;*.cmd;*.rs;*.json;*.toml;*.yaml;*.yml;*.html;*.htm;*.txt").as_ptr()),
            },
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(w!("Python / 代码脚本 (*.py;*.js;*.ts;*.ps1;*.rs)").as_ptr()),
                pszSpec: PCWSTR(w!("*.py;*.js;*.mjs;*.ts;*.ps1;*.bat;*.cmd;*.rs").as_ptr()),
            },
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(w!("Markdown 文档 (*.md;*.markdown)").as_ptr()),
                pszSpec: PCWSTR(w!("*.md;*.markdown;*.mdx").as_ptr()),
            },
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(w!("PDF 文档 (*.pdf)").as_ptr()),
                pszSpec: PCWSTR(w!("*.pdf").as_ptr()),
            },
            COMDLG_FILTERSPEC {
                pszName: PCWSTR(w!("所有文件 (*.*)").as_ptr()),
                pszSpec: PCWSTR(w!("*.*").as_ptr()),
            },
        ];
        let _ = dialog.SetFileTypes(&filters);
        let _ = dialog.SetFileTypeIndex(1);
        set_initial_folder(&dialog, initial_dir);

        if let Err(err) = dialog.Show(Some(HWND(owner as *mut _))) {
            return if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(err)
            };
        }
        extract_result_path(&dialog)
    }
}

unsafe fn set_initial_folder(dialog: &IFileOpenDialog, initial_dir: &str) {
    if !initial_dir.is_empty() {
        if let Ok(folder) =
            SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(initial_dir), None)
        {
            let _ = dialog.SetFolder(&folder);
        }
    }
}

unsafe fn extract_result_path(dialog: &IFileOpenDialog) -> windows::core::Result<Option<String>> {
    let item = dialog.GetResult()?;
    let raw_path = item.GetDisplayName(SIGDN_FILESYSPATH)?;
    let path_str = raw_path.to_string();
    CoTaskMemFree(Some(raw_path.0.cast()));
    Ok(Some(normalize_windows_path(&path_str?)))
}

pub fn pick_save_file(
    owner: isize,
    initial_dir: String,
    default_name: String,
) -> Result<Option<String>, String> {
    std::thread::Builder::new()
        .name("docprism-save-picker".into())
        .spawn(move || {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|e| format!("无法初始化保存窗口：{e}"))?;
            let _apt = ComApartment;
            show_save_dialog(owner, &initial_dir, &default_name)
                .map_err(|e| format!("选择保存路径失败：{e}"))
        })
        .map_err(|e| format!("无法启动保存对话框线程：{e}"))?
        .join()
        .map_err(|_| "保存对话框异常退出".to_string())?
}

fn show_save_dialog(
    owner: isize,
    initial_dir: &str,
    default_name: &str,
) -> windows::core::Result<Option<String>> {
    unsafe {
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_NOCHANGEDIR,
        )?;
        dialog.SetTitle(w!("保存文件"))?;
        if !default_name.is_empty() {
            let _ = dialog.SetFileName(&HSTRING::from(default_name));
        }
        if !initial_dir.is_empty() {
            if let Ok(folder) =
                SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(initial_dir), None)
            {
                let _ = dialog.SetFolder(&folder);
            }
        }
        if let Err(err) = dialog.Show(Some(HWND(owner as *mut _))) {
            return if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(err)
            };
        }
        let item = dialog.GetResult()?;
        let raw_path = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path_str = raw_path.to_string();
        CoTaskMemFree(Some(raw_path.0.cast()));
        Ok(Some(normalize_windows_path(&path_str?)))
    }
}
