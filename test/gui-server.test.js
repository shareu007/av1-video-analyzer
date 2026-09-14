import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { blockAnnotationContent, layoutBlockAnnotations } from "../public/block-annotations.js";
import { buildReferenceStateIndex, blockPredictionSources, pictureLabel, referenceBlockUsage, namedReferenceBindings, referenceUsageTone, referenceTimelineTargets } from "../public/reference-state.js";

import {
  analyzeFrameLuma,
  analyzeGuiBuffer,
  analyzeGuiJsonInWorker,
  createAnalysisGate,
  createGuiServer,
  decodeFramePreview,
  readGuiAsset,
  safeSourceName,
  startGuiServer,
} from "../src/gui-server.js";
import { makeIvf, makeObu } from "./fixtures.js";
import { parseSequenceHeader } from "../src/sequence-header-parser.js";
import { parseFrameHeaderPrefix, sequenceContextFromNodes } from "../src/frame-header-parser.js";
import { readSnapshotPage } from "../src/snapshot-store.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { writeBlockOverlaySnapshot } from "../src/block-overlay-store.js";
import { inspectSnapshotFrameWindow } from "../src/snapshot-frame-inspection.js";
import { DEMO_SAMPLE_NAME, demoSampleBytes } from "../public/demo-sample.js";
import { resolveGuiNativeWorkers } from "../src/native-worker-discovery.js";

async function invokeGuiRoute(server, url, { method = "GET", body = null, headers = {} } = {}) {
  const encodedBody = body === null ? Buffer.alloc(0) : Buffer.from(body);
  const request = Readable.from(encodedBody.length ? [encodedBody] : []);
  request.method = method;
  request.url = url;
  request.headers = {
    ...(encodedBody.length ? { "content-length": String(encodedBody.length) } : {}),
    ...headers,
  };
  const response = {
    headersSent: false,
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = "") {
      this.body += body;
    },
    destroy(error) {
      throw error;
    },
  };
  await server.listeners("request")[0](request, response);
  return response;
}

