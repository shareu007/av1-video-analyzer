import {
  BlockOverlayRenderer,
  BlockSpatialIndex,
  motionVectorReferenceColor,
  motionVectorToPixels,
  blockLayerLegend,
} from "./block-renderer.js";
import { filterBlockRecords, summarizeBlockStatistics } from "./block-statistics.js";
import { buildNativeTraceFieldMap, compareTraceEntry } from "./trace-compare.js";
import { nextNavigationIndex } from "./keyboard-navigation.js";
import { csvRow, timelineCsvRows } from "./csv.js";
import {
  DEFAULT_FRAME_TABLE_FILTERS,
  buildFrameTableRows,
  filterFrameTableRows,
  frameTableCsvRows,
  pageFrameTableRows,
  sortFrameTableRows,
} from "./frame-table.js";
import { DEMO_SAMPLE_NAME, demoSampleBytes } from "./demo-sample.js";
import { displayedFrameSummary, sourcePointFromClient } from "./preview-model.js";
import { analysisModes } from "./analysis-modes.js";
import { attachPreviewPan } from "./preview-pan.js";

const elements = {
  openButton: document.querySelector("#open-button"),
  emptyOpenButton: document.querySelector("#empty-open-button"),
  demoButton: document.querySelector("#demo-button"),
  fileInput: document.querySelector("#file-input"),
  fileSummary: document.querySelector("#file-summary"),
  serviceStatus: document.querySelector("#service-status"),
  themeButton: document.querySelector("#theme-button"),
  exportButton: document.querySelector("#export-button"),
  csvButton: document.querySelector("#csv-button"),
  pngButton: document.querySelector("#png-button"),
  overlayButton: document.querySelector("#overlay-button"),
  overlayInput: document.querySelector("#overlay-input"),
  compareButton: document.querySelector("#compare-button"),
  cacheGcButton: document.querySelector("#cache-gc-button"),
  cacheGcDialog: document.querySelector("#cache-gc-dialog"),
  cacheGcAgeInput: document.querySelector("#cache-gc-age-input"),
  cacheGcResults: document.querySelector("#cache-gc-results"),
  cacheGcPreview: document.querySelector("#cache-gc-preview"),
  cacheGcApply: document.querySelector("#cache-gc-apply"),
  snapshotButton: document.querySelector("#snapshot-button"),
  snapshotDialog: document.querySelector("#snapshot-dialog"),
  snapshotForm: document.querySelector("#snapshot-form"),
  snapshotIdInput: document.querySelector("#snapshot-id-input"),
  derivedSyntaxIdInput: document.querySelector("#derived-syntax-id-input"),
  syntaxOverlayIdInput: document.querySelector("#syntax-overlay-id-input"),
  snapshotSourceInput: document.querySelector("#snapshot-source-input"),
  compareInput: document.querySelector("#compare-input"),
  structureCount: document.querySelector("#structure-count"),
  structureFilter: document.querySelector("#structure-filter"),
  structureTree: document.querySelector("#structure-tree"),
  structureAllFrames: document.querySelector("#structure-all-frames"),
  structureScopeLabel: document.querySelector("#structure-scope-label"),
  previousFrame: document.querySelector("#previous-frame"),
  nextFrame: document.querySelector("#next-frame"),
  framePosition: document.querySelector("#frame-position"),
  frameJumpForm: document.querySelector("#frame-jump-form"),
  frameJumpInput: document.querySelector("#frame-jump-input"),
  diagnosticsPanel: document.querySelector("#diagnostics-panel"),
  diagnosticToggle: document.querySelector("#diagnostic-toggle"),
  diagnosticToggleLabel: document.querySelector("#diagnostic-toggle-label"),
  workspace: document.querySelector("#workspace"),
  timeline: document.querySelector("#timeline"),
  viewportContent: document.querySelector("#viewport-content"),
  selectionChip: document.querySelector("#selection-chip"),
  inspector: document.querySelector("#inspector"),
  diagnosticsList: document.querySelector("#diagnostic-list"),
  diagnosticsStats: document.querySelector("#diagnostic-stats"),
  busyOverlay: document.querySelector("#busy-overlay"),
  busyFilename: document.querySelector("#busy-filename"),
  cancelAnalysisButton: document.querySelector("#cancel-analysis-button"),
  toast: document.querySelector("#toast"),
  hexTab: document.querySelector("#hex-tab"),
  overviewTab: document.querySelector("#overview-tab"),
  frameTableTab: document.querySelector("#frame-table-tab"),
  frameTab: document.querySelector("#frame-tab"),
  traceTab: document.querySelector("#trace-tab"),
  compareTab: document.querySelector("#compare-tab"),
};

const state = {
  file: null,
  bytes: null,
  report: null,
  snapshotId: null,
  snapshotManifest: null,
  snapshotPage: null,
  snapshotQuery: null,
  snapshotOnly: false,
  snapshotSourceFile: null,
  snapshotSelection: null,
  derivedInspection: null,
  derivedSyntaxPage: null,
  derivedSelection: new Set(),
  derivedSelectionInitialized: false,
  pendingDerivedSelection: null,
  syntaxOverlay: null,
  syntaxOverlayPage: null,
  selection: null,
  selectedFrameId: null,
  view: "hex",
  filter: "",
  showAllFrames: false,
  inspectorSections: new Map(),
  showSuperblockGrid: false,
  previews: new Map(),
  frameStats: new Map(),
  blockStatisticsCache: new WeakMap(),
  overlay: null,
  blockOverlaySnapshotId: null,
  blockOverlayStore: null,
  headerTrace: null,
  comparison: null,
  comparisonMetrics: new Map(),
  comparisonPreviews: new Map(),
  controllers: new Map(),
  overlayLayer: "partition",
  analysisMode: "coding-flow",
  showBlockBorders: true,
  previewZoom: "fit",
  blockResizeObserver: null,
  blockAnimationFrame: null,
  blockVisibilityFilter: "all",
  showMotionVectors: false,
  motionVectorComponent: "all",
  motionVectorScale: 4,
  motionVectorMinimumMagnitude: 0,
  motionVectorOpacity: 0.85,
  frameChartMetric: "size",
  frameTableFilters: { ...DEFAULT_FRAME_TABLE_FILTERS },
  frameTableSort: { key: "frameId", direction: "ascending" },
  frameTablePage: 0,
  overlayOpacity: 0.42,
  selectedBlock: null,
  blockRenderer: null,
  cacheGcPlan: null,
  busyOperationKey: null,
  busyPreviousFocus: null,
  health: null,
};

function replaceController(key) {
  state.controllers.get(key)?.abort();
  const controller = new AbortController();
  state.controllers.set(key, controller);
  return controller;
}

function abortOperations(...keys) {
  const targets = keys.length ? keys : [...state.controllers.keys()];
  for (const key of targets) {
    state.controllers.get(key)?.abort();
    state.controllers.delete(key);
    const pendingCache = key === "preview" ? state.previews : key === "luma" ? state.frameStats : null;
    if (pendingCache) {
      for (const [id, record] of pendingCache) {
        if (record.status === "loading") pendingCache.delete(id);
      }
    }
  }
}

function releaseBlockRenderer() {
  state.previewPanCleanup?.();
  state.previewPanCleanup = null;
  state.blockResizeObserver?.disconnect();
  state.blockResizeObserver = null;
  if (state.blockAnimationFrame !== null) cancelAnimationFrame(state.blockAnimationFrame);
  state.blockAnimationFrame = null;
  state.blockRenderer?.destroy();
  state.blockRenderer = null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatSyntaxValue(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function formatDuration(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 0.001) return `${(value * 1_000_000).toFixed(1)} µs`;
  if (value < 1) return `${(value * 1_000).toFixed(2)} ms`;
  if (value < 60) return `${value.toFixed(3)} s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${(value - minutes * 60).toFixed(1)}s`;
}

function formatBitrate(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${value.toFixed(0)} bit/s`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} kbit/s`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)} Mbit/s`;
  return `${(value / 1_000_000_000).toFixed(2)} Gbit/s`;
}

function formatMotionPixels(value) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(3).replace(/\.?0+$/, "")} px`;
}

function motionVectorColorCss(referenceSlot, vectorIndex = 0) {
  return `rgb(${motionVectorReferenceColor(referenceSlot, vectorIndex)
    .map((component) => Math.round(component * 255)).join(" ")})`;
}

function frameStatisticsPoint(frameId) {
  return state.report?.frameStatistics?.points?.find((point) => point.frameId === frameId) ?? null;
}

function sampleChartPoints(points, metric, maximum = 512) {
  if (points.length <= maximum) return points;
  const bucketCount = Math.max(1, Math.floor(maximum / 4));
  const value = (point) => metric === "bitrate"
    ? point.bitrateBitsPerSecond ?? 0
    : metric === "duration" ? point.durationSeconds ?? 0 : point.sizeBytes;
  const selected = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * points.length / bucketCount);
    const end = Math.floor((bucket + 1) * points.length / bucketCount);
    const items = points.slice(start, end);
    if (items.length === 0) continue;
    let minimum = items[0];
    let maximumPoint = items[0];
    for (const point of items) {
      if (value(point) < value(minimum)) minimum = point;
      if (value(point) > value(maximumPoint)) maximumPoint = point;
    }
    selected.push(items[0], minimum, maximumPoint, items.at(-1));
  }
  return [...new Map(selected.map((point) => [point.frameId, point])).values()]
    .sort((left, right) => left.frameId - right.frameId);
}

function formatRange(range) {
  if (!range) return "—";
  return `0x${range.start.toString(16).padStart(8, "0")} · ${range.length} B`;
}

function setBusy(active, filename = "", operationKey = null) {
  elements.busyFilename.textContent = filename;
  elements.busyOverlay.hidden = !active;
  elements.workspace.setAttribute("aria-busy", String(active));
  if (active) {
    state.busyOperationKey = operationKey;
    state.busyPreviousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    elements.cancelAnalysisButton.disabled = false;
    elements.cancelAnalysisButton.textContent = "Cancel analysis";
    queueMicrotask(() => elements.cancelAnalysisButton.focus());
  } else {
    state.busyOperationKey = null;
    const previousFocus = state.busyPreviousFocus;
    state.busyPreviousFocus = null;
    if (previousFocus?.isConnected) queueMicrotask(() => previousFocus.focus());
  }
}

function cancelBusyAnalysis() {
  const controller = state.controllers.get(state.busyOperationKey);
  if (!controller || controller.signal.aborted) return;
  elements.cancelAnalysisButton.disabled = true;
  elements.cancelAnalysisButton.textContent = "Cancelling…";
  controller.abort("user-cancelled");
}

function bindRovingNavigation(container, selector, orientation) {
  for (const item of container.querySelectorAll(selector)) {
    if (item.dataset.rovingBound === "true") continue;
    item.dataset.rovingBound = "true";
    item.addEventListener("keydown", (event) => {
      const items = [...container.querySelectorAll(selector)].filter(({ disabled }) => !disabled);
      const currentIndex = items.indexOf(event.currentTarget);
      const nextIndex = nextNavigationIndex({
        key: event.key,
        currentIndex,
        itemCount: items.length,
        orientation,
      });
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex].focus();
      items[nextIndex].click();
    });
  }
}

function humanType(type) {
  return type.name.replaceAll("_", " ");
}

const REFERENCE_NAMES = ["LAST", "LAST2", "LAST3", "GOLDEN", "BWDREF", "ALTREF2", "ALTREF"];

function formatBufferRemovalTimes(summary) {
  if (!summary.bufferRemovalTimePresent) return "not present";
  const times = Array.from(summary.bufferRemovalTimes ?? [], (value, index) =>
    value === undefined ? null : `OP${index}=${value}`,
  ).filter(Boolean);
  return times.join(" · ") || "present, no matching layer";
}

function summarizeGlobalMotion(summary) {
  const active = (summary.globalMotionTypes ?? [])
    .map((type, index) => type && type !== "IDENTITY" ? `${REFERENCE_NAMES[index] ?? `REF${index}`}:${type}` : null)
    .filter(Boolean);
  return active.join(" · ") || "all identity";
}

function summarizeSegmentation(summary) {
  if (!summary.segmentationEnabled) return "disabled";
  const active = (summary.segmentation ?? []).flat().filter(({ enabled } = {}) => enabled);
  const altQ = (summary.segmentation ?? [])
    .map((features) => features?.[0])
    .filter(({ enabled } = {}) => enabled)
    .map(({ value }) => value);
  return `${active.length} active feature${active.length === 1 ? "" : "s"}${altQ.length ? ` · ALT_Q ${Math.min(...altQ)}…${Math.max(...altQ)}` : ""}`;
}

function summarizeFilmGrain(summary) {
  const grain = summary.filmGrain;
  if (!grain?.applyGrain) return "not applied";
  const points = `${grain.yPoints?.length ?? 0}/${grain.cbPoints?.length ?? 0}/${grain.crPoints?.length ?? 0}`;
  const source = grain.updateGrain === false ? `ref slot ${grain.referenceIndex}` : "updated";
  return `seed ${grain.grainSeed} · Y/Cb/Cr ${points} · ${source}`;
}

const INSPECTION_FEATURE_FLAGS = Object.freeze({
  partition: 1,
  mode: 2,
  "motion-vector": 4,
  transform: 8,
  coefficient: 16,
  qindex: 32,
  filter: 64,
});

const INSPECTION_FEATURE_LABELS = Object.freeze({
  partition: "Partition",
  mode: "Prediction mode",
  "motion-vector": "Motion vectors",
  transform: "Transform",
  coefficient: "Coefficient counts",
  qindex: "Q index",
  filter: "Loop filter",
});

function overlaySupportsFeature(feature) {
  const provenance = state.overlay?.provenance;
  if (!provenance || !Number.isInteger(provenance.featureFlags)) return true;
  return (provenance.featureFlags & INSPECTION_FEATURE_FLAGS[feature]) !== 0;
}

function unavailableInspectionValue(feature, value) {
  return overlaySupportsFeature(feature) ? value : null;
}

function inspectionCapabilitySummary() {
  const provenance = state.overlay?.provenance;
  if (!provenance || !Number.isInteger(provenance.featureFlags)) return null;
  const missing = Array.isArray(provenance.missingFeatures)
    ? provenance.missingFeatures
    : Object.keys(INSPECTION_FEATURE_FLAGS)
      .filter((feature) => !overlaySupportsFeature(feature));
  return {
    complete: missing.length === 0,
    missing,
    label: missing.length === 0
      ? "complete inspection feature set"
      : `partial inspection · missing ${missing.map((feature) => (
        INSPECTION_FEATURE_LABELS[feature] ?? feature
      )).join(", ")}`,
  };
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (elements.toast.hidden = true), 5000);
}

function applyServiceCapabilities() {
  const capabilities = state.health?.capabilities;
  if (!capabilities) return;
  elements.snapshotButton.disabled = !capabilities.snapshotStore;
  elements.cacheGcButton.disabled = !capabilities.snapshotStore;
  if (!capabilities.framePreview) {
    elements.frameTab.disabled = true;
    elements.pngButton.disabled = true;
  }
  if (!capabilities.headerTrace) elements.traceTab.disabled = true;
  if (!capabilities.pixelComparison) {
    elements.compareTab.disabled = true;
    elements.compareButton.disabled = true;
  }
}

async function loadServiceHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    const preflight = value.preflight;
    state.health = {
      status: preflight?.status ?? "ready",
      capabilities: value.capabilities ?? preflight?.capabilities ?? null,
      blockInspection: value.blockInspection ?? { enabled: false },
      streamingIndexUploadLimitBytes: value.streamingIndexUploadLimitBytes ?? null,
    };
    const status = state.health.status;
    const labels = { ready: "Service ready", degraded: "Limited functionality", error: "Service error" };
    elements.serviceStatus.className = `service-status ${status}`;
    elements.serviceStatus.textContent = labels[status] ?? "Service online";
    const unavailable = preflight?.checks
      ?.filter((item) => item.status === "warning" || item.status === "error")
      .map((item) => item.id)
      .join(", ");
    elements.serviceStatus.title = unavailable
      ? `Unavailable: ${unavailable}`
      : `Node ${preflight?.runtime?.node ?? "local"} · Local service ready`;
    applyServiceCapabilities();
  } catch (error) {
    state.health = { status: "error", capabilities: null };
    elements.serviceStatus.className = "service-status error";
    elements.serviceStatus.textContent = "Service error";
    elements.serviceStatus.title = `Health check failed: ${error.message}`;
  }
}

function cacheGcMinimumAge() {
  const value = Number(elements.cacheGcAgeInput.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Minimum transaction age must be a non-negative integer");
  }
  return value;
}

function renderCacheGcPlan(plan, message = null) {
  if (message) {
    elements.cacheGcResults.innerHTML = `<strong>Plan unavailable</strong>${escapeHtml(message)}`;
    elements.cacheGcApply.disabled = true;
    return;
  }
  const references = plan.references;
  const candidates = plan.candidates.slice(0, 50).map((candidate) =>
    `<li>${escapeHtml(candidate.category)} · ${escapeHtml(candidate.relativePath)}</li>`,
  ).join("");
  const overflow = plan.candidates.length > 50
    ? `<li>…More: ${plan.candidates.length - 50} items</li>`
    : "";
  elements.cacheGcResults.innerHTML = `<strong>${plan.summary.candidateCount} rebuildable cache candidates</strong><span class="safe">Content Snapshot deletions: ${plan.summary.contentSnapshotDeletionCount}</span><br>Parent ${references.parents.count} · Derived ${references.derivedSyntax.count} (Overlay references: ${references.derivedSyntax.referencedByOverlayCount})· Overlay ${references.syntaxOverlays.count}<br>Plan ${escapeHtml(plan.planId.slice(0, 16))}${candidates ? `<ul>${candidates}${overflow}</ul>` : "<br>No cleanup needed"}`;
  elements.cacheGcApply.disabled = plan.summary.candidateCount === 0;
}

async function previewCacheGc() {
  const controller = replaceController("cache-gc");
  elements.cacheGcPreview.disabled = true;
  elements.cacheGcApply.disabled = true;
  elements.cacheGcResults.textContent = "Scanning references and rebuildable caches…";
  try {
    const minimumAgeMs = cacheGcMinimumAge();
    const response = await fetch(`/api/cache-gc?minimumAgeMs=${minimumAgeMs}`, {
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({ error: response.statusText }));
    if (!response.ok) throw apiError(response, value);
    if (state.controllers.get("cache-gc") !== controller) return;
    state.cacheGcPlan = value;
    renderCacheGcPlan(value);
  } catch (error) {
    if (error.name !== "AbortError") {
      state.cacheGcPlan = null;
      renderCacheGcPlan(null, error.message);
    }
  } finally {
    if (state.controllers.get("cache-gc") === controller) {
      state.controllers.delete("cache-gc");
      elements.cacheGcPreview.disabled = false;
    }
  }
}

async function applyCacheGc() {
  const plan = state.cacheGcPlan;
  if (!plan || !window.confirm(
    `Delete ${plan.summary.candidateCount} rebuildable caches/expired transactions? Content Snapshots will not be deleted.`,
  )) return;
  const controller = replaceController("cache-gc");
  elements.cacheGcPreview.disabled = true;
  elements.cacheGcApply.disabled = true;
  try {
    const response = await fetch("/api/cache-gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        planId: plan.planId,
        minimumAgeMs: cacheGcMinimumAge(),
      }),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({ error: response.statusText }));
    if (!response.ok) throw apiError(response, value);
    if (state.controllers.get("cache-gc") !== controller) return;
    state.cacheGcPlan = null;
    elements.cacheGcResults.innerHTML = `<strong>Maintenance complete</strong><span class="safe">Removed ${value.removedCount} items; parent Snapshots, Derived Syntax, and Syntax Overlay content were preserved.</span>`;
    elements.cacheGcApply.disabled = true;
    showToast(`Storage maintenance complete: removed ${value.removedCount} items; content Snapshots preserved`);
  } catch (error) {
    if (error.name !== "AbortError") {
      state.cacheGcPlan = null;
      renderCacheGcPlan(null, error.code === "CACHE_GC_PLAN_STALE"
        ? "Disk state changed; preview again before executing"
        : error.message);
    }
  } finally {
    if (state.controllers.get("cache-gc") === controller) {
      state.controllers.delete("cache-gc");
      elements.cacheGcPreview.disabled = false;
    }
  }
}

function apiError(response, failure) {
  const error = new Error(failure?.error ?? `HTTP ${response.status}`);
  if (typeof failure?.code === "string") error.code = failure.code;
  return error;
}

function analysisErrorMessage(error) {
  if (error.code === "ANALYSIS_CAPACITY_EXHAUSTED") return "Analysis service is busy; try again later";
  if (error.code === "INDEX_CAPACITY_EXHAUSTED") return "A large file is already being indexed; try again later";
  if (error.code === "ANALYSIS_TIMEOUT") return "Analysis exceeded 15 seconds and was safely terminated";
  if (error.code === "ANALYSIS_CANCELLED" || error.code === "INDEX_CANCELLED" || error.name === "AbortError") return null;
  return error.message;
}

