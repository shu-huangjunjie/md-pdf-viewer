use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub prefs_file: PathBuf,
    pub is_portable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspaceSession {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub root_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub theme: String,
    pub font_size: u32,
    pub content_width: String,
    pub last_workspace: Option<String>,
    pub recent_workspaces: Vec<String>,
    pub recent_files: Vec<String>,
    pub bookmarks: Vec<String>,
    #[serde(default)]
    pub preferred_python: Option<String>,
    #[serde(default)]
    pub saved_workspaces: Vec<SavedWorkspaceSession>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
}

impl Default for UserPreferences {
    fn default() -> Self {
        let mut bookmarks = Vec::new();
        let default_study_dir =
            r"D:\huangjunjie\fine-tune the model using field data-total\gemini";
        if Path::new(default_study_dir).is_dir() {
            bookmarks.push(default_study_dir.to_string());
        }
        Self {
            theme: "light".to_string(),
            font_size: 16,
            content_width: "comfortable".to_string(),
            last_workspace: bookmarks.first().cloned(),
            recent_workspaces: bookmarks.clone(),
            recent_files: Vec::new(),
            bookmarks,
            preferred_python: None,
            saved_workspaces: Vec::new(),
            active_workspace_id: None,
        }
    }
}

impl AppPaths {
    pub fn discover() -> Result<Self, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));

        if let Some(ref dir) = exe_dir {
            let portable_data = dir.join("data");
            if portable_data.is_dir() {
                let logs_dir = portable_data.join("logs");
                std::fs::create_dir_all(&logs_dir)
                    .map_err(|e| format!("无法创建便携日志目录: {e}"))?;
                return Ok(Self {
                    prefs_file: portable_data.join("preferences.json"),
                    data_dir: portable_data,
                    logs_dir,
                    is_portable: true,
                });
            }
        }

        let local_root = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
        let base = local_root.join("PrismStudio");
        let data_dir = base.join("data");
        let logs_dir = base.join("logs");
        std::fs::create_dir_all(&data_dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
        std::fs::create_dir_all(&logs_dir).map_err(|e| format!("无法创建日志目录: {e}"))?;

        let prefs_file = data_dir.join("preferences.json");
        if !prefs_file.exists() {
            let legacy_prefs = local_root
                .join("DocPrismReader")
                .join("data")
                .join("preferences.json");
            if legacy_prefs.is_file() {
                let _ = std::fs::copy(&legacy_prefs, &prefs_file);
            }
        }

        Ok(Self {
            prefs_file,
            data_dir,
            logs_dir,
            is_portable: false,
        })
    }

    pub fn load_preferences(&self) -> UserPreferences {
        if let Ok(raw) = std::fs::read_to_string(&self.prefs_file) {
            if let Ok(prefs) = serde_json::from_str::<UserPreferences>(&raw) {
                return prefs;
            }
        }
        let defaults = UserPreferences::default();
        let _ = self.save_preferences(&defaults);
        defaults
    }

    pub fn save_preferences(&self, prefs: &UserPreferences) -> Result<(), String> {
        let json = serde_json::to_string_pretty(prefs)
            .map_err(|e| format!("序列化配置失败: {e}"))?;
        std::fs::write(&self.prefs_file, json).map_err(|e| format!("保存配置失败: {e}"))
    }
}

pub fn normalize_windows_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let stripped = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    stripped.replace('/', r"\")
}

pub fn to_slash_path(path: &Path) -> String {
    normalize_windows_path(&path.to_string_lossy()).replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_preferences_deserialize_without_saved_workspaces() {
        let legacy_json = r#"{
            "theme": "dark",
            "fontSize": 18,
            "contentWidth": "wide",
            "lastWorkspace": "D:\\project_a",
            "recentWorkspaces": ["D:\\project_a"],
            "recentFiles": [],
            "bookmarks": []
        }"#;
        let prefs: UserPreferences =
            serde_json::from_str(legacy_json).expect("legacy prefs should parse");
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.saved_workspaces.len(), 0);
        assert_eq!(prefs.active_workspace_id, None);
    }

    #[test]
    fn multi_workspace_preferences_roundtrip() {
        let mut prefs = UserPreferences::default();
        prefs.saved_workspaces = vec![
            SavedWorkspaceSession {
                id: "ws-1".to_string(),
                name: Some("实验空间".to_string()),
                root_paths: vec![r"D:\proj_a".to_string(), r"E:\data_b".to_string()],
            },
            SavedWorkspaceSession {
                id: "ws-2".to_string(),
                name: None,
                root_paths: vec![r"D:\tools\viewer".to_string()],
            },
        ];
        prefs.active_workspace_id = Some("ws-1".to_string());

        let json = serde_json::to_string(&prefs).expect("serialize");
        let parsed: UserPreferences = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.saved_workspaces, prefs.saved_workspaces);
        assert_eq!(parsed.active_workspace_id.as_deref(), Some("ws-1"));
    }
}
