use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::CString;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::SystemTime;
use tauri::{AppHandle, Manager};
use walkdir::{DirEntry, WalkDir};

#[derive(Clone, Copy)]
enum ScanMode {
    RecursiveFiles,
    TrashEntries,
}

#[derive(Clone)]
struct CategoryDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    risk_level: RiskLevel,
    default_selected: bool,
    root: PathBuf,
    scan_mode: ScanMode,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    enabled_categories: Vec<String>,
    exclude_paths: Vec<String>,
    old_file_days: u64,
    min_size_bytes: u64,
    history_retention_days: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            enabled_categories: vec![
                "user_cache".to_string(),
                "logs".to_string(),
                "trash".to_string(),
            ],
            exclude_paths: Vec::new(),
            old_file_days: 90,
            min_size_bytes: 0,
            history_retention_days: 90,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageOverview {
    home_path: String,
    total_bytes: u64,
    available_bytes: u64,
    used_bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanError {
    category_id: String,
    path: String,
    message: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanableItem {
    id: String,
    path: String,
    display_name: String,
    bytes: u64,
    modified_at: String,
    accessed_at: String,
    category_id: String,
    selected: bool,
    deletable: bool,
    warning: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryResult {
    id: String,
    name: String,
    description: String,
    risk_level: RiskLevel,
    total_bytes: u64,
    total_files: usize,
    default_selected: bool,
    items: Vec<CleanableItem>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    id: String,
    started_at: String,
    finished_at: String,
    total_bytes: u64,
    total_files: usize,
    categories: Vec<CategoryResult>,
    errors: Vec<ScanError>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    id: String,
    finished_at: String,
    total_bytes: u64,
    total_files: usize,
    categories: Vec<CategorySummary>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorySummary {
    id: String,
    name: String,
    total_bytes: u64,
    total_files: usize,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupHistory {
    id: String,
    executed_at: String,
    requested_bytes: u64,
    deleted_bytes: u64,
    requested_files: usize,
    deleted_files: usize,
    failed_files: usize,
    categories: Vec<String>,
    result: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupTarget {
    path: String,
    category_id: String,
    bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupRequest {
    items: Vec<CleanupTarget>,
    allow_permanent_trash_delete: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupFailure {
    path: String,
    category_id: String,
    message: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupReport {
    id: String,
    executed_at: String,
    requested_bytes: u64,
    deleted_bytes: u64,
    requested_files: usize,
    deleted_files: usize,
    failed_files: usize,
    categories: Vec<String>,
    failures: Vec<CleanupFailure>,
    deleted_paths: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    storage: StorageOverview,
    settings: AppSettings,
    history: Vec<CleanupHistory>,
    last_scan: Option<ScanSummary>,
}

struct PreparedCleanupTarget {
    path: PathBuf,
    path_string: String,
    category_id: String,
    bytes: u64,
}

#[derive(Default)]
struct CleanupBatchResult {
    deleted_bytes: u64,
    deleted_files: usize,
    failures: Vec<CleanupFailure>,
    deleted_paths: Vec<String>,
}

impl CleanupBatchResult {
    fn record_success(&mut self, target: &PreparedCleanupTarget) {
        self.deleted_bytes += target.bytes;
        self.deleted_files += 1;
        self.deleted_paths.push(target.path_string.clone());
    }

    fn record_failure(&mut self, target: &PreparedCleanupTarget, message: String) {
        self.failures.push(CleanupFailure {
            path: target.path_string.clone(),
            category_id: target.category_id.clone(),
            message,
        });
    }

    fn merge(&mut self, other: CleanupBatchResult) {
        self.deleted_bytes += other.deleted_bytes;
        self.deleted_files += other.deleted_files;
        self.failures.extend(other.failures);
        self.deleted_paths.extend(other.deleted_paths);
    }
}

#[tauri::command]
fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    Ok(AppState {
        storage: storage_overview()?,
        settings: load_settings(&app)?,
        history: load_history(&app)?,
        last_scan: load_last_scan(&app)?,
    })
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let cleaned = sanitize_settings(settings);
    write_json(&settings_path(&app)?, &cleaned)?;
    Ok(cleaned)
}

#[tauri::command]
fn scan_categories(app: AppHandle) -> Result<ScanResult, String> {
    let settings = load_settings(&app)?;
    let started_at = now_iso();
    let mut errors = Vec::new();
    let enabled: HashSet<&str> = settings
        .enabled_categories
        .iter()
        .map(String::as_str)
        .collect();
    let mut categories = Vec::new();

    for definition in category_definitions() {
        if !enabled.contains(definition.id) {
            continue;
        }

        let result = match definition.scan_mode {
            ScanMode::RecursiveFiles => scan_recursive_files(&definition, &settings, &mut errors),
            ScanMode::TrashEntries => scan_trash_entries(&definition, &settings, &mut errors),
        };
        categories.push(result);
    }

    let total_bytes = categories.iter().map(|category| category.total_bytes).sum();
    let total_files = categories.iter().map(|category| category.total_files).sum();
    let result = ScanResult {
        id: make_id(&format!("scan-{started_at}")),
        started_at,
        finished_at: now_iso(),
        total_bytes,
        total_files,
        categories,
        errors,
    };

    write_json(&last_scan_path(&app)?, &scan_summary(&result))?;
    Ok(result)
}

#[tauri::command]
async fn clean_items(app: AppHandle, request: CleanupRequest) -> Result<CleanupReport, String> {
    tauri::async_runtime::spawn_blocking(move || clean_items_blocking(app, request))
        .await
        .map_err(|error| format!("削除処理の実行に失敗しました: {error}"))?
}

fn clean_items_blocking(app: AppHandle, request: CleanupRequest) -> Result<CleanupReport, String> {
    let settings = load_settings(&app)?;
    let executed_at = now_iso();
    let requested_bytes = request.items.iter().map(|item| item.bytes).sum();
    let requested_files = request.items.len();
    let mut categories = HashSet::new();
    let mut normal_targets = Vec::new();
    let mut permanent_trash_targets = Vec::new();
    let mut batch = CleanupBatchResult::default();

    for item in request.items {
        categories.insert(item.category_id.clone());
        let path = expand_tilde(&item.path);
        let path_string = path.to_string_lossy().to_string();

        if is_protected_path(&path) {
            batch.failures.push(CleanupFailure {
                path: path_string,
                category_id: item.category_id,
                message: "保護パスのためスキップしました".to_string(),
            });
            continue;
        }

        if is_excluded_path(&path, &settings) {
            batch.failures.push(CleanupFailure {
                path: path_string,
                category_id: item.category_id,
                message: "除外パスに一致するためスキップしました".to_string(),
            });
            continue;
        }

        if !path.exists() {
            batch.failures.push(CleanupFailure {
                path: path_string,
                category_id: item.category_id,
                message: "スキャン後に移動または削除された可能性があります".to_string(),
            });
            continue;
        }

        let target = PreparedCleanupTarget {
            path,
            path_string,
            category_id: item.category_id,
            bytes: item.bytes,
        };

        if target.category_id == "trash" {
            if request.allow_permanent_trash_delete {
                permanent_trash_targets.push(target);
            } else {
                batch.record_failure(&target, "ゴミ箱内の項目は追加確認が必要です".to_string());
            }
        } else {
            normal_targets.push(target);
        }
    }

    batch.merge(move_targets_to_trash(&normal_targets));
    batch.merge(delete_permanent_targets(&permanent_trash_targets)?);

    let mut category_list: Vec<String> = categories.into_iter().collect();
    category_list.sort();
    let failed_files = batch.failures.len();
    let report = CleanupReport {
        id: make_id(&format!("cleanup-{executed_at}-{requested_files}")),
        executed_at: executed_at.clone(),
        requested_bytes,
        deleted_bytes: batch.deleted_bytes,
        requested_files,
        deleted_files: batch.deleted_files,
        failed_files,
        categories: category_list.clone(),
        failures: batch.failures,
        deleted_paths: batch.deleted_paths,
    };

    append_history(
        &app,
        CleanupHistory {
            id: report.id.clone(),
            executed_at,
            requested_bytes,
            deleted_bytes: report.deleted_bytes,
            requested_files,
            deleted_files: report.deleted_files,
            failed_files,
            categories: category_list,
            result: if failed_files == 0 {
                "success".to_string()
            } else if report.deleted_files == 0 {
                "failed".to_string()
            } else {
                "partial".to_string()
            },
        },
    )?;

    Ok(report)
}

fn move_targets_to_trash(targets: &[PreparedCleanupTarget]) -> CleanupBatchResult {
    let mut result = CleanupBatchResult::default();
    if targets.is_empty() {
        return result;
    }

    let context = fast_trash_context();
    let paths: Vec<&Path> = targets.iter().map(|target| target.path.as_path()).collect();

    if context.delete_all(paths).is_ok() {
        for target in targets {
            result.record_success(target);
        }
        return result;
    }

    for target in targets {
        if !target.path.exists() {
            result.record_success(target);
            continue;
        }

        match context.delete(&target.path) {
            Ok(()) => result.record_success(target),
            Err(error) => {
                result.record_failure(target, format!("ゴミ箱への移動に失敗しました: {error}"))
            }
        }
    }

    result
}

fn fast_trash_context() -> trash::TrashContext {
    let mut context = trash::TrashContext::new();

    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }

    context
}

fn delete_permanent_targets(
    targets: &[PreparedCleanupTarget],
) -> Result<CleanupBatchResult, String> {
    let mut result = CleanupBatchResult::default();
    if targets.is_empty() {
        return Ok(result);
    }

    let worker_count = cleanup_worker_count(targets.len());
    let chunk_size = targets.len().div_ceil(worker_count);

    thread::scope(|scope| {
        let mut handles = Vec::new();

        for chunk in targets.chunks(chunk_size) {
            handles.push(scope.spawn(move || {
                let mut chunk_result = CleanupBatchResult::default();
                for target in chunk {
                    match permanently_delete_trash_item(&target.path) {
                        Ok(()) => chunk_result.record_success(target),
                        Err(message) => chunk_result.record_failure(target, message),
                    }
                }
                chunk_result
            }));
        }

        for handle in handles {
            let chunk_result = handle
                .join()
                .map_err(|_| "削除ワーカーでエラーが発生しました".to_string())?;
            result.merge(chunk_result);
        }

        Ok(result)
    })
}

fn cleanup_worker_count(target_count: usize) -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .min(4)
        .min(target_count.max(1))
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    let target = expand_tilde(&path);
    run_open_command(&["-R", &target.to_string_lossy()])
}

#[tauri::command]
fn open_trash() -> Result<(), String> {
    let trash = home_dir().join(".Trash");
    run_open_command(&[&trash.to_string_lossy()])
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            save_settings,
            scan_categories,
            clean_items,
            open_in_finder,
            open_trash
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ゴミよおさらば");
}

fn category_definitions() -> Vec<CategoryDefinition> {
    let home = home_dir();
    vec![
        CategoryDefinition {
            id: "user_cache",
            name: "ユーザーキャッシュ",
            description: "アプリが再生成できるユーザー領域の一時データです。",
            risk_level: RiskLevel::Low,
            default_selected: true,
            root: home.join("Library").join("Caches"),
            scan_mode: ScanMode::RecursiveFiles,
        },
        CategoryDefinition {
            id: "logs",
            name: "アプリケーションログ",
            description: "ユーザー領域に保存されたログです。調査中のログは確認してください。",
            risk_level: RiskLevel::Low,
            default_selected: true,
            root: home.join("Library").join("Logs"),
            scan_mode: ScanMode::RecursiveFiles,
        },
        CategoryDefinition {
            id: "trash",
            name: "ゴミ箱",
            description: "ゴミ箱内の項目です。削除時は追加確認のうえ完全削除します。",
            risk_level: RiskLevel::Medium,
            default_selected: true,
            root: home.join(".Trash"),
            scan_mode: ScanMode::TrashEntries,
        },
    ]
}

fn scan_recursive_files(
    definition: &CategoryDefinition,
    settings: &AppSettings,
    errors: &mut Vec<ScanError>,
) -> CategoryResult {
    let mut items = Vec::new();

    if !definition.root.exists() {
        return empty_category(definition);
    }

    let walker = WalkDir::new(&definition.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_descend(entry, settings));

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(ScanError {
                    category_id: definition.id.to_string(),
                    path: error
                        .path()
                        .map(|path| path.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    message: error.to_string(),
                });
                continue;
            }
        };

        if entry.file_type().is_dir() {
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if is_protected_path(path) || is_excluded_path(path, settings) {
            continue;
        }

        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ScanError {
                    category_id: definition.id.to_string(),
                    path: path.to_string_lossy().to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };

        if metadata.len() < settings.min_size_bytes {
            continue;
        }

        items.push(item_from_path(definition, path, metadata.len(), true));
    }

    category_from_items(definition, items)
}

fn scan_trash_entries(
    definition: &CategoryDefinition,
    settings: &AppSettings,
    errors: &mut Vec<ScanError>,
) -> CategoryResult {
    let mut items = Vec::new();

    if !definition.root.exists() {
        return empty_category(definition);
    }

    let entries = match fs::read_dir(&definition.root) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(ScanError {
                category_id: definition.id.to_string(),
                path: definition.root.to_string_lossy().to_string(),
                message: error.to_string(),
            });
            return empty_category(definition);
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(ScanError {
                    category_id: definition.id.to_string(),
                    path: definition.root.to_string_lossy().to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };

        let path = entry.path();
        if path == definition.root || is_protected_path(&path) || is_excluded_path(&path, settings)
        {
            continue;
        }

        let bytes = path_size(&path, definition.id, errors);
        if bytes < settings.min_size_bytes {
            continue;
        }

        items.push(item_from_path(definition, &path, bytes, true));
    }

    category_from_items(definition, items)
}

fn empty_category(definition: &CategoryDefinition) -> CategoryResult {
    category_from_items(definition, Vec::new())
}

fn category_from_items(
    definition: &CategoryDefinition,
    items: Vec<CleanableItem>,
) -> CategoryResult {
    let total_bytes = items.iter().map(|item| item.bytes).sum();
    let total_files = items.len();
    CategoryResult {
        id: definition.id.to_string(),
        name: definition.name.to_string(),
        description: definition.description.to_string(),
        risk_level: definition.risk_level,
        total_bytes,
        total_files,
        default_selected: definition.default_selected,
        items,
    }
}

fn item_from_path(
    definition: &CategoryDefinition,
    path: &Path,
    bytes: u64,
    deletable: bool,
) -> CleanableItem {
    let metadata = fs::symlink_metadata(path).ok();
    let modified_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_to_iso)
        .unwrap_or_else(now_iso);
    let accessed_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.accessed().ok())
        .map(system_time_to_iso)
        .unwrap_or_else(|| modified_at.clone());
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let warning = if definition.id == "trash" {
        Some("ゴミ箱内の項目は完全削除になります。".to_string())
    } else {
        None
    };

    CleanableItem {
        id: make_id(&format!("{}:{}", definition.id, path.to_string_lossy())),
        path: path.to_string_lossy().to_string(),
        display_name,
        bytes,
        modified_at,
        accessed_at,
        category_id: definition.id.to_string(),
        selected: definition.default_selected && deletable,
        deletable,
        warning,
    }
}

fn should_descend(entry: &DirEntry, settings: &AppSettings) -> bool {
    let path = entry.path();
    !is_protected_path(path) && !is_excluded_path(path, settings)
}

fn path_size(path: &Path, category_id: &str, errors: &mut Vec<ScanError>) -> u64 {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            errors.push(ScanError {
                category_id: category_id.to_string(),
                path: path.to_string_lossy().to_string(),
                message: error.to_string(),
            });
            return 0;
        }
    };

    if metadata.is_file() {
        return metadata.len();
    }

    if !metadata.is_dir() {
        return 0;
    }

    let mut total = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(ScanError {
                    category_id: category_id.to_string(),
                    path: error
                        .path()
                        .map(|path| path.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.to_string_lossy().to_string()),
                    message: error.to_string(),
                });
                continue;
            }
        };

        if entry.file_type().is_file() {
            match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => total += metadata.len(),
                Err(error) => errors.push(ScanError {
                    category_id: category_id.to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    message: error.to_string(),
                }),
            }
        }
    }
    total
}