test("a failed block worker preserves the HTTP analysis report and snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-block-fallback-"));
  try {
    const server = createGuiServer({ snapshotDirectory: root,
      nativeInspectionWorkerExecutable: path.join(root, "missing-inspection-worker") });
    const response = await invokeGuiRoute(server, "/api/analyze?name=sample.ivf", {
      method: "POST", body: Buffer.from(demoSampleBytes()),
    });
    assert.equal(response.status, 200);
    const report = JSON.parse(response.body);
    assert.equal(report.summary.frameCount, 1);
    assert.ok(report.syntaxNodes.length > 0);
    assert.equal(report.blockInspection.status, "failed");
    assert.equal(report.blockInspection.code, "NATIVE_INSPECTION_SPAWN_FAILED");
    assert.equal(report.blockOverlay, undefined);
    assert.ok(report.diagnostics.some(({ code }) => code === "BLOCK_INSPECTION_FAILED"));
    assert.equal(report.summary.warningCount, report.diagnostics.filter(({ severity }) => severity === "warning").length);
    const id = response.headers["x-av1scope-snapshot-id"];
    assert.match(id, /^[0-9a-f]{64}$/);
    const saved = await readSnapshotPage(root, id, "diagnostics");
    assert.ok(saved.records.some(({ code }) => code === "BLOCK_INSPECTION_FAILED"));
    assert.equal(response.headers["x-av1scope-block-overlay-id"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("media/test streams analyze through the GUI route with real block data", async (t) => {
  const files = ["test_256x256_av1.ivf", "testsrc_256x256.ivf"];
  const pinned = new URL("../build/native-v3.12.1-golden/av1scope_inspection_worker", import.meta.url);
  try {
    await access(pinned);
    for (const name of files) await access(new URL(`../media/${name}`, import.meta.url));
  } catch {
    t.skip("local test media and pinned inspection build are not installed");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-media-blocks-"));
  try {
    const options = await resolveGuiNativeWorkers({ snapshotDirectory: root }, { environment: {} });
    assert.match(options.nativeInspectionWorkerExecutable, /native-v3\.12\.1-golden/);
    const server = createGuiServer(options);
    for (const name of files) {
      const bytes = await readFile(new URL(`../media/${name}`, import.meta.url));
      const response = await invokeGuiRoute(server, `/api/analyze?name=${name}`, { method: "POST", body: bytes });
      assert.equal(response.status, 200, `${name}: ${response.body.slice(0, 300)}`);
      const report = JSON.parse(response.body);
      assert.equal(report.summary.errorCount, 0);
      assert.equal(report.blockInspection.status, "ready");
      assert.equal(report.blockOverlay.provenance.featureFlags, 127);
      assert.equal(report.blockOverlay.provenance.producer, "libaom-inspect-v1");
      assert.equal(report.blockOverlay.frames.length, report.frames.length);
      const blocks = report.blockOverlay.frames.flatMap(({ blocks }) => blocks);
      assert.equal(report.blockInspection.blockCount, blocks.length);
      assert.ok(blocks.length > 100);
      assert.ok(blocks.some(({ mode }) => mode === "inter"));
      assert.ok(blocks.some(({ mv }) => mv.length > 0));
      const intra = blocks.find((block) => block.intraMode != null);
      assert.ok(intra);
      assert.match(blockAnnotationContent(intra, "mode").lines[0], /INTRA/);
      assert.doesNotMatch(blockAnnotationContent(intra, "mode").lines[0], /INTRA_\d|Unavailable/);
      const residual = blocks.find((block) => block.coeffNonZero > 0);
      assert.ok(residual);
      const residualContent = blockAnnotationContent(residual, "coefficients");
      assert.match(residualContent.lines[0], /^(Sparse|Medium|Dense) · [\d.]+%$/);
      assert.equal(residualContent.lines[1], `NZ ${residual.coeffNonZero} / ${residual.width * residual.height}`);
      assert.equal(residualContent.bar, residual.coeffNonZero / (residual.width * residual.height));
      const motion = blocks.find((block) => block.mv.length > 0);
      assert.match(blockAnnotationContent(motion, "motion").detail[0], /MV1 R\d: Δx .* px/);
      const referenceStates = buildReferenceStateIndex(report);
      assert.equal(referenceStates.get(0).after.length, 8);
      if (name === "test_256x256_av1.ivf") {
        const fifth = referenceStates.get(5);
        const fifthBlocks = report.blockOverlay.frames.find((frame) => frame.frameId === 5).blocks;
        const usage = referenceBlockUsage(fifthBlocks);
        assert.equal(fifth.picture.obuId, 16);
        assert.equal(pictureLabel(fifth.picture, { compact: true }), "F5·shown");
        assert.equal(usage.totalBlocks, 22);
        assert.equal(usage.interBlocks, 22);
        assert.equal(usage.unknownBlocks, 0);
        assert.deepEqual(usage.counts.slice(1), [0, 0, 0, 0, 22, 0, 0]);
        const source = fifth.bindings.find((binding) => binding.reference === 5).picture;
        assert.equal(source.obuId, 15);
        assert.equal(pictureLabel(source, { compact: true }), "F5·H1");
        const named = namedReferenceBindings(fifth);
        assert.equal(named.length, 7);
        assert.equal(named[4].name, "BWDREF_FRAME");
        assert.equal(named[4].slot, 5);
        assert.equal(named[4].picture, fifth.before[5]);
        assert.equal(named[6].name, "ALTREF_FRAME");
        assert.equal(named[6].picture, named[4].picture);
        for (const block of fifthBlocks) {
          const annotation = blockAnnotationContent(block, "mode", { referenceState: fifth });
          assert.equal(annotation.tone, "inter");
          assert.equal(annotation.lines[0], "INTER ← F5·H1");
          assert.ok(annotation.detail.includes("Same frame packet, different picture: still INTER"));
        }
        const third = referenceStates.get(3);
        assert.equal(pictureLabel(third.bindings.find((binding) => binding.reference === 1).picture, { compact: true }), "F1·H3");
        assert.equal(pictureLabel(third.bindings.find((binding) => binding.reference === 5).picture, { compact: true }), "F1·H2");
        const thirdUsage = referenceBlockUsage(report.blockOverlay.frames.find((frame) => frame.frameId === 3).blocks);
        assert.equal(thirdUsage.totalBlocks, 31);
        assert.equal(thirdUsage.counts[1], 10);
        assert.equal(thirdUsage.counts[5], 25);
        const thirdNamed = namedReferenceBindings(third);
        assert.equal(referenceUsageTone(thirdNamed.filter((entry) => entry.slot === 5), thirdUsage), "forward");
        assert.equal(referenceUsageTone(thirdNamed.filter((entry) => entry.slot === 3), thirdUsage), "backward");
        assert.equal(referenceUsageTone(thirdNamed.filter((entry) => entry.slot === 2), thirdUsage), null);
        assert.deepEqual(referenceTimelineTargets([{ frameId: 1 }], third, thirdUsage).map((entry) => [entry.direction, entry.used]), [["forward", true], ["backward", true]]);
      }
      for (const frameOverlay of report.blockOverlay.frames) {
        const block = frameOverlay.blocks.find((entry) => entry.mv.length > 0);
        if (!block) continue;
        const sources = blockPredictionSources(block, referenceStates.get(frameOverlay.frameId), report.blockOverlay);
        assert.ok(sources.length > 0);
        assert.ok(sources.every((source) => source.slot != null && source.picture?.obuId != null && source.region), `${name} F${frameOverlay.frameId}: source mapping must resolve`);
      }
      for (const layer of ["mode", "coefficients", "motion"]) {
        const labels = layoutBlockAnnotations(report.blockOverlay.frames[0].blocks, { layer, width: 256, height: 256, bounds: { width: 1024, height: 1024 } });
        assert.ok(labels.length > 0, `${name}: ${layer} should have readable labels at 400%`);
      }
      assert.ok(blocks.every(({ width, height, x, y }) => width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 256 && y + height <= 256));
      const overlayId = response.headers["x-av1scope-block-overlay-id"];
      assert.match(overlayId, /^[0-9a-f]{64}$/);
      const stored = await invokeGuiRoute(server, `/api/block-overlays/${overlayId}/blocks?offset=0&limit=10`);
      assert.equal(stored.status, 200);
      assert.equal(JSON.parse(stored.body).total, blocks.length);
      const png = await decodeFramePreview(bytes, 0, { ffmpegPath: options.ffmpegPath });
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      t.diagnostic(`${name}: ${report.frames.length} frames, ${blocks.length} real blocks, preview and stored overlay verified`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI workspace assets include the primary analysis surfaces", async () => {
  const [html, css, javascript, renderer, blockStatistics, traceCompare, keyboardNavigation] = await Promise.all([
    readGuiAsset("index.html"),
    readGuiAsset("styles.css"),
    readGuiAsset("app.js"),
    readGuiAsset("block-renderer.js"),
    readGuiAsset("block-statistics.js"),
    readGuiAsset("trace-compare.js"),
    readGuiAsset("keyboard-navigation.js"),
  ]);
  assert.match(html, /AV1Scope/);
  assert.match(html, /Bitstream structure/);
  assert.match(html, /Frame timeline/);
  assert.match(html, /Field inspector/);
  assert.match(html, /Diagnostics/);
  assert.match(html, /Export JSON/);
  assert.match(html, /Export CSV/);
  assert.match(html, /Export frame PNG/);
  assert.match(html, /FFmpeg Trace/);
  assert.match(html, /Quality comparison/);
  assert.match(html, /Open snapshot/);
  assert.match(html, /Derived Syntax ID/);
  assert.match(html, /Syntax Overlay ID/);
  assert.match(html, /Storage maintenance/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /id="cancel-analysis-button"/);
  assert.match(html, /id="service-status"/);
  assert.match(html, /id="demo-button"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="snapshot-dialog-title"/);
  assert.match(css, /\.hex-view/);
  assert.match(css, /\.frame-card/);
  assert.match(css, /\.superblock-grid/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /forced-colors/);
  assert.match(css, /max-width: 700px/);
  assert.match(javascript, /\/api\/analyze/);
  assert.match(javascript, /replaceController\("analysis"\)/);
  assert.match(javascript, /cancelBusyAnalysis/);
  assert.match(javascript, /loadServiceHealth/);
  assert.match(javascript, /loadDemoSample/);
  assert.match(javascript, /indexLargeFile/);
  assert.match(javascript, /\/api\/index/);
  assert.match(javascript, /ANALYSIS_CAPACITY_EXHAUSTED/);
  assert.match(javascript, /loadSnapshotPage/);
  assert.match(javascript, /openSnapshot/);
  assert.match(javascript, /\/api\/snapshots\//);
  assert.match(javascript, /loadSnapshotSyntaxInspection/);
  assert.match(javascript, /\/inspect\/\$\{record\.obuId\}/);
  assert.match(javascript, /openDerivedSyntax/);
  assert.match(javascript, /\/api\/derived-syntax\//);
  assert.match(javascript, /buildSyntaxOverlay/);
  assert.match(javascript, /openSyntaxOverlay/);
  assert.match(javascript, /\/api\/syntax-overlays\//);
  assert.match(javascript, /\/api\/cache-gc/);
  assert.match(javascript, /\/query/);
  assert.match(css, /\.derived-syntax-reference/);
  assert.match(css, /\.derived-syntax-list/);
  assert.match(css, /\.snapshot-records/);
  assert.match(javascript, /renderInspector/);
  assert.match(javascript, /Compound type/u);
  assert.match(javascript, /Q delta/u);
  assert.match(javascript, /Analysis provenance/);
  assert.match(javascript, /Adapter version/);
  assert.match(javascript, /Container demux/);
  assert.match(javascript, /Worker sandbox/);
  assert.match(javascript, /Worker SHA-256/);
  assert.match(javascript, /Average bitrate/);
  assert.match(javascript, /Peak rolling bitrate/);
  assert.match(javascript, /GOP details/);
  assert.match(javascript, /Frame timing & rate/);
  assert.match(javascript, /blockInspection: value\.blockInspection/);
  assert.match(javascript, /partial inspection · missing/);
  assert.match(javascript, /unavailableInspectionValue/);
  assert.match(javascript, /Motion vectors/);
  assert.match(javascript, /pixel displacement unavailable/);
  assert.match(javascript, /Block statistics · luma/);
  assert.match(javascript, /block-filter/);
  assert.match(javascript, /timelineCsvRows/);
  assert.match(css, /\.gop-summary/);
  assert.match(javascript, /bindRovingNavigation/);
  assert.match(javascript, /setBusy/);
  assert.match(javascript, /referenceFrameIds/);
  assert.match(javascript, /use_128x128_superblock/);
  assert.match(javascript, /compare-frame/);
  assert.match(javascript, /csvRow/);
  assert.match(renderer, /drawArraysInstanced/);
  assert.match(renderer, /buildMotionVectorInstanceData/);
  assert.match(renderer, /u_css_pixel/);
  assert.match(blockStatistics, /calculateRectangleCoverage/);
  assert.match(blockStatistics, /filterBlockRecords/);
  assert.match(blockStatistics, /summarizeMotionVectors/);
  assert.match(traceCompare, /buildNativeTraceFieldMap/);
  assert.match(keyboardNavigation, /nextNavigationIndex/);
});

test("GUI analysis core returns the same versioned report", async () => {
  const sequenceHeader = makeObu({
    type: 1,
    payload: Buffer.from("180cffda0080", "hex"),
  });
  const input = makeIvf([{ payload: sequenceHeader, timestamp: 9n }]);
  const report = await analyzeGuiBuffer(input, "sample.ivf");

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.source.name, "sample.ivf");
  assert.equal(report.summary.frameCount, 1);
  assert.equal(report.summary.obuCount, 1);
  assert.equal(report.syntaxNodes.length, 29);
  assert.equal(report.obus[0].syntaxStatus, "complete");
  assert.equal(report.frameStatistics.schemaVersion, "av1scope.frame-statistics.v1");
  assert.equal(report.frameStatistics.frameCount, 1);
  assert.equal(report.frameStatistics.timingMode, "partially-defaulted");
  assert.ok(Math.abs(report.frameStatistics.durationSeconds - 1 / 30) < 1e-12);
  assert.equal(report.frameStatistics.gop.count, 1);
});

test("GUI analysis worker returns a serialized versioned report", async () => {
  const sequenceHeader = makeObu({
    type: 1,
    payload: Buffer.from("180cffda0080", "hex"),
  });
  const input = makeIvf([{ payload: sequenceHeader, timestamp: 9n }]);
  const report = JSON.parse(await analyzeGuiJsonInWorker(input, "worker.ivf"));

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.source.name, "worker.ivf");
  assert.equal(report.summary.frameCount, 1);
  assert.equal(report.syntaxNodes.length, 29);
  assert.equal(report.frameStatistics.schemaVersion, "av1scope.frame-statistics.v1");
  assert.equal(report.frameStatistics.frameCount, 1);
});

test("GUI analysis worker can atomically persist a pageable snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-snapshots-"));
  try {
    const sequenceHeader = makeObu({
      type: 1,
      payload: Buffer.from("180cffda0080", "hex"),
    });
    const input = makeIvf([{ payload: sequenceHeader, timestamp: 9n }]);
    const result = await analyzeGuiJsonInWorker(input, "snapshot.ivf", {
      snapshotDirectory: root,
      returnDetails: true,
    });

    assert.equal(JSON.parse(result.json).source.name, "snapshot.ivf");
    assert.match(result.snapshot.snapshotId, /^[0-9a-f]{64}$/);
    const page = await readSnapshotPage(root, result.snapshot.snapshotId, "frames");
    assert.equal(page.total, 1);
    assert.equal(page.records[0].timestamp, "9");

    const server = createGuiServer({ snapshotDirectory: root });
    const manifestResponse = await invokeGuiRoute(
      server, `/api/snapshots/${result.snapshot.snapshotId}/manifest`,
    );
    assert.equal(manifestResponse.status, 200);
    assert.equal(JSON.parse(manifestResponse.body).snapshotId, result.snapshot.snapshotId);
    const pageResponse = await invokeGuiRoute(
      server, `/api/snapshots/${result.snapshot.snapshotId}/frames?offset=0&limit=1`,
    );
    assert.equal(pageResponse.status, 200);
    assert.equal(JSON.parse(pageResponse.body).records[0].timestamp, "9");
    const invalidResponse = await invokeGuiRoute(
      server, `/api/snapshots/${result.snapshot.snapshotId}/frames?offset=-1`,
    );
    assert.equal(invalidResponse.status, 400);
    const missingResponse = await invokeGuiRoute(
      server, `/api/snapshots/${"0".repeat(64)}/manifest`,
    );
    assert.equal(missingResponse.status, 404);
    assert.equal(JSON.parse(missingResponse.body).code, "SNAPSHOT_NOT_FOUND");
    const queryResponse = await invokeGuiRoute(
      server, `/api/snapshots/${result.snapshot.snapshotId}/query`, {
        method: "POST",
        body: JSON.stringify({
          collection: "obus",
          filter: { path: "type.code", op: "eq", value: 1 },
          projection: ["obuId", "type.name"],
          limit: 10,
        }),
      },
    );
    assert.equal(queryResponse.status, 200);
    const query = JSON.parse(queryResponse.body);
    assert.equal(query.kind, "av1scope-snapshot-query-page");
    assert.deepEqual(query.records[0].record, { obuId: 0, "type.name": "sequence_header" });
    const invalidQueryResponse = await invokeGuiRoute(
      server, `/api/snapshots/${result.snapshot.snapshotId}/query`, {
        method: "POST",
        body: JSON.stringify({
          collection: "obus",
          filter: { path: "__proto__.polluted", op: "eq", value: true },
        }),
      },
    );
    assert.equal(invalidQueryResponse.status, 400);
    assert.equal(JSON.parse(invalidQueryResponse.body).code, "SNAPSHOT_QUERY_INVALID");

    const obuPage = await readSnapshotPage(root, result.snapshot.snapshotId, "obus");
    const sequenceRecord = obuPage.records[0];
    const payload = input.subarray(
      sequenceRecord.payloadRange.start,
      sequenceRecord.payloadRange.start + sequenceRecord.payloadRange.length,
    );
    const inspectionResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/inspect/${sequenceRecord.obuId}`,
      {
        method: "POST",
        body: JSON.stringify({ payload: payload.toString("base64") }),
      },
    );
    assert.equal(inspectionResponse.status, 200);
    const inspection = JSON.parse(inspectionResponse.body);
    assert.equal(inspection.status, "complete");
    assert.equal(inspection.nodes[0].bitRange.startBit, sequenceRecord.payloadRange.start * 8);
    assert.match(inspection.derivedSnapshot.id, /^[0-9a-f]{64}$/);
    assert.equal(inspection.derivedSnapshot.created, true);
    const replayResponse = await invokeGuiRoute(
      server, `/api/derived-syntax/${inspection.derivedSnapshot.id}`,
    );
    assert.equal(replayResponse.status, 200);
    const replay = JSON.parse(replayResponse.body);
    assert.equal(replay.parentSnapshotId, result.snapshot.snapshotId);
    assert.deepEqual(replay.inspection.nodes, inspection.nodes);
    const reusedResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/inspect/${sequenceRecord.obuId}`,
      {
        method: "POST",
        body: JSON.stringify({ payload: payload.toString("base64") }),
      },
    );
    assert.equal(JSON.parse(reusedResponse.body).derivedSnapshot.created, false);
    const derivedPageResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/derived-syntax?offset=0&limit=10`,
    );
    assert.equal(derivedPageResponse.status, 200);
    const derivedPage = JSON.parse(derivedPageResponse.body);
    assert.equal(derivedPage.total, 1);
    assert.equal(derivedPage.records[0].derivedSnapshotId, inspection.derivedSnapshot.id);
    const overlayResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/syntax-overlays`,
      {
        method: "POST",
        body: JSON.stringify({
          derivedSnapshotIds: [inspection.derivedSnapshot.id],
        }),
      },
    );
    assert.equal(overlayResponse.status, 200);
    const overlay = JSON.parse(overlayResponse.body);
    assert.match(overlay.overlaySnapshotId, /^[0-9a-f]{64}$/);
    assert.equal(overlay.summary.coveredObuCount, 1);
    assert.equal(overlay.collections.syntaxNodes.count, inspection.nodes.length);
    const overlayReplayResponse = await invokeGuiRoute(
      server, `/api/syntax-overlays/${overlay.overlaySnapshotId}`,
    );
    assert.equal(overlayReplayResponse.status, 200);
    const overlayReplay = JSON.parse(overlayReplayResponse.body);
    assert.equal(overlayReplay.syntaxNodes.length, inspection.nodes.length);
    const overlayManifestResponse = await invokeGuiRoute(
      server, `/api/syntax-overlays/${overlay.overlaySnapshotId}/manifest`,
    );
    assert.equal(overlayManifestResponse.status, 200);
    assert.equal(JSON.parse(overlayManifestResponse.body).syntaxNodes, undefined);
    const overlayPageResponse = await invokeGuiRoute(
      server, `/api/syntax-overlays/${overlay.overlaySnapshotId}/syntaxNodes?offset=0&limit=2`,
    );
    const overlayPage = JSON.parse(overlayPageResponse.body);
    assert.equal(overlayPage.records.length, 2);
    assert.equal(overlayPage.total, inspection.nodes.length);
    const overlayConflictResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/syntax-overlays`,
      {
        method: "POST",
        body: JSON.stringify({
          derivedSnapshotIds: [inspection.derivedSnapshot.id, inspection.derivedSnapshot.id],
        }),
      },
    );
    assert.equal(overlayConflictResponse.status, 409);
    assert.equal(JSON.parse(overlayConflictResponse.body).code, "SYNTAX_OVERLAY_CONFLICT");

    const pending = path.join(
      root, "syntax-overlays", ".pending.7.77777777-7777-4777-8777-777777777777.tmp",
    );
    await mkdir(pending);
    const gcPreviewResponse = await invokeGuiRoute(
      server, "/api/cache-gc?minimumAgeMs=0",
    );
    assert.equal(gcPreviewResponse.status, 200);
    const gcPreview = JSON.parse(gcPreviewResponse.body);
    assert.equal(gcPreview.mode, "dry-run");
    assert.equal(gcPreview.summary.candidateCount, 1);
    const staleGcResponse = await invokeGuiRoute(server, "/api/cache-gc", {
      method: "POST",
      body: JSON.stringify({ minimumAgeMs: 0, planId: "0".repeat(64) }),
    });
    assert.equal(staleGcResponse.status, 409);
    assert.equal(JSON.parse(staleGcResponse.body).code, "CACHE_GC_PLAN_STALE");
    await access(pending);
    const gcApplyResponse = await invokeGuiRoute(server, "/api/cache-gc", {
      method: "POST",
      body: JSON.stringify({ minimumAgeMs: 0, planId: gcPreview.planId }),
    });
    assert.equal(gcApplyResponse.status, 200);
    assert.equal(JSON.parse(gcApplyResponse.body).removedCount, 1);
    await assert.rejects(access(pending), /ENOENT/);

    const incompleteResponse = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/inspect/${sequenceRecord.obuId}`,
      { method: "POST", body: JSON.stringify({ payload: payload.subarray(0, 1).toString("base64") }) },
    );
    assert.equal(incompleteResponse.status, 400);
    assert.equal(
      JSON.parse(incompleteResponse.body).code,
      "SNAPSHOT_INSPECTION_PAYLOAD_INCOMPLETE",
    );
    const missingDerivedResponse = await invokeGuiRoute(
      server, `/api/derived-syntax/${"f".repeat(64)}`,
    );
    assert.equal(missingDerivedResponse.status, 404);
    assert.equal(JSON.parse(missingDerivedResponse.body).code, "DERIVED_SYNTAX_NOT_FOUND");
    server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI snapshot API binds standalone Tile Group to Sequence and Frame Header payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-tile-snapshot-"));
  try {
    const ivf = Buffer.from(
      "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
      "base64",
    );
    const source = await analyzeGuiBuffer(ivf, "source.ivf");
    const sourceSequence = source.obus.find(({ type }) => type.code === 1);
    const sourceFrame = source.obus.find(({ type }) => type.code === 6);
    const sourcePayload = (record) => ivf.subarray(
      record.payloadRange.start, record.payloadRange.start + record.payloadRange.length,
    );
    const sequenceSyntax = parseSequenceHeader(sourcePayload(sourceSequence), {
      ...sourceSequence, payloadRange: { start: 0, length: sourcePayload(sourceSequence).length },
    });
    const frameSyntax = parseFrameHeaderPrefix(sourcePayload(sourceFrame), {
      ...sourceFrame, payloadRange: { start: 0, length: sourcePayload(sourceFrame).length },
    }, sequenceContextFromNodes(sequenceSyntax.nodes), { referenceSlots: Array(8).fill(null) });
    const headerBytes = Math.ceil(frameSyntax.parsedBitLength / 8);
    const input = Buffer.concat([
      makeObu({ type: 1, payload: sourcePayload(sourceSequence) }),
      makeObu({ type: 3, payload: sourcePayload(sourceFrame).subarray(0, headerBytes) }),
      makeObu({ type: 4, payload: sourcePayload(sourceFrame).subarray(headerBytes) }),
    ]);
    const result = await analyzeGuiJsonInWorker(input, "tile-group.obu", {
      snapshotDirectory: root,
      returnDetails: true,
    });
    const obus = (await readSnapshotPage(
      root, result.snapshot.snapshotId, "obus", { limit: 10 },
    )).records;
    const sequence = obus.find(({ type }) => type.code === 1);
    const frameHeader = obus.find(({ type }) => type.code === 3);
    const tileGroup = obus.find(({ type }) => type.code === 4);
    const payload = (record) => input.subarray(
      record.payloadRange.start, record.payloadRange.start + record.payloadRange.length,
    );
    const server = createGuiServer({ snapshotDirectory: root });
    const response = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/inspect/${tileGroup.obuId}`,
      {
        method: "POST",
        body: JSON.stringify({
          payload: payload(tileGroup).toString("base64"),
          sequenceObuId: sequence.obuId,
          sequencePayload: payload(sequence).toString("base64"),
          frameHeaderObuId: frameHeader.obuId,
          frameHeaderPayload: payload(frameHeader).toString("base64"),
        }),
      },
    );
    assert.equal(response.status, 200);
    const inspection = JSON.parse(response.body);
    assert.equal(inspection.summary.kind, "tile_group");
    assert.equal(inspection.summary.contextFrameHeaderObuId, frameHeader.obuId);
    const replayResponse = await invokeGuiRoute(
      server, `/api/derived-syntax/${inspection.derivedSnapshot.id}`,
    );
    const replay = JSON.parse(replayResponse.body);
    assert.equal(replay.request.frameHeaderContext.obuId, frameHeader.obuId);

    const missingContext = await invokeGuiRoute(
      server,
      `/api/snapshots/${result.snapshot.snapshotId}/inspect/${tileGroup.obuId}`,
      {
        method: "POST",
        body: JSON.stringify({ payload: payload(tileGroup).toString("base64") }),
      },
    );
    assert.equal(missingContext.status, 400);
    assert.equal(JSON.parse(missingContext.body).code, "SNAPSHOT_INSPECTION_CONTEXT_INVALID");
    server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI analysis worker rejects a request cancelled before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    analyzeGuiJsonInWorker(Buffer.from("not-video"), "cancelled.obu", {
      signal: controller.signal,
    }),
    (error) => error.message === "analysis cancelled"
      && error.code === "ANALYSIS_CANCELLED"
      && error.statusCode === 499,
  );
});

test("GUI analysis worker receives cancellation while work is active", async () => {
  let instance = null;
  class PendingWorker extends EventEmitter {
    constructor() {
      super();
      this.messages = [];
      instance = this;
    }

    postMessage(message) {
      this.messages.push(message);
    }

    terminate() {
      this.terminationCount = (this.terminationCount ?? 0) + 1;
      return Promise.resolve(0);
    }
  }

  const controller = new AbortController();
  const pending = analyzeGuiJsonInWorker(Buffer.from("work"), "active.obu", {
    signal: controller.signal,
    WorkerClass: PendingWorker,
  });
  controller.abort();

  await assert.rejects(pending, /analysis cancelled/);
  assert.deepEqual(instance.messages, [{ type: "abort" }]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(instance.terminationCount, 1);
});

test("GUI analysis route cancels disconnected work and releases gate capacity", async () => {
  let analysisStarted;
  const started = new Promise((resolve) => {
    analysisStarted = resolve;
  });
  const analyzeInWorker = (_input, _name, { signal }) => new Promise((_resolve, reject) => {
    analysisStarted();
    signal.addEventListener("abort", () => {
      const error = new Error("analysis cancelled");
      error.code = "ANALYSIS_CANCELLED";
      error.statusCode = 499;
      reject(error);
    }, { once: true });
  });
  const server = createGuiServer({ maxConcurrentAnalyses: 1, analyzeInWorker });
  const request = Readable.from([Buffer.from("work")]);
  request.method = "POST";
  request.url = "/api/analyze?name=cancelled.obu";
  request.headers = { "content-length": "4" };
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    status: null,
    headers: null,
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = "") {
      this.body += body;
      this.writableEnded = true;
    },
    destroy(error) {
      throw error;
    },
  });

  const route = server.listeners("request")[0](request, response);
  await started;
  const busyHealth = await invokeGuiRoute(server, "/api/health");
  assert.equal(JSON.parse(busyHealth.body).analysisWorkers.active, 1);
  request.emit("aborted");
  await route;

  assert.equal(response.status, 499);
  assert.equal(JSON.parse(response.body).code, "ANALYSIS_CANCELLED");
  const idleHealth = await invokeGuiRoute(server, "/api/health");
  assert.equal(JSON.parse(idleHealth.body).analysisWorkers.active, 0);
  server.close();
});

test("GUI analysis worker exposes a structured deadline error", async () => {
  class PendingWorker extends EventEmitter {
    postMessage() {}
    terminate() {
      return Promise.resolve(0);
    }
  }

  await assert.rejects(
    analyzeGuiJsonInWorker(Buffer.from("work"), "timeout.obu", {
      timeoutMs: 5,
      WorkerClass: PendingWorker,
    }),
    (error) => error.code === "ANALYSIS_TIMEOUT" && error.statusCode === 504,
  );
});

test("GUI analysis gate bounds worker concurrency and releases capacity", async () => {
  const gate = createAnalysisGate(1);
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const first = gate.run(() => blocker);

  assert.equal(gate.active, 1);
  await assert.rejects(
    gate.run(() => Promise.resolve("second")),
    (error) => error.statusCode === 429 && error.code === "ANALYSIS_CAPACITY_EXHAUSTED",
  );
  release("first");
  assert.equal(await first, "first");
  assert.equal(gate.active, 0);
  assert.equal(await gate.run(() => Promise.resolve("next")), "next");
});

test("GUI strips uploaded path components and control bytes", () => {
  assert.equal(safeSourceName("../../private/sample.obu"), "sample.obu");
  assert.equal(safeSourceName("folder/%00bad.ivf"), "bad.ivf");
  assert.equal(safeSourceName("%2E%2E%2Fsecret%2Fclip.ivf"), "clip.ivf");
  assert.equal(safeSourceName("%zz"), "upload.obu");
});

test("GUI server is constructible without starting a listener", () => {
  const server = createGuiServer();
  assert.equal(server.listening, false);
  server.close();
});

test("GUI health exposes startup capabilities", async () => {
  const preflight = {
    schemaVersion: "gui-preflight-v1",
    ok: true,
    status: "degraded",
    capabilities: {
      structuralAnalysis: true,
      containerAnalysis: false,
      framePreview: false,
      headerTrace: false,
      pixelComparison: false,
      snapshotStore: false,
      nativeDemux: false,
    },
    checks: [],
  };
  const server = createGuiServer({ preflight });
  const response = await invokeGuiRoute(server, "/api/health");
  const health = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(health.preflight.status, "degraded");
  assert.equal(health.capabilities.framePreview, false);
  assert.equal(health.blockInspection.enabled, false);
  server.close();
});

test("GUI health exposes configured native block inspection", async () => {
  const server = createGuiServer({
    nativeInspectionWorkerExecutable: "/fixed/native-inspection-worker",
  });
  const response = await invokeGuiRoute(server, "/api/health");
  const health = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.deepEqual(health.blockInspection, {
    enabled: true,
    implementation: "av1scope-native-inspection-worker-v2",
    isolatedProcess: true,
  });
  server.close();
});

test("GUI exposes persisted Block Overlay manifests and paged records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-block-overlay-"));
  try {
    const report = await analyzeGuiBuffer(Buffer.from(demoSampleBytes()), "demo.ivf");
    const parent = await writeReportSnapshot(report, root);
    const stored = await writeBlockOverlaySnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      overlay: {
        schemaVersion: 1,
        provenance: { producer: "gui-route-test", build: "fixed" },
        frames: [{ frameId: 0, blocks: [{
          x: 0, y: 0, width: 16, height: 16,
          mode: "intra", partition: "none", qindex: 255,
        }] }],
      },
    });
    const server = createGuiServer({ snapshotDirectory: root });
    const list = await invokeGuiRoute(server, `/api/snapshots/${parent.snapshotId}/block-overlays`);
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body).overlays.map(({ blockOverlaySnapshotId }) => (
      blockOverlaySnapshotId
    )), [stored.blockOverlaySnapshotId]);
    const manifest = await invokeGuiRoute(
      server, `/api/block-overlays/${stored.blockOverlaySnapshotId}/manifest`,
    );
    assert.equal(JSON.parse(manifest.body).summary.blockCount, 1);
    const blocks = await invokeGuiRoute(
      server, `/api/block-overlays/${stored.blockOverlaySnapshotId}/blocks?offset=0&limit=1`,
    );
    assert.equal(JSON.parse(blocks.body).records[0].qindex, 255);
    server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI plans and persists a source-bound snapshot frame inspection window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-frame-inspection-"));
  try {
    const bytes = Buffer.from(demoSampleBytes());
    const analyzed = await analyzeGuiBuffer(bytes, DEMO_SAMPLE_NAME);
    const fingerprint = "b".repeat(64);
    const report = {
      ...analyzed,
      source: {
        ...analyzed.source,
        fingerprint: { algorithm: "test", digest: fingerprint },
      },
    };
    const parent = await writeReportSnapshot(report, root);
    const frame = report.frames[0];
    const payload = bytes.subarray(
      frame.payloadRange.start,
      frame.payloadRange.start + frame.payloadRange.length,
    );
    const server = createGuiServer({
      snapshotDirectory: root,
      nativeInspectionWorkerExecutable: "/fixed/mock-inspection-worker",
      inspectSnapshotFrame: (directory, snapshotId, frameId, input, options) => (
        inspectSnapshotFrameWindow(directory, snapshotId, frameId, input, {
          ...options,
          inspectFrames: async (_input, localReport) => ({
            schemaVersion: 1,
            provenance: { producer: "gui-window-test", build: "fixed" },
            frames: localReport.frames.map(({ frameId: localFrameId }) => ({
              frameId: localFrameId,
              blocks: [{
                x: 0, y: 0, width: 16, height: 16,
                mode: "intra", partition: "none", qindex: 255,
              }],
            })),
          }),
        })
      ),
    });
    const endpoint = `/api/snapshots/${parent.snapshotId}/inspect-frames/0`;
    const planned = await invokeGuiRoute(server, endpoint);
    assert.equal(planned.status, 200);
    assert.equal(JSON.parse(planned.body).inputByteLength, payload.length);

    const rejected = await invokeGuiRoute(server, endpoint, { method: "POST", body: payload });
    assert.equal(rejected.status, 409);
    assert.equal(JSON.parse(rejected.body).code, "SNAPSHOT_SOURCE_FINGERPRINT_MISMATCH");

    const inspected = await invokeGuiRoute(server, endpoint, {
      method: "POST",
      body: payload,
      headers: { "x-av1scope-source-fingerprint": fingerprint },
    });
    assert.equal(inspected.status, 201);
    const result = JSON.parse(inspected.body);
    assert.equal(result.summary.frameCount, 1);
    assert.equal(result.summary.blockCount, 1);
    assert.match(result.blockOverlaySnapshotId, /^[0-9a-f]{64}$/u);
    server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI streams an uploaded file into a reusable snapshot without retaining upload staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-index-route-"));
  const uploadRoot = path.join(root, "uploads");
  await mkdir(uploadRoot);
  try {
    const bytes = demoSampleBytes();
    const server = createGuiServer({
      snapshotDirectory: root,
      temporaryDirectory: uploadRoot,
    });
    const first = await invokeGuiRoute(
      server,
      `/api/index?name=${encodeURIComponent(DEMO_SAMPLE_NAME)}`,
      { method: "POST", body: bytes },
    );
    assert.equal(first.status, 201);
    const created = JSON.parse(first.body);
    assert.equal(created.kind, "av1scope-streaming-index");
    assert.equal(created.created, true);
    assert.equal(created.source.name, DEMO_SAMPLE_NAME);
    assert.equal(created.summary.frameCount, 1);
    assert.match(created.snapshotId, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readdir(uploadRoot), []);

    const repeated = await invokeGuiRoute(
      server,
      `/api/index?name=${encodeURIComponent(DEMO_SAMPLE_NAME)}`,
      { method: "POST", body: bytes },
    );
    assert.equal(repeated.status, 200);
    assert.equal(JSON.parse(repeated.body).created, false);

    const health = JSON.parse((await invokeGuiRoute(server, "/api/health")).body);
    assert.equal(health.indexWorkers.active, 0);
    assert.equal(health.indexWorkers.limit, 1);
    server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI streaming index cancellation releases capacity and removes upload staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-index-cancel-"));
  const uploadRoot = path.join(root, "uploads");
  await mkdir(uploadRoot);
  let indexingStarted;
  const started = new Promise((resolve) => {
    indexingStarted = resolve;
  });
  const indexFileToSnapshot = (_inputPath, _name, { signal }) => new Promise((_resolve, reject) => {
    indexingStarted();
    signal.addEventListener("abort", () => {
      const error = new Error("streaming index cancelled");
      error.code = "INDEX_CANCELLED";
      error.statusCode = 499;
      reject(error);
    }, { once: true });
  });
  const server = createGuiServer({
    snapshotDirectory: root,
    temporaryDirectory: uploadRoot,
    indexFileToSnapshot,
  });
  const request = Readable.from([Buffer.from(demoSampleBytes())]);
  request.method = "POST";
  request.url = `/api/index?name=${encodeURIComponent(DEMO_SAMPLE_NAME)}`;
  request.headers = { "content-length": String(demoSampleBytes().length) };
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    status: null,
    body: "",
    writableEnded: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body = "") {
      this.body += body;
      this.writableEnded = true;
    },
    destroy(error) {
      throw error;
    },
  });
  try {
    const route = server.listeners("request")[0](request, response);
    await started;
    request.emit("aborted");
    await route;
    assert.equal(response.status, 499);
    assert.equal(JSON.parse(response.body).code, "INDEX_CANCELLED");
    assert.deepEqual(await readdir(uploadRoot), []);
    const health = JSON.parse((await invokeGuiRoute(server, "/api/health")).body);
    assert.equal(health.indexWorkers.active, 0);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI streaming index requires a store and enforces its upload limit", async () => {
  const disabled = createGuiServer();
  const disabledResponse = await invokeGuiRoute(disabled, "/api/index?name=sample.ivf", {
    method: "POST",
    body: demoSampleBytes(),
  });
  assert.equal(disabledResponse.status, 409);
  assert.equal(JSON.parse(disabledResponse.body).code, "SNAPSHOT_STORE_DISABLED");
  disabled.close();

  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-index-limit-"));
  try {
    const limited = createGuiServer({ snapshotDirectory: root, streamUploadLimitBytes: 8 });
    const response = await invokeGuiRoute(limited, "/api/index?name=sample.ivf", {
      method: "POST",
      body: demoSampleBytes(),
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).code, "INDEX_UPLOAD_TOO_LARGE");
    limited.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI server rejects failed preflight before opening a listener", async () => {
  const preflight = {
    ok: false,
    checks: [{
      id: "public-assets",
      required: true,
      ok: false,
      status: "error",
      message: "required GUI asset is missing",
    }],
  };
  await assert.rejects(
    startGuiServer({ preflight }),
    /GUI preflight failed: public-assets: required GUI asset is missing/,
  );
});

test("GUI decodes a bounded PNG preview through FFmpeg", async () => {
  const input = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const png = await decodeFramePreview(input, 0);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 50);
});

test("GUI preview reports an unavailable frame", async () => {
  const input = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  await assert.rejects(decodeFramePreview(input, 5), /produced no preview|exited with code/);
});

test("GUI preview accepts cancellation before spawning useful work", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decodeFramePreview(Buffer.from("not-video"), 0, { signal: controller.signal }),
    /cancelled/,
  );
});

test("GUI computes bounded frame luma statistics", async () => {
  const input = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const stats = await analyzeFrameLuma(input, 0);
  assert.equal(stats.sampleCount, 256);
  assert.equal(stats.histogram.reduce((sum, count) => sum + count, 0), 256);
  assert.ok(stats.minimum >= 0 && stats.maximum <= 255);
  assert.ok(Number.isFinite(stats.mean));
  assert.ok(Number.isFinite(stats.standardDeviation));
});
