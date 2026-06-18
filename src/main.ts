import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import "./styles.css";

type RiskLevel = "low" | "medium" | "high";
type View = "home" | "results" | "cleanup" | "history" | "settings";
type DetailSort = "size" | "modified" | "path";
type DetailFilter = "all" | "selected" | "unselected";

type AppSettings = {
  enabledCategories: string[];
  excludePaths: string[];
  oldFileDays: number;
  minSizeBytes: number;
  historyRetentionDays: number;
};

type StorageOverview = {
  homePath: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
};

type ScanError = {
  categoryId: string;
  path: string;
  message: string;
};

type CleanableItem = {
  id: string;
  path: string;
  displayName: string;
  bytes: number;
  modifiedAt: string;
  accessedAt: string;
  categoryId: string;
  selected: boolean;
  deletable: boolean;
  warning?: string | null;
};

type CategoryResult = {
  id: string;
  name: string;
  description: string;
  riskLevel: RiskLevel;
  totalBytes: number;
  totalFiles: number;
  defaultSelected: boolean;
  items: CleanableItem[];
};

type ScanResult = {
  id: string;
  startedAt: string;
  finishedAt: string;
  totalBytes: number;
  totalFiles: number;
  categories: CategoryResult[];
  errors: ScanError[];
};

type CategorySummary = {
  id: string;
  name: string;
  totalBytes: number;
  totalFiles: number;
};

type ScanSummary = {
  id: string;
  finishedAt: string;
  totalBytes: number;
  totalFiles: number;
  categories: CategorySummary[];
};

type CleanupHistory = {
  id: string;
  executedAt: string;
  requestedBytes: number;
  deletedBytes: number;
  requestedFiles: number;
  deletedFiles: number;
  failedFiles: number;
  categories: string[];
  result: "success" | "partial" | "failed";
};

type CleanupTarget = {
  path: string;
  categoryId: string;
  bytes: number;
};

type CleanupFailure = {
  path: string;
  categoryId: string;
  message: string;
};

type CleanupReport = {
  id: string;
  executedAt: string;
  requestedBytes: number;
  deletedBytes: number;
  requestedFiles: number;
  deletedFiles: number;
  failedFiles: number;
  categories: string[];
  failures: CleanupFailure[];
  deletedPaths: string[];
};

type AppState = {
  storage: StorageOverview;
  settings: AppSettings;
  history: CleanupHistory[];
  lastScan?: ScanSummary | null;
};

type UiState = {
  appState: AppState | null;
  scanResult: ScanResult | null;
  cleanupReport: CleanupReport | null;
  selectedItemIds: Set<string>;
  activeCategoryId: string | null;
  view: View;
  sort: DetailSort;
  filter: DetailFilter;
  isLoading: boolean;
  isScanning: boolean;
  isCleaning: boolean;
  confirmOpen: boolean;
  confirmTrashPermanent: boolean;
  settingsDraft: AppSettings | null;
  error: string | null;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root was not found.");
}

const appRoot = app;

const categoryMeta: Record<string, { label: string; short: string }> = {
  user_cache: { label: "ユーザーキャッシュ", short: "キャッシュ" },
  logs: { label: "アプリケーションログ", short: "ログ" },
  trash: { label: "ゴミ箱", short: "ゴミ箱" }
};

const state: UiState = {
  appState: null,
  scanResult: null,
  cleanupReport: null,
  selectedItemIds: new Set(),
  activeCategoryId: null,
  view: "home",
  sort: "size",
  filter: "all",
  isLoading: true,
  isScanning: false,
  isCleaning: false,
  confirmOpen: false,
  confirmTrashPermanent: false,
  settingsDraft: null,
  error: null
};

appRoot.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  void handleAction(action, target);
});

appRoot.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!target.dataset.action) return;
  handleChange(target.dataset.action, target);
});

appRoot.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!target.dataset.action) return;
  handleInput(target.dataset.action, target);
});

void init();

async function init() {
  await refreshAppState();
  state.isLoading = false;
  render();
}

async function refreshAppState() {
  try {
    state.appState = await command<AppState>("get_app_state");
  } catch (error) {
    state.error = asMessage(error);
  }
}