async function loadSnapshotPage(collection, offset = 0) {
  if (!state.snapshotId) return;
  const controller = replaceController("snapshot-page");
  const limit = 100;
  state.snapshotPage = { status: "loading", collection, offset, limit };
  if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
    renderSnapshotWorkspace(state.snapshotManifest.value);
  } else if (state.view === "overview") renderSelection();
  try {
    const response = await fetch(
      `/api/snapshots/${state.snapshotId}/${collection}?offset=${offset}&limit=${limit}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("snapshot-page") !== controller) return;
    state.snapshotPage = { status: "ready", collection, offset, limit, value };
  } catch (error) {
    if (error.name !== "AbortError") {
      state.snapshotPage = { status: "error", collection, offset, limit, message: error.message };
    }
  } finally {
    if (state.controllers.get("snapshot-page") === controller) {
      state.controllers.delete("snapshot-page");
      if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
        renderSnapshotWorkspace(state.snapshotManifest.value);
      } else if (state.view === "overview") renderSelection();
    }
  }
}

function rerenderSnapshotSurface() {
  if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
    renderSnapshotWorkspace(state.snapshotManifest.value);
  } else if (state.view === "overview") {
    renderSelection();
  }
}

function parseSnapshotQueryValue(raw, operator) {
  const value = raw.trim();
  if (operator === "exists") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("The exists operator value must be true or false");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function snapshotQueryRequestFromForm(form) {
  const data = new FormData(form);
  const path = String(data.get("path") ?? "").trim();
  const operator = String(data.get("operator") ?? "eq");
  const projectionText = String(data.get("projection") ?? "").trim();
  return {
    collection: String(data.get("collection") ?? "obus"),
    filter: path ? {
      path,
      op: operator,
      value: parseSnapshotQueryValue(String(data.get("value") ?? ""), operator),
    } : null,
    projection: projectionText
      ? projectionText.split(",").map((item) => item.trim()).filter(Boolean)
      : null,
    limit: 50,
  };
}

async function runSnapshotQuery(request, {
  pageToken = null,
  pageIndex = 0,
  tokens = [null],
} = {}) {
  if (!state.snapshotId) return;
  const controller = replaceController("snapshot-query");
  state.snapshotQuery = { status: "loading", request, pageIndex, tokens };
  rerenderSnapshotSurface();
  try {
    const response = await fetch(`/api/snapshots/${state.snapshotId}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, pageToken }),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({ error: response.statusText }));
    if (!response.ok) throw apiError(response, value);
    if (state.controllers.get("snapshot-query") !== controller) return;
    const nextTokens = [...tokens];
    if (value.nextPageToken) nextTokens[pageIndex + 1] = value.nextPageToken;
    else nextTokens.length = pageIndex + 1;
    state.snapshotQuery = {
      status: "ready",
      request,
      value,
      pageIndex,
      tokens: nextTokens,
    };
  } catch (error) {
    if (error.name !== "AbortError") {
      state.snapshotQuery = {
        status: "error",
        request,
        message: error.message,
        pageIndex,
        tokens,
      };
    }
  } finally {
    if (state.controllers.get("snapshot-query") === controller) {
      state.controllers.delete("snapshot-query");
      rerenderSnapshotSurface();
    }
  }
}