fn permanently_delete_trash_item(path: &Path) -> Result<(), String> {
    let trash_root = home_dir().join(".Trash");
    if path == trash_root || !path.starts_with(&trash_root) {
        return Err("ゴミ箱配下ではないため完全削除しません".to_string());
    }

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("完全削除に失敗しました: {error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("完全削除に失敗しました: {error}"))
    }
}

fn scan_summary(result: &ScanResult) -> ScanSummary {
    ScanSummary {
        id: result.id.clone(),
        finished_at: result.finished_at.clone(),
        total_bytes: result.total_bytes,
        total_files: result.total_files,
        categories: result
            .categories
            .iter()
            .map(|category| CategorySummary {
                id: category.id.clone(),
                name: category.name.clone(),
                total_bytes: category.total_bytes,
                total_files: category.total_files,
            })
            .collect(),
    }
}

fn storage_overview() -> Result<StorageOverview, String> {
    let home = home_dir();
    let c_path = CString::new(home.to_string_lossy().as_bytes())
        .map_err(|_| "ホームパスを読み取れませんでした".to_string())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let status = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if status != 0 {
        return Err("ストレージ情報を取得できませんでした".to_string());
    }

    let stat = unsafe { stat.assume_init() };
    let block_size = if stat.f_frsize > 0 {
        stat.f_frsize
    } else {
        stat.f_bsize
    } as u64;
    let total_bytes = (stat.f_blocks as u64).saturating_mul(block_size);
    let available_bytes = (stat.f_bavail as u64).saturating_mul(block_size);
    let free_bytes = (stat.f_bfree as u64).saturating_mul(block_size);
    let used_bytes = total_bytes.saturating_sub(free_bytes);

    Ok(StorageOverview {
        home_path: home.to_string_lossy().to_string(),
        total_bytes,
        available_bytes,
        used_bytes,
    })
}

fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    Ok(sanitize_settings(load_json(&settings_path(app)?)?))
}

fn load_history(app: &AppHandle) -> Result<Vec<CleanupHistory>, String> {
    load_json(&history_path(app)?)
}

fn load_last_scan(app: &AppHandle) -> Result<Option<ScanSummary>, String> {
    let path = last_scan_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    load_json(&path).map(Some)
}

fn append_history(app: &AppHandle, item: CleanupHistory) -> Result<(), String> {
    let mut history = load_history(app)?;
    history.insert(0, item);
    let retention = load_settings(app)?.history_retention_days as usize;
    let max_items = retention.max(1) * 4;
    history.truncate(max_items);
    write_json(&history_path(app)?, &history)
}

fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    let valid: HashSet<&str> = category_definitions()
        .iter()
        .map(|definition| definition.id)
        .collect();
    settings
        .enabled_categories
        .retain(|category| valid.contains(category.as_str()));
    settings.enabled_categories.sort();
    settings.enabled_categories.dedup();
    settings.exclude_paths = settings
        .exclude_paths
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect();
    settings.exclude_paths.sort();
    settings.exclude_paths.dedup();
    settings.old_file_days = settings.old_file_days.clamp(1, 3650);
    settings.history_retention_days = settings.history_retention_days.clamp(1, 3650);
    settings
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("アプリ保存先を取得できませんでした: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("cleanup-history.json"))
}