async function handleAction(action: string | undefined, target: HTMLElement) {
  if (!action) return;

  switch (action) {
    case "nav":
      setView((target.dataset.view as View) ?? "home");
      break;
    case "start-scan":
      await startScan();
      break;
    case "select-category":
      state.activeCategoryId = target.dataset.category ?? state.activeCategoryId;
      state.view = "results";
      render();
      break;
    case "set-sort":
      state.sort = (target.dataset.sort as DetailSort) ?? "size";
      render();
      break;
    case "set-filter":
      state.filter = (target.dataset.filter as DetailFilter) ?? "all";
      render();
      break;
    case "open-confirm":
      if (getSelectedItems().length > 0) {
        state.confirmOpen = true;
        state.confirmTrashPermanent = false;
        render();
      }
      break;
    case "close-confirm":
      state.confirmOpen = false;
      state.confirmTrashPermanent = false;
      render();
      break;
    case "run-cleanup":
      await runCleanup();
      break;
    case "open-finder":
      await openInFinder(target.dataset.path ?? "");
      break;
    case "open-trash":
      await command<void>("open_trash");
      break;
    case "save-settings":
      await saveSettings();
      break;
    case "dismiss-error":
      state.error = null;
      render();
      break;
  }
}

function handleChange(action: string, target: HTMLInputElement | HTMLTextAreaElement) {
  switch (action) {
    case "category-toggle":
      toggleCategorySelection(target.dataset.category ?? "", (target as HTMLInputElement).checked);
      break;
    case "item-toggle":
      toggleItemSelection(target.dataset.item ?? "", (target as HTMLInputElement).checked);
      break;
    case "trash-confirm":
      state.confirmTrashPermanent = (target as HTMLInputElement).checked;
      render();
      break;
    case "settings-category":
      updateSettingsCategory(target.dataset.category ?? "", (target as HTMLInputElement).checked);
      break;
  }
}

function handleInput(action: string, target: HTMLInputElement | HTMLTextAreaElement) {
  ensureSettingsDraft();
  if (!state.settingsDraft) return;

  switch (action) {
    case "exclude-paths":
      state.settingsDraft.excludePaths = target.value
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean);
      break;
    case "min-size":
      state.settingsDraft.minSizeBytes = Math.max(0, Number(target.value || 0)) * 1024 * 1024;
      break;
    case "old-days":
      state.settingsDraft.oldFileDays = clampInt(target.value, 1, 3650);
      break;
    case "history-days":
      state.settingsDraft.historyRetentionDays = clampInt(target.value, 1, 3650);
      break;
  }
}

function setView(view: View) {
  state.view = view;
  state.confirmOpen = false;
  if (view === "settings") {
    ensureSettingsDraft(true);
  }
  render();
}

async function startScan() {
  state.isScanning = true;
  state.error = null;
  state.cleanupReport = null;
  state.confirmOpen = false;
  state.view = "results";
  render();

  try {
    const result = await command<ScanResult>("scan_categories");
    state.scanResult = result;
    state.selectedItemIds = new Set(
      result.categories.flatMap((category) =>
        category.items.filter((item) => item.selected && item.deletable).map((item) => item.id)
      )
    );
    state.activeCategoryId = result.categories[0]?.id ?? null;
    await refreshAppState();
  } catch (error) {
    state.error = asMessage(error);
  } finally {
    state.isScanning = false;
    render();
  }
}

async function runCleanup() {
  const selectedItems = getSelectedItems();
  const hasTrash = selectedItems.some((item) => item.categoryId === "trash");

  if (hasTrash && !state.confirmTrashPermanent) {
    state.error = "ゴミ箱内の項目を完全削除するには追加確認が必要です。";
    render();
    return;
  }

  state.isCleaning = true;
  state.cleanupReport = null;
  state.confirmOpen = false;
  state.view = "cleanup";
  state.error = null;
  render();

  const request = {
    items: selectedItems.map<CleanupTarget>((item) => ({
      path: item.path,
      categoryId: item.categoryId,
      bytes: item.bytes
    })),
    allowPermanentTrashDelete: state.confirmTrashPermanent
  };

  try {
    const report = await command<CleanupReport>("clean_items", { request });
    state.cleanupReport = report;
    state.confirmTrashPermanent = false;
    removeDeletedItems(report.deletedPaths);
    state.isCleaning = false;
    render();
    await refreshAppState();
  } catch (error) {
    state.error = asMessage(error);
    state.view = "results";
  } finally {
    state.isCleaning = false;
    state.confirmOpen = false;
    state.confirmTrashPermanent = false;
    render();
  }
}

async function openInFinder(path: string) {
  if (!path) return;
  try {
    await command<void>("open_in_finder", { path });
  } catch (error) {
    state.error = asMessage(error);
    render();
  }
}