async function loadDerivedSyntaxPage(offset = 0) {
  if (!state.snapshotId) return;
  const controller = replaceController("derived-syntax-page");
  const limit = 1_000;
  state.derivedSyntaxPage = { status: "loading", offset, limit };
  try {
    const response = await fetch(
      `/api/snapshots/${state.snapshotId}/derived-syntax?offset=${offset}&limit=${limit}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("derived-syntax-page") !== controller) return;
    state.derivedSyntaxPage = { status: "ready", offset, limit, value };
    const available = new Set(value.records.map(({ derivedSnapshotId }) => derivedSnapshotId));
    for (const id of state.derivedSelection) {
      if (!available.has(id) && value.total <= limit) state.derivedSelection.delete(id);
    }
    if (!state.derivedSelectionInitialized) {
      const selectedObus = new Set();
      for (const record of value.records) {
        if (selectedObus.has(record.obuId)) continue;
        selectedObus.add(record.obuId);
        state.derivedSelection.add(record.derivedSnapshotId);
      }
      state.derivedSelectionInitialized = true;
    }
    if (state.pendingDerivedSelection) {
      const selected = value.records.find(({ derivedSnapshotId }) =>
        derivedSnapshotId === state.pendingDerivedSelection);
      if (selected) {
        for (const record of value.records) {
          if (record.obuId === selected.obuId) {
            state.derivedSelection.delete(record.derivedSnapshotId);
          }
        }
        state.derivedSelection.add(selected.derivedSnapshotId);
      }
      state.pendingDerivedSelection = null;
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      state.derivedSyntaxPage = { status: "error", message: error.message };
    }
  } finally {
    if (state.controllers.get("derived-syntax-page") === controller) {
      state.controllers.delete("derived-syntax-page");
      if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
        renderSnapshotWorkspace(state.snapshotManifest.value);
      } else if (state.view === "overview") renderSelection();
    }
  }
}

async function loadSnapshotManifest(snapshotId) {
  const controller = replaceController("snapshot-manifest");
  try {
    const response = await fetch(`/api/snapshots/${snapshotId}/manifest`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("snapshot-manifest") !== controller || state.snapshotId !== snapshotId) return;
    state.snapshotManifest = { status: "ready", value };
    if (state.snapshotOnly) renderSnapshotWorkspace(value);
    void loadBlockOverlayStore(snapshotId);
    void loadDerivedSyntaxPage(0);
    const derivedObuId = state.syntaxOverlay?.status === "ready"
      ? state.syntaxOverlay.value.provenance.contributors[0]?.obuId ?? 0
      : state.derivedInspection?.status === "ready"
        ? state.derivedInspection.value.request.obuId
        : 0;
    await loadSnapshotPage("obus", Math.floor(derivedObuId / 100) * 100);
  } catch (error) {
    if (error.name !== "AbortError") {
      state.snapshotManifest = { status: "error", message: error.message };
      if (state.snapshotOnly) {
        elements.viewportContent.innerHTML = `<div class="preview-error">Failed to open Snapshot<br><small>${escapeHtml(error.message)}</small></div>`;
      } else if (state.view === "overview") renderSelection();
    }
  } finally {
    if (state.controllers.get("snapshot-manifest") === controller) {
      state.controllers.delete("snapshot-manifest");
    }
  }
}

async function loadBlockOverlayPage(blockOverlaySnapshotId, offset = 0) {
  const controller = replaceController("block-overlay-page");
  try {
    const response = await fetch(
      `/api/block-overlays/${blockOverlaySnapshotId}/blocks?offset=${offset}&limit=200`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const page = await response.json();
    if (state.controllers.get("block-overlay-page") !== controller) return;
    state.blockOverlayStore = {
      ...state.blockOverlayStore,
      status: "ready",
      page,
    };
  } catch (error) {
    if (error.name !== "AbortError") {
      state.blockOverlayStore = { status: "error", message: error.message };
    }
  } finally {
    if (state.controllers.get("block-overlay-page") === controller) {
      state.controllers.delete("block-overlay-page");
      if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
        renderSnapshotWorkspace(state.snapshotManifest.value);
      } else if (state.view === "overview") renderSelection();
    }
  }
}

async function loadBlockOverlayStore(snapshotId) {
  const controller = replaceController("block-overlay-store");
  state.blockOverlayStore = { status: "loading" };
  try {
    const response = await fetch(`/api/snapshots/${snapshotId}/block-overlays`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const list = await response.json();
    if (state.controllers.get("block-overlay-store") !== controller || state.snapshotId !== snapshotId) return;
    const selected = list.overlays.find(({ blockOverlaySnapshotId }) => (
      blockOverlaySnapshotId === state.blockOverlaySnapshotId
    )) ?? list.overlays[0] ?? null;
    if (selected === null) {
      state.blockOverlayStore = { status: "ready", list, manifest: null, page: null };
      return;
    }
    const manifestResponse = await fetch(
      `/api/block-overlays/${selected.blockOverlaySnapshotId}/manifest`,
      { signal: controller.signal },
    );
    if (!manifestResponse.ok) {
      const failure = await manifestResponse.json().catch(() => ({ error: manifestResponse.statusText }));
      throw apiError(manifestResponse, failure);
    }
    const manifest = await manifestResponse.json();
    if (state.controllers.get("block-overlay-store") !== controller || state.snapshotId !== snapshotId) return;
    state.blockOverlaySnapshotId = selected.blockOverlaySnapshotId;
    state.blockOverlayStore = { status: "loading", list, manifest, page: null };
    void loadBlockOverlayPage(selected.blockOverlaySnapshotId, 0);
  } catch (error) {
    if (error.name !== "AbortError") {
      state.blockOverlayStore = { status: "error", message: error.message };
    }
  } finally {
    if (state.controllers.get("block-overlay-store") === controller) {
      state.controllers.delete("block-overlay-store");
      if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
        renderSnapshotWorkspace(state.snapshotManifest.value);
      } else if (state.view === "overview") renderSelection();
    }
  }
}

function bindSnapshotControls() {
  elements.viewportContent.querySelectorAll("[data-snapshot-collection]").forEach((button) => {
    button.addEventListener("click", () => {
      state.derivedInspection = null;
      state.syntaxOverlay = null;
      loadSnapshotPage(button.dataset.snapshotCollection, 0);
    });
  });
  elements.viewportContent.querySelectorAll("[data-snapshot-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = state.snapshotPage;
      if (current?.status !== "ready") return;
      state.derivedInspection = null;
      state.syntaxOverlay = null;
      const delta = button.dataset.snapshotPage === "next" ? current.limit : -current.limit;
      loadSnapshotPage(current.collection, Math.max(0, current.offset + delta));
    });
  });
  elements.viewportContent.querySelectorAll("[data-block-overlay-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = state.blockOverlayStore?.page;
      if (!current || !state.blockOverlaySnapshotId) return;
      const delta = button.dataset.blockOverlayPage === "next" ? current.limit : -current.limit;
      void loadBlockOverlayPage(
        state.blockOverlaySnapshotId,
        Math.max(0, current.offset + delta),
      );
    });
  });
  elements.viewportContent.querySelector("[data-attach-snapshot-source]")?.addEventListener(
    "click", () => elements.snapshotSourceInput.click(),
  );
  elements.viewportContent.querySelectorAll("[data-snapshot-record]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = state.snapshotPage;
      if (current?.status !== "ready") return;
      state.derivedInspection = null;
      state.syntaxOverlay = null;
      const record = current.value.records[Number(button.dataset.snapshotRecord)];
      state.snapshotSelection = { record, collection: current.collection };
      inspectSnapshotRecord(record, current.collection);
    });
  });
  elements.viewportContent.querySelectorAll("[data-derived-select]").forEach((input) => {
    input.addEventListener("change", () => {
      const page = state.derivedSyntaxPage?.value;
      const selected = page?.records.find(({ derivedSnapshotId }) =>
        derivedSnapshotId === input.dataset.derivedSelect);
      if (!selected) return;
      if (input.checked) {
        for (const record of page.records) {
          if (record.obuId === selected.obuId) {
            state.derivedSelection.delete(record.derivedSnapshotId);
            const peer = elements.viewportContent.querySelector(
              `[data-derived-select="${record.derivedSnapshotId}"]`,
            );
            if (peer && peer !== input) peer.checked = false;
          }
        }
        state.derivedSelection.add(selected.derivedSnapshotId);
      } else {
        state.derivedSelection.delete(selected.derivedSnapshotId);
      }
      updateDerivedSelectionControls();
    });
  });
  elements.viewportContent.querySelector("[data-build-syntax-overlay]")?.addEventListener(
    "click", () => buildSyntaxOverlay(),
  );
  elements.viewportContent.querySelector("[data-snapshot-query-form]")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      try {
        void runSnapshotQuery(snapshotQueryRequestFromForm(event.currentTarget));
      } catch (error) {
        showToast(`Invalid query parameters: ${error.message}`);
      }
    },
  );
  elements.viewportContent.querySelectorAll("[data-snapshot-query-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = state.snapshotQuery;
      if (current?.status !== "ready") return;
      const pageIndex = current.pageIndex +
        (button.dataset.snapshotQueryPage === "next" ? 1 : -1);
      if (pageIndex < 0 || pageIndex >= current.tokens.length) return;
      void runSnapshotQuery(current.request, {
        pageToken: current.tokens[pageIndex],
        pageIndex,
        tokens: current.tokens,
      });
    });
  });
}

function updateDerivedSelectionControls() {
  const button = elements.viewportContent.querySelector("[data-build-syntax-overlay]");
  if (!button) return;
  button.disabled = state.derivedSelection.size === 0;
  button.textContent = `Build Syntax Overlay · ${state.derivedSelection.size}`;
}

function renderSnapshotWorkspace(manifest) {
  const header = manifest.header;
  state.report = { ...header, frames: [], obus: [], syntaxNodes: [], diagnostics: [] };
  state.file = { name: header.source.name };
  updateFrameNavigation();
  setDiagnosticsExpanded(header.summary.errorCount > 0 || header.summary.warningCount > 0);
  if (state.view !== "overview" && state.view !== "frame-table") state.view = "overview";
  elements.fileSummary.innerHTML = `<strong>${escapeHtml(header.source.name)}</strong><span>${escapeHtml(header.source.format)} · ${formatBytes(header.source.size)} · ${manifest.collections.frames.count} frames</span>`;
  elements.structureCount.textContent = manifest.collections.obus.count;
  elements.structureTree.innerHTML = `<div class="panel-empty compact"><span class="empty-icon">◫</span><p>${manifest.collections.obus.count} OBUs persisted; browse with the paginated overview</p></div>`;
  elements.timeline.innerHTML = `<div class="timeline-empty">Snapshot index · ${manifest.collections.frames.count} frame records</div>`;
  elements.diagnosticsStats.innerHTML = `<span class="stat good"><b>${header.summary.errorCount}</b> errors</span><span class="stat neutral"><b>${header.summary.warningCount}</b> warnings</span>`;
  elements.diagnosticsList.innerHTML = `<div class="diagnostic-ok"><span>◫</span> View diagnostic records in the paginated Snapshot cards</div>`;
  elements.inspector.innerHTML = `<div class="panel-empty"><span class="empty-icon">◫</span><p>Paginated Snapshot mode does not load the full report into memory</p></div>`;
  elements.exportButton.disabled = true;
  elements.csvButton.disabled = true;
  elements.pngButton.disabled = true;
  elements.overlayButton.disabled = true;
  elements.compareButton.disabled = true;
  elements.selectionChip.textContent = `Snapshot ${state.snapshotId.slice(0, 12)}`;
  if (state.view === "frame-table") renderFrameTable();
  else elements.viewportContent.innerHTML = `<div class="overview">${renderFrameStatisticsSummary(header.frameStatistics)}${renderSnapshotStore()}</div>`;
  for (const [button, view] of [[elements.hexTab, "hex"], [elements.frameTab, "frame"], [elements.overviewTab, "overview"], [elements.frameTableTab, "frame-table"], [elements.traceTab, "trace"], [elements.compareTab, "compare"]]) {
    const active = view === state.view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    button.disabled = view !== "overview" && view !== "frame-table";
  }
  elements.viewportContent.setAttribute("aria-labelledby", state.view === "frame-table" ? "frame-table-tab" : "overview-tab");
  bindSnapshotControls();
  if (state.syntaxOverlay?.status === "ready") {
    renderSyntaxOverlayReplay(state.syntaxOverlay.value);
  } else if (state.derivedInspection?.status === "ready") {
    renderDerivedSyntaxReplay(state.derivedInspection.value);
  }
}

function openSnapshot(
  snapshotId,
  { derivedInspection = null, syntaxOverlay = null, sourceFile = null } = {},
) {
  if (!/^[0-9a-f]{64}$/.test(snapshotId)) {
    showToast("Snapshot ID must be a 64-character lowercase SHA-256 hash");
    return;
  }
  abortOperations();
  releaseBlockRenderer();
  state.snapshotOnly = true;
  state.view = "overview";
  state.snapshotId = snapshotId;
  state.snapshotManifest = { status: "loading" };
  state.snapshotPage = null;
  state.snapshotQuery = null;
  state.frameTableFilters = { ...DEFAULT_FRAME_TABLE_FILTERS };
  state.frameTableSort = { key: "frameId", direction: "ascending" };
  state.frameTablePage = 0;
  state.snapshotSourceFile = sourceFile;
  state.snapshotSelection = null;
  state.derivedInspection = derivedInspection;
  state.derivedSyntaxPage = null;
  state.derivedSelection = new Set();
  state.derivedSelectionInitialized = false;
  state.pendingDerivedSelection = null;
  state.syntaxOverlay = syntaxOverlay;
  state.syntaxOverlayPage = null;
  state.blockOverlaySnapshotId = null;
  state.blockOverlayStore = null;
  state.bytes = null;
  state.report = null;
  elements.viewportContent.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Opening Snapshot ${snapshotId.slice(0, 12)}</p></div>`;
  void loadSnapshotManifest(snapshotId);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function analyzeFile(file) {
  if (file.size > 64 * 1024 * 1024) {
    void indexLargeFile(file);
    return;
  }
  if (/\.(?:mp4|webm)$/i.test(file.name) &&
      state.health?.capabilities?.containerAnalysis === false) {
    showToast("MP4/WebM analysis requires ffprobe or Native Demux Worker；Run npm run --silent gui:check");
    return;
  }
  abortOperations();
  const controller = replaceController("analysis");
  setBusy(true, file.name, "analysis");
  try {
    releaseBlockRenderer();
    state.selectedBlock = null;
    for (const preview of state.previews.values()) {
      if (preview.status === "ready") URL.revokeObjectURL(preview.url);
    }
    state.previews.clear();
    state.frameStats.clear();
    const bytes = await file.arrayBuffer();
    const response = await fetch(`/api/analyze?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const report = await response.json();
    const snapshotId = response.headers.get("x-av1scope-snapshot-id");
    const blockOverlaySnapshotId = response.headers.get("x-av1scope-block-overlay-id");
    if (state.controllers.get("analysis") !== controller) return;
    state.file = file;
    state.bytes = new Uint8Array(bytes);
    state.report = report;
    state.overlay = report.blockOverlay ?? null;
    delete report.blockOverlay;
    state.snapshotId = snapshotId;
    state.blockOverlaySnapshotId = blockOverlaySnapshotId;
    state.snapshotManifest = snapshotId ? { status: "loading" } : null;
    state.snapshotPage = null;
    state.snapshotQuery = null;
    state.frameTableFilters = { ...DEFAULT_FRAME_TABLE_FILTERS };
    state.frameTableSort = { key: "frameId", direction: "ascending" };
    state.frameTablePage = 0;
    state.snapshotOnly = false;
    state.snapshotSourceFile = null;
    state.snapshotSelection = null;
    state.derivedInspection = null;
    state.derivedSyntaxPage = null;
    state.derivedSelection = new Set();
    state.derivedSelectionInitialized = false;
    state.pendingDerivedSelection = null;
    state.syntaxOverlay = null;
    state.syntaxOverlayPage = null;
    state.selectedFrameId = state.report.frames[0]?.frameId ?? null;
    state.view = state.selectedFrameId !== null && state.health?.capabilities?.framePreview === true
      ? "frame" : "overview";
    for (const button of [elements.hexTab, elements.frameTab, elements.overviewTab, elements.frameTableTab, elements.traceTab, elements.compareTab]) {
      button.disabled = false;
    }
    elements.exportButton.disabled = false;
    elements.csvButton.disabled = false;
    elements.pngButton.disabled = state.selectedFrameId === null;
    elements.overlayButton.disabled = false;
    elements.compareButton.disabled = false;
    applyServiceCapabilities();
    state.headerTrace = null;
    state.comparison = null;
    state.comparisonMetrics.clear();
    for (const preview of state.comparisonPreviews.values()) {
      if (preview.status === "ready") {
        URL.revokeObjectURL(preview.referenceUrl);
        URL.revokeObjectURL(preview.candidateUrl);
      }
    }
    state.comparisonPreviews.clear();
    state.selection = state.report.obus[0]
      ? { kind: "obu", id: state.report.obus[0].obuId }
      : null;
    setDiagnosticsExpanded(report.summary.errorCount > 0 || report.summary.warningCount > 0);
    renderAll();
    if (snapshotId) void loadSnapshotManifest(snapshotId);
  } catch (error) {
    const message = analysisErrorMessage(error);
    if (message) showToast(`Analysis failed: ${message}`);
  } finally {
    if (state.controllers.get("analysis") === controller) {
      state.controllers.delete("analysis");
      setBusy(false);
    }
  }
}

async function indexLargeFile(file) {
  if (state.health?.capabilities?.streamingIndex === false) {
    showToast("Large-file indexing requires Snapshot Store; remove --no-snapshot and restart the GUI");
    return;
  }
  if (/\.(?:mp4|webm)$/i.test(file.name) &&
      state.health?.capabilities?.containerAnalysis === false) {
    showToast("MP4/WebM indexing requires ffprobe or a Native Demux Worker");
    return;
  }
  const uploadLimit = state.health?.streamingIndexUploadLimitBytes;
  if (Number.isSafeInteger(uploadLimit) && file.size > uploadLimit) {
    showToast(`File exceeds the GUI streaming index limit of ${formatBytes(uploadLimit)}`);
    return;
  }
  abortOperations();
  const controller = replaceController("index");
  setBusy(true, `${file.name} · Streaming Snapshot`, "index");
  let completed = null;
  try {
    const response = await fetch(`/api/index?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const result = await response.json();
    if (state.controllers.get("index") !== controller) return;
    let sourceFile = null;
    let sourceWarning = "";
    if (result.source?.fingerprint?.digest) {
      try {
        const digest = await fingerprintBrowserFile(file);
        if (digest === result.source.fingerprint.digest) sourceFile = file;
        else sourceWarning = "Source fingerprint mismatch. Attach the original file again";
      } catch (error) {
        // Indexing has already succeeded. A browser-side binding failure must
        // not discard the snapshot or leave the workspace on the empty screen.
        sourceWarning = `Source not attached: ${error.message}`;
      }
    }
    if (state.controllers.get("index") !== controller || controller.signal.aborted) return;
    completed = { result, sourceFile, sourceWarning };
  } catch (error) {
    const message = analysisErrorMessage(error);
    if (message) showToast(`Large-file indexing failed: ${message}`);
  } finally {
    if (state.controllers.get("index") === controller) {
      state.controllers.delete("index");
      setBusy(false);
    }
  }
  if (completed) {
    openSnapshot(completed.result.snapshotId, { sourceFile: completed.sourceFile });
    showToast(`Indexing complete: ${completed.result.summary.frameCount} frames · ${completed.result.summary.obuCount} OBU${completed.sourceWarning ? `. ${completed.sourceWarning}` : ""}`);
  }
}

function renderAll() {
  const { report, file } = state;
  const blockSummary = report.blockInspection?.status === "ready"
    ? ` · ${report.blockInspection.blockCount} blocks` : "";
  elements.fileSummary.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(report.source.format)} · ${formatBytes(report.source.size)} · ${report.summary.frameCount} frames${escapeHtml(blockSummary)}</span>`;
  elements.structureCount.textContent = report.summary.obuCount;
  renderTimeline();
  renderStructure();
  renderDiagnostics();
  renderSelection();
}

function diagnosticsForFrame(frameId) {
  return state.report.diagnostics.filter(({ frameId: value }) => value === frameId);
}

function selectFrame(frameId) {
  if (!state.report || state.snapshotOnly) return;
  const frame = state.report.frames.find((candidate) => candidate.frameId === frameId);
  if (!frame) return;
  state.selectedFrameId = frameId;
  state.selectedBlock = null;
  abortOperations("preview", "luma", "compare", "compare-preview");
  state.selection = frame.obuIds.length ? { kind: "obu", id: frame.obuIds[0] } : null;
  renderTimeline();
  renderStructure();
  renderSelection();
}

function updateFrameNavigation() {
  const frames = state.snapshotOnly ? [] : state.report?.frames ?? [];
  const index = frames.findIndex(({ frameId }) => frameId === state.selectedFrameId);
  elements.previousFrame.disabled = index <= 0;
  elements.nextFrame.disabled = index < 0 || index >= frames.length - 1;
  elements.frameJumpInput.disabled = frames.length === 0;
  elements.frameJumpInput.max = String(Math.max(0, frames.length - 1));
  elements.frameJumpInput.value = index < 0 ? "" : String(index);
  elements.framePosition.textContent = index < 0
    ? state.snapshotOnly ? "Browse the frame table" : "No frame selected"
    : `Frame ${index} / ${frames.length - 1}`;
  elements.structureAllFrames.disabled = state.snapshotOnly;
}

function moveFrame(delta) {
  if (state.snapshotOnly) return;
  const frames = state.report?.frames ?? [];
  const index = frames.findIndex(({ frameId }) => frameId === state.selectedFrameId);
  const frame = frames[index + delta];
  if (index >= 0 && frame) selectFrame(frame.frameId);
}

function setDiagnosticsExpanded(expanded) {
  elements.workspace.classList.toggle("diagnostics-collapsed", !expanded);
  elements.diagnosticsPanel.classList.toggle("diagnostics-collapsed", !expanded);
  elements.diagnosticToggle.setAttribute("aria-expanded", String(expanded));
  elements.diagnosticToggleLabel.textContent = expanded ? "Collapse" : "Expand";
  elements.diagnosticsList.hidden = !expanded;
}

function frameTableSourceRows() {
  if (!state.snapshotOnly) {
    return buildFrameTableRows(
      state.report?.frames ?? [],
      state.report?.frameStatistics,
      state.report?.diagnostics ?? [],
    );
  }
  const current = state.snapshotPage;
  if (current?.status !== "ready" || current.collection !== "frames") return [];
  return buildFrameTableRows(
    current.value.records,
    state.snapshotManifest?.value?.header?.frameStatistics,
  ).map((row, index) => ({
    ...row,
    diagnosticCount: null,
    hasDiagnostic: null,
    snapshotRecord: current.value.records[index],
  }));
}

function filteredFrameTableRows() {
  return sortFrameTableRows(
    filterFrameTableRows(frameTableSourceRows(), state.frameTableFilters),
    state.frameTableSort,
  );
}

function frameTableSortHeader(key, label) {
  const active = state.frameTableSort.key === key;
  const direction = active ? state.frameTableSort.direction : "none";
  const arrow = active ? (direction === "ascending" ? " ↑" : " ↓") : "";
  return `<th scope="col" aria-sort="${direction}"><button type="button" data-frame-table-sort="${key}">${label}${arrow}</button></th>`;
}

function frameTableFilterInput(name, label, { placeholder = "—", min = null } = {}) {
  const value = state.frameTableFilters[name] ?? "";
  return `<label>${label}<input type="number" name="${name}" value="${escapeHtml(value)}" placeholder="${placeholder}" ${min === null ? "" : `min="${min}"`}></label>`;
}

function renderFrameTable() {
  const snapshotPage = state.snapshotPage;
  if (state.snapshotOnly && (snapshotPage?.collection !== "frames" || snapshotPage.status !== "ready")) {
    const failure = snapshotPage?.collection === "frames" && snapshotPage.status === "error"
      ? `<div class="preview-error">Failed to load frame page<br><small>${escapeHtml(snapshotPage.message)}</small></div>`
      : `<div class="preview-loading"><span class="spinner"></span><p>Loading frame index page</p></div>`;
    elements.viewportContent.innerHTML = `<div class="frame-table-workbench">${failure}</div>`;
    return;
  }

  const sourceRows = frameTableSourceRows();
  const frameTypes = [...new Set(sourceRows.map(({ frameType }) => frameType))].sort();
  const filteredRows = filteredFrameTableRows();
  const page = state.snapshotOnly
    ? pageFrameTableRows(filteredRows, { page: 0, pageSize: Math.max(1, filteredRows.length || 1) })
    : pageFrameTableRows(filteredRows, { page: state.frameTablePage });
  state.frameTablePage = page.page;
  const filter = state.frameTableFilters;
  const activeFilterCount = Object.keys(DEFAULT_FRAME_TABLE_FILTERS)
    .filter((key) => filter[key] !== DEFAULT_FRAME_TABLE_FILTERS[key]).length;
  const snapshotScope = state.snapshotOnly
    ? `Snapshot local batch filter · source records ${snapshotPage.value.offset + (snapshotPage.value.records.length ? 1 : 0)}–${snapshotPage.value.offset + snapshotPage.value.records.length} / ${snapshotPage.value.total} · diagnostic counts unavailable in frame pages`
    : `All frames · ${page.pageSize} rows per page`;
  const rows = page.rows.map((row) => {
    const active = row.frameId === state.selectedFrameId;
    const classes = [active ? "active" : "", row.keyframe ? "keyframe" : "", row.hasDiagnostic ? "diagnostic" : ""].filter(Boolean).join(" ");
    const refs = row.references.length ? row.references.map((id) => `#${id}`).join(" ") : "—";
    const gop = row.gopIndex === null ? "—" : `${row.gopIndex}:${row.gopFrameIndex ?? "—"}`;
    return `<tr class="${classes}" data-frame-table-row="${row.frameId}" tabindex="${active ? 0 : -1}" aria-selected="${active}" aria-label="Frame ${row.frameId}, ${escapeHtml(row.frameType)}, ${row.sizeBytes ?? "size unavailable"} bytes">
      <td><b>${row.frameId}</b><small>D${row.decodeIndex ?? "—"}</small></td>
      <td><span class="frame-type-pill">${escapeHtml(row.frameType)}</span></td>
      <td title="PTS / DTS"><b>${escapeHtml(row.pts ?? "—")}</b><small>${escapeHtml(row.dts ?? "—")}</small></td>
      <td>${formatDuration(row.durationSeconds)}</td>
      <td>${row.sizeBytes === null ? "—" : formatBytes(row.sizeBytes)}</td>
      <td>${formatBitrate(row.bitrateBitsPerSecond)}</td>
      <td>${row.qindex ?? "—"}</td>
      <td>${gop}</td>
      <td>${escapeHtml(refs)}</td>
      <td>${row.obuCount}</td>
      <td class="${row.hasDiagnostic ? "warning" : ""}">${row.diagnosticCount ?? "—"}</td>
    </tr>`;
  }).join("");
  const typeOptions = frameTypes.map((type) => `<option value="${escapeHtml(type)}" ${filter.frameType === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("");
  const localPager = state.snapshotOnly ? "" : `<div class="frame-table-pager"><button type="button" data-frame-table-page="prev" ${page.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${page.page + 1} / ${page.pageCount} · ${page.start + (page.rows.length ? 1 : 0)}–${page.end}</span><button type="button" data-frame-table-page="next" ${page.page + 1 >= page.pageCount ? "disabled" : ""}>Next</button></div>`;
  const snapshotPager = state.snapshotOnly ? `<div class="frame-table-pager"><button type="button" data-frame-snapshot-page="prev" ${snapshotPage.value.offset === 0 ? "disabled" : ""}>Previous batch: 100 frames</button><span>Stable server pagination</span><button type="button" data-frame-snapshot-page="next" ${snapshotPage.value.offset + snapshotPage.value.records.length >= snapshotPage.value.total ? "disabled" : ""}>Next batch: 100 frames</button></div>` : "";

  elements.viewportContent.innerHTML = `<div class="frame-table-workbench">
    <section class="frame-table-toolbar">
      <header><div><span class="eyebrow">FRAME ANALYSIS</span><h3>Frame analysis</h3></div><div><button type="button" data-frame-export="csv">Export ${state.snapshotOnly ? "batch" : "filtered"} CSV</button><button type="button" data-frame-export="json">Export ${state.snapshotOnly ? "batch" : "filtered"} JSON</button></div></header>
      <details class="analysis-disclosure"${activeFilterCount ? " open" : ""}><summary>Filters${activeFilterCount ? ` · ${activeFilterCount} active` : ""}</summary><form data-frame-table-filter>
        ${frameTableFilterInput("frameIdMin", "Frame ≥", { min: 0 })}
        ${frameTableFilterInput("frameIdMax", "Frame ≤", { min: 0 })}
        <label>Frame type<select name="frameType"><option value="all">All</option>${typeOptions}</select></label>
        ${frameTableFilterInput("gopIndex", "GOP", { min: 0 })}
        <label>Diagnostics<select name="diagnostic" ${state.snapshotOnly ? "disabled" : ""}><option value="all" ${filter.diagnostic === "all" ? "selected" : ""}>All</option><option value="with" ${filter.diagnostic === "with" ? "selected" : ""}>With issues</option><option value="without" ${filter.diagnostic === "without" ? "selected" : ""}>Without issues</option></select></label>
        ${frameTableFilterInput("qindexMin", "Q ≥", { min: 0 })}
        ${frameTableFilterInput("qindexMax", "Q ≤", { min: 0 })}
        ${frameTableFilterInput("sizeMin", "Bytes ≥", { min: 0 })}
        ${frameTableFilterInput("sizeMax", "Bytes ≤", { min: 0 })}
        ${frameTableFilterInput("bitrateMin", "bit/s ≥", { min: 0 })}
        ${frameTableFilterInput("bitrateMax", "bit/s ≤", { min: 0 })}
        <div class="frame-filter-actions"><button type="submit">Apply</button><button type="button" data-frame-filter-reset>Reset</button></div>
      </form></details>
      <div class="frame-table-status"><span>${snapshotScope}</span><b>Matched ${filteredRows.length} / ${sourceRows.length}</b></div>
    </section>
    <div class="frame-table-scroll"><table role="grid" aria-label="Frame analysis results" aria-rowcount="${filteredRows.length}"><thead><tr>
      ${frameTableSortHeader("frameId", "Frame")}${frameTableSortHeader("frameType", "Type")}${frameTableSortHeader("pts", "PTS / DTS")}
      ${frameTableSortHeader("durationSeconds", "Duration")}${frameTableSortHeader("sizeBytes", "Size")}${frameTableSortHeader("bitrateBitsPerSecond", "Bitrate")}
      ${frameTableSortHeader("qindex", "Q")}${frameTableSortHeader("gopIndex", "GOP:Pos")}<th class="frame-table-static" scope="col">Refs</th><th class="frame-table-static" scope="col">OBUs</th>${frameTableSortHeader("diagnosticCount", "Diag")}
    </tr></thead><tbody>${rows || `<tr><td colspan="11" class="frame-table-empty">No matching frames</td></tr>`}</tbody></table></div>
    ${localPager}${snapshotPager}
  </div>`;

  const form = elements.viewportContent.querySelector("[data-frame-table-filter]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = new FormData(form);
    state.frameTableFilters = Object.fromEntries(
      Object.keys(DEFAULT_FRAME_TABLE_FILTERS).map((key) => [key, String(values.get(key) ?? (key === "frameType" || key === "diagnostic" ? "all" : ""))]),
    );
    state.frameTablePage = 0;
    renderFrameTable();
  });
  elements.viewportContent.querySelector("[data-frame-filter-reset]")?.addEventListener("click", () => {
    state.frameTableFilters = { ...DEFAULT_FRAME_TABLE_FILTERS };
    state.frameTablePage = 0;
    renderFrameTable();
  });
  elements.viewportContent.querySelectorAll("[data-frame-table-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.frameTableSort;
      state.frameTableSort = state.frameTableSort.key === key
        ? { key, direction: state.frameTableSort.direction === "ascending" ? "descending" : "ascending" }
        : { key, direction: "ascending" };
      state.frameTablePage = 0;
      renderFrameTable();
    });
  });
  elements.viewportContent.querySelectorAll("[data-frame-table-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.frameTablePage += button.dataset.frameTablePage === "next" ? 1 : -1;
      renderFrameTable();
    });
  });
  elements.viewportContent.querySelectorAll("[data-frame-snapshot-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const delta = button.dataset.frameSnapshotPage === "next" ? snapshotPage.limit : -snapshotPage.limit;
      void loadSnapshotPage("frames", Math.max(0, snapshotPage.offset + delta));
    });
  });
  elements.viewportContent.querySelectorAll("[data-frame-export]").forEach((button) => {
    button.addEventListener("click", () => exportFilteredFrameTable(button.dataset.frameExport));
  });
  elements.viewportContent.querySelectorAll("[data-frame-table-row]").forEach((row) => {
    const activate = () => {
      const frameId = Number(row.dataset.frameTableRow);
      if (state.snapshotOnly) {
        const record = frameTableSourceRows().find((candidate) => candidate.frameId === frameId)?.snapshotRecord;
        if (!record) return;
        state.selectedFrameId = frameId;
        state.snapshotSelection = { record, collection: "frames" };
        inspectSnapshotRecord(record, "frames");
        renderFrameTable();
      } else selectFrame(frameId);
    };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  bindRovingNavigation(elements.viewportContent, "[data-frame-table-row]", "vertical");
}

function exportFilteredFrameTable(format) {
  const rows = filteredFrameTableRows().map(({ snapshotRecord, ...row }) => row);
  const stem = state.file?.name?.replace(/\.[^.]+$/, "") || "analysis";
  const scope = state.snapshotOnly ? "snapshot-page" : "filtered";
  if (format === "json") {
    downloadBlob(new Blob([`${JSON.stringify(rows, null, 2)}\n`], { type: "application/json" }), `${stem}.frames.${scope}.json`);
  } else {
    downloadBlob(new Blob([`${frameTableCsvRows(rows).join("\n")}\n`], { type: "text/csv" }), `${stem}.frames.${scope}.csv`);
  }
  showToast(`Exported ${rows.length} ${state.snapshotOnly ? "batch" : "filtered"} frames`);
}

function renderTimeline() {
  const { report } = state;
  updateFrameNavigation();
  if (report.frames.length === 0) {
    elements.timeline.innerHTML = `<div class="timeline-empty">Raw OBU streams have no container frame timeline</div>`;
    return;
  }
  const maxSize = report.frames.reduce(
    (maximum, { declaredSize }) => Math.max(maximum, declaredSize), 1,
  );
  const statisticPoints = new Map(
    (report.frameStatistics?.points ?? []).map((point) => [point.frameId, point]),
  );
  const selectedIndex = Math.max(0, report.frames.findIndex(({ frameId }) => frameId === state.selectedFrameId));
  const windowStart = Math.max(0, Math.min(selectedIndex - 30, report.frames.length - 80));
  elements.timeline.innerHTML = report.frames.slice(windowStart, windowStart + 80)
    .map((frame) => {
      const hasDiagnostic = diagnosticsForFrame(frame.frameId).some(({ severity }) => severity === "error" || severity === "fatal" || severity === "warning");
      const frameType = frame.headerSummary?.frameTypeName?.replace("_FRAME", "") ?? "FRAME";
      const references = [...new Set(frame.headerSummary?.referenceFrameIds?.filter((id) => id !== null) ?? [])];
      const relation = references.length ? `Refs ${references.map((id) => `#${id}`).join(", ")}` : "Intra / random access";
      const active = frame.frameId === state.selectedFrameId;
      const point = statisticPoints.get(frame.frameId);
      const timing = point?.durationSeconds === null || point?.durationSeconds === undefined
        ? "" : ` · ${formatDuration(point.durationSeconds)}`;
      const bitrate = point?.bitrateBitsPerSecond === null || point?.bitrateBitsPerSecond === undefined
        ? "" : ` · ${formatBitrate(point.bitrateBitsPerSecond)}`;
      return `<button type="button" class="frame-card ${active ? "active" : ""} ${hasDiagnostic ? "error" : ""} ${point?.keyframe ? "keyframe" : ""}" data-frame-id="${frame.frameId}" aria-pressed="${active}" tabindex="${active ? 0 : -1}" title="${escapeHtml(`PTS ${frame.timestamp}${timing} · ${relation}${bitrate} · ${frame.obuIds.length} OBU${hasDiagnostic ? " · Issues found" : ""}`)}" style="--weight:${Math.max(5, (frame.declaredSize / maxSize) * 100)}%"><b>${frame.decodeIndex} · ${escapeHtml(frameType)}</b><span>${formatBytes(frame.declaredSize)}${hasDiagnostic ? " · !" : ""}</span></button>`;
    })
    .join("");
  elements.timeline.querySelectorAll("[data-frame-id]").forEach((button) => {
    button.addEventListener("click", () => selectFrame(Number(button.dataset.frameId)));
  });
  bindRovingNavigation(elements.timeline, "[data-frame-id]", "horizontal");
  elements.timeline.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function obuMatches(obu) {
  if (!state.filter) return true;
  const query = state.filter.toLowerCase();
  if (`${obu.type.name} ${obu.type.code} ${obu.obuId}`.includes(query)) return true;
  return state.report.syntaxNodes.some(
    (node) => node.obuId === obu.obuId && node.path.toLowerCase().includes(query),
  );
}

function obuButton(obu) {
  const active = state.selection?.kind === "obu" && state.selection.id === obu.obuId;
  return `<button type="button" role="option" aria-selected="${active}" tabindex="${active ? 0 : -1}" class="tree-item ${active ? "active" : ""}" data-obu-id="${obu.obuId}"><span class="node-icon">▣</span><span class="node-copy"><strong>${escapeHtml(humanType(obu.type))}</strong><small>OBU ${obu.obuId} · ${escapeHtml(obu.syntaxStatus)}</small></span><span class="node-size">${obu.byteRange.length} B</span></button>`;
}

function renderStructure() {
  const { report } = state;
  const groups = [];
  const selectedFrame = report.frames.find(({ frameId }) => frameId === state.selectedFrameId);
  const allFrames = state.showAllFrames || Boolean(state.filter) || !selectedFrame;
  elements.structureScopeLabel.textContent = state.filter ? "Search all frames" : allFrames ? "All frames" : `Frame ${selectedFrame.decodeIndex}`;
  const obuById = new Map(report.obus.map((obu) => [obu.obuId, obu]));
  if (report.frames.length) {
    for (const frame of allFrames ? report.frames : [selectedFrame]) {
      const frameObus = frame.obuIds
        .map((id) => obuById.get(id))
        .filter((obu) => obu && obuMatches(obu));
      if (frameObus.length === 0) continue;
      groups.push(`<section class="tree-group"><div class="tree-label">Frame ${frame.decodeIndex} · PTS ${escapeHtml(frame.timestamp)}</div>${frameObus.map(obuButton).join("")}</section>`);
    }
  } else {
    const obus = report.obus.filter(obuMatches);
    if (obus.length) groups.push(`<section class="tree-group"><div class="tree-label">Raw OBU sequence</div>${obus.map(obuButton).join("")}</section>`);
  }
  elements.structureTree.innerHTML = groups.join("") || `<div class="panel-empty compact"><span class="empty-icon">⌕</span><p>No matching OBU or fields</p></div>`;
  elements.structureTree.querySelectorAll("[data-obu-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.obuId);
      const obu = obuById.get(id);
      state.selection = { kind: "obu", id };
      if (obu?.frameId !== null && obu?.frameId !== undefined && obu.frameId !== state.selectedFrameId) {
        state.selectedFrameId = obu.frameId;
        abortOperations("preview", "luma", "compare", "compare-preview");
        renderTimeline();
      }
      state.selectedBlock = null;
      renderStructure();
      renderSelection();
    });
  });
  const structureItems = elements.structureTree.querySelectorAll("[data-obu-id]");
  if (structureItems.length > 0 && ![...structureItems].some(({ tabIndex }) => tabIndex === 0)) {
    structureItems[0].tabIndex = 0;
  }
  bindRovingNavigation(elements.structureTree, "[data-obu-id]", "vertical");
}

function selectedObu() {
  if (!state.report || !state.selection) return null;
  if (state.selection.kind === "obu") return state.report.obus.find(({ obuId }) => obuId === state.selection.id);
  const node = state.report.syntaxNodes.find(({ nodeId }) => nodeId === state.selection.id);
  return state.report.obus.find(({ obuId }) => obuId === node?.obuId);
}

function selectedNode() {
  if (state.selection?.kind !== "syntax") return null;
  return state.report.syntaxNodes.find(({ nodeId }) => nodeId === state.selection.id);
}

function renderSelection() {
  const obu = selectedObu();
  const node = selectedNode();
  if (!obu) {
    elements.selectionChip.textContent = "No selection";
    elements.inspector.innerHTML = `<div class="panel-empty"><p>No available OBU fields</p></div>`;
    renderViewport(null, null);
    return;
  }
  elements.selectionChip.textContent = state.selectedBlock
    ? `Block ${state.selectedBlock.blockId} · ${state.selectedBlock.width}×${state.selectedBlock.height}`
    : node ? node.path : `OBU ${obu.obuId} / ${humanType(obu.type)}`;
  renderViewport(obu, node);
  renderInspector(obu, node, state.selectedBlock);
}

function byteClasses(index, obu, node) {
  const classes = ["hex-byte"];
  const nodeStart = node?.bitRange ? Math.floor(node.bitRange.startBit / 8) : null;
  const nodeEnd = node?.bitRange ? Math.ceil((node.bitRange.startBit + node.bitRange.lengthBits) / 8) : null;
  const selectedStart = nodeStart ?? obu.byteRange.start;
  const selectedEnd = nodeEnd ?? obu.byteRange.start + obu.byteRange.length;
  if (index >= selectedStart && index < selectedEnd) classes.push("selected");
  if (index >= obu.headerRange.start && index < obu.headerRange.start + obu.headerRange.length) classes.push("header");
  return classes.join(" ");
}

function renderHex(obu, node) {
  const focusStart = Math.max(0, obu.byteRange.start - 16);
  const focusEnd = Math.min(state.bytes.length, obu.byteRange.start + obu.byteRange.length + 16);
  const rowStart = Math.floor(focusStart / 16) * 16;
  const rowEnd = Math.ceil(focusEnd / 16) * 16;
  const rows = [];
  for (let offset = rowStart; offset < rowEnd; offset += 16) {
    const cells = [];
    let ascii = "";
    for (let column = 0; column < 16; column += 1) {
      const index = offset + column;
      if (index < state.bytes.length) {
        const byte = state.bytes[index];
        cells.push(`<span class="${byteClasses(index, obu, node)}">${byte.toString(16).padStart(2, "0")}</span>`);
        ascii += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";
      } else {
        cells.push("<span></span>");
        ascii += " ";
      }
    }
    rows.push(`<div class="hex-row"><span class="hex-offset">${offset.toString(16).padStart(8, "0")}</span>${cells.join("")}<span class="hex-ascii">${escapeHtml(ascii)}</span></div>`);
  }
  return `<div class="hex-view">${rows.join("")}</div>`;
}

function renderFrameStatisticsSummary(statistics) {
  if (!statistics) return "";
  const gop = statistics.gop ?? {};
  const timingLabel = {
    explicit: "packet duration",
    inferred: "timestamp delta",
    "partially-defaulted": "partial fallback",
    unavailable: "unavailable",
  }[statistics.timingMode] ?? statistics.timingMode;
  const metrics = `<section class="metric-grid frame-statistics-metrics">
    <div class="metric"><span>Duration</span><b>${formatDuration(statistics.durationSeconds)}</b></div>
    <div class="metric"><span>Average bitrate</span><b>${formatBitrate(statistics.averageBitrateBitsPerSecond)}</b></div>
    <div class="metric"><span>Peak rolling bitrate</span><b>${formatBitrate(statistics.peakRollingBitrateBitsPerSecond)}</b></div>
    <div class="metric"><span>Average FPS</span><b>${statistics.averageFrameRate == null ? "—" : statistics.averageFrameRate.toFixed(3)}</b></div>
    <div class="metric"><span>GOPs</span><b>${gop.count ?? 0}</b></div>
    <div class="metric"><span>Average GOP length</span><b>${gop.averageLength === null || gop.averageLength === undefined ? "—" : gop.averageLength.toFixed(2)}</b></div>
  </section>`;
  const gopRows = (gop.records ?? []).slice(0, 20).map((record) => `<tr>
    <td>${record.index}</td><td>${record.startFrameId}–${record.endFrameId}</td>
    <td>${record.length}</td><td>${formatBytes(record.sizeBytes)}</td>
    <td>${formatDuration(record.durationSeconds)}</td>
    <td>${formatBitrate(record.averageBitrateBitsPerSecond)}</td>
  </tr>`).join("");
  const gopTable = gopRows ? `<details class="analysis-disclosure"><summary>GOP details · ${gop.count}</summary><section class="analysis-card gop-summary"><div class="statistics-table-scroll"><table><thead><tr><th>GOP</th><th>Frames</th><th>Length</th><th>Bytes</th><th>Duration</th><th>Bitrate</th></tr></thead><tbody>${gopRows}</tbody></table></div>${gop.recordsTruncated ? `<small>${gop.recordsTruncated} records truncated</small>` : ""}</section></details>` : "";
  const anomaly = statistics.anomalyCount > 0
    ? `<section class="analysis-card timing-warning"><header><h3>Timing quality</h3><span>${statistics.anomalyCount} anomalies</span></header><p>${escapeHtml(timingLabel)} · ${statistics.timedFrameCount}/${statistics.frameCount} timed frames · ${statistics.anomaliesTruncated ?? 0} anomaly records truncated</p></section>`
    : "";
  return `${metrics}${anomaly}${gopTable}`;
}

function renderOverview(obu) {
  const total = Math.max(state.report.source.size, 1);
  const frames = state.report.frames;
  const statistics = state.report.frameStatistics ?? null;
  const frameTypes = Object.entries(frames.reduce((counts, frame) => {
    const name = frame.headerSummary?.frameTypeName ?? "UNKNOWN";
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {}));
  const rawPoints = statistics?.points ?? frames.map((frame) => ({
    frameId: frame.frameId,
    sizeBytes: frame.declaredSize,
    bitrateBitsPerSecond: null,
    durationSeconds: null,
    frameType: frame.headerSummary?.frameTypeName ?? "UNKNOWN",
    keyframe: frame.frameId === 0,
  }));
  const chartPoints = sampleChartPoints(rawPoints, state.frameChartMetric);
  const chartValue = (point) => state.frameChartMetric === "bitrate"
    ? point.bitrateBitsPerSecond ?? 0
    : state.frameChartMetric === "duration" ? point.durationSeconds ?? 0 : point.sizeBytes;
  const chartMaximum = chartPoints.reduce(
    (maximum, point) => Math.max(maximum, chartValue(point)), 0,
  ) || 1;
  const chartLabel = state.frameChartMetric === "bitrate" ? "Frame bitrate"
    : state.frameChartMetric === "duration" ? "Frame duration" : "Frame size";
  const chartSummary = state.frameChartMetric === "bitrate"
    ? `avg ${formatBitrate(statistics?.averageBitrateBitsPerSecond)}`
    : state.frameChartMetric === "duration"
      ? `total ${formatDuration(statistics?.durationSeconds)}`
      : `avg ${formatBytes(Math.round(statistics?.frameSizeBytes?.average ?? 0))}`;
  const frameChart = chartPoints.length ? `<section class="analysis-card frame-chart"><header><h3>${chartLabel}</h3><div class="chart-controls"><span>${chartSummary}${statistics?.pointsDownsampled ? " · sampled" : ""}</span><label>Metric <select data-frame-chart-metric><option value="size" ${state.frameChartMetric === "size" ? "selected" : ""}>Size</option><option value="bitrate" ${state.frameChartMetric === "bitrate" ? "selected" : ""}>Bitrate</option><option value="duration" ${state.frameChartMetric === "duration" ? "selected" : ""}>Duration</option></select></label></div></header><div class="chart-bars">${chartPoints.map((point) => {
    const height = Math.max(3, (chartValue(point) / chartMaximum) * 100);
    const valueLabel = state.frameChartMetric === "bitrate"
      ? formatBitrate(point.bitrateBitsPerSecond)
      : state.frameChartMetric === "duration"
        ? formatDuration(point.durationSeconds)
        : formatBytes(point.sizeBytes);
    return `<button type="button" data-overview-frame="${point.frameId}" class="chart-bar ${point.keyframe ? "keyframe" : ""} ${point.frameId === state.selectedFrameId ? "active" : ""}" style="--height:${height}%" title="Frame ${point.frameId} · ${point.frameType ?? "UNKNOWN"} · ${valueLabel} · GOP ${point.gopIndex ?? "—"}"><i></i><span>${point.frameId}</span></button>`;
  }).join("")}</div></section>` : "";
  const demux = state.report.provenance?.demux;
  const demuxImplementation = typeof demux === "string"
    ? demux
    : demux?.implementation ?? (state.report.container ? "legacy / unspecified" : "not applicable");
  const provenance = `<section class="analysis-card provenance-card"><header><h3>Analysis provenance</h3><span>${escapeHtml(state.report.provenance?.implementation ?? "unknown")}</span></header>${propertyRows([
    ["Parser", `${state.report.provenance?.parser ?? "unknown"} ${state.report.provenance?.parserVersion ?? ""}`.trim(), true],
    ["Container demux", demuxImplementation],
    ["Adapter", demux?.adapter ?? "—"],
    ["Adapter version", demux?.adapterVersion ?? "—"],
    ["Feature flags", demux?.featureFlags === undefined ? "—" : `0x${Number(demux.featureFlags).toString(16)}`],
    ["Worker sandbox", demux?.workerSandboxFlags === undefined
      ? "—"
      : `${(demux.workerSandboxFlags & 1) !== 0 ? "no_new_privs" : "no no_new_privs"} · ${(demux.workerSandboxFlags & 2) !== 0 ? "seccomp" : "no seccomp"} · ${(demux.workerSandboxFlags & 4) !== 0 ? "denylist" : "no denylist"} · ${(demux.workerSandboxFlags & 8) !== 0 ? "parent-death" : "no parent-death"} · ${(demux.workerSandboxFlags & 16) !== 0 ? "non-dumpable" : "dumpable"}`],
    ["Worker SHA-256", demux?.workerExecutable?.sha256 ?? "—", true],
    ["Worker binary bytes", demux?.workerExecutable?.size ?? "—"],
  ])}</section>`;
  const typeLegend = frameTypes.length ? `<section class="analysis-card type-summary"><header><h3>Frame types</h3></header><div>${frameTypes.map(([name, count]) => `<span><i></i>${escapeHtml(name)} <b>${count}</b></span>`).join("")}</div></section>` : "";
  return `<div class="overview">${frameChart}${typeLegend}${renderFrameStatisticsSummary(statistics)}<details class="analysis-disclosure"><summary>Engine and provenance</summary>${provenance}</details>${state.snapshotId ? `<details class="analysis-disclosure"><summary>Snapshots and advanced queries</summary>${renderSnapshotStore()}</details>` : ""}<details class="analysis-disclosure"><summary>OBU byte distribution</summary><section class="analysis-card"><header><h3>OBU byte map</h3><span>${formatBytes(total)}</span></header>${state.report.obus.map((record) => {
    const width = Math.max(.3, (record.byteRange.length / total) * 100);
    const active = record.obuId === obu?.obuId;
    return `<div class="range-bar ${active ? "active" : ""}"><label>OBU ${record.obuId} · ${escapeHtml(record.type.name)}</label><div class="range-track"><div class="range-fill" style="width:${width}%;margin-left:${(record.byteRange.start / total) * 100}%"></div></div><output>${record.byteRange.length} B</output></div>`;
  }).join("")}</section></details></div>`;
}


function snapshotRecordLabel(collection, record) {
  if (collection === "frames") return `Frame ${record.frameId} · PTS ${record.timestamp} · ${record.declaredSize} B`;
  if (collection === "obus") return `OBU ${record.obuId} · ${record.type?.name ?? "unknown"} · ${record.byteRange?.length ?? 0} B`;
  if (collection === "syntaxNodes") return `Node ${record.nodeId} · ${record.path} = ${record.value}`;
  return `${record.severity ?? "info"} · ${record.code} · ${record.message}`;
}

async function fingerprintBrowserFile(file) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Source verification requires HTTPS or localhost, use a secure URL to attach the original file");
  }
  const sampleBytes = 64 * 1024;
  const firstLength = Math.min(sampleBytes, file.size);
  const lastStart = Math.max(firstLength, file.size - sampleBytes);
  const prefix = new TextEncoder().encode(`av1scope-source-v1\0${file.size}\0`);
  const first = new Uint8Array(await file.slice(0, firstLength).arrayBuffer());
  const last = new Uint8Array(await file.slice(lastStart).arrayBuffer());
  const input = new Uint8Array(prefix.length + first.length + last.length);
  input.set(prefix);
  input.set(first, prefix.length);
  input.set(last, prefix.length + first.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function inspectSnapshotRecord(record, collection) {
  abortOperations("snapshot-inspect", "snapshot-frame-inspect");
  const rows = collection === "obus" ? [
    ["OBU ID", record.obuId], ["Type", `${record.type.code} / ${record.type.name}`],
    ["Frame", record.frameId ?? "raw stream"], ["Byte range", formatRange(record.byteRange)],
    ["Header", formatRange(record.headerRange)], ["Size field", formatRange(record.sizeFieldRange)],
    ["Payload", formatRange(record.payloadRange)], ["Complete", String(record.complete)],
  ] : Object.entries(record).slice(0, 20).map(([key, value]) => [
    key, typeof value === "object" ? JSON.stringify(value) : String(value),
  ]);
  const inspectable = collection === "obus" && [1, 3, 4, 5, 6, 7].includes(record.type?.code);
  const deepStatus = !inspectable ? "" : state.snapshotSourceFile
    ? `<section class="property-group" id="snapshot-syntax-inspection"><h4>On-demand syntax</h4><div class="preview-loading"><span class="spinner"></span><p>Reading from the attached source: payload</p></div></section>`
    : `<section class="property-group"><h4>On-demand syntax</h4><div class="preview-error">First use the Snapshot Store card to attach the verified source file</div></section>`;
  const frameInspection = collection !== "frames" ? ""
    : !state.health?.blockInspection?.enabled
      ? `<section class="property-group"><h4>Block inspection</h4><div class="preview-error">Missing Native Inspection Worker；build the pinned libaom producer or configure an explicit path</div></section>`
      : !state.snapshotSourceFile
        ? `<section class="property-group"><h4>Block inspection</h4><div class="preview-error">Attach the verified source file first</div></section>`
        : `<section class="property-group" id="snapshot-frame-inspection"><h4>Block inspection</h4><p>Decode from the nearest random-access frame to Frame ${record.frameId}, Results are saved to a paged Block Overlay Snapshot. </p><button type="button" class="secondary-button" data-inspect-snapshot-frame="${record.frameId}">Inspect Frame ${record.frameId}</button></section>`;
  elements.inspector.innerHTML = `<div class="inspector-title"><span>Snapshot ${escapeHtml(collection)}</span><h3>${escapeHtml(snapshotRecordLabel(collection, record))}</h3></div><section class="property-group"><h4>Stored record</h4>${propertyRows(rows)}</section>${deepStatus}${frameInspection}`;
  if (inspectable && state.snapshotSourceFile) void loadSnapshotSyntaxInspection(record);
  elements.inspector.querySelector("[data-inspect-snapshot-frame]")?.addEventListener(
    "click", () => inspectSnapshotFrame(record),
  );
}

async function inspectSnapshotFrame(record) {
  const target = elements.inspector.querySelector("#snapshot-frame-inspection");
  if (!target || !state.snapshotSourceFile || !state.snapshotId) return;
  const controller = replaceController("snapshot-frame-inspect");
  target.innerHTML = `<h4>Block inspection</h4><div class="preview-loading"><span class="spinner"></span><p>Planning the random-access decode window</p></div>`;
  try {
    const endpoint = `/api/snapshots/${state.snapshotId}/inspect-frames/${record.frameId}`;
    const planResponse = await fetch(endpoint, { signal: controller.signal });
    if (!planResponse.ok) {
      const failure = await planResponse.json().catch(() => ({ error: planResponse.statusText }));
      throw apiError(planResponse, failure);
    }
    const plan = await planResponse.json();
    const slices = [];
    let inputByteLength = 0;
    for (const range of plan.decoderConfigRanges ?? []) {
      if (!Number.isSafeInteger(range?.start) || range.start < 0
          || !Number.isSafeInteger(range?.length) || range.length < 1
          || range.start + range.length > state.snapshotSourceFile.size) {
        throw new Error("Sequence Header range exceeds the attached source file");
      }
      slices.push(state.snapshotSourceFile.slice(range.start, range.start + range.length));
      inputByteLength += range.length;
    }
    for (const frame of plan.frames) {
      const range = frame.payloadRange;
      if (!Number.isSafeInteger(range?.start) || range.start < 0
          || !Number.isSafeInteger(range?.length) || range.length < 1
          || range.start + range.length > state.snapshotSourceFile.size) {
        throw new Error(`Frame ${frame.frameId} payload range exceeds the attached source file`);
      }
      slices.push(state.snapshotSourceFile.slice(range.start, range.start + range.length));
      inputByteLength += range.length;
    }
    if (inputByteLength !== plan.inputByteLength) {
      throw new Error("Decode window size differs from the Snapshot plan");
    }
    target.innerHTML = `<h4>Block inspection</h4><div class="preview-loading"><span class="spinner"></span><p>Uploading ${plan.frames.length} frames / ${formatBytes(inputByteLength)} for isolated decoding${plan.sequenceHeaderFound ? "" : " (Index window has no Sequence Header)"}</p></div>`;
    const fingerprint = state.snapshotManifest?.value?.header?.source?.fingerprint?.digest;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(fingerprint ? { "x-av1scope-source-fingerprint": fingerprint } : {}),
      },
      body: new Blob(slices, { type: "application/octet-stream" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const result = await response.json();
    if (state.controllers.get("snapshot-frame-inspect") !== controller) return;
    state.blockOverlaySnapshotId = result.blockOverlaySnapshotId;
    target.innerHTML = `<h4>Block inspection</h4>${propertyRows([
      ["Decode window", `Frame ${result.plan.randomAccessFrameId}–${result.plan.targetFrameId}`],
      ["Input", `${result.plan.frames.length} frames / ${formatBytes(result.plan.inputByteLength)}`],
      ["Blocks", result.summary.blockCount],
      ["Snapshot", result.blockOverlaySnapshotId.slice(0, 16)],
    ])}`;
    showToast(`Frame ${record.frameId} inspection complete: ${result.summary.blockCount} blocks`);
    void loadBlockOverlayStore(state.snapshotId);
  } catch (error) {
    if (error.name !== "AbortError" && target.isConnected) {
      target.innerHTML = `<h4>Block inspection</h4><div class="preview-error">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    if (state.controllers.get("snapshot-frame-inspect") === controller) {
      state.controllers.delete("snapshot-frame-inspect");
    }
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function readBoundPayload(record, maximumLength, requireComplete = false) {
  const range = record?.payloadRange;
  if (!Number.isSafeInteger(range?.start) || range.start < 0 ||
      !Number.isSafeInteger(range?.length) || range.length < 1 ||
      range.start + range.length > state.snapshotSourceFile.size) {
    throw new Error("Indexed payload range exceeds the attached source file");
  }
  if (requireComplete && range.length > maximumLength) {
    throw new Error(`Full payload exceeds ${formatBytes(maximumLength)} on-demand inspection limit`);
  }
  const length = Math.min(range.length, maximumLength);
  return new Uint8Array(await state.snapshotSourceFile
    .slice(range.start, range.start + length).arrayBuffer());
}

async function findEarlierSequenceHeader(obuId, signal) {
  let end = obuId;
  while (end > 0) {
    const offset = Math.max(0, end - 10_000);
    const response = await fetch(
      `/api/snapshots/${state.snapshotId}/obus?offset=${offset}&limit=${end - offset}`,
      { signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const page = await response.json();
    const sequence = page.records.findLast?.(({ type }) => type?.code === 1)
      ?? [...page.records].reverse().find(({ type }) => type?.code === 1);
    if (sequence) return sequence;
    end = offset;
  }
  return null;
}

function sameObuLayer(left, right) {
  return left?.header?.extensionFlag === right?.header?.extensionFlag &&
    left?.header?.temporalId === right?.header?.temporalId &&
    left?.header?.spatialId === right?.header?.spatialId &&
    (left?.frameId === null || right?.frameId === null || left?.frameId === right?.frameId);
}

async function findEarlierFrameHeader(record, signal) {
  let end = record.obuId;
  while (end > 0) {
    const offset = Math.max(0, end - 10_000);
    const response = await fetch(
      `/api/snapshots/${state.snapshotId}/obus?offset=${offset}&limit=${end - offset}`,
      { signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const page = await response.json();
    const frameHeader = [...page.records].reverse().find((candidate) =>
      [3, 7].includes(candidate.type?.code) && sameObuLayer(candidate, record));
    if (frameHeader) return frameHeader;
    end = offset;
  }
  return null;
}

function renderSnapshotSyntaxInspection(
  result,
  {
    derivedSnapshotId = null,
    sourceLabel = "sample-fingerprint-matched local file",
  } = {},
) {
  const diagnostics = result.diagnostics?.length
    ? `<div class="snapshot-syntax-diagnostics">${result.diagnostics.map((item) =>
      `<div class="diagnostic-row"><span class="severity ${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span><code>${escapeHtml(item.code)}</code><span class="message">${escapeHtml(item.message)}</span></div>`,
    ).join("")}</div>`
    : "";
  const nodes = result.nodes?.map((node) =>
    `<div class="tree-item"><span class="node-icon">ƒ</span><span class="node-copy"><strong>${escapeHtml(node.path)}</strong><small>${escapeHtml(node.coding)} · ${node.bitRange ? `absolute bit ${node.bitRange.startBit} + ${node.bitRange.lengthBits}` : "inferred"}</small></span><span class="node-size">${escapeHtml(node.value)}</span></div>`,
  ).join("") || `<div class="preview-error">The parser returned no syntax fields</div>`;
  const persisted = derivedSnapshotId
    ? `<div class="derived-syntax-reference"><span>Derived Syntax <code>${derivedSnapshotId}</code></span><div><button type="button" data-open-derived-syntax="${derivedSnapshotId}">By ID Replay</button><button type="button" data-export-derived-syntax="${derivedSnapshotId}">Export  JSON</button></div></div>`
    : "";
  return `<h4>On-demand syntax · ${result.nodes?.length ?? 0} fields</h4>${persisted}${propertyRows([
    ["Status", result.status],
    ["Coverage", `${result.parsedBitLength ?? 0} / ${(result.inspectedPayloadBytes ?? 0) * 8} inspected bits`],
    ["Source", sourceLabel],
  ])}${diagnostics}<div class="snapshot-syntax-nodes">${nodes}</div>`;
}

function renderDerivedSyntaxReplay(manifest) {
  const id = manifest.derivedSnapshotId;
  state.snapshotSelection = null;
  elements.inspector.innerHTML = `<div class="inspector-title"><span>Derived Syntax Snapshot</span><h3>${id.slice(0, 16)}</h3></div><section class="property-group">${renderSnapshotSyntaxInspection(
    manifest.inspection, {
      derivedSnapshotId: id,
      sourceLabel: "frozen client-submitted payload digest",
    },
  )}</section><section class="property-group"><h4>Immutable provenance</h4>${propertyRows([
    ["Parent snapshot", manifest.parentSnapshotId],
    ["OBU", String(manifest.request.obuId)],
    ["Payload SHA-256", manifest.request.payloadSha256],
    ["Payload transport", manifest.request.transport],
    ["Parser", `${manifest.provenance.parser} ${manifest.provenance.parserVersion}`],
    ["Verification boundary", manifest.sourceBinding.verificationBoundary],
  ])}</section>`;
  bindDerivedSyntaxButtons(elements.inspector);
}

function bindDerivedSyntaxButtons(root) {
  root.querySelectorAll("[data-open-derived-syntax]").forEach((button) => {
    button.addEventListener("click", () => openDerivedSyntax(button.dataset.openDerivedSyntax));
  });
  root.querySelectorAll("[data-export-derived-syntax]").forEach((button) => {
    button.addEventListener("click", () => exportDerivedSyntax(button.dataset.exportDerivedSyntax));
  });
}

async function exportDerivedSyntax(derivedSnapshotId) {
  const controller = replaceController("derived-export");
  try {
    const response = await fetch(`/api/derived-syntax/${derivedSnapshotId}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    downloadBlob(
      new Blob([await response.text()], { type: "application/json" }),
      `av1scope-derived-syntax-${derivedSnapshotId.slice(0, 12)}.json`,
    );
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Derived syntax export failed: ${error.message}`);
  } finally {
    if (state.controllers.get("derived-export") === controller) {
      state.controllers.delete("derived-export");
    }
  }
}

async function openDerivedSyntax(derivedSnapshotId) {
  if (!/^[0-9a-f]{64}$/.test(derivedSnapshotId)) {
    showToast("Derived Syntax ID must be a 64-character lowercase SHA-256 hash");
    return;
  }
  const controller = replaceController("derived-syntax");
  elements.inspector.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Verifying derived syntax ${derivedSnapshotId.slice(0, 12)}</p></div>`;
  try {
    const response = await fetch(`/api/derived-syntax/${derivedSnapshotId}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("derived-syntax") !== controller) return;
    openSnapshot(value.parentSnapshotId, {
      derivedInspection: { status: "ready", value },
    });
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Failed to open derived syntax: ${error.message}`);
  } finally {
    if (state.controllers.get("derived-syntax") === controller) {
      state.controllers.delete("derived-syntax");
    }
  }
}

async function buildSyntaxOverlay() {
  if (!state.snapshotId || state.derivedSelection.size === 0) return;
  const controller = replaceController("syntax-overlay-build");
  const button = elements.viewportContent.querySelector("[data-build-syntax-overlay]");
  if (button) {
    button.disabled = true;
    button.textContent = "Building Syntax Overlay…";
  }
  try {
    const response = await fetch(`/api/snapshots/${state.snapshotId}/syntax-overlays`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ derivedSnapshotIds: [...state.derivedSelection] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("syntax-overlay-build") !== controller) return;
    state.derivedInspection = null;
    state.syntaxOverlay = { status: "ready", value };
    state.syntaxOverlayPage = { status: "loading", collection: "syntaxNodes", offset: 0, limit: 200 };
    renderSyntaxOverlayReplay(value);
    void loadSyntaxOverlayPage(value.overlaySnapshotId, "syntaxNodes", 0);
    showToast(`Syntax Overlay ${value.overlaySnapshotId.slice(0, 12)} ${value.created ? "created" : "reused"}`);
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Syntax Overlay build failed: ${error.message}`);
  } finally {
    if (state.controllers.get("syntax-overlay-build") === controller) {
      state.controllers.delete("syntax-overlay-build");
      updateDerivedSelectionControls();
    }
  }
}

async function loadSyntaxOverlayPage(
  overlaySnapshotId,
  collection = "syntaxNodes",
  offset = 0,
) {
  const controller = replaceController("syntax-overlay-page");
  const limit = 200;
  state.syntaxOverlayPage = { status: "loading", collection, offset, limit };
  if (state.syntaxOverlay?.status === "ready") renderSyntaxOverlayReplay(state.syntaxOverlay.value);
  try {
    const response = await fetch(
      `/api/syntax-overlays/${overlaySnapshotId}/${collection}?offset=${offset}&limit=${limit}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("syntax-overlay-page") !== controller) return;
    state.syntaxOverlayPage = { status: "ready", collection, offset, limit, value };
  } catch (error) {
    if (error.name !== "AbortError") {
      state.syntaxOverlayPage = { status: "error", collection, offset, limit, message: error.message };
    }
  } finally {
    if (state.controllers.get("syntax-overlay-page") === controller) {
      state.controllers.delete("syntax-overlay-page");
      if (state.syntaxOverlay?.status === "ready") renderSyntaxOverlayReplay(state.syntaxOverlay.value);
    }
  }
}

function syntaxOverlayRecord(record, collection) {
  if (collection === "diagnostics") {
    return `<div class="diagnostic-row"><span class="severity ${escapeHtml(record.severity)}">${escapeHtml(record.severity)}</span><code>${escapeHtml(record.code)}</code><span class="message">${escapeHtml(record.message)}</span></div>`;
  }
  return `<div class="tree-item"><span class="node-icon">ƒ</span><span class="node-copy"><strong>${escapeHtml(record.path)}</strong><small>OBU ${record.obuId} · ${escapeHtml(record.coding)} · ${record.bitRange ? `absolute bit ${record.bitRange.startBit} + ${record.bitRange.lengthBits}` : "inferred"}</small></span><span class="node-size">${escapeHtml(record.value)}</span></div>`;
}

function renderSyntaxOverlayReplay(manifest) {
  const id = manifest.overlaySnapshotId;
  const current = state.syntaxOverlayPage;
  let page = `<div class="preview-loading"><span class="spinner"></span><p>Loading Overlay page</p></div>`;
  if (current?.status === "error") page = `<div class="preview-error">${escapeHtml(current.message)}</div>`;
  if (current?.status === "ready") {
    const value = current.value;
    const end = value.offset + value.records.length;
    page = `<div class="snapshot-page-head"><span>${value.offset + (value.records.length ? 1 : 0)}–${end} / ${value.total}</span><div><button type="button" data-overlay-page="prev" ${value.offset === 0 ? "disabled" : ""}>Previous</button><button type="button" data-overlay-page="next" ${end >= value.total ? "disabled" : ""}>Next</button></div></div><div class="snapshot-syntax-nodes">${value.records.map((record) => syntaxOverlayRecord(record, value.collection)).join("") || "No records"}</div>`;
  }
  elements.inspector.innerHTML = `<div class="inspector-title"><span>Syntax Overlay Snapshot</span><h3>${id.slice(0, 16)}</h3></div><section class="property-group"><h4>Unified syntax view</h4><div class="derived-syntax-reference"><span>Overlay ID<code>${id}</code></span><div><button type="button" data-open-syntax-overlay="${id}">By ID Replay</button><button type="button" data-export-syntax-overlay="${id}">Export  JSON</button></div></div>${propertyRows([
    ["Parent snapshot", manifest.parentSnapshotId],
    ["Covered OBUs", String(manifest.summary.coveredObuCount)],
    ["Syntax nodes", String(manifest.summary.syntaxNodeCount)],
    ["Diagnostics", String(manifest.summary.diagnosticCount)],
    ["Complete", String(manifest.summary.complete)],
  ])}<div class="snapshot-collections overlay-collections"><button type="button" data-overlay-collection="syntaxNodes" class="snapshot-collection ${current?.collection === "syntaxNodes" ? "active" : ""}">Syntax<b>${manifest.collections.syntaxNodes.count}</b></button><button type="button" data-overlay-collection="diagnostics" class="snapshot-collection ${current?.collection === "diagnostics" ? "active" : ""}">Diagnostics<b>${manifest.collections.diagnostics.count}</b></button></div>${page}</section>`;
  bindSyntaxOverlayButtons(elements.inspector, manifest);
}

function bindSyntaxOverlayButtons(root, manifest) {
  root.querySelectorAll("[data-open-syntax-overlay]").forEach((button) => {
    button.addEventListener("click", () => openSyntaxOverlay(button.dataset.openSyntaxOverlay));
  });
  root.querySelectorAll("[data-export-syntax-overlay]").forEach((button) => {
    button.addEventListener("click", () => exportSyntaxOverlay(button.dataset.exportSyntaxOverlay));
  });
  root.querySelectorAll("[data-overlay-collection]").forEach((button) => {
    button.addEventListener("click", () => loadSyntaxOverlayPage(
      manifest.overlaySnapshotId, button.dataset.overlayCollection, 0,
    ));
  });
  root.querySelectorAll("[data-overlay-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = state.syntaxOverlayPage;
      if (current?.status !== "ready") return;
      const delta = button.dataset.overlayPage === "next" ? current.limit : -current.limit;
      loadSyntaxOverlayPage(
        manifest.overlaySnapshotId,
        current.collection,
        Math.max(0, current.offset + delta),
      );
    });
  });
}

async function exportSyntaxOverlay(overlaySnapshotId) {
  const controller = replaceController("syntax-overlay-export");
  try {
    const response = await fetch(`/api/syntax-overlays/${overlaySnapshotId}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    downloadBlob(
      new Blob([await response.text()], { type: "application/json" }),
      `av1scope-syntax-overlay-${overlaySnapshotId.slice(0, 12)}.json`,
    );
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Syntax Overlay export failed: ${error.message}`);
  } finally {
    if (state.controllers.get("syntax-overlay-export") === controller) {
      state.controllers.delete("syntax-overlay-export");
    }
  }
}

async function openSyntaxOverlay(overlaySnapshotId) {
  if (!/^[0-9a-f]{64}$/.test(overlaySnapshotId)) {
    showToast("Syntax Overlay ID must be a 64-character lowercase SHA-256 hash");
    return;
  }
  const controller = replaceController("syntax-overlay-open");
  elements.inspector.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Verifying Syntax Overlay ${overlaySnapshotId.slice(0, 12)}</p></div>`;
  try {
    const response = await fetch(`/api/syntax-overlays/${overlaySnapshotId}/manifest`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const value = await response.json();
    if (state.controllers.get("syntax-overlay-open") !== controller) return;
    openSnapshot(value.parentSnapshotId, {
      syntaxOverlay: { status: "ready", value },
    });
    state.syntaxOverlayPage = { status: "loading", collection: "syntaxNodes", offset: 0, limit: 200 };
    void loadSyntaxOverlayPage(value.overlaySnapshotId, "syntaxNodes", 0);
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Syntax Overlay failed to open: ${error.message}`);
  } finally {
    if (state.controllers.get("syntax-overlay-open") === controller) {
      state.controllers.delete("syntax-overlay-open");
    }
  }
}

