import assert from "node:assert/strict";
import test from "node:test";

import { parseHeaderTrace, traceAv1Headers } from "../src/header-trace.js";

test("parses FFmpeg trace_headers fields and packet association", () => {
  const entries = parseHeaderTrace(`
[trace_headers @ 0x1] Packet: 100 bytes, key frame, pts 0.
[trace_headers @ 0x1] Frame Header
[trace_headers @ 0x1] 24          show_existing_frame                                         0 = 0
[trace_headers @ 0x1] 43          base_q_idx                                           01010111 = 87
`);
  assert.deepEqual(entries.map(({ frameIndex, name, value }) => [frameIndex, name, value]), [
    [0, "show_existing_frame", 0],
    [0, "base_q_idx", 87],
  ]);
});

test("runs FFmpeg AV1 header trace on a bounded fixture", async () => {
  const input = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const trace = await traceAv1Headers(input);
  assert.equal(trace.provenance.producer, "ffmpeg-trace_headers");
  assert.ok(trace.entries.some(({ name }) => name === "seq_profile"));
  assert.ok(trace.entries.some(({ name }) => name === "base_q_idx"));
});
