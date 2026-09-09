import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_SAMPLE_NAME, demoSampleBytes } from "../public/demo-sample.js";
import { analyzeGuiBuffer, decodeFramePreview } from "../src/gui-server.js";

test("built-in GUI demo is a structurally valid and decodable AV1 IVF", async () => {
  const bytes = demoSampleBytes();
  const report = await analyzeGuiBuffer(Buffer.from(bytes), DEMO_SAMPLE_NAME);
  assert.equal(report.source.format, "ivf");
  assert.equal(report.summary.frameCount, 1);
  assert.equal(report.summary.errorCount, 0);
  assert.ok(report.summary.obuCount > 0);
  assert.ok(report.syntaxNodes.length > 0);
  assert.equal(report.frameStatistics.frameCount, 1);
  assert.ok(report.frameStatistics.averageBitrateBitsPerSecond > 0);
  assert.equal(report.frameStatistics.gop.count, 1);

  const png = await decodeFramePreview(Buffer.from(bytes), 0);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