async function loadSnapshotSyntaxInspection(record) {
  const controller = replaceController("snapshot-inspect");
  const target = elements.inspector.querySelector("#snapshot-syntax-inspection");
  try {
    const requireComplete = [1, 4, 5].includes(record.type.code);
    const payload = await readBoundPayload(record, 256 * 1024, requireComplete);
    const request = { payload: bytesToBase64(payload) };
    if ([3, 4, 6, 7].includes(record.type.code)) {
      let sequenceBefore = record.obuId;
      if (record.type.code === 4) {
        const frameHeader = await findEarlierFrameHeader(record, controller.signal);
        if (!frameHeader) throw new Error("No earlier same-layer Frame Header context");
        request.frameHeaderObuId = frameHeader.obuId;
        request.frameHeaderPayload = bytesToBase64(
          await readBoundPayload(frameHeader, 256 * 1024, true),
        );
        sequenceBefore = frameHeader.obuId;
      }
      const sequence = await findEarlierSequenceHeader(sequenceBefore, controller.signal);
      if (sequence) {
        request.sequenceObuId = sequence.obuId;
        request.sequencePayload = bytesToBase64(
          await readBoundPayload(sequence, 256 * 1024, true),
        );
      } else if (record.type.code === 4) {
        throw new Error("Missing Frame Header preceding Sequence Header context");
      }
    }
    const response = await fetch(
      `/api/snapshots/${state.snapshotId}/inspect/${record.obuId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const result = await response.json();
    if (state.controllers.get("snapshot-inspect") !== controller || !target?.isConnected) return;
    target.innerHTML = renderSnapshotSyntaxInspection(result, {
      derivedSnapshotId: result.derivedSnapshot?.id ?? null,
    });
    bindDerivedSyntaxButtons(target);
    if (result.derivedSnapshot?.id) {
      state.pendingDerivedSelection = result.derivedSnapshot.id;
      void loadDerivedSyntaxPage(0);
    }
  } catch (error) {
    if (error.name !== "AbortError" && target?.isConnected) {
      target.innerHTML = `<h4>On-demand syntax</h4><div class="preview-error">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    if (state.controllers.get("snapshot-inspect") === controller) {
      state.controllers.delete("snapshot-inspect");
    }
  }
}

function renderSnapshotQuery() {
  const queryState = state.snapshotQuery;
  const request = queryState?.request ?? {
    collection: "obus",
    filter: { path: "type.code", op: "eq", value: 1 },
    projection: ["obuId", "type.name", "frameId", "byteRange.start", "byteRange.length"],
  };
  const selected = (value, expected) => value === expected ? "selected" : "";
  const path = request.filter?.path ?? "";
  const operator = request.filter?.op ?? "eq";
  const rawValue = request.filter === null ? "" : String(request.filter?.value ?? "");
  const projection = request.projection?.join(",") ?? "";
  let result = `<div class="snapshot-query-empty">Enter a field path and condition. Leave the path empty to match all records.</div>`;
  if (queryState?.status === "loading") {
    result = `<div class="preview-loading"><span class="spinner"></span><p>Validating and scanning Snapshot chunk</p></div>`;
  } else if (queryState?.status === "error") {
    result = `<div class="preview-error">${escapeHtml(queryState.message)}</div>`;
  } else if (queryState?.status === "ready") {
    const value = queryState.value;
    const rows = value.records.map(({ sourceOffset, record }) =>
      `<div class="snapshot-query-row"><b>#${sourceOffset}</b><code>${escapeHtml(JSON.stringify(record))}</code></div>`,
    ).join("");
    result = `<div class="snapshot-page-head"><span>Page ${queryState.pageIndex + 1} · Matched ${value.matchedCount} · scanned on this page: ${value.scannedCount} / source total: ${value.sourceTotal}</span><div><button type="button" data-snapshot-query-page="prev" ${queryState.pageIndex === 0 ? "disabled" : ""}>Previous</button><button type="button" data-snapshot-query-page="next" ${value.nextPageToken === null ? "disabled" : ""}>Next</button></div></div><div class="snapshot-query-results">${rows || "<span>No matching records</span>"}</div><small>Query ${escapeHtml(value.queryId.slice(0, 16))} · page token bound to Snapshot and the full query</small>`;
  }
  return `<div class="snapshot-query-panel"><h4>Stable Snapshot Query</h4><form data-snapshot-query-form><label>Collection<select name="collection"><option value="frames" ${selected(request.collection, "frames")}>Frames</option><option value="obus" ${selected(request.collection, "obus")}>OBUs</option><option value="syntaxNodes" ${selected(request.collection, "syntaxNodes")}>Syntax</option><option value="diagnostics" ${selected(request.collection, "diagnostics")}>Diagnostics</option></select></label><label>Field path<input name="path" value="${escapeHtml(path)}" placeholder="type.code"></label><label>Operator<select name="operator">${["eq", "ne", "lt", "lte", "gt", "gte", "contains", "exists"].map((item) => `<option value="${item}" ${selected(operator, item)}>${item}</option>`).join("")}</select></label><label>Value<input name="value" value="${escapeHtml(rawValue)}" placeholder="1 / true / text"></label><label class="snapshot-query-projection">Projected fields (comma-separated)<input name="projection" value="${escapeHtml(projection)}" placeholder="obuId,type.name"></label><button class="secondary-button" type="submit">Run query</button></form>${result}</div>`;
}

function renderSnapshotStore() {
  if (!state.snapshotId) return "";
  const manifestState = state.snapshotManifest;
  if (manifestState?.status === "error") {
    return `<section class="analysis-card snapshot-card"><header><h3>Snapshot Store</h3><span>${state.snapshotId.slice(0, 12)}</span></header><div class="preview-error">${escapeHtml(manifestState.message)}</div></section>`;
  }
  if (manifestState?.status !== "ready") {
    return `<section class="analysis-card snapshot-card"><header><h3>Snapshot Store</h3><span>${state.snapshotId.slice(0, 12)}</span></header><div class="preview-loading"><span class="spinner"></span><p>Verifying manifest</p></div></section>`;
  }
  const names = [
    ["frames", "Frames"], ["obus", "OBUs"],
    ["syntaxNodes", "Syntax"], ["diagnostics", "Diagnostics"],
  ];
  const current = state.snapshotPage;
  const controls = names.map(([name, label]) => {
    const count = manifestState.value.collections[name].count;
    return `<button type="button" class="snapshot-collection ${current?.collection === name ? "active" : ""}" data-snapshot-collection="${name}">${label}<b>${count}</b></button>`;
  }).join("");
  let page = `<div class="preview-loading"><span class="spinner"></span><p>Loading chunk</p></div>`;
  if (current?.status === "error") page = `<div class="preview-error">${escapeHtml(current.message)}</div>`;
  if (current?.status === "ready") {
    const { value } = current;
    const end = value.offset + value.records.length;
    page = `<div class="snapshot-page-head"><span>${value.offset + (value.records.length ? 1 : 0)}–${end} / ${value.total}</span><div><button type="button" data-snapshot-page="prev" ${value.offset === 0 ? "disabled" : ""}>Previous</button><button type="button" data-snapshot-page="next" ${end >= value.total ? "disabled" : ""}>Next</button></div></div><div class="snapshot-records">${value.records.map((record, index) => `<button type="button" data-snapshot-record="${index}">${escapeHtml(snapshotRecordLabel(value.collection, record))}</button>`).join("") || "<span>No records</span>"}</div>`;
  }
  const fingerprint = manifestState.value.header.source.fingerprint;
  const source = fingerprint ? `<div class="snapshot-source"><span>${state.snapshotSourceFile ? `✓ ${escapeHtml(state.snapshotSourceFile.name)}` : "Attach the original file for deep syntax inspection"}</span><button type="button" data-attach-snapshot-source>${state.snapshotSourceFile ? "Replace source" : "Attach source"}</button></div>` : "";
  const derivedState = state.derivedSyntaxPage;
  let derived = `<div class="preview-loading"><span class="spinner"></span><p>Loading derived syntax</p></div>`;
  if (derivedState?.status === "error") {
    derived = `<div class="preview-error">${escapeHtml(derivedState.message)}</div>`;
  } else if (derivedState?.status === "ready") {
    const value = derivedState.value;
    const rows = value.records.map((record) => `<label class="derived-syntax-row"><input type="checkbox" data-derived-select="${record.derivedSnapshotId}" ${state.derivedSelection.has(record.derivedSnapshotId) ? "checked" : ""}><span><b>OBU ${record.obuId} · ${escapeHtml(record.type.name)}</b><small>${record.derivedSnapshotId.slice(0, 16)} · ${record.nodeCount} fields · ${escapeHtml(record.status)}</small></span></label>`).join("");
    derived = `${rows ? `<div class="derived-syntax-list">${rows}</div><div class="derived-syntax-actions"><span>${value.total > value.records.length ? `Showing ${value.records.length} / ${value.total}` : `${value.total}  derived results`} · Per OBU select one version</span><button type="button" data-build-syntax-overlay ${state.derivedSelection.size ? "" : "disabled"}>Build Syntax Overlay · ${state.derivedSelection.size}</button></div>` : `<div class="snapshot-source"><span>No on-demand syntax results yet</span></div>`}`;
  }
  const blockState = state.blockOverlayStore;
  let blockOverlay = `<div class="snapshot-source"><span>No stored block data</span></div>`;
  if (blockState?.status === "loading") {
    blockOverlay = `<div class="preview-loading"><span class="spinner"></span><p>Loading Block Overlay</p></div>`;
  } else if (blockState?.status === "error") {
    blockOverlay = `<div class="preview-error">${escapeHtml(blockState.message)}</div>`;
  } else if (blockState?.manifest && blockState.page) {
    const value = blockState.page;
    const end = value.offset + value.records.length;
    const records = value.records.map((record) => `<div class="snapshot-query-row"><b>F${record.frameId} · B${record.blockId}</b><code>${escapeHtml(`${record.partition} / ${record.mode} / Q ${record.qindex ?? "—"} · ${record.x},${record.y} ${record.width}×${record.height}`)}</code></div>`).join("");
    blockOverlay = `<div class="snapshot-page-head"><span>${value.offset + (value.records.length ? 1 : 0)}–${end} / ${value.total}</span><div><button type="button" data-block-overlay-page="prev" ${value.offset === 0 ? "disabled" : ""}>Previous</button><button type="button" data-block-overlay-page="next" ${end >= value.total ? "disabled" : ""}>Next</button></div></div><div class="snapshot-query-results">${records || "<span>No records</span>"}</div><small>${escapeHtml(blockState.manifest.provenance.producer ?? "unknown")} · ${escapeHtml(blockState.manifest.provenance.build ?? "unknown")} · ${state.blockOverlaySnapshotId.slice(0, 16)}</small>`;
  }
  return `<section class="analysis-card snapshot-card"><header><h3>Snapshot Store · paged</h3><span title="${state.snapshotId}">${state.snapshotId.slice(0, 12)}</span></header>${source}<div class="snapshot-collections">${controls}</div>${page}${renderSnapshotQuery()}<div class="derived-syntax-panel"><h4>Derived Syntax</h4>${derived}</div><div class="derived-syntax-panel"><h4>Block Overlay · paged</h4>${blockOverlay}</div></section>`;
}

function renderViewport(obu, node) {
  if (state.view === "frame") {
    renderFramePreview();
  } else if (state.view === "frame-table") {
    renderFrameTable();
  } else if (state.view === "trace") {
    renderHeaderTrace();
  } else if (state.view === "compare") {
    renderComparison();
  } else {
    elements.viewportContent.innerHTML = state.view === "hex"
      ? obu ? renderHex(obu, node) : `<div class="panel-empty"><p>Select OBU to inspect bytes</p></div>`
      : renderOverview(obu);
  }
  const tabs = [
    [elements.hexTab, "hex"],
    [elements.frameTab, "frame"],
    [elements.overviewTab, "overview"],
    [elements.frameTableTab, "frame-table"],
    [elements.traceTab, "trace"],
    [elements.compareTab, "compare"],
  ];
  for (const [button, view] of tabs) {
    const active = state.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  const activeTab = tabs.find(([, view]) => state.view === view)?.[0];
  if (activeTab) elements.viewportContent.setAttribute("aria-labelledby", activeTab.id);
  elements.viewportContent.querySelectorAll("[data-overview-frame]").forEach((button) => {
    button.addEventListener("click", () => selectFrame(Number(button.dataset.overviewFrame)));
  });
  elements.viewportContent.querySelector("[data-frame-chart-metric]")?.addEventListener("change", (event) => {
    state.frameChartMetric = event.currentTarget.value;
    renderSelection();
  });
  bindSnapshotControls();
}

async function renderHeaderTrace() {
  if (state.headerTrace?.status === "ready") {
    const entries = state.headerTrace.value.entries.filter(({ frameIndex }) =>
      state.selectedFrameId === null || frameIndex === null || frameIndex === state.selectedFrameId,
    );
    const selectedFrame = state.report.frames.find(({ frameId }) => frameId === state.selectedFrameId);
    const selectedObuIds = new Set(selectedFrame?.obuIds ?? []);
    const nativeFields = buildNativeTraceFieldMap(state.report.syntaxNodes
      .filter(({ obuId }) => selectedObuIds.has(obuId)));
    let matches = 0;
    let mismatches = 0;
    const rows = entries.map((entry) => {
      const { comparable, match, nativeValue } = compareTraceEntry(nativeFields, entry);
      if (match) matches += 1;
      if (comparable && !match) mismatches += 1;
      const comparison = comparable ? `<span class="trace-compare ${match ? "match" : "mismatch"}" title="AV1Scope=${nativeValue}">${match ? "✓" : `≠ ${nativeValue}`}</span>` : "";
      return `<div class="trace-row"><span>${entry.frameIndex === null ? "extra" : `F${entry.frameIndex}`}</span><b>${escapeHtml(entry.section)}</b><code>${escapeHtml(entry.name)}</code><em>bit ${entry.bitOffset}</em><output>${entry.value}</output>${comparison}</div>`;
    }).join("");
    elements.viewportContent.innerHTML = `<div class="trace-view"><div class="trace-provenance">Supplementary comparison · ffmpeg trace_headers · bit offset uses OBU relative offsets, not absolute file offsets</div><div class="trace-summary"><span>Comparable parser fields <b>${matches + mismatches}</b></span><span class="match">Matched <b>${matches}</b></span><span class="${mismatches ? "mismatch" : "match"}">Mismatched <b>${mismatches}</b></span></div>${rows || `<div class="preview-error">No fields for this frame: trace fields</div>`}</div>`;
    return;
  }
  if (state.headerTrace?.status === "error") {
    elements.viewportContent.innerHTML = `<div class="preview-error">FFmpeg Trace unavailable<br><small>${escapeHtml(state.headerTrace.message)}</small></div>`;
    return;
  }
  elements.viewportContent.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Running FFmpeg trace_headers</p></div>`;
  if (state.headerTrace?.status === "loading") return;
  state.headerTrace = { status: "loading" };
  const controller = replaceController("trace");
  try {
    const response = await fetch("/api/header-trace", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: state.bytes,
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(failure.error ?? `HTTP ${response.status}`);
    }
    state.headerTrace = { status: "ready", value: await response.json() };
  } catch (error) {
    state.headerTrace = error.name === "AbortError"
      ? null
      : { status: "error", message: error.message };
  } finally {
    if (state.controllers.get("trace") === controller) state.controllers.delete("trace");
  }
  if (state.view === "trace") renderHeaderTrace();
}

function comparisonEnvelope(reference, candidate) {
  const magic = new TextEncoder().encode("AV1SCOPECMP1");
  const output = new Uint8Array(magic.length + 4 + reference.length + candidate.length);
  output.set(magic, 0);
  new DataView(output.buffer).setUint32(magic.length, reference.length, false);
  output.set(reference, magic.length + 4);
  output.set(candidate, magic.length + 4 + reference.length);
  return output;
}

async function renderComparison() {
  if (!state.comparison) {
    elements.viewportContent.innerHTML = `<div class="hero-empty"><span class="empty-icon">⇄</span><h1>Load a comparison stream</h1><p>Align by Frame ID  to compare decoded luma using MAE、PSNR、SSIM and the absolute difference distribution.</p><button class="secondary-button" id="inline-compare-button" type="button">Choose comparison stream</button></div>`;
    elements.viewportContent.querySelector("#inline-compare-button").addEventListener("click", () => elements.compareInput.click());
    return;
  }
  const frameId = state.selectedFrameId;
  if (frameId === null) {
    elements.viewportContent.innerHTML = `<div class="preview-error">This input has no comparable container frames</div>`;
    return;
  }
  const record = state.comparisonMetrics.get(frameId);
  if (record?.status === "ready") {
    const value = record.value;
    const previews = state.comparisonPreviews.get(frameId);
    if (!previews || previews.status !== "ready") {
      elements.viewportContent.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Generating both frame previews</p></div>`;
      if (!previews) loadComparisonPreviews(frameId);
      return;
    }
    const maxCount = Math.max(...value.differenceHistogram, 1);
    const bars = value.differenceHistogram.map((count, difference) => `<i style="--height:${Math.max(.5, count / maxCount * 100)}%" title="|ΔY|=${difference}: ${count}"></i>`).join("");
    elements.viewportContent.innerHTML = `<div class="compare-view"><div class="compare-heading"><div><span>REFERENCE</span><b>${escapeHtml(state.file.name)}</b></div><strong>Frame ${frameId}</strong><div><span>CANDIDATE</span><b>${escapeHtml(state.comparison.file.name)}</b></div></div><section class="wipe-card"><div class="wipe-stage"><img src="${previews.referenceUrl}" alt="Reference Frame ${frameId}"><div class="wipe-candidate" style="--wipe:50%"><img src="${previews.candidateUrl}" alt="Candidate Frame ${frameId}"></div><span class="wipe-line" style="--wipe:50%"></span></div><label>Wipe position <input id="wipe-slider" type="range" min="0" max="100" value="50"></label></section><section class="metric-grid compare-metrics"><div class="metric"><span>Y-PSNR</span><b>${value.psnr === null ? "∞" : value.psnr.toFixed(3)} dB</b></div><div class="metric"><span>Global SSIM</span><b>${value.ssim.toFixed(6)}</b></div><div class="metric"><span>MAE</span><b>${value.mae.toFixed(4)}</b></div><div class="metric"><span>Max |ΔY|</span><b>${value.maximumAbsoluteError}</b></div></section><section class="analysis-card"><header><h3>Absolute luma difference</h3><span>${value.identical ? "Identical pixels" : `${value.pixelCount} pixels`}</span></header><div class="difference-histogram">${bars}</div><div class="difference-axis"><span>0</span><span>64</span><span>128</span><span>192</span><span>255</span></div></section><p class="metric-note">SSIM uses global frame statistics. Record the metric version and color/bit-depth conversion settings for formal reports.</p></div>`;
    elements.viewportContent.querySelector("#wipe-slider").addEventListener("input", (event) => {
      const wipe = `${event.target.value}%`;
      elements.viewportContent.querySelector(".wipe-candidate").style.setProperty("--wipe", wipe);
      elements.viewportContent.querySelector(".wipe-line").style.setProperty("--wipe", wipe);
    });
    return;
  }
  if (record?.status === "error") {
    elements.viewportContent.innerHTML = `<div class="preview-error">Comparison failed<br><small>${escapeHtml(record.message)}</small></div>`;
    return;
  }
  elements.viewportContent.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Decoding and comparing Frame ${frameId}</p></div>`;
  if (record?.status === "loading") return;
  state.comparisonMetrics.set(frameId, { status: "loading" });
  const controller = replaceController("compare");
  try {
    const response = await fetch(`/api/compare-frame?frame=${frameId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: comparisonEnvelope(state.bytes, state.comparison.bytes),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(failure.error ?? `HTTP ${response.status}`);
    }
    state.comparisonMetrics.set(frameId, { status: "ready", value: await response.json() });
  } catch (error) {
    if (error.name === "AbortError") state.comparisonMetrics.delete(frameId);
    else state.comparisonMetrics.set(frameId, { status: "error", message: error.message });
  } finally {
    if (state.controllers.get("compare") === controller) state.controllers.delete("compare");
  }
  if (state.view === "compare" && state.selectedFrameId === frameId) renderComparison();
}

