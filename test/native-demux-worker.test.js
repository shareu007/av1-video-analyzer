import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  analyzeMediaBuffer,
  nativeDemuxResultToProbe,
} from "../src/analyzer.js";
import { runCli } from "../src/cli.js";
import { analyzeGuiJsonInWorker } from "../src/gui-server.js";
import {
  createNativeDemuxResponseDecoder,
  decodeNativeDemuxResponse,
  demuxBufferInNativeWorker,
  encodeNativeDemuxRequest,
  NativeDemuxWorkerError,
} from "../src/native-demux-worker.js";

function command(name, args, options = {}) {
  return spawnSync(name, args, { encoding: "utf8", ...options });
}

function nativeEnvironment() {
  return {
    ...process.env,
    ASAN_OPTIONS: `detect_leaks=${process.env.AV1SCOPE_NATIVE_LEAKS === "1" ? 1 : 0}:halt_on_error=1`,
    UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  };
}

function compiler() {
  for (const name of [process.env.CC, "cc", "gcc", "clang"].filter(Boolean)) {
    if (command(name, ["--version"]).status === 0) return name;
  }
  return null;
}

function record(kind, status, values = []) {
  const output = Buffer.alloc(72);
  output.writeUInt32LE(kind, 0);
  output.writeUInt32LE(status, 4);
  values.forEach((value, index) => output.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 8 + index * 8));
  return output;
}

function response(...records) {
  const header = Buffer.alloc(16);
  Buffer.from([0x41, 0x31, 0x44, 0x4d, 0x4f, 0x30, 0x31, 0]).copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(72, 12);
  return Buffer.concat([header, ...records]);
}

function runRawWorker(executable, request) {
  return spawnSync(executable, [], {
    input: request,
    encoding: null,
    maxBuffer: 1024 * 1024,
    env: nativeEnvironment(),
  });
}

test("native demux IPC codec rejects invalid framing and source ranges", () => {
  const input = Buffer.from("DKIF", "ascii");
  assert.equal(Buffer.concat(encodeNativeDemuxRequest(input)).length, 60);
  assert.throws(() => encodeNativeDemuxRequest(input, { maximumRecords: 0 }), RangeError);
  assert.throws(() => decodeNativeDemuxResponse(Buffer.alloc(16), { sourceBytes: 4 }), NativeDemuxWorkerError);
  const invalid = response(
    record(1, 0, [0, 64, 36, 1, 30, 1, 0x3d0764, 3]),
    record(2, 0, [0, 0, 1, 0, 0, 1, 3, 2]),
    record(3, 1, [1]),
  );
  assert.throws(
    () => decodeNativeDemuxResponse(invalid, { sourceBytes: 4 }),
    /invalid sample/u,
  );
  const nonCanonical = response(
    record(1, 0, [0x1_0000_0000n, 64, 36, 1, 30, 0, 0x3d0764, 3]),
    record(3, 1, [0]),
  );
  assert.throws(
    () => decodeNativeDemuxResponse(nonCanonical, { sourceBytes: 4 }),
    /non-canonical/u,
  );
  const dirtyEnd = response(
    record(1, 0, [0, 64, 36, 1, 30, 0, 0x3d0764, 3]),
    record(3, 1, [0, 1]),
  );
  assert.throws(
    () => decodeNativeDemuxResponse(dirtyEnd, { sourceBytes: 4 }),
    /invalid end/u,
  );
});

test("native demux IPC decoder is invariant across arbitrary stream chunk boundaries", () => {
  const valid = response(
    record(1, 0, [2, 64, 36, 1, 30, 2, 0x3d0764, 3]),
    record(2, 0, [0, 2, 1, -1, 0, 1, 48, 16]),
    record(2, 0, [1, 2, 0, 0, 1, 1, 64, 8]),
    record(3, 1, [2]),
  );
  const expected = decodeNativeDemuxResponse(valid, {
    sourceBytes: 72, maximumSampleBytes: 64, maximumRecords: 2,
  });
  for (let chunkBytes = 1; chunkBytes <= valid.length + 1; chunkBytes += 1) {
    const decoder = createNativeDemuxResponseDecoder({
      sourceBytes: 72, maximumSampleBytes: 64, maximumRecords: 2,
    });
    for (let offset = 0; offset < valid.length; offset += chunkBytes) {
      decoder.push(valid.subarray(offset, offset + chunkBytes));
    }
    assert.deepEqual(decoder.finish(), expected, `chunk size ${chunkBytes}`);
  }
});