async function saveSettings() {
  ensureSettingsDraft();
  if (!state.settingsDraft) return;

  try {
    const settings = await command<AppSettings>("save_settings", {
      settings: state.settingsDraft
    });
    if (state.appState) {
      state.appState.settings = settings;
    }
    state.settingsDraft = structuredClone(settings);
    state.error = null;
  } catch (error) {
    state.error = asMessage(error);
  }
  render();
}

function toggleCategorySelection(categoryId: string, selected: boolean) {
  const category = state.scanResult?.categories.find((candidate) => candidate.id === categoryId);
  if (!category) return;

  for (const item of category.items) {
    if (!item.deletable) continue;
    if (selected) {
      state.selectedItemIds.add(item.id);
    } else {
      state.selectedItemIds.delete(item.id);
    }
  }
  render();
}

function toggleItemSelection(itemId: string, selected: boolean) {
  const item = getAllItems().find((candidate) => candidate.id === itemId);
  if (!item?.deletable) return;

  if (selected) {
    state.selectedItemIds.add(itemId);
  } else {
    state.selectedItemIds.delete(itemId);
  }
  render();
}

function updateSettingsCategory(categoryId: string, enabled: boolean) {
  ensureSettingsDraft();
  if (!state.settingsDraft || !categoryId) return;

  const next = new Set(state.settingsDraft.enabledCategories);
  if (enabled) {
    next.add(categoryId);
  } else {
    next.delete(categoryId);
  }
  state.settingsDraft.enabledCategories = [...next].sort();
}

function removeDeletedItems(paths: string[]) {
  if (!state.scanResult || paths.length === 0) return;

  const deleted = new Set(paths);
  for (const category of state.scanResult.categories) {
    category.items = category.items.filter((item) => !deleted.has(item.path));
    category.totalBytes = category.items.reduce((sum, item) => sum + item.bytes, 0);
    category.totalFiles = category.items.length;
  }

  state.scanResult.totalBytes = state.scanResult.categories.reduce(
    (sum, category) => sum + category.totalBytes,
    0
  );
  state.scanResult.totalFiles = state.scanResult.categories.reduce(
    (sum, category) => sum + category.totalFiles,
    0
  );

  state.selectedItemIds = new Set(
    getAllItems()
      .filter((item) => state.selectedItemIds.has(item.id))
      .map((item) => item.id)
  );
}

function ensureSettingsDraft(force = false) {
  if (!state.appState) return;
  if (force || !state.settingsDraft) {
    state.settingsDraft = structuredClone(state.appState.settings);
  }
}

function getAllItems(): CleanableItem[] {
  return state.scanResult?.categories.flatMap((category) => category.items) ?? [];
}

function getSelectedItems(): CleanableItem[] {
  return getAllItems().filter((item) => state.selectedItemIds.has(item.id) && item.deletable);
}

function selectedStats() {
  const items = getSelectedItems();
  return {
    files: items.length,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    hasTrash: items.some((item) => item.categoryId === "trash"),
    categories: [...new Set(items.map((item) => item.categoryId))]
  };
}

function render() {
  const content = state.isLoading
    ? renderLoading()
    : state.isScanning
      ? renderScanning()
      : renderView();

  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">掃</div>
          <div>
            <strong>ゴミよおさらば</strong>
            <span>macOS cleanup</span>
          </div>
        </div>
        <nav class="nav">
          ${navButton("home", "ホーム")}
          ${navButton("results", "スキャン結果")}
          ${navButton("history", "履歴")}
          ${navButton("settings", "設定")}
        </nav>
        ${renderSidebarStatus()}
      </aside>
      <main class="workspace">
        ${renderTopbar()}
        ${state.error ? renderError(state.error) : ""}
        <section class="screen">${content}</section>
      </main>
      ${state.confirmOpen ? renderConfirmDialog() : ""}
    </div>
  `;
}

function navButton(view: View, label: string) {
  const active = state.view === view ? "is-active" : "";
  return `<button class="nav-button ${active}" data-action="nav" data-view="${view}">${label}</button>`;
}

function renderTopbar() {
  const storage = state.appState?.storage;
  const available = storage ? formatBytes(storage.availableBytes) : "-";
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">Apple Silicon / macOS 13+</p>
        <h1>${pageTitle()}</h1>
      </div>
      <div class="topbar-meta">
        <span>空き容量</span>
        <strong>${available}</strong>
      </div>
    </header>
  `;
}

function renderSidebarStatus() {
  const lastScan = state.appState?.lastScan;
  return `
    <div class="sidebar-status">
      <span>前回スキャン</span>
      <strong>${lastScan ? formatDate(lastScan.finishedAt) : "未実行"}</strong>
      <small>${lastScan ? `${formatBytes(lastScan.totalBytes)} / ${lastScan.totalFiles}件` : "対象カテゴリを選んで開始"}</small>
    </div>
  `;
}