async function loadComparisonPreviews(frameId) {
  state.comparisonPreviews.set(frameId, { status: "loading" });
  const controller = replaceController("compare-preview");
  try {
    const decode = async (bytes) => {
      const response = await fetch(`/api/preview?frame=${frameId}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`preview HTTP ${response.status}`);
      return URL.createObjectURL(await response.blob());
    };
    const [referenceUrl, candidateUrl] = await Promise.all([
      decode(state.bytes),
      decode(state.comparison.bytes),
    ]);
    state.comparisonPreviews.set(frameId, { status: "ready", referenceUrl, candidateUrl });
  } catch (error) {
    if (error.name === "AbortError") state.comparisonPreviews.delete(frameId);
    else {
      state.comparisonPreviews.set(frameId, { status: "error", message: error.message });
      state.comparisonMetrics.set(frameId, { status: "error", message: error.message });
    }
  } finally {
    if (state.controllers.get("compare-preview") === controller) state.controllers.delete("compare-preview");
  }
  if (state.view === "compare" && state.selectedFrameId === frameId) renderComparison();
}

function formatStatistic(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(digits);
}

function formatPercent(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—" : `${(value * 100).toFixed(2)}%`;
}

function renderBlockDistribution(title, distribution, maximumItems = 8) {
  const items = distribution.items.slice(0, maximumItems);
  const rows = items.map((item) => `<div class="block-stat-row" title="${escapeHtml(`${item.count} records · ${formatPercent(item.areaRatio)} of known record-area`)}"><span>${escapeHtml(item.label)}</span><i><b style="--bar:${Math.max(1, (item.areaRatio ?? 0) * 100)}%"></b></i><output>${item.count.toLocaleString()} · ${formatPercent(item.areaRatio)}</output></div>`).join("");
  const truncated = distribution.items.length > maximumItems
    ? `<small>Top ${maximumItems} / ${distribution.items.length} values</small>` : "";
  return `<section class="block-stat-card"><header><h4>${escapeHtml(title)}</h4><span>known ${distribution.knownCount.toLocaleString()} · missing ${distribution.missingCount.toLocaleString()}</span></header>${rows || `<div class="block-stat-empty">No produced values</div>`}${truncated}</section>`;
}

function renderBlockStatisticsPanel(statistics, motionLegend = "") {
  const coverage = statistics.coverage;
  const overlap = coverage.status === "exact"
    ? `${formatStatistic(coverage.overlapArea, 0)} px²`
    : `Unavailable · >${coverage.recordLimit.toLocaleString()} records`;
  const qindex = statistics.qindex;
  const coefficients = statistics.coefficients;
  const qMaximum = Math.max(...statistics.qindexHistogram.bins.map(({ area }) => area), 1);
  const qHistogram = statistics.qindexHistogram.bins.map((bin) => `<i style="--height:${Math.max(bin.area ? 3 : 0, bin.area / qMaximum * 100)}%" title="Q ${bin.minimum}–${bin.maximum}: ${bin.count} records · ${formatPercent(bin.areaRatio)} known record-area"><b></b><span>${bin.minimum}</span></i>`).join("");
  return `<details class="block-statistics-panel"><summary><span>Block statistics · luma</span><small>Coverage, QIndex and coding distribution</small></summary>
    <div class="block-stat-metrics">
      <div><span>Luma records</span><b>${statistics.lumaRecordCount.toLocaleString()}</b><small>${statistics.nonLumaRecordCount.toLocaleString()} non-luma excluded</small></div>
      <div><span>Exact coverage</span><b>${coverage.status === "exact" ? formatPercent(coverage.coverageRatio) : "—"}</b><small>${coverage.status === "exact" ? `${formatStatistic(coverage.coveredArea, 0)} / ${formatStatistic(coverage.frameArea, 0)} px²` : coverage.status}</small></div>
      <div><span>Overlap area</span><b>${overlap}</b><small>duplicate sum ${formatStatistic(coverage.duplicateArea, 0)} px²</small></div>
      <div><span>QIndex</span><b>${formatStatistic(qindex.areaWeightedMean)}</b><small>min ${formatStatistic(qindex.minimum)} · p50 ${formatStatistic(qindex.median)} · p95 ${formatStatistic(qindex.p95)} · max ${formatStatistic(qindex.maximum)} · missing ${qindex.missingCount}</small></div>
      <div><span>Non-zero coeffs</span><b>${formatStatistic(coefficients.sum, 0)}</b><small>mean ${formatStatistic(coefficients.mean)} · max ${formatStatistic(coefficients.maximum)} · missing ${coefficients.missingCount}</small></div>
      <div><span>Skip blocks</span><b>${statistics.skipCount.toLocaleString()}</b></div>
    </div>
    <section class="block-q-histogram"><header><h4>QIndex distribution</h4><span>16-value bins · area weighted</span></header><div>${qHistogram}</div></section>
    <div class="block-distribution-grid">
      ${renderBlockDistribution("Prediction mode", statistics.distributions.mode)}
      ${renderBlockDistribution("Partition", statistics.distributions.partition)}
      ${renderBlockDistribution("Block size", statistics.distributions.blockSize)}
      ${renderBlockDistribution("Transform size", statistics.distributions.transformSize)}
      ${renderBlockDistribution("Segment", statistics.distributions.segment)}
    </div>
    ${motionLegend ? `<section class="block-motion-details"><h4>Motion vectors · all block records</h4>${motionLegend}</section>` : ""}
  </details>`;
}

async function renderFramePreview() {
  const frameId = state.selectedFrameId;
  if (frameId === null) {
    elements.viewportContent.innerHTML = `<div class="preview-error">Raw OBU streams have no decodable container frames</div>`;
    return;
  }
  const cached = state.previews.get(frameId);
  if (cached?.status === "ready") {
    releaseBlockRenderer();
    const frame = state.report.frames.find(({ frameId: id }) => id === frameId);
    const displaySummary = displayedFrameSummary(state.report, frame);
    const width = displaySummary.frameWidth ?? state.report.container?.width ?? 1;
    const height = displaySummary.frameHeight ?? state.report.container?.height ?? 1;
    const use128 = state.report.syntaxNodes.find(({ path }) => path === "sequence_header.use_128x128_superblock")?.value === 1;
    const sbSize = use128 ? 128 : 64;
    const lines = [];
    for (let x = sbSize; x < width; x += sbSize) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"></line>`);
    for (let y = sbSize; y < height; y += sbSize) lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"></line>`);
    const grid = `<svg class="superblock-grid ${state.showSuperblockGrid ? "" : "hidden"}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><rect x=".5" y=".5" width="${Math.max(0, width - 1)}" height="${Math.max(0, height - 1)}"></rect>${lines.join("")}</svg>`;
    const frameOverlay = state.overlay?.frames.find(({ frameId: id }) => id === frameId);
    const hasBlocks = (frameOverlay?.blocks.length ?? 0) > 0;
    const blocks = hasBlocks ? `<canvas class="block-overlay" width="${width}" height="${height}" aria-label="Coding blocks and motion vectors"></canvas>` : "";
    const modes = analysisModes(frameOverlay?.blocks ?? [], overlaySupportsFeature);
    let activeMode = modes.find(({ id }) => id === state.analysisMode);
    if (!activeMode?.available) activeMode = modes.find(({ id }) => id === "yuv");
    state.analysisMode = activeMode.id;
    if (activeMode.id !== "info-overlays" || !["qindex", "quant-delta"].includes(state.overlayLayer)) state.overlayLayer = activeMode.layer;
    if (activeMode.id === "simple-motion") state.showMotionVectors = true;
    const layerFeatures = { mode: "mode", partition: null, none: null, qindex: "qindex", "quant-delta": "qindex", coefficients: "coefficient", motion: "motion-vector" };
    if (!(state.overlayLayer in layerFeatures) || (layerFeatures[state.overlayLayer] !== null && !overlaySupportsFeature(layerFeatures[state.overlayLayer]))) {
      state.overlayLayer = "partition";
    }
    const layerOption = (value, label) => {
      const available = layerFeatures[value] === null || overlaySupportsFeature(layerFeatures[value]);
      return `<option value="${value}" ${state.overlayLayer === value ? "selected" : ""} ${available ? "" : "disabled"}>${label}${available ? "" : " (unavailable)"}</option>`;
    };
    let blockStatistics = hasBlocks ? state.blockStatisticsCache.get(frameOverlay.blocks) : null;
    if (hasBlocks && !blockStatistics) {
      blockStatistics = summarizeBlockStatistics(frameOverlay.blocks, { frameWidth: width, frameHeight: height });
      state.blockStatisticsCache.set(frameOverlay.blocks, blockStatistics);
    }
    if (blockStatistics && blockStatistics.filterCounts[state.blockVisibilityFilter] === 0) {
      state.blockVisibilityFilter = blockStatistics.filterCounts.all > 0 ? "all" : "all-planes";
    }
    const motionSummary = blockStatistics?.motion ?? null;
    const motionFeatureAvailable = overlaySupportsFeature("motion-vector");
    const hasMotionVectors = motionFeatureAvailable && (motionSummary?.vectorCount ?? 0) > 0;
    const layerControls = hasBlocks ? `<div class="block-controls">
      <label ${activeMode.id === "info-overlays" ? "" : "hidden"}>Overlay <select id="block-layer">${activeMode.id === "info-overlays" ? `${layerOption("qindex", "QIndex")}${layerOption("quant-delta", "Q delta")}` : layerOption(activeMode.layer, activeMode.label)}</select></label>
      <label><input id="block-borders" type="checkbox" ${state.showBlockBorders ? "checked" : ""}>Block borders</label>
      <label class="motion-toggle" title="Show prediction offsets from each block center. Expand Motion vector guide for units and reference colors."><input id="mv-toggle" type="checkbox" ${state.showMotionVectors && hasMotionVectors ? "checked" : ""} ${hasMotionVectors ? "" : "disabled"}>Motion vectors</label>
      </div>${renderMotionVectorGuide()}<details class="analysis-disclosure"${state.blockVisibilityFilter !== "all" ? " open" : ""}><summary>Overlay settings${state.blockVisibilityFilter !== "all" ? ` · Filter: ${escapeHtml(state.blockVisibilityFilter)}` : ""}</summary><div class="block-controls">
      <label>Filter <select id="block-filter">${[
        ["all", "All luma"], ["intra", "Intra"], ["inter", "Inter"], ["skip", "Skip"],
        ["compound", "Compound"], ["motion", "Has MV"], ["coeff", "Non-zero coeff"], ["all-planes", "All planes"],
      ].map(([value, label]) => `<option value="${value}" ${state.blockVisibilityFilter === value ? "selected" : ""} ${blockStatistics.filterCounts[value] === 0 ? "disabled" : ""}>${label} (${blockStatistics.filterCounts[value]})</option>`).join("")}</select></label>
      <label>Overlay opacity <input id="block-opacity" type="range" min="5" max="80" value="${Math.round(state.overlayOpacity * 100)}"></label>
      <label>Vectors <select id="mv-component" ${hasMotionVectors ? "" : "disabled"}><option value="all" ${state.motionVectorComponent === "all" ? "selected" : ""}>All</option><option value="primary" ${state.motionVectorComponent === "primary" ? "selected" : ""}>MV 1</option><option value="secondary" ${state.motionVectorComponent === "secondary" ? "selected" : ""}>MV 2</option></select></label>
      <label>MV scale <input id="mv-scale" type="range" min="1" max="16" step="1" value="${state.motionVectorScale}" ${hasMotionVectors ? "" : "disabled"}><output id="mv-scale-value">${state.motionVectorScale}×</output></label>
      <label>MV opacity <input id="mv-opacity" type="range" min="10" max="100" value="${Math.round(state.motionVectorOpacity * 100)}" ${hasMotionVectors ? "" : "disabled"}></label>
      <label>Min magnitude <select id="mv-minimum" ${hasMotionVectors ? "" : "disabled"}>${[0, 0.25, 0.5, 1, 2, 4].map((value) => `<option value="${value}" ${state.motionVectorMinimumMagnitude === value ? "selected" : ""}>${value} px</option>`).join("")}</select></label>
    </div></details>` : "";
    const motionReferences = motionSummary ? Object.entries(motionSummary.referenceSlotCounts)
      .map(([slot, count], index) => `<span><i style="--mv-color:${motionVectorColorCss(Number(slot), index)}"></i>Ref ${slot} <b>${count}</b></span>`).join("") : "";
    const motionLegend = hasBlocks && motionFeatureAvailable ? `<div class="motion-vector-summary"><div><span>MV <b>${motionSummary.vectorCount}</b></span><span>Compound <b>${motionSummary.compoundBlockCount}</b></span><span>Zero <b>${motionSummary.zeroVectorCount}</b></span><span>Mean <b>${formatMotionPixels(motionSummary.meanMagnitudePixels)}</b></span><span>Max <b>${formatMotionPixels(motionSummary.maximumMagnitudePixels)}</b></span>${motionSummary.unknownPrecisionCount ? `<span class="warning">Unknown precision <b>${motionSummary.unknownPrecisionCount}</b></span>` : ""}</div><div class="motion-reference-legend">${motionReferences || "No reference slots"}</div></div>` : "";
    const blockStatisticsPanel = blockStatistics ? renderBlockStatisticsPanel(blockStatistics, motionLegend) : "";
    const visibleBlockCount = blockStatistics?.filterCounts[state.blockVisibilityFilter] ?? 0;
    const noBlocksMessage = state.report.blockInspection?.status === "failed"
      ? `${state.report.blockInspection.reason} (${state.report.blockInspection.code})`
      : state.report.blockInspection?.status === "ready"
        ? displaySummary.showExistingFrame
          ? `This frame reuses reference slot ${displaySummary.frameToShowMapIdx}; block records for the reused picture are unavailable.`
          : "No new block records for this frame. Select another frame to inspect coding blocks."
        : "Block inspection is disabled. Configure libaom inspection and reopen the stream, or import block data from Tools.";
    elements.viewportContent.innerHTML = `<div class="frame-preview"><div class="preview-scroll"><div class="preview-stage"><img src="${cached.url}" alt="Frame ${frameId} decoded preview">${grid}${blocks}</div></div><div class="preview-caption"><span>${width}×${height}</span><label class="overlay-toggle"><input id="sb-grid-toggle" type="checkbox" ${state.showSuperblockGrid ? "checked" : ""}> ${sbSize}×${sbSize} SB grid</label></div>${layerControls}<div class="overlay-note">${hasBlocks ? `<span id="block-visible-count">${visibleBlockCount}</span> / ${frameOverlay.blocks.length} blocks visible` : escapeHtml(noBlocksMessage)}</div>${blockStatisticsPanel}</div>`;
    const stage = elements.viewportContent.querySelector(".preview-stage");
    stage.style.aspectRatio = `${width} / ${height}`;
    stage.style.width = state.previewZoom === "fit" ? `min(100%, ${Math.round(width / height * 600)}px)` : `${width * Number(state.previewZoom)}px`;
    stage.parentElement.insertAdjacentHTML("beforebegin", `<div class="preview-toolbar"><label>Mode <select id="analysis-mode">${modes.map((mode) => `<option value="${mode.id}" ${mode.id === activeMode.id ? "selected" : ""} ${mode.available ? "" : "disabled"} title="${escapeHtml(mode.note)}">${mode.label}${mode.available ? "" : " — unavailable"}</option>`).join("")}</select></label><label>Zoom <select id="preview-zoom">${[["fit", "Fit"], ["1", "100%"], ["2", "200%"], ["4", "400%"], ["8", "800%"]].map(([value, label]) => `<option value="${value}" ${String(state.previewZoom) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><span>Drag to pan · Click to inspect · Double-click to reset</span></div><p class="mode-description">${escapeHtml(activeMode.note)}</p>`);
    elements.viewportContent.querySelector("#analysis-mode").addEventListener("change", (event) => {
      const mode = modes.find(({ id }) => id === event.target.value);
      if (!mode?.available) return;
      state.analysisMode = mode.id;
      state.showMotionVectors = mode.id === "simple-motion";
      state.selectedBlock = null;
      renderFramePreview();
      const obu = selectedObu();
      if (obu) renderInspector(obu, selectedNode(), null);
    });
    elements.viewportContent.querySelector("#preview-zoom").addEventListener("change", (event) => {
      state.previewZoom = event.target.value;
      renderFramePreview();
    });
    elements.viewportContent.querySelector("#sb-grid-toggle").addEventListener("change", (event) => {
      state.showSuperblockGrid = event.target.checked;
      elements.viewportContent.querySelector(".superblock-grid").classList.toggle("hidden", !state.showSuperblockGrid);
    });
    if (hasBlocks) setupBlockOverlay(frameOverlay.blocks, width, height, hasMotionVectors);
    state.previewPanCleanup = attachPreviewPan(elements.viewportContent.querySelector(".preview-scroll"));
    elements.viewportContent.querySelector(".frame-preview").insertAdjacentHTML("beforeend", `<details class="analysis-disclosure" id="luma-details"><summary>Luma statistics</summary></details>`);
    const lumaDetails = elements.viewportContent.querySelector("#luma-details");
    lumaDetails.addEventListener("toggle", () => {
      if (lumaDetails.open && !lumaDetails.dataset.loaded) {
        lumaDetails.dataset.loaded = "true";
        renderLumaStats(frameId);
      }
    });
    return;
  }
  if (cached?.status === "error") {
    elements.viewportContent.innerHTML = `<div class="preview-error">Frame preview unavailable<br><small>${escapeHtml(cached.message)}</small></div>`;
    return;
  }
  elements.viewportContent.innerHTML = `<div class="preview-loading"><span class="spinner"></span><p>Decoding Frame ${frameId}</p></div>`;
  state.previews.set(frameId, { status: "loading" });
  const controller = replaceController("preview");
  try {
    const response = await fetch(`/api/preview?frame=${frameId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: state.bytes,
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(failure.error ?? `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (state.controllers.get("preview") !== controller) return;
    const url = URL.createObjectURL(blob);
    state.previews.set(frameId, { status: "ready", url });
  } catch (error) {
    if (state.controllers.get("preview") !== controller) return;
    if (error.name === "AbortError") state.previews.delete(frameId);
    else state.previews.set(frameId, { status: "error", message: error.message });
  } finally {
    if (state.controllers.get("preview") === controller) state.controllers.delete("preview");
  }
  if (state.view === "frame" && state.selectedFrameId === frameId) renderFramePreview();
}

function setupBlockOverlay(blocks, width, height, motionVectorsAvailable = false) {
  releaseBlockRenderer();
  const canvas = elements.viewportContent.querySelector(".block-overlay");
  if (!canvas) return;
  let visibleBlocks = filterBlockRecords(blocks, state.blockVisibilityFilter);
  let index = new BlockSpatialIndex(visibleBlocks);
  try {
    const renderer = new BlockOverlayRenderer(canvas, width, height);
    state.blockRenderer = renderer;
    const legend = document.createElement("div");
    legend.className = "block-layer-legend";
    canvas.closest(".frame-preview").querySelector(".block-controls").after(legend);
    const paint = () => {
      if (state.blockRenderer !== renderer) return;
      legend.innerHTML = blockLayerLegend(state.overlayLayer).map(({ label, color }) => `<span>${color ? `<i style="background:${color}"></i>` : ""}${escapeHtml(label)}</span>`).join("");
      const borders = elements.viewportContent.querySelector("#block-borders");
      borders.disabled = ["partition", "none", "motion"].includes(state.overlayLayer);
      borders.checked = state.overlayLayer === "partition" || (!["none", "motion"].includes(state.overlayLayer) && state.showBlockBorders);
      const gridToggle = elements.viewportContent.querySelector("#sb-grid-toggle");
      gridToggle.disabled = state.overlayLayer === "none";
      gridToggle.checked = state.overlayLayer !== "none" && state.showSuperblockGrid;
      elements.viewportContent.querySelector(".superblock-grid").classList.toggle("hidden", state.overlayLayer === "none" || !state.showSuperblockGrid);
      renderer.render(visibleBlocks, {
      layer: state.overlayLayer,
      showBorders: state.overlayLayer === "motion" ? false : state.showBlockBorders,
      opacity: state.overlayOpacity,
      showMotionVectors: state.showMotionVectors && motionVectorsAvailable,
      motionVectorComponent: state.motionVectorComponent,
      motionVectorScale: state.motionVectorScale,
      motionVectorMinimumMagnitude: state.motionVectorMinimumMagnitude,
      motionVectorOpacity: state.motionVectorOpacity,
      selectedBlockId: state.selectedBlock?.blockId ?? null,
      });
    };
    state.blockAnimationFrame = requestAnimationFrame(paint);
    if (typeof ResizeObserver !== "undefined") {
      state.blockResizeObserver = new ResizeObserver(paint);
      state.blockResizeObserver.observe(canvas.parentElement);
    }
    elements.viewportContent.querySelector("#block-borders").addEventListener("change", (event) => {
      state.showBlockBorders = event.target.checked;
      paint();
    });
    elements.viewportContent.querySelector("#block-layer").addEventListener("change", (event) => {
      state.overlayLayer = event.target.value;
      if (state.overlayLayer === "none") {
        state.selectedBlock = null;
        elements.viewportContent.querySelector(".block-selection")?.remove();
      }
      paint();
    });
    elements.viewportContent.querySelector("#block-opacity").addEventListener("input", (event) => {
      state.overlayOpacity = Number(event.target.value) / 100;
      paint();
    });
    elements.viewportContent.querySelector("#block-filter")?.addEventListener("change", (event) => {
      state.blockVisibilityFilter = event.target.value;
      visibleBlocks = filterBlockRecords(blocks, state.blockVisibilityFilter);
      index = new BlockSpatialIndex(visibleBlocks);
      const count = elements.viewportContent.querySelector("#block-visible-count");
      if (count) count.textContent = visibleBlocks.length.toLocaleString();
      if (state.selectedBlock && !visibleBlocks.includes(state.selectedBlock)) {
        state.selectedBlock = null;
        elements.viewportContent.querySelector(".block-selection")?.remove();
        const obu = selectedObu();
        if (obu) {
          elements.selectionChip.textContent = `OBU ${obu.obuId} / ${humanType(obu.type)}`;
          renderInspector(obu, selectedNode(), null);
        }
      }
      paint();
    });
    elements.viewportContent.querySelector("#mv-toggle")?.addEventListener("change", (event) => {
      state.showMotionVectors = event.target.checked;
      paint();
    });
    elements.viewportContent.querySelector("#mv-component")?.addEventListener("change", (event) => {
      state.motionVectorComponent = event.target.value;
      paint();
    });
    elements.viewportContent.querySelector("#mv-scale")?.addEventListener("input", (event) => {
      state.motionVectorScale = Number(event.target.value);
      const output = elements.viewportContent.querySelector("#mv-scale-value");
      if (output) output.textContent = `${state.motionVectorScale}×`;
      paint();
    });
    elements.viewportContent.querySelector("#mv-minimum")?.addEventListener("change", (event) => {
      state.motionVectorMinimumMagnitude = Number(event.target.value);
      paint();
    });
    elements.viewportContent.querySelector("#mv-opacity")?.addEventListener("input", (event) => {
      state.motionVectorOpacity = Number(event.target.value) / 100;
      paint();
    });
    canvas.addEventListener("click", (event) => {
      if (state.overlayLayer === "none") return;
      const point = sourcePointFromClient(canvas.getBoundingClientRect(), event.clientX, event.clientY, width, height);
      if (!point) return;
      const { x, y } = point;
      state.selectedBlock = index.pick(x, y);
      const oldHighlight = elements.viewportContent.querySelector(".block-selection");
      oldHighlight?.remove();
      if (state.selectedBlock) {
        const highlight = document.createElement("div");
        highlight.className = "block-selection";
        highlight.setAttribute("aria-hidden", "true");
        highlight.style.left = `${state.selectedBlock.x / width * 100}%`;
        highlight.style.top = `${state.selectedBlock.y / height * 100}%`;
        highlight.style.width = `${state.selectedBlock.width / width * 100}%`;
        highlight.style.height = `${state.selectedBlock.height / height * 100}%`;
        canvas.parentElement.append(highlight);
      }
      paint();
      const obu = selectedObu();
      if (obu) {
        elements.selectionChip.textContent = state.selectedBlock
          ? `Block ${state.selectedBlock.blockId} · ${state.selectedBlock.width}×${state.selectedBlock.height}`
          : `OBU ${obu.obuId} / ${humanType(obu.type)}`;
        renderInspector(obu, selectedNode(), state.selectedBlock);
      }
    });
  } catch (error) {
    canvas.replaceWith(Object.assign(document.createElement("div"), {
      className: "block-render-error",
      textContent: `Block rendering failed: ${error.message}`,
    }));
  }
}

async function renderLumaStats(frameId) {
  const root = elements.viewportContent.querySelector("#luma-details");
  if (!root) return;
  const record = state.frameStats.get(frameId);
  if (!record) {
    root.insertAdjacentHTML("beforeend", `<div class="luma-loading">Computing luma statistics…</div>`);
    state.frameStats.set(frameId, { status: "loading" });
    const controller = replaceController("luma");
    try {
      const response = await fetch(`/api/frame-stats?frame=${frameId}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: state.bytes,
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(failure.error ?? `HTTP ${response.status}`);
      }
      const value = await response.json();
      if (state.controllers.get("luma") !== controller) return;
      state.frameStats.set(frameId, { status: "ready", value });
    } catch (error) {
      if (state.controllers.get("luma") !== controller) return;
      if (error.name === "AbortError") state.frameStats.delete(frameId);
      else state.frameStats.set(frameId, { status: "error", message: error.message });
    } finally {
      if (state.controllers.get("luma") === controller) state.controllers.delete("luma");
    }
    if (state.view === "frame" && state.selectedFrameId === frameId) {
      const currentRoot = elements.viewportContent.querySelector("#luma-details");
      currentRoot?.querySelector(".luma-loading")?.remove();
      if (currentRoot?.open) renderLumaStats(frameId);
      else if (currentRoot) delete currentRoot.dataset.loaded;
    }
    return;
  }
  if (record.status === "error") {
    root.insertAdjacentHTML("beforeend", `<div class="luma-loading">Luma statistics unavailable: ${escapeHtml(record.message)}</div>`);
    return;
  }
  if (record.status !== "ready") return;
  const stats = record.value;
  const maxCount = Math.max(...stats.histogram, 1);
  const bars = stats.histogram.map((count, value) => `<i style="--height:${Math.max(.5, count / maxCount * 100)}%" title="Y=${value}: ${count}"></i>`).join("");
  root.insertAdjacentHTML("beforeend", `<section class="luma-panel"><header><b>Luma histogram</b><span>min ${stats.minimum} · max ${stats.maximum} · mean ${stats.mean.toFixed(2)} · σ ${stats.standardDeviation.toFixed(2)}</span></header><div class="luma-histogram">${bars}</div></section>`);
}

function propertyRows(entries) {
  const meaningful = entries.filter(([, value]) => value !== null && value !== undefined && value !== "" && value !== "—");
  return `<dl>${meaningful.map(([key, value, accent = false]) => `<div class="property-row"><dt>${escapeHtml(key)}</dt><dd class="${accent ? "accent" : ""}">${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function renderBitStrip(node) {
  if (!node?.bitRange) return "";
  const bits = [];
  for (let position = 0; position < Math.min(64, node.bitRange.lengthBits); position += 1) {
    const absolute = node.bitRange.startBit + position;
    const byte = state.bytes[Math.floor(absolute / 8)];
    const value = (byte >> (7 - (absolute % 8))) & 1;
    bits.push(`<span class="bit hot" title="bit ${absolute}">${value}</span>`);
  }
  return `<div class="bit-strip">${bits.join("")}</div>`;
}

function renderMotionVectorGuide() {
  return `<details class="analysis-disclosure motion-vector-guide"><summary>Motion vector guide</summary>
    <div class="motion-guide-content">
      <p>A motion vector describes a block's prediction offset in a reference picture. The arrow starts at the current block center and shows that offset: positive X points right and positive Y points down. It does not directly measure an object's speed or its motion to the next frame.</p>
      <p><b>Units:</b> Raw values use the recorded subpixel precision. For example, (8, -16) at 1/8 pel means (+1, -2) pixels: 1 pixel right and 2 pixels up. |MV| is the displacement length in pixels.</p>
      <p><b>References:</b> MV 1 and MV 2 are the first and second prediction vectors; compound prediction can use both. Their numbers do not indicate forward or backward time. Ref identifies the recorded reference, not a frame number. Arrow colors follow the reference legend; vectors for a selected block are white.</p>
      <p><b>Display:</b> MV scale enlarges arrows without changing the reported values. Min magnitude filters by the original pixel displacement. Zero vectors and vectors with unknown precision have no arrow; intra blocks normally have no motion vectors. The Original picture layer hides all vectors.</p>
      <p><b>Statistics:</b> MV counts vectors with known precision, including zero vectors. Mean and Max use their unscaled lengths across the frame's block records; they do not count only the arrows currently visible.</p>
    </div></details>`;
}

function renderInspector(obu, node, block = null) {
  let blockHtml = null;
  const frame = obu.frameId === null ? null : state.report.frames.find(({ frameId }) => frameId === obu.frameId);
  const statisticPoint = frame ? frameStatisticsPoint(frame.frameId) : null;
  let html = `<div class="inspector-title"><span>${node ? "Syntax field" : `OBU ${obu.obuId}`}</span><h3>${escapeHtml(node?.path ?? humanType(obu.type))}</h3></div>`;
  if (block) {
    const vectors = block.mv.length
      ? block.mv.map((vector, index) => {
        const displacement = motionVectorToPixels(vector);
        const reference = block.refs[index] === undefined ? "ref —" : `ref ${block.refs[index]}`;
        const pixels = displacement
          ? ` → (${formatMotionPixels(displacement.x)}, ${formatMotionPixels(displacement.y)}) · |MV| ${formatMotionPixels(displacement.magnitude)}`
          : " → pixel displacement unavailable";
        const direction = displacement
          ? displacement.magnitude === 0 ? " · zero displacement"
            : ` · ${[
              displacement.x ? `${formatMotionPixels(Math.abs(displacement.x))} ${displacement.x > 0 ? "right" : "left"}` : null,
              displacement.y ? `${formatMotionPixels(Math.abs(displacement.y))} ${displacement.y > 0 ? "down" : "up"}` : null,
            ].filter(Boolean).join(", ")}`
          : "";
        return `MV${index + 1} ${reference}: raw (${vector.x}, ${vector.y}) ${vector.precision ?? "unknown precision"}${pixels}${direction}`;
      }).join(" / ")
      : "—";
    html = `<div class="inspector-title"><span>Block record</span><h3>Block ${block.blockId} · ${block.width}×${block.height}</h3></div><section class="property-group"><h4>Geometry & coding</h4>${propertyRows([
      ["Position", `${block.x}, ${block.y}`, true], ["Plane", String(block.plane)],
      ["Partition", unavailableInspectionValue("partition", block.partition)], ["Segment", block.segmentId], ["Skip", String(block.skip)],
      ["Mode", unavailableInspectionValue("mode", block.mode)], ["Intra mode", unavailableInspectionValue("mode", block.intraMode)], ["Inter mode", unavailableInspectionValue("mode", block.interMode)],
      ["MI position", block.miRow === null || block.miRow === undefined
        ? "—" : `${block.miColumn}, ${block.miRow}`],
      ["Reference slots", block.refs.join(", ") || "—"], ["Motion vectors", unavailableInspectionValue("motion-vector", vectors)],
      ["Compound type", block.compoundType], ["Q index", unavailableInspectionValue("qindex", block.qindex)],
      ["Q delta", unavailableInspectionValue("qindex", block.quantDelta)], ["Transform size", unavailableInspectionValue("transform", block.txSize)], ["Transform type", unavailableInspectionValue("transform", block.txType)],
      ["Non-zero coeffs", unavailableInspectionValue("coefficient", block.coeffNonZero)], ["Filter", unavailableInspectionValue("filter", block.filter)],
    ])}</section><section class="property-group"><h4>Inspection provenance</h4>${propertyRows([
      ["Producer", state.overlay?.provenance?.producer ?? "external"],
      ["Build", state.overlay?.provenance?.build ?? "—"],
      ["Inspection features", inspectionCapabilitySummary()?.label ?? "unspecified"],
    ])}</section>`;
    blockHtml = html;
  }
  if (node) {
    html += `<section class="property-group"><h4>Field value</h4>${propertyRows([
      ["Value", formatSyntaxValue(node.value), true],
      ["Coding", node.coding],
      ["Presence", node.presence],
      ["Bit range", node.bitRange ? `${node.bitRange.startBit} + ${node.bitRange.lengthBits} bits` : "inferred / no source bits"],
      ["Spec", node.specAnchor],
    ])}${renderBitStrip(node)}</section>`;
  }
  html += `<section class="property-group"><h4>Source range</h4>${propertyRows([
    ["OBU type", `${obu.type.code} / ${obu.type.name}`, true],
    ["OBU range", formatRange(obu.byteRange)],
    ["Header", formatRange(obu.headerRange)],
    ["Size field", formatRange(obu.sizeFieldRange)],
    ["Payload", formatRange(obu.payloadRange)],
    ["Syntax status", obu.syntaxStatus],
    ["Frame", frame ? `#${frame.decodeIndex} · PTS ${frame.timestamp}` : "raw stream"],
  ])}</section>`;
  if (frame) html += `<section class="property-group"><h4>Frame timing & rate</h4>${propertyRows([
    ["PTS / DTS", `${frame.pts ?? frame.timestamp} / ${frame.dts ?? "—"}`, true],
    ["Duration", statisticPoint ? `${formatDuration(statisticPoint.durationSeconds)} · ${statisticPoint.durationTicks} ticks (${statisticPoint.durationSource})` : "—"],
    ["Frame bitrate", formatBitrate(statisticPoint?.bitrateBitsPerSecond)],
    ["GOP position", statisticPoint ? `GOP ${statisticPoint.gopIndex} · ${statisticPoint.gopFrameIndex + 1}` : "—"],
    ["Random access", statisticPoint?.keyframe ? `yes · ${statisticPoint.keyframeSource}` : "no"],
  ])}</section>`;
  html += `<section class="property-group"><h4>OBU Header</h4>${propertyRows([
    ["forbidden_bit", String(obu.header.forbiddenBit)],
    ["extension_flag", String(obu.header.extensionFlag)],
    ["has_size_field", String(obu.header.hasSizeField)],
    ["temporal_id", String(obu.header.temporalId ?? "—")],
    ["spatial_id", String(obu.header.spatialId ?? "—")],
  ])}</section>`;
  if (obu.frameHeaderSummary) {
    const summary = obu.frameHeaderSummary;
    const references = [...new Set(summary.referenceFrameIds?.filter((id) => id !== null) ?? [])];
    html += `<section class="property-group"><h4>Frame Header summary</h4>${propertyRows([
      ["Frame type", summary.frameTypeName, true],
      ["Coded size", `${summary.frameWidth ?? "?"} × ${summary.frameHeight ?? "?"}`],
      ["Render size", `${summary.renderWidth ?? "?"} × ${summary.renderHeight ?? "?"}`],
      ["Refresh slots", summary.refreshFrameFlags === undefined ? "not parsed" : `0x${summary.refreshFrameFlags.toString(16).padStart(2, "0")}`],
      ["Reference slots", summary.referenceSlotIndices?.join(", ") || "—"],
      ["Reference frames", references.length ? references.map((id) => `#${id}`).join(", ") : "—"],
      ["Invalidated slots", summary.invalidatedReferenceSlots?.join(" / ") || "none"],
      ["Base Q index", summary.baseQIdx === undefined ? "not parsed" : String(summary.baseQIdx), summary.baseQIdx !== undefined],
      ["Tile layout", summary.tileCols === undefined ? "not parsed" : `${summary.tileCols} × ${summary.tileRows}`],
      ["Tile size bytes", summary.tileSizeBytes === undefined ? "not parsed" : String(summary.tileSizeBytes)],
      ["Loop filter Y/U/V", summary.loopFilterLevels?.join(" / ") ?? "not parsed"],
      ["CDEF presets", summary.cdefBits === undefined ? "not parsed" : String(1 << summary.cdefBits)],
    ])}</section><section class="property-group"><h4>Segmentation & Tiles</h4>${propertyRows([
      ["Segmentation", summarizeSegmentation(summary), Boolean(summary.segmentationEnabled)],
      ["Map / temporal / data", summary.segmentationEnabled ? `${summary.segmentationUpdateMap} / ${summary.segmentationTemporalUpdate} / ${summary.segmentationUpdateData}` : "—"],
      ["Tile spacing", summary.tileColsLog2 === undefined ? "not parsed" : summary.uniformTiles ? "uniform" : "non-uniform"],
      ["Tile widths (SB)", summary.tileWidthsSb?.join(" / ") || "—"],
      ["Tile heights (SB)", summary.tileHeightsSb?.join(" / ") || "—"],
    ])}</section><section class="property-group"><h4>Loop tools & Transform</h4>${propertyRows([
      ["Coded / all lossless", `${Boolean(summary.codedLossless)} / ${Boolean(summary.allLossless)}`],
      ["Restoration Y/U/V", summary.restorationTypes?.join(" / ") ?? "not parsed", Boolean(summary.usesLoopRestoration)],
      ["Restoration unit", summary.loopRestorationSizes?.join(" / ") || "—"],
      ["LR shift / UV shift", summary.lrUnitShift === undefined ? "not parsed" : `${summary.lrUnitShift} / ${summary.lrUvShift}`],
      ["Transform mode", summary.txMode ?? "not parsed", summary.txMode === "TX_MODE_SELECT"],
      ["Reduced transform set", String(Boolean(summary.reducedTxSet))],
    ])}</section><section class="property-group"><h4>Prediction & Global Motion</h4>${propertyRows([
      ["Reference selection", summary.referenceSelect ? "single or compound" : "single only"],
      ["Skip mode allowed", String(Boolean(summary.skipModeAllowed))],
      ["Skip mode present", String(Boolean(summary.skipModePresent)), Boolean(summary.skipModePresent)],
      ["Skip reference slots", summary.skipModeSlotIndices?.join(" / ") || "—"],
      ["Warped motion", String(Boolean(summary.allowWarpedMotion))],
      ["Global motion", summarizeGlobalMotion(summary), (summary.globalMotionTypes ?? []).some((type) => type !== "IDENTITY")],
    ])}</section><section class="property-group"><h4>Film Grain & Timing</h4>${propertyRows([
      ["Film grain", summarizeFilmGrain(summary), Boolean(summary.filmGrain?.applyGrain)],
      ["AR lag / overlap", summary.filmGrain?.applyGrain ? `${summary.filmGrain.arCoeffLag ?? "ref"} / ${summary.filmGrain.overlapFlag ?? "ref"}` : "—"],
      ["Order hint", summary.orderHint ?? "not present"],
      ["Presentation time", summary.framePresentationTime ?? "not present", summary.framePresentationTime !== null],
      ["Buffer removal", formatBufferRemovalTimes(summary), Boolean(summary.bufferRemovalTimePresent)],
    ])}</section>`;
  }
  if (obu.tileGroupSummary) {
    const summary = obu.tileGroupSummary;
    const shownTiles = summary.tiles?.slice(0, 32) ?? [];
    const tileSizes = shownTiles.map(({ tileNum, tileSize }) => `#${tileNum}: ${tileSize} B`).join(" / ");
    const remaining = (summary.tiles?.length ?? 0) - shownTiles.length;
    html += `<section class="property-group"><h4>Tile Group summary</h4>${propertyRows([
      ["Tile range", `${summary.tgStart} … ${summary.tgEnd}`, true],
      ["Frame layout", `${summary.tileCols} × ${summary.tileRows} · ${summary.numTiles} tiles`],
      ["Tiles in group", String(summary.tiles?.length ?? 0)],
      ["Header bytes", String(summary.headerByteLength)],
      ["Size-field bytes", String(summary.tileSizeBytes)],
      ["Embedded OBU_FRAME", String(Boolean(summary.embeddedFrame))],
      ["Completes frame", String(Boolean(summary.completeFrame)), Boolean(summary.completeFrame)],
      ["Frame Header OBU", summary.contextFrameHeaderObuId === null ? "—" : `OBU ${summary.contextFrameHeaderObuId}`],
      ["Tile sizes", `${tileSizes}${remaining > 0 ? ` / … +${remaining}` : ""}` || "—"],
    ])}</section>`;
  }
  if (obu.metadataSummary) {
    const metadata = obu.metadataSummary;
    const metadataDetails = metadata.metadataType === 3 ? [
      ["Scalability mode", metadata.scalabilityModeIdc],
      ["Spatial layers", metadata.spatialLayerCount],
      ["Temporal group", metadata.temporalGroupSize ?? "predefined / absent"],
    ] : metadata.metadataType === 5 ? [
      ["Counting type", metadata.timecode?.countingType],
      ["Frame count", metadata.timecode?.nFrames],
      ["Timestamp", metadata.timecode?.seconds === null ? "partial timestamp" : `${String(metadata.timecode?.hours ?? 0).padStart(2, "0")}:${String(metadata.timecode?.minutes ?? 0).padStart(2, "0")}:${String(metadata.timecode?.seconds ?? 0).padStart(2, "0")}`],
      ["Time offset", `${metadata.timecode?.timeOffsetValue ?? 0} (${metadata.timecode?.timeOffsetLength ?? 0} bits)`],
    ] : [];
    html += `<section class="property-group"><h4>Metadata summary</h4>${propertyRows([
      ["Metadata type", obu.metadataSummary.metadataTypeName, true],
      ["Type code", String(obu.metadataSummary.metadataType)],
      ["Coverage", obu.syntaxStatus],
      ...metadataDetails,
    ])}</section>`;
  }
  // Block selection has its own detail panel; unrelated OBU fields are kept
  // out of that selection context. Other sections remain available on demand.
  if (block) html = blockHtml;
  elements.inspector.innerHTML = html.replace(
    /<section class="property-group"><h4>(.*?)<\/h4>([\s\S]*?)<\/section>/g,
    (_match, title, content) => {
      const key = `${block ? "block" : node ? "syntax" : "obu"}:${title}`;
      const defaultOpen = title === "Field value" || title === "Geometry &amp; coding" || title === "Geometry & coding"
        || (!node && title === "Source range");
      const open = state.inspectorSections.get(key) ?? defaultOpen;
      return `<details class="property-group" data-inspector-section="${escapeHtml(key)}"${open ? " open" : ""}><summary>${title}</summary><div class="property-content">${content}</div></details>`;
    },
  );
  elements.inspector.querySelectorAll("[data-inspector-section]").forEach((section) => {
    section.addEventListener("toggle", () => state.inspectorSections.set(section.dataset.inspectorSection, section.open));
  });
  elements.inspector.querySelectorAll("[data-syntax-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selection = { kind: "syntax", id: Number(button.dataset.syntaxId) };
      state.selectedBlock = null;
      renderSelection();
    });
  });
  bindRovingNavigation(elements.inspector, "[data-syntax-id]", "vertical");
}