test("native demux IPC decoder rejects truncated and post-terminal streams", () => {
  const stream = record(1, 0, [0, 64, 36, 1, 30, 0, 0x3d0764, 3]);
  const end = record(3, 1, [0]);
  const valid = response(stream, end);
  for (const length of [0, 1, 15, 16, 17, valid.length - 1]) {
    const decoder = createNativeDemuxResponseDecoder({ sourceBytes: 4 });
    decoder.push(valid.subarray(0, length));
    assert.throws(() => decoder.finish(), NativeDemuxWorkerError, `length ${length}`);
  }
  assert.throws(
    () => decodeNativeDemuxResponse(Buffer.concat([valid, record(2, 0)]), { sourceBytes: 4 }),
    /invalid end/u,
  );
  const nativeError = response(record(4, 5));
  assert.throws(
    () => decodeNativeDemuxResponse(Buffer.concat([nativeError, record(3, 1)]), { sourceBytes: 4 }),
    /invalid native demux error record/u,
  );
  const decoder = createNativeDemuxResponseDecoder({ sourceBytes: 4 });
  decoder.push(valid);
  decoder.finish();
  assert.throws(() => decoder.push(Buffer.alloc(0)), /already finished/u);
});

test("native demux result adapter preserves packet scalars", () => {
  const probe = nativeDemuxResultToProbe({
    protocol: "av1scope.native-demux-worker.v1",
    stream: {
      trackId: 2, width: 64, height: 36,
      timeBaseNum: 1, timeBaseDen: 30, sampleCount: 1,
      adapterVersion: "61.7.100", adapterFeatureFlags: 3,
      workerSandboxFlags: 31,
    },
    samples: [{
      sampleId: 0, trackId: 2, flags: 1,
      dts: -1n, pts: 0n, duration: 1n,
      sourceStart: 48, sourceLength: 123,
    }],
  });
  assert.equal(probe.streams[0].codec_name, "av1");
  assert.equal(probe.packets[0].dts, "-1");
  assert.equal(probe.packets[0].pos, "48");
  assert.equal(probe.packets[0].flags, "K_");
  assert.equal(probe.nativeAdapterVersion, "61.7.100");
  assert.equal(probe.nativeAdapterFeatureFlags, 3);
  assert.equal(probe.nativeWorkerSandboxFlags, 31);
});

test("native demux parent classifies cancellation, timeout, and crash", async () => {
  const input = Buffer.from("DKIF", "ascii");
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(
    demuxBufferInNativeWorker(input, {
      executable: process.execPath,
      signal: alreadyCancelled.signal,
    }),
    (error) => error.code === "NATIVE_DEMUX_CANCELLED",
  );

  await assert.rejects(
    demuxBufferInNativeWorker(input, {
      executable: process.execPath,
      timeoutMs: 25,
      spawnImpl: (_executable, _args, options) => spawn(
        process.execPath,
        ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
        options,
      ),
    }),
    (error) => error.code === "NATIVE_DEMUX_TIMEOUT",
  );

  await assert.rejects(
    demuxBufferInNativeWorker(input, {
      executable: process.execPath,
      maximumCrashRetries: 0,
      spawnImpl: (_executable, _args, options) => spawn(
        process.execPath,
        ["-e", "process.exit(23)"],
        options,
      ),
    }),
    (error) => error.code === "NATIVE_DEMUX_CRASHED",
  );

  let attempts = 0;
  await assert.rejects(
    demuxBufferInNativeWorker(input, {
      executable: process.execPath,
      maximumCrashRetries: 1,
      spawnImpl: (_executable, _args, options) => {
        attempts += 1;
        return spawn(process.execPath, ["-e", "process.exit(23)"], options);
      },
    }),
    (error) => error.code === "NATIVE_DEMUX_CRASHED" && error.attempts === 2,
  );
  assert.equal(attempts, 2);
});