fn last_scan_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("last-scan.json"))
}

fn load_json<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }

    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(json.as_bytes())
        .map_err(|error| error.to_string())
}

fn is_excluded_path(path: &Path, settings: &AppSettings) -> bool {
    settings.exclude_paths.iter().any(|excluded| {
        let excluded_path = expand_tilde(excluded);
        !excluded_path.as_os_str().is_empty() && path.starts_with(excluded_path)
    })
}

fn is_protected_path(path: &Path) -> bool {
    if has_component(path, ".git") {
        return true;
    }

    let home = home_dir();
    let protected = [
        PathBuf::from("/System"),
        PathBuf::from("/Applications"),
        home.join("Applications"),
        home.join("Documents"),
        home.join("Desktop"),
        home.join("Pictures"),
        home.join("Movies"),
        home.join("Music"),
    ];

    protected
        .iter()
        .any(|protected| path.starts_with(protected))
}

fn has_component(path: &Path, needle: &str) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value == needle,
        _ => false,
    })
}

fn expand_tilde(input: &str) -> PathBuf {
    if input == "~" {
        return home_dir();
    }

    if let Some(rest) = input.strip_prefix("~/") {
        return home_dir().join(rest);
    }

    PathBuf::from(input)
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn system_time_to_iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn make_id(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn run_open_command(args: &[&str]) -> Result<(), String> {
    let status = Command::new("open")
        .args(args)
        .status()
        .map_err(|error| format!("Finderを開けませんでした: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Finderを開けませんでした".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_user_content_directories() {
        let home = home_dir();
        assert!(is_protected_path(&home.join("Documents").join("memo.txt")));
        assert!(is_protected_path(&home.join("Pictures").join("photo.jpg")));
        assert!(!is_protected_path(
            &home.join("Library").join("Caches").join("sample.cache")
        ));
    }

    #[test]
    fn detects_git_directories() {
        let path = home_dir()
            .join("Library")
            .join("Caches")
            .join("repo")
            .join(".git")
            .join("objects");
        assert!(is_protected_path(&path));
    }

    #[test]
    fn expands_home_prefix() {
        assert_eq!(expand_tilde("~/Library"), home_dir().join("Library"));
        assert_eq!(expand_tilde("~"), home_dir());
    }

    #[test]
    fn settings_are_sanitized() {
        let settings = sanitize_settings(AppSettings {
            enabled_categories: vec![
                "logs".to_string(),
                "logs".to_string(),
                "unknown".to_string(),
            ],
            exclude_paths: vec!["".to_string(), " ~/tmp ".to_string()],
            old_file_days: 0,
            min_size_bytes: 12,
            history_retention_days: 0,
        });
        assert_eq!(settings.enabled_categories, vec!["logs"]);
        assert_eq!(settings.exclude_paths, vec!["~/tmp"]);
        assert_eq!(settings.old_file_days, 1);
        assert_eq!(settings.min_size_bytes, 12);
        assert_eq!(settings.history_retention_days, 1);
    }
}
