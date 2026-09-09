import assert from "node:assert/strict";
import test from "node:test";

import { probeMediaFilePackets, probeMediaPackets } from "../src/media-probe.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("media packet probe honors cancellation before spawning ffprobe", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    probeMediaPackets(Buffer.from("not-a-container"), { signal: controller.signal }),
    /ffprobe cancelled/,
  );
});

test("media packet probe indexes a real single-frame AV1 fixture", async () => {
  const input = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const metadata = await probeMediaPackets(input);

  assert.equal(metadata.streams[0].codec_name, "av1");
  assert.equal(metadata.streams[0].width, 16);
  assert.equal(metadata.streams[0].height, 16);
  assert.equal(metadata.packets.length, 1);
  assert.equal(Number(metadata.packets[0].size), 24);
});

test("media packet probe reads a file path without piping the container into memory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-probe-"));
  try {
    const inputPath = path.join(directory, "sample.ivf");
    await writeFile(inputPath, Buffer.from(
      "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
      "base64",
    ));
    const metadata = await probeMediaFilePackets(inputPath);
    assert.equal(metadata.streams[0].codec_name, "av1");
    assert.equal(metadata.packets.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
