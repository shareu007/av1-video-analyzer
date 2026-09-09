import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeNativeDemuxResponse,
  NativeDemuxWorkerError,
} from "../src/native-demux-worker.js";

const corpus = await readFile(
  new URL("./fixtures/native-demux-worker-golden-v1.tsv", import.meta.url),
  "utf8",
);

function errorName(error) {
  if (!(error instanceof NativeDemuxWorkerError)) return error.constructor.name;
  if (error.status !== null) {
    return error.status > 8 ? `UnknownStatus(${error.status})` : `NativeStatus(${error.status})`;
  }
  const patterns = [
    [/framing/u, "InvalidFraming"],
    [/record budget/u, "RecordBudget"],
    [/non-canonical/u, "NonCanonicalSigned32"],
    [/invalid stream metadata/u, "InvalidStream"],
    [/invalid sample/u, "InvalidSample"],
    [/invalid end/u, "InvalidEnd"],
  ];
  return patterns.find(([pattern]) => pattern.test(error.message))?.[1] ?? error.code;
}

function syntax(result) {
  const stream = result.stream;
  const security = stream.workerSandboxFlags === 0
    ? ""
    : `@${stream.adapterFeatureFlags}/${stream.workerSandboxFlags}`;
  return `ok:${stream.trackId}/${stream.width}/${stream.height}/${stream.timeBaseNum}`
    + `/${stream.timeBaseDen}/${result.samples.length}${security}:`
    + result.samples.map((sample) => [
      sample.sampleId, sample.trackId, sample.flags, sample.dts, sample.pts,
      sample.duration, sample.sourceStart, sample.sourceLength,
    ].join("/")).join(";");
}

for (const line of corpus.split(/\r?\n/u)) {
  if (line.length === 0 || line.startsWith("#")) continue;
  const [name, hex, sourceBytes, maximumSampleBytes, maximumRecords, expected] = line.split("\t");
  test(`shared native demux Worker Golden: ${name}`, () => {
    let actual;
    try {
      actual = syntax(decodeNativeDemuxResponse(Buffer.from(hex, "hex"), {
        sourceBytes: Number(sourceBytes),
        maximumSampleBytes: Number(maximumSampleBytes),
        maximumRecords: Number(maximumRecords),
      }));
    } catch (error) {
      actual = `err:${errorName(error)}`;
    }
    assert.equal(actual, expected);
  });
}