function pageTitle() {
  if (state.isScanning) return "スキャン中";
  if (state.isCleaning) return "削除中";
  const titles: Record<View, string> = {
    home: "ホーム",
    results: "スキャン結果",
    cleanup: "削除完了",
    history: "削除履歴",
    settings: "設定"
  };
  return titles[state.view];
}

function renderView() {
  switch (state.view) {
    case "home":
      return renderHome();
    case "results":
      return renderResults();
    case "cleanup":
      return renderCleanup();
    case "history":
      return renderHistory();
    case "settings":
      return renderSettings();
  }
}

function renderLoading() {
  return `
    <div class="center-state">
      <div class="loader"></div>
      <h2>ローカル状態を読み込み中</h2>
    </div>
  `;
}

function renderScanning() {
  return `
    <div class="scan-state">
      <div class="scan-pulse"></div>
      <div>
        <p class="eyebrow">Scan in progress</p>
        <h2>キャッシュ、ログ、ゴミ箱を確認しています</h2>
        <p>アクセスできない領域はスキップし、理由を結果に残します。</p>
      </div>
      <div class="progress-track"><span></span></div>
    </div>
  `;
}

function renderHome() {
  const appState = state.appState;
  if (!appState) return renderLoading();

  const storage = appState.storage;
  const usedRatio = storage.totalBytes > 0 ? (storage.usedBytes / storage.totalBytes) * 100 : 0;
  const lastScan = appState.lastScan;
  const categories = appState.settings.enabledCategories;

  return `
    <div class="home-grid">
      <section class="storage-panel">
        <div class="panel-heading">
          <p class="eyebrow">Storage</p>
          <h2>${formatBytes(storage.availableBytes)} 空き</h2>
        </div>
        <div class="storage-bar" aria-label="ストレージ使用量">
          <span style="width: ${Math.min(100, Math.max(0, usedRatio))}%"></span>
        </div>
        <div class="metric-row">
          <div><span>使用中</span><strong>${formatBytes(storage.usedBytes)}</strong></div>
          <div><span>合計</span><strong>${formatBytes(storage.totalBytes)}</strong></div>
          <div><span>ホーム</span><strong title="${escapeAttr(storage.homePath)}">${escapeHtml(shortPath(storage.homePath))}</strong></div>
        </div>
        <button class="primary-action" data-action="start-scan">スキャン開始</button>
      </section>

      <section class="summary-panel">
        <div class="panel-heading">
          <p class="eyebrow">Last scan</p>
          <h2>${lastScan ? formatBytes(lastScan.totalBytes) : "未スキャン"}</h2>
        </div>
        ${
          lastScan
            ? `<p>${formatDate(lastScan.finishedAt)} に ${lastScan.totalFiles} 件を検出しました。</p>`
            : "<p>初回スキャンで、削除前に確認できる候補だけを表示します。</p>"
        }
        <div class="inline-actions">
          <button class="secondary-action" data-action="nav" data-view="history">履歴を見る</button>
          <button class="secondary-action" data-action="nav" data-view="settings">設定</button>
        </div>
      </section>
    </div>

    <section class="category-strip">
      <div class="section-title">
        <h2>スキャン対象</h2>
        <p>${categories.length}カテゴリが有効です。</p>
      </div>
      <div class="category-list compact">
        ${Object.entries(categoryMeta)
          .map(([id, meta]) => {
            const enabled = categories.includes(id);
            const summary = lastScan?.categories.find((category) => category.id === id);
            return `
              <button class="category-row ${enabled ? "" : "is-muted"}" data-action="nav" data-view="settings">
                <span>${escapeHtml(meta.label)}</span>
                <strong>${summary ? formatBytes(summary.totalBytes) : enabled ? "対象" : "無効"}</strong>
              </button>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderResults() {
  const result = state.scanResult;
  if (!result) {
    const lastScan = state.appState?.lastScan;
    return `
      <div class="empty-state">
        <p class="eyebrow">Results</p>
        <h2>このセッションのスキャン結果はありません</h2>
        <p>${lastScan ? `前回は ${formatDate(lastScan.finishedAt)} に ${formatBytes(lastScan.totalBytes)} を検出しました。` : "スキャンを開始するとカテゴリ別の候補と詳細が表示されます。"}</p>
        <button class="primary-action" data-action="start-scan">スキャン開始</button>
      </div>
    `;
  }

  const activeCategory = result.categories.find((category) => category.id === state.activeCategoryId) ?? result.categories[0];
  const stats = selectedStats();

  return `
    <div class="results-summary">
      <div>
        <p class="eyebrow">Scan finished</p>
        <h2>${formatBytes(result.totalBytes)} / ${result.totalFiles}件</h2>
        <p>${formatDate(result.finishedAt)} に完了しました。</p>
      </div>
      <div class="delete-summary">
        <span>削除予定</span>
        <strong>${formatBytes(stats.bytes)}</strong>
        <small>${stats.files}件</small>
        <button class="primary-action" data-action="open-confirm" ${stats.files === 0 ? "disabled" : ""}>削除確認</button>
      </div>
    </div>

    <div class="results-layout">
      <section class="category-column">
        ${result.categories.map(renderCategoryRow).join("")}
        ${result.errors.length > 0 ? renderScanErrors(result.errors) : ""}
      </section>
      <section class="details-column">
        ${activeCategory ? renderDetails(activeCategory) : renderNoCategory()}
      </section>
    </div>
  `;
}

function renderCategoryRow(category: CategoryResult) {
  const selectedCount = category.items.filter((item) => state.selectedItemIds.has(item.id)).length;
  const deletableCount = category.items.filter((item) => item.deletable).length;
  const checked = deletableCount > 0 && selectedCount === deletableCount;
  const active = category.id === state.activeCategoryId ? "is-active" : "";

  return `
    <article class="category-card ${active}" data-action="select-category" data-category="${category.id}">
      <div class="category-card-main">
        <input
          type="checkbox"
          data-action="category-toggle"
          data-category="${category.id}"
          ${checked ? "checked" : ""}
          ${deletableCount === 0 ? "disabled" : ""}
          aria-label="${escapeAttr(category.name)}を選択"
        />
        <div>
          <h3>${escapeHtml(category.name)}</h3>
          <p>${escapeHtml(category.description)}</p>
        </div>
      </div>
      <div class="category-card-meta">
        <span class="risk risk-${category.riskLevel}">${riskLabel(category.riskLevel)}</span>
        <strong>${formatBytes(category.totalBytes)}</strong>
        <small>${selectedCount}/${category.totalFiles}件 選択</small>
      </div>
    </article>
  `;
}

function renderDetails(category: CategoryResult) {
  const items = sortedItems(filteredItems(category.items));
  const limited = items.slice(0, 300);

  return `
    <div class="details-header">
      <div>
        <p class="eyebrow">Details</p>
        <h2>${escapeHtml(category.name)}</h2>
      </div>
      <div class="segmented">
        ${segmentButton("set-filter", "all", "全て", state.filter)}
        ${segmentButton("set-filter", "selected", "選択済み", state.filter)}
        ${segmentButton("set-filter", "unselected", "未選択", state.filter)}
      </div>
    </div>
    <div class="toolbar-line">
      <span>${items.length}件を表示</span>
      <div class="segmented">
        ${segmentButton("set-sort", "size", "サイズ", state.sort)}
        ${segmentButton("set-sort", "modified", "更新日", state.sort)}
        ${segmentButton("set-sort", "path", "パス", state.sort)}
      </div>
    </div>
    <div class="file-table">
      <div class="file-row file-head">
        <span></span>
        <span>項目</span>
        <span>サイズ</span>
        <span>更新日</span>
        <span></span>
      </div>
      ${
        limited.length > 0
          ? limited.map(renderFileRow).join("")
          : `<div class="table-empty">表示できる項目はありません。</div>`
      }
    </div>
    ${items.length > limited.length ? `<p class="table-note">表示を軽くするため、先頭300件までを表示しています。選択状態は全件に反映されます。</p>` : ""}
  `;
}

function renderFileRow(item: CleanableItem) {
  return `
    <div class="file-row">
      <input
        type="checkbox"
        data-action="item-toggle"
        data-item="${item.id}"
        ${state.selectedItemIds.has(item.id) ? "checked" : ""}
        ${!item.deletable ? "disabled" : ""}
        aria-label="${escapeAttr(item.displayName)}を選択"
      />
      <div class="path-cell">
        <strong>${escapeHtml(item.displayName)}</strong>
        <span title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span>
        ${item.warning ? `<em>${escapeHtml(item.warning)}</em>` : ""}
      </div>
      <span>${formatBytes(item.bytes)}</span>
      <span>${formatDate(item.modifiedAt)}</span>
      <button class="icon-button" data-action="open-finder" data-path="${escapeAttr(item.path)}" title="Finderで表示">表示</button>
    </div>
  `;
}

function renderNoCategory() {
  return `
    <div class="empty-state">
      <h2>対象カテゴリがありません</h2>
      <p>設定で少なくとも1つのカテゴリを有効にしてください。</p>
      <button class="secondary-action" data-action="nav" data-view="settings">設定を開く</button>
    </div>
  `;
}

function renderScanErrors(errors: ScanError[]) {
  return `
    <div class="scan-errors">
      <h3>スキャン中のスキップ</h3>
      ${errors
        .slice(0, 6)
        .map(
          (error) => `
            <p>
              <strong>${escapeHtml(categoryMeta[error.categoryId]?.short ?? error.categoryId)}</strong>
              <span title="${escapeAttr(error.path)}">${escapeHtml(shortPath(error.path))}</span>
              <small>${escapeHtml(error.message)}</small>
            </p>
          `
        )
        .join("")}
      ${errors.length > 6 ? `<small>ほか ${errors.length - 6}件</small>` : ""}
    </div>
  `;
}

function renderConfirmDialog() {
  const stats = selectedStats();
  const selectedCategories = stats.categories.map((id) => categoryMeta[id]?.label ?? id).join("、");
  const blocked = stats.hasTrash && !state.confirmTrashPermanent;

  return `
    <div class="modal-backdrop">
      <section class="confirm-dialog">
        <div class="panel-heading">
          <p class="eyebrow">Confirm cleanup</p>
          <h2>削除前確認</h2>
        </div>
        <div class="confirm-metrics">
          <div><span>対象サイズ</span><strong>${formatBytes(stats.bytes)}</strong></div>
          <div><span>対象件数</span><strong>${stats.files}件</strong></div>
          <div><span>カテゴリ</span><strong>${escapeHtml(selectedCategories || "-")}</strong></div>
        </div>
        <p class="confirm-copy">キャッシュとログはmacOSのゴミ箱へ移動します。ゴミ箱カテゴリは既にゴミ箱内にあるため、追加確認がある場合のみ完全削除します。</p>
        ${
          stats.hasTrash
            ? `
              <label class="danger-check">
                <input type="checkbox" data-action="trash-confirm" ${state.confirmTrashPermanent ? "checked" : ""} />
                <span>ゴミ箱内の選択項目を完全削除することを理解しました</span>
              </label>
            `
            : ""
        }
        <div class="dialog-actions">
          <button class="secondary-action" data-action="close-confirm">戻る</button>
          <button class="primary-action danger" data-action="run-cleanup" ${blocked || state.isCleaning ? "disabled" : ""}>
            ${state.isCleaning ? "処理中" : "実行"}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderCleanup() {
  if (state.isCleaning) {
    return renderCleaning();
  }

  const report = state.cleanupReport;
  if (!report) {
    return `
      <div class="empty-state">
        <h2>削除結果はありません</h2>
        <button class="secondary-action" data-action="nav" data-view="results">結果へ戻る</button>
      </div>
    `;
  }

  return `
    <section class="cleanup-report">
      <div class="panel-heading">
        <p class="eyebrow">Cleanup complete</p>
        <h2>${formatBytes(report.deletedBytes)} を処理しました</h2>
      </div>
      <div class="metric-row">
        <div><span>成功</span><strong>${report.deletedFiles}件</strong></div>
        <div><span>失敗</span><strong>${report.failedFiles}件</strong></div>
        <div><span>要求サイズ</span><strong>${formatBytes(report.requestedBytes)}</strong></div>
      </div>
      <div class="inline-actions">
        <button class="primary-action" data-action="open-trash">ゴミ箱を開く</button>
        <button class="secondary-action" data-action="nav" data-view="results">結果へ戻る</button>
      </div>
      ${
        report.failures.length > 0
          ? `
            <div class="failure-list">
              <h3>失敗した項目</h3>
              ${report.failures
                .map(
                  (failure) => `
                    <p>
                      <strong>${escapeHtml(shortPath(failure.path))}</strong>
                      <span>${escapeHtml(failure.message)}</span>
                    </p>
                  `
                )
                .join("")}
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderCleaning() {
  const stats = selectedStats();
  return `
    <div class="scan-state">
      <div class="loader"></div>
      <div>
        <p class="eyebrow">Cleanup in progress</p>
        <h2>選択した項目を処理しています</h2>
        <p>${formatBytes(stats.bytes)} / ${stats.files}件を処理中です。完了後に結果を表示します。</p>
      </div>
    </div>
  `;
}

function renderHistory() {
  const history = state.appState?.history ?? [];
  if (history.length === 0) {
    return `
      <div class="empty-state">
        <p class="eyebrow">History</p>
        <h2>削除履歴はありません</h2>
        <p>削除を実行すると、日時、サイズ、件数、カテゴリがここに残ります。</p>
      </div>
    `;
  }

  return `
    <div class="history-list">
      ${history
        .map(
          (item) => `
            <article class="history-row">
              <div>
                <strong>${formatDate(item.executedAt)}</strong>
                <span>${item.categories.map((category) => categoryMeta[category]?.short ?? category).join("、")}</span>
              </div>
              <div>
                <strong>${formatBytes(item.deletedBytes)}</strong>
                <span>${item.deletedFiles}/${item.requestedFiles}件</span>
              </div>
              <span class="status status-${item.result}">${historyStatus(item.result)}</span>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSettings() {
  ensureSettingsDraft();
  const draft = state.settingsDraft;
  if (!draft) return renderLoading();

  return `
    <div class="settings-layout">
      <section class="settings-section">
        <div class="section-title">
          <h2>スキャン対象</h2>
          <p>カテゴリ単位でオン/オフできます。</p>
        </div>
        <div class="toggle-list">
          ${Object.entries(categoryMeta)
            .map(
              ([id, meta]) => `
                <label class="toggle-row">
                  <span>
                    <strong>${escapeHtml(meta.label)}</strong>
                    <small>${settingsDescription(id)}</small>
                  </span>
                  <input type="checkbox" data-action="settings-category" data-category="${id}" ${draft.enabledCategories.includes(id) ? "checked" : ""} />
                </label>
              `
            )
            .join("")}
        </div>
      </section>

      <section class="settings-section">
        <div class="section-title">
          <h2>除外パス</h2>
          <p>1行に1つずつ入力します。チルダ表記を使えます。</p>
        </div>
        <textarea class="path-input" data-action="exclude-paths" spellcheck="false">${escapeHtml(draft.excludePaths.join("\n"))}</textarea>
      </section>

      <section class="settings-section settings-grid">
        <label>
          <span>最小表示サイズ MB</span>
          <input type="number" min="0" step="1" value="${Math.round(draft.minSizeBytes / 1024 / 1024)}" data-action="min-size" />
        </label>
        <label>
          <span>古いファイル判定 日</span>
          <input type="number" min="1" step="1" value="${draft.oldFileDays}" data-action="old-days" />
        </label>
        <label>
          <span>履歴保持 日</span>
          <input type="number" min="1" step="1" value="${draft.historyRetentionDays}" data-action="history-days" />
        </label>
      </section>

      <div class="settings-actions">
        <button class="primary-action" data-action="save-settings">設定を保存</button>
      </div>
    </div>
  `;
}

function segmentButton(action: string, value: string, label: string, activeValue: string) {
  return `
    <button class="${value === activeValue ? "is-active" : ""}" data-action="${action}" data-${action === "set-sort" ? "sort" : "filter"}="${value}">
      ${label}
    </button>
  `;
}

function filteredItems(items: CleanableItem[]) {
  if (state.filter === "selected") {
    return items.filter((item) => state.selectedItemIds.has(item.id));
  }
  if (state.filter === "unselected") {
    return items.filter((item) => !state.selectedItemIds.has(item.id));
  }
  return items;
}

function sortedItems(items: CleanableItem[]) {
  return [...items].sort((a, b) => {
    if (state.sort === "path") return a.path.localeCompare(b.path);
    if (state.sort === "modified") {
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    }
    return b.bytes - a.bytes;
  });
}

function settingsDescription(id: string) {
  if (id === "user_cache") return "ユーザー領域の ~/Library/Caches";
  if (id === "logs") return "ユーザー領域の ~/Library/Logs";
  return " ~/.Trash の直下項目";
}

function renderError(message: string) {
  return `
    <div class="error-banner">
      <span>${escapeHtml(message)}</span>
      <button data-action="dismiss-error">閉じる</button>
    </div>
  `;
}

function riskLabel(risk: RiskLevel) {
  return risk === "low" ? "低リスク" : risk === "medium" ? "確認推奨" : "慎重に確認";
}

function historyStatus(result: CleanupHistory["result"]) {
  if (result === "success") return "完了";
  if (result === "partial") return "一部失敗";
  return "失敗";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function shortPath(path: string) {
  const home = state.appState?.storage.homePath;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  if (path.length <= 42) return path;
  return `...${path.slice(-39)}`;
}

function clampInt(value: string, min: number, max: number) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value: unknown) {
  return escapeHtml(value);
}

function asMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI_INTERNALS__) {
    return mockCommand<T>(name, args);
  }
  return tauriInvoke<T>(name, args);
}

async function mockCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, name === "scan_categories" ? 900 : 150));

  if (name === "get_app_state") {
    return mockAppState() as T;
  }
  if (name === "scan_categories") {
    return mockScanResult() as T;
  }
  if (name === "save_settings") {
    return (args?.settings ?? mockAppState().settings) as T;
  }
  if (name === "clean_items") {
    const request = args?.request as { items: CleanupTarget[] };
    const deletedBytes = request.items.reduce((sum, item) => sum + item.bytes, 0);
    return {
      id: "mock-cleanup",
      executedAt: new Date().toISOString(),
      requestedBytes: deletedBytes,
      deletedBytes,
      requestedFiles: request.items.length,
      deletedFiles: request.items.length,
      failedFiles: 0,
      categories: [...new Set(request.items.map((item) => item.categoryId))],
      failures: [],
      deletedPaths: request.items.map((item) => item.path)
    } satisfies CleanupReport as T;
  }
  return undefined as T;
}

function mockAppState(): AppState {
  const home = "/Users/example";
  return {
    storage: {
      homePath: home,
      totalBytes: 512 * 1024 ** 3,
      availableBytes: 86 * 1024 ** 3,
      usedBytes: 426 * 1024 ** 3
    },
    settings: {
      enabledCategories: ["logs", "trash", "user_cache"],
      excludePaths: ["~/Library/Caches/DoNotTouch"],
      oldFileDays: 90,
      minSizeBytes: 0,
      historyRetentionDays: 90
    },
    history: [
      {
        id: "history-1",
        executedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
        requestedBytes: 780 * 1024 ** 2,
        deletedBytes: 760 * 1024 ** 2,
        requestedFiles: 120,
        deletedFiles: 116,
        failedFiles: 4,
        categories: ["user_cache", "logs"],
        result: "partial"
      }
    ],
    lastScan: {
      id: "last-scan",
      finishedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
      totalBytes: 1420 * 1024 ** 2,
      totalFiles: 272,
      categories: [
        { id: "user_cache", name: "ユーザーキャッシュ", totalBytes: 980 * 1024 ** 2, totalFiles: 191 },
        { id: "logs", name: "アプリケーションログ", totalBytes: 140 * 1024 ** 2, totalFiles: 74 },
        { id: "trash", name: "ゴミ箱", totalBytes: 300 * 1024 ** 2, totalFiles: 7 }
      ]
    }
  };
}

function mockScanResult(): ScanResult {
  const now = new Date().toISOString();
  const categories: CategoryResult[] = [
    mockCategory("user_cache", "ユーザーキャッシュ", "アプリが再生成できるユーザー領域の一時データです。", "low", 14),
    mockCategory("logs", "アプリケーションログ", "ユーザー領域に保存されたログです。", "low", 9),
    mockCategory("trash", "ゴミ箱", "ゴミ箱内の項目です。削除時は追加確認のうえ完全削除します。", "medium", 5)
  ];
  return {
    id: "mock-scan",
    startedAt: now,
    finishedAt: now,
    totalBytes: categories.reduce((sum, category) => sum + category.totalBytes, 0),
    totalFiles: categories.reduce((sum, category) => sum + category.totalFiles, 0),
    categories,
    errors: []
  };
}

function mockCategory(
  id: string,
  name: string,
  description: string,
  riskLevel: RiskLevel,
  count: number
): CategoryResult {
  const home = "/Users/example";
  const root =
    id === "user_cache" ? `${home}/Library/Caches` : id === "logs" ? `${home}/Library/Logs` : `${home}/.Trash`;
  const items = Array.from({ length: count }, (_, index) => {
    const bytes = (index + 1) * 12 * 1024 ** 2;
    const path = `${root}/${id}-${index + 1}${id === "logs" ? ".log" : ".cache"}`;
    return {
      id: `${id}-${index}`,
      path,
      displayName: path.split("/").slice(-1)[0] ?? path,
      bytes,
      modifiedAt: new Date(Date.now() - index * 3600000).toISOString(),
      accessedAt: new Date(Date.now() - index * 7200000).toISOString(),
      categoryId: id,
      selected: true,
      deletable: true,
      warning: id === "trash" ? "ゴミ箱内の項目は完全削除になります。" : null
    };
  });
  return {
    id,
    name,
    description,
    riskLevel,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    totalFiles: items.length,
    defaultSelected: true,
    items
  };
}
