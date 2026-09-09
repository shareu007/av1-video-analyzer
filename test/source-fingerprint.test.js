import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeSourceFingerprint } from "../src/source-fingerprint.js";

test("source fingerprint is stable and changes at either sampled edge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-fingerprint-"));
  try {
    const firstPath = path.join(directory, "first.bin");
    const secondPath = path.join(directory, "second.bin");
    const data = Buffer.alloc(200_000, 0x55);
    await writeFile(firstPath, data);
    await writeFile(secondPath, data);
    const original = await computeSourceFingerprint(firstPath);
    assert.deepEqual(await computeSourceFingerprint(secondPath), original);

    data[0] ^= 0xff;
    await writeFile(secondPath, data);
    assert.notEqual((await computeSourceFingerprint(secondPath)).digest, original.digest);
    data[0] ^= 0xff;
    data[data.length - 1] ^= 0xff;
    await writeFile(secondPath, data);
    assert.notEqual((await computeSourceFingerprint(secondPath)).digest, original.digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
