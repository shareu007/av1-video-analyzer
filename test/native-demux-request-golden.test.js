import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encodeNativeDemuxRequest } from "../src/native-demux-worker.js";

const corpus = await readFile(
  new URL("./fixtures/native-demux-request-golden-v1.tsv", import.meta.url),
  "utf8",
);

function errorName(error) {
  if (/input exceeds/u.test(error.message)) return "InputTooLarge";
  if (/maximumProbeBytes/u.test(error.message)) return "InvalidProbeBudget";
  if (/maximumSampleBytes/u.test(error.message)) return "InvalidSampleBudget";
  if (/maximumRecords/u.test(error.message)) return "InvalidRecordBudget";
  return error.constructor.name;
}

for (const line of corpus.split(/\r?\n/u)) {
  if (line.length === 0 || line.startsWith("#")) continue;
  const [name, sourceBytes, probeBytes, sampleBytes, records, track, expected] = line.split("\t");
  test(`shared native demux request Golden: ${name}`, () => {
    let actual;
    try {
      const input = Buffer.alloc(Number(sourceBytes));
      actual = encodeNativeDemuxRequest(input, {
        maximumProbeBytes: Number(probeBytes),
        maximumSampleBytes: Number(sampleBytes),
        maximumRecords: Number(records),
        requestedTrackId: Number(track),
      })[0].toString("hex");
    } catch (error) {
      actual = `err:${errorName(error)}`;
    }
    assert.equal(actual, expected);
  });
}