function renderDiagnostics() {
  const diagnostics = state.report.diagnostics;
  elements.diagnosticsStats.innerHTML = `<span class="stat good"><b>${state.report.summary.errorCount}</b> errors</span><span class="stat neutral"><b>${state.report.summary.warningCount}</b> warnings</span>`;
  if (diagnostics.length === 0) {
    elements.diagnosticsList.innerHTML = `<div class="diagnostic-ok"><span>✓</span> Indexing complete. No issues found.</div>`;
    return;
  }
  elements.diagnosticsList.innerHTML = diagnostics.map((item, index) => `<button type="button" class="diagnostic-row" tabindex="${index === 0 ? 0 : -1}" data-diagnostic-index="${index}" aria-label="${escapeHtml(`${item.severity} ${item.code}: ${item.message}`)}"><span class="severity ${item.severity}">${escapeHtml(item.severity)}</span><code>${escapeHtml(item.code)}</code><span class="message">${escapeHtml(item.message)}</span><span class="range">${formatRange(item.byteRange)}</span></button>`).join("");
  elements.diagnosticsList.querySelectorAll("[data-diagnostic-index]").forEach((row) => {
    const select = () => {
      const item = diagnostics[Number(row.dataset.diagnosticIndex)];
      state.selectedBlock = null;
      state.filter = "";
      elements.structureFilter.value = "";
      abortOperations("preview", "luma", "compare", "compare-preview");
      const obu = state.report.obus.find(({ obuId }) => obuId === item.obuId);
      const frameId = item.frameId ?? obu?.frameId;
      if (frameId !== null && frameId !== undefined) {
        state.selectedFrameId = frameId;
        const frame = state.report.frames.find((frame) => frame.frameId === frameId);
        state.selection = frame?.obuIds.length ? { kind: "obu", id: frame.obuIds[0] } : null;
      }
      if (obu) state.selection = { kind: "obu", id: obu.obuId };
      renderTimeline(); renderStructure(); renderSelection();
    };
    row.addEventListener("click", select);
  });
  bindRovingNavigation(elements.diagnosticsList, "[data-diagnostic-index]", "vertical");
}

