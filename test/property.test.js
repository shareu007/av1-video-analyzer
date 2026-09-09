import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  createNativeDemuxResponseDecoder,
  NativeDemuxWorkerError,
} from "../src/native-demux-worker.js";

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function assertRangeInSource(range, sourceSize) {
  assert.ok(Number.isSafeInteger(range.start));
  assert.ok(Number.isSafeInteger(range.length));
  assert.ok(range.start >= 0);
  assert.ok(range.length >= 0);
  assert.ok(range.start + range.length <= sourceSize);
}

test("fuzz smoke keeps all published ranges inside the source", () => {
  const random = xorshift32(0x41563153);
  for (let caseIndex = 0; caseIndex < 2_000; caseIndex += 1) {
    const length = random() % 257;
    const input = Buffer.alloc(length);
    for (let byteIndex = 0; byteIndex < length; byteIndex += 1) {
      input[byteIndex] = random() & 0xff;
    }

    const report = analyzeBuffer(input);
    assert.equal(report.source.size, length);
    for (const frame of report.frames) {
      assertRangeInSource(frame.sampleRange, length);
      assertRangeInSource(frame.payloadRange, length);
    }
    for (const obu of report.obus) {
      assertRangeInSource(obu.byteRange, length);
      assertRangeInSource(obu.headerRange, length);
      assertRangeInSource(obu.payloadRange, length);
      if (obu.sizeFieldRange !== null) {
        assertRangeInSource(obu.sizeFieldRange, length);
      }
    }
    for (const node of report.syntaxNodes) {
      if (node.bitRange === null) continue;
      assert.ok(Number.isSafeInteger(node.bitRange.startBit));
      assert.ok(Number.isSafeInteger(node.bitRange.lengthBits));
      assert.ok(node.bitRange.startBit >= 0);
      assert.ok(node.bitRange.lengthBits > 0);
      assert.ok(node.bitRange.startBit + node.bitRange.lengthBits <= length * 8);
    }
    for (const item of report.diagnostics) {
      if (item.byteRange !== null) {
        assertRangeInSource(item.byteRange, length);
      }
    }
  }
});

function nativeRecord(kind, status, values = []) {
  const output = Buffer.alloc(72);
  output.writeUInt32LE(kind, 0);
  output.writeUInt32LE(status, 4);
  values.forEach((value, index) => {
    output.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 8 + index * 8);
  });
  return output;
}

function nativeResponse(...records) {
  const header = Buffer.alloc(16);
  Buffer.from([0x41, 0x31, 0x44, 0x4d, 0x4f, 0x30, 0x31, 0]).copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(72, 12);
  return Buffer.concat([header, ...records]);
}

test("native demux IPC mutation smoke only succeeds safely or rejects structurally", () => {
  const random = xorshift32(0x4e445750);
  const seed = nativeResponse(
    nativeRecord(1, 0, [0, 64, 36, 1, 30, 2, 0x3d0764, 3]),
    nativeRecord(2, 0, [0, 0, 1, -1, 0, 1, 48, 8]),
    nativeRecord(2, 0, [1, 0, 0, 0, 1, 1, 56, 8]),
    nativeRecord(3, 1, [2]),
  );
  for (let caseIndex = 0; caseIndex < 2_000; caseIndex += 1) {
    const candidate = Buffer.from(seed);
    const mutationCount = 1 + (random() % 8);
    for (let mutation = 0; mutation < mutationCount; mutation += 1) {
      candidate[random() % candidate.length] ^= 1 << (random() % 8);
    }
    const truncateAt = random() % 5 === 0 ? random() % candidate.length : candidate.length;
    const input = candidate.subarray(0, truncateAt);
    const decoder = createNativeDemuxResponseDecoder({
      sourceBytes: 64, maximumSampleBytes: 64, maximumRecords: 8,
    });
    let offset = 0;
    let result = null;
    let failure = null;
    try {
      while (offset < input.length) {
        const chunkBytes = 1 + (random() % 97);
        decoder.push(input.subarray(offset, offset + chunkBytes));
        offset += chunkBytes;
      }
      result = decoder.finish();
    } catch (error) {
      failure = error;
    }
    if (failure !== null) {
      assert.ok(failure instanceof NativeDemuxWorkerError, failure?.stack);
      assert.ok(
        failure.code === "NATIVE_DEMUX_PROTOCOL_ERROR"
          || failure.code === "NATIVE_DEMUX_WORKER_FAILED",
      );
      continue;
    }
    assert.equal(result.protocol, "av1scope.native-demux-worker.v1");
    assert.ok(result.samples.length <= 8);
    for (const sample of result.samples) {
      assert.equal(sample.trackId, result.stream.trackId);
      assert.ok(sample.sourceStart >= 0);
      assert.ok(sample.sourceLength >= 0);
      assert.ok(sample.sourceStart + sample.sourceLength <= 64);
    }
  }
});