test("native demux parent detects executable changes during analysis", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-worker-fingerprint-"));
  try {
    const executable = path.join(temporary, "worker.bin");
    await writeFile(executable, Buffer.from("stable worker bytes"));
    const valid = response(
      record(1, 0, [0, 64, 36, 1, 30, 0, 0x3d0764, 3]),
      record(3, 1, [0]),
    );
    await assert.rejects(
      demuxBufferInNativeWorker(Buffer.from("DKIF", "ascii"), {
        executable,
        maximumCrashRetries: 0,
        spawnImpl: () => {
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => true;
          setImmediate(async () => {
            await appendFile(executable, Buffer.from("!"));
            child.stdout.end(valid);
            child.stderr.end();
            child.emit("close", 0, null);
          });
          return child;
        },
      }),
      (error) => error.code === "NATIVE_DEMUX_EXECUTABLE_CHANGED",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native demux process isolates libavformat and matches ffprobe", async (context) => {
  const cc = compiler();
  const pkg = command("pkg-config", ["--cflags", "--libs", "libavformat", "libavcodec", "libavutil"]);
  if (cc === null || pkg.status !== 0 || command("ffmpeg", ["-version"]).status !== 0) {
    context.skip("native FFmpeg development/runtime tools unavailable");
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-demux-worker-"));
  try {
    const executable = path.join(temporary, "worker");
    const sanitizerFlags = process.env.AV1SCOPE_NATIVE_SANITIZERS === "1"
      ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
      : [];
    const build = command(cc, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      ...sanitizerFlags,
      "-I", "native/include",
      "native/ffmpeg_demux_adapter.c", "native/ffmpeg_demux_worker.c",
      "native/worker_limits.c", "native/worker_sandbox.c",
      ...pkg.stdout.trim().split(/\s+/u).filter(Boolean),
      ...sanitizerFlags,
      "-o", executable,
    ]);
    assert.equal(build.status, 0, build.stderr);
    const validHeader = encodeNativeDemuxRequest(Buffer.alloc(0), { maximumRecords: 1 })[0];
    const badMagic = Buffer.from(validHeader);
    badMagic[0] ^= 0xff;
    const badMagicResult = runRawWorker(executable, badMagic);
    assert.equal(badMagicResult.status, 0, badMagicResult.stderr?.toString());
    assert.throws(
      () => decodeNativeDemuxResponse(badMagicResult.stdout, { sourceBytes: 0, maximumRecords: 1 }),
      (error) => error.status === 3,
    );
    const trailing = runRawWorker(executable, Buffer.concat([validHeader, Buffer.from([1])]));
    assert.equal(trailing.status, 0, trailing.stderr?.toString());
    assert.throws(
      () => decodeNativeDemuxResponse(trailing.stdout, { sourceBytes: 0, maximumRecords: 1 }),
      (error) => error.status === 3,
    );
    const oversizedRecordBudget = Buffer.from(validHeader);
    oversizedRecordBudget.writeBigUInt64LE(250_001n, 40);
    const budgetResult = runRawWorker(executable, oversizedRecordBudget);
    assert.equal(budgetResult.status, 0, budgetResult.stderr?.toString());
    assert.throws(
      () => decodeNativeDemuxResponse(budgetResult.stdout, { sourceBytes: 0, maximumRecords: 1 }),
      (error) => error.status === 6,
    );
    for (const [extension, muxer] of [["mp4", "mp4"], ["webm", "webm"]]) {
      const media = path.join(temporary, `sample.${extension}`);
      const encoded = command("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "testsrc2=size=64x36:rate=3:duration=1", "-frames:v", "3",
        "-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "0",
        "-tiles", "1x1", "-g", "3", "-f", muxer, media,
      ]);
      assert.equal(encoded.status, 0, encoded.stderr);
      const input = await readFile(media);
      const result = await demuxBufferInNativeWorker(input, {
        executable,
        timeoutMs: 5_000,
        spawnImpl: (commandName, args, options) => spawn(commandName, args, {
          ...options,
          env: {
            ...nativeEnvironment(),
          },
        }),
      });
      assert.match(result.workerExecutable.sha256, /^[0-9a-f]{64}$/u);
      assert.ok(result.workerExecutable.size > 0);
      assert.equal(result.stream.width, 64);
      assert.equal(result.stream.height, 36);
      assert.match(result.stream.adapterVersion, /^61\./u);
      assert.equal(result.stream.adapterFeatureFlags, 3);
      if (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) {
        assert.equal(result.stream.workerSandboxFlags, 31);
      } else {
        assert.equal(result.stream.workerSandboxFlags, 0);
      }
      assert.equal(result.samples.length, 3);
      assert.deepEqual(result.samples.map(({ sampleId }) => sampleId), [0, 1, 2]);
      assert.ok(result.samples.every(({ sourceStart, sourceLength }) => (
        sourceStart >= 0 && sourceLength > 0 && sourceStart + sourceLength <= input.length
      )));
      const probe = command("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=index,width,height,time_base:packet=stream_index,pts,dts,duration,pos,size,flags",
        "-of", "json", media,
      ]);
      assert.equal(probe.status, 0, probe.stderr);
      const oracle = JSON.parse(probe.stdout);
      assert.equal(result.stream.trackId, oracle.streams[0].index);
      assert.equal(`${result.stream.timeBaseNum}/${result.stream.timeBaseDen}`, oracle.streams[0].time_base);
      for (const [index, sample] of result.samples.entries()) {
        const packet = oracle.packets[index];
        assert.equal(sample.trackId, packet.stream_index);
        assert.equal((sample.flags & 1) !== 0, packet.flags.includes("K"));
        assert.equal(sample.dts, BigInt(packet.dts));
        assert.equal(sample.pts, BigInt(packet.pts));
        assert.equal(sample.duration, BigInt(packet.duration));
        assert.equal(sample.sourceStart, Number(packet.pos));
        assert.equal(sample.sourceLength, Number(packet.size));
      }
      const nativeReport = await analyzeMediaBuffer(input, {
        sourceName: `native.${extension}`,
        nativeDemuxWorkerExecutable: executable,
        nativeDemuxWorker: (mediaInput, options) => demuxBufferInNativeWorker(mediaInput, {
          ...options,
          spawnImpl: (commandName, args, spawnOptions) => spawn(commandName, args, {
            ...spawnOptions,
            env: {
              ...nativeEnvironment(),
            },
          }),
        }),
      });
      const referenceReport = await analyzeMediaBuffer(input, { sourceName: `reference.${extension}` });
      assert.deepEqual(
        nativeReport.frames.map(({ sampleRange, timestamp, keyframe, obuIds }) => ({
          sampleRange, timestamp, keyframe, obuIds,
        })),
        referenceReport.frames.map(({ sampleRange, timestamp, keyframe, obuIds }) => ({
          sampleRange, timestamp, keyframe, obuIds,
        })),
      );
      assert.deepEqual(nativeReport.obus, referenceReport.obus);
      assert.equal(nativeReport.provenance.demux.implementation, "av1scope-native-demux-worker-v1");
      assert.match(nativeReport.provenance.demux.adapterVersion, /^61\./u);
      assert.equal(
        nativeReport.provenance.demux.workerSandboxFlags,
        process.platform === "linux" && ["x64", "arm64"].includes(process.arch) ? 31 : 0,
      );
      assert.deepEqual(nativeReport.provenance.demux.workerExecutable, result.workerExecutable);
      assert.equal(referenceReport.provenance.demux.implementation, "ffprobe-reference");
      if (process.env.AV1SCOPE_NATIVE_SANITIZERS !== "1") {
        const guiReport = JSON.parse(await analyzeGuiJsonInWorker(input, `gui.${extension}`, {
          nativeDemuxWorkerExecutable: executable,
        }));
        assert.equal(guiReport.provenance.demux.implementation, "av1scope-native-demux-worker-v1");
        assert.deepEqual(guiReport.obus, nativeReport.obus);

        let cliOutput = "";
        assert.equal(await runCli([
          "analyze", media, "--compact", "--native-demux-worker", executable,
        ], {
          stdout: { write: (chunk) => { cliOutput += chunk; } },
          stderr: { write: () => {} },
        }), 0);
        const cliReport = JSON.parse(cliOutput);
        assert.equal(cliReport.provenance.demux.implementation, "av1scope-native-demux-worker-v1");
        assert.deepEqual(cliReport.obus, nativeReport.obus);
      }
    }

    await assert.rejects(
      demuxBufferInNativeWorker(Buffer.from("DKIF", "ascii"), {
        executable,
        timeoutMs: 5_000,
        spawnImpl: (commandName, args, options) => spawn(commandName, args, {
          ...options,
          env: {
            ...nativeEnvironment(),
          },
        }),
      }),
      (error) => error instanceof NativeDemuxWorkerError && error.status === 5,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