function openPicker() { elements.fileInput.click(); }
function loadDemoSample() {
  const bytes = demoSampleBytes();
  void analyzeFile(new File([bytes], DEMO_SAMPLE_NAME, {
    type: "video/av1",
    lastModified: 0,
  }));
}
elements.openButton.addEventListener("click", openPicker);
elements.emptyOpenButton.addEventListener("click", openPicker);
elements.demoButton.addEventListener("click", loadDemoSample);
elements.cancelAnalysisButton.addEventListener("click", cancelBusyAnalysis);
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) analyzeFile(file);
  elements.fileInput.value = "";
});
elements.structureAllFrames.addEventListener("change", () => {
  state.showAllFrames = elements.structureAllFrames.checked;
  if (state.report && !state.snapshotOnly) renderStructure();
});
elements.previousFrame.addEventListener("click", () => moveFrame(-1));
elements.nextFrame.addEventListener("click", () => moveFrame(1));
elements.frameJumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.snapshotOnly || !state.report) return;
  const value = elements.frameJumpInput.value.trim();
  const index = Number(value);
  if (!value || !Number.isSafeInteger(index) || index < 0 || index >= state.report.frames.length) {
    showToast("Enter a valid frame number");
    return;
  }
  selectFrame(state.report.frames[index].frameId);
});
elements.diagnosticToggle.addEventListener("click", () => {
  setDiagnosticsExpanded(elements.diagnosticsList.hidden);
});
for (const menu of document.querySelectorAll(".action-menu")) {
  menu.addEventListener("click", (event) => {
    if (event.target.closest("button") && !event.target.closest("button").disabled) menu.open = false;
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  menu.addEventListener("toggle", () => {
    if (menu.open) {
      for (const other of document.querySelectorAll(".action-menu")) {
        if (other !== menu) other.open = false;
      }
    }
  });
}
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll(".action-menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
elements.structureFilter.addEventListener("input", () => {
  state.filter = elements.structureFilter.value.trim();
  if (state.report) renderStructure();
});
elements.themeButton.addEventListener("click", () => document.documentElement.classList.toggle("light"));
elements.exportButton.addEventListener("click", () => {
  if (!state.report) return;
  const blob = new Blob([`${JSON.stringify(state.report, null, 2)}\n`], { type: "application/json" });
  const stem = state.file?.name?.replace(/\.[^.]+$/, "") || "analysis";
  downloadBlob(blob, `${stem}.av1scope.json`);
  showToast("Analysis report exported");
});
elements.csvButton.addEventListener("click", () => {
  if (!state.report) return;
  const stem = state.file?.name?.replace(/\.[^.]+$/, "") || "analysis";
  let rows;
  let suffix;
  if (state.view === "compare") {
    rows = ["frame_index,pixel_count,identical,mae,mse,psnr,ssim,max_absolute_error"];
    for (const [frameIndex, record] of [...state.comparisonMetrics.entries()].sort(([left], [right]) => left - right)) {
      if (record.status !== "ready") continue;
      const value = record.value;
      rows.push(csvRow([frameIndex, value.pixelCount, value.identical, value.mae, value.mse, value.psnr ?? "inf", value.ssim, value.maximumAbsoluteError]));
    }
    suffix = "comparison";
  } else if (state.view === "frame-table") {
    rows = frameTableCsvRows(filteredFrameTableRows());
    suffix = "frames.filtered";
  } else {
    rows = timelineCsvRows(state.report.frames, state.report.frameStatistics);
    suffix = "timeline";
  }
  downloadBlob(new Blob([`${rows.join("\n")}\n`], { type: "text/csv" }), `${stem}.${suffix}.csv`);
  showToast("CSV exported");
});
elements.pngButton.addEventListener("click", async () => {
  if (state.selectedFrameId === null) return;
  elements.pngButton.disabled = true;
  try {
    const response = await fetch(`/api/preview?frame=${state.selectedFrameId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: state.bytes,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stem = state.file?.name?.replace(/\.[^.]+$/, "") || "frame";
    downloadBlob(await response.blob(), `${stem}.frame-${state.selectedFrameId}.png`);
    showToast("Current frame PNG exported");
  } catch (error) {
    showToast(`PNG export failed: ${error.message}`);
  } finally {
    elements.pngButton.disabled = false;
    applyServiceCapabilities();
  }
});
elements.overlayButton.addEventListener("click", () => elements.overlayInput.click());
elements.overlayInput.addEventListener("change", async () => {
  const [file] = elements.overlayInput.files;
  elements.overlayInput.value = "";
  if (!file || !state.report) return;
  try {
    const overlay = JSON.parse(await file.text());
    const response = await fetch("/api/validate-overlay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overlay, report: state.report }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(failure.error ?? `HTTP ${response.status}`);
    }
    state.overlay = await response.json();
    state.selectedBlock = null;
    showToast(`Imported ${state.overlay.frames.reduce((sum, frame) => sum + frame.blocks.length, 0)} block records`);
    if (state.view === "frame") renderSelection();
  } catch (error) {
    showToast(`Block import failed: ${error.message}`);
  }
});
function switchView(view) {
  if (state.view !== view) abortOperations("preview", "luma", "trace", "compare", "compare-preview", "compare-analysis");
  if (view !== "frame") {
    releaseBlockRenderer();
    state.selectedBlock = null;
  }
  state.view = view;
  if (state.snapshotOnly && state.snapshotManifest?.status === "ready") {
    renderSnapshotWorkspace(state.snapshotManifest.value);
    if (view === "frame-table" && state.snapshotPage?.collection !== "frames") {
      void loadSnapshotPage("frames", 0);
    }
    return;
  }
  if (state.report) renderSelection();
}
elements.hexTab.addEventListener("click", () => switchView("hex"));
elements.frameTab.addEventListener("click", () => switchView("frame"));
elements.overviewTab.addEventListener("click", () => switchView("overview"));
elements.frameTableTab.addEventListener("click", () => switchView("frame-table"));
elements.traceTab.addEventListener("click", () => switchView("trace"));
elements.compareTab.addEventListener("click", () => switchView("compare"));
bindRovingNavigation(document, '[role="tab"]', "horizontal");
elements.compareButton.addEventListener("click", () => elements.compareInput.click());
elements.cacheGcButton.addEventListener("click", () => {
  abortOperations("cache-gc");
  state.cacheGcPlan = null;
  elements.cacheGcApply.disabled = true;
  elements.cacheGcResults.textContent = "Click Preview plan to scan the current store. ";
  elements.cacheGcDialog.showModal();
  void previewCacheGc();
});
elements.cacheGcPreview.addEventListener("click", () => previewCacheGc());
elements.cacheGcApply.addEventListener("click", () => applyCacheGc());
elements.cacheGcAgeInput.addEventListener("input", () => {
  abortOperations("cache-gc");
  state.cacheGcPlan = null;
  elements.cacheGcApply.disabled = true;
  elements.cacheGcResults.textContent = "Age threshold changed. Preview the plan again.";
});
elements.cacheGcDialog.addEventListener("close", () => abortOperations("cache-gc"));
elements.snapshotButton.addEventListener("click", () => {
  elements.snapshotIdInput.value = "";
  elements.derivedSyntaxIdInput.value = "";
  elements.syntaxOverlayIdInput.value = "";
  elements.snapshotDialog.showModal();
  elements.snapshotIdInput.focus();
});
elements.snapshotForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const mode = event.submitter?.value;
  const input = mode === "derived"
    ? elements.derivedSyntaxIdInput
    : mode === "overlay"
      ? elements.syntaxOverlayIdInput
      : elements.snapshotIdInput;
  const value = input.value.trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    input.setCustomValidity("Enter a 64-character lowercase SHA-256 hash ID");
    input.reportValidity();
    input.setCustomValidity("");
    return;
  }
  elements.snapshotDialog.close();
  if (mode === "derived") void openDerivedSyntax(value);
  else if (mode === "overlay") void openSyntaxOverlay(value);
  else openSnapshot(value);
});
elements.snapshotSourceInput.addEventListener("change", async () => {
  const [file] = elements.snapshotSourceInput.files;
  elements.snapshotSourceInput.value = "";
  const expected = state.snapshotManifest?.value?.header?.source;
  if (!file || !expected?.fingerprint) return;
  if (file.size !== expected.size) {
    showToast(`Source size mismatch; expected ${formatBytes(expected.size)}`);
    return;
  }
  try {
    const digest = await fingerprintBrowserFile(file);
    if (digest !== expected.fingerprint.digest) {
      showToast("Source fingerprint mismatch. Attachment rejected.");
      return;
    }
    state.snapshotSourceFile = file;
    showToast(`Verified source attached: ${file.name}`);
    const selection = state.snapshotSelection;
    if (state.snapshotOnly) renderSnapshotWorkspace(state.snapshotManifest.value);
    else if (state.view === "overview") renderSelection();
    if (selection) inspectSnapshotRecord(selection.record, selection.collection);
  } catch (error) {
    showToast(`Source fingerprint failed: ${error.message}`);
  }
});
elements.compareInput.addEventListener("change", async () => {
  const [file] = elements.compareInput.files;
  elements.compareInput.value = "";
  if (!file || !state.report) return;
  if (file.size > 64 * 1024 * 1024) {
    showToast("Comparison stream exceeds the 64 MiB GUI limit");
    return;
  }
  abortOperations("compare-analysis", "compare", "compare-preview");
  const controller = replaceController("compare-analysis");
  setBusy(true, file.name, "compare-analysis");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const response = await fetch(`/api/analyze?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: response.statusText }));
      throw apiError(response, failure);
    }
    const report = await response.json();
    if (state.controllers.get("compare-analysis") !== controller) return;
    if (report.summary.frameCount === 0) throw new Error("Comparison stream has no decodable frames");
    const primary = state.report.container;
    const candidate = report.container;
    if (primary?.width && candidate?.width &&
        (primary.width !== candidate.width || primary.height !== candidate.height)) {
      throw new Error(`Dimensions differ: ${primary.width}×${primary.height} vs ${candidate.width}×${candidate.height}`);
    }
    for (const preview of state.comparisonPreviews.values()) {
      if (preview.status === "ready") {
        URL.revokeObjectURL(preview.referenceUrl);
        URL.revokeObjectURL(preview.candidateUrl);
      }
    }
    state.comparisonPreviews.clear();
    state.comparison = { file, bytes, report };
    state.comparisonMetrics.clear();
    state.view = "compare";
    renderSelection();
  } catch (error) {
    const message = analysisErrorMessage(error);
    if (message) showToast(`Failed to load comparison stream: ${message}`);
  } finally {
    if (state.controllers.get("compare-analysis") === controller) {
      state.controllers.delete("compare-analysis");
      setBusy(false);
    }
  }
});

for (const target of [document.body, elements.viewportContent]) {
  target.addEventListener("dragover", (event) => { event.preventDefault(); document.querySelector("#drop-zone")?.classList.add("dragging"); });
  target.addEventListener("dragleave", () => document.querySelector("#drop-zone")?.classList.remove("dragging"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.querySelector("#drop-zone")?.classList.remove("dragging");
    const [file] = event.dataTransfer.files;
    if (file) analyzeFile(file);
  });
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable;
  if (event.key === "Escape" && state.busyOperationKey) {
    event.preventDefault();
    cancelBusyAnalysis();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    openPicker();
    return;
  }
  if (event.key === "/" && !editing && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    elements.structureFilter.focus();
    elements.structureFilter.select();
  }
});

void loadServiceHealth();
window.__AV1SCOPE__ = {
  state,
  analyzeFile,
  indexLargeFile,
  loadSnapshotPage,
  openSnapshot,
};
