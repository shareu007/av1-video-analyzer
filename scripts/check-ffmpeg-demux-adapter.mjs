import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function command(name, args, options = {}) {
  return spawnSync(name, args, { encoding: "utf8", ...options });
}

function sanitizerEnvironment() {
  return {
    ...process.env,
    ASAN_OPTIONS: `detect_leaks=${process.env.AV1SCOPE_NATIVE_LEAKS === "1" ? 1 : 0}:halt_on_error=1`,
    UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  };
}

function deterministicNoise(length, seed) {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function mutations(name, original) {
  const cases = [];
  const prefixLengths = [0, 1, 2, 3, 4, 8, 12, 31, 32, Math.floor(original.length / 2), original.length - 1];
  for (const length of new Set(prefixLengths.filter((value) => value >= 0 && value < original.length))) {
    cases.push([`${name}-prefix-${length}`, original.subarray(0, length)]);
  }
  for (let index = 0; index < 12 && original.length > 0; index += 1) {
    const offset = Math.floor((index * (original.length - 1)) / 11);
    const changed = Buffer.from(original);
    changed[offset] ^= 1 << (index % 8);
    cases.push([`${name}-flip-${offset}-${index % 8}`, changed]);
  }
  for (let index = 0; index < 4 && original.length > 0; index += 1) {
    const start = Math.floor((index * original.length) / 4);
    const changed = Buffer.from(original);
    changed.fill(index % 2 === 0 ? 0x00 : 0xff, start, Math.min(start + 32, changed.length));
    cases.push([`${name}-overwrite-${start}`, changed]);
  }
  return cases;
}

function findCompiler() {
  for (const candidate of [process.env.CC, "cc", "gcc", "clang"].filter(Boolean)) {
    if (command(candidate, ["--version"]).status === 0) return candidate;
  }
  return null;
}

const compiler = findCompiler();
const pkgConfig = command("pkg-config", ["--cflags", "--libs", "libavformat", "libavcodec", "libavutil"]);
const ffmpeg = command("ffmpeg", ["-version"]);
const ffprobe = command("ffprobe", ["-version"]);
if (compiler === null || pkgConfig.status !== 0 || ffmpeg.status !== 0 || ffprobe.status !== 0) {
  process.stdout.write("FFmpeg demux adapter check skipped: compiler or FFmpeg development/runtime tools unavailable\n");
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-ffmpeg-adapter-"));
try {
  const executable = path.join(temporary, "ffmpeg-demux-smoke");
  const pkgFlags = pkgConfig.stdout.trim().split(/\s+/u).filter(Boolean);
  const sanitizerFlags = process.env.AV1SCOPE_NATIVE_SANITIZERS === "1"
    ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    : [];
  const build = command(compiler, [
    "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
    ...sanitizerFlags,
    "-I", "native/include",
    "native/ffmpeg_demux_adapter.c",
    "native/test/ffmpeg-demux-smoke.c",
    ...pkgFlags, ...sanitizerFlags,
    "-o", executable,
  ]);
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exitCode = build.status ?? 1;
    process.exit();
  }

  const formats = [
    ["ivf", "ivf"],
    ["mp4", "mp4"],
    ["webm", "webm"],
  ];
  const encodedInputs = [];
  let mp4InputPath = null;
  for (const [extension, muxer] of formats) {
    const file = path.join(temporary, `sample.${extension}`);
    const encode = command("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=3:duration=1",
      "-frames:v", "3", "-c:v", "libaom-av1", "-cpu-used", "8",
      "-row-mt", "0", "-tiles", "1x1", "-g", "3", "-f", muxer, file,
    ]);
    assert.equal(encode.status, 0, encode.stderr);
    encodedInputs.push([extension, await readFile(file)]);
    if (extension === "mp4") mp4InputPath = file;

    const probe = command("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=index,width,height,time_base:packet=stream_index,pts,dts,duration,pos,size,flags",
      "-of", "json", file,
    ]);
    assert.equal(probe.status, 0, probe.stderr);
    const oracle = JSON.parse(probe.stdout);
    const adapter = command(executable, [file], {
      env: sanitizerEnvironment(),
    });
    assert.equal(adapter.status, 0, adapter.stderr);
    const lines = adapter.stdout.trim().split(/\r?\n/u).map((line) => line.split("\t"));
    assert.equal(lines[0][0], "ADAPTER");
    assert.equal(lines[0][1], "av1scope-libavformat");
    assert.match(lines[0][2], /^Lavf/u);
    const stream = lines.find(([kind]) => kind === "STREAM");
    const expectedStream = oracle.streams[0];
    assert.equal(Number(stream[1]), expectedStream.index);
    assert.equal(Number(stream[2]), expectedStream.width);
    assert.equal(Number(stream[3]), expectedStream.height);
    assert.equal(`${stream[4]}/${stream[5]}`, expectedStream.time_base);

    const samples = lines.filter(([kind]) => kind === "SAMPLE");
    assert.equal(samples.length, oracle.packets.length, `${extension} packet count`);
    for (const [index, sample] of samples.entries()) {
      const packet = oracle.packets[index];
      assert.equal(Number(sample[1]), index, `${extension} sample ID`);
      assert.equal(Number(sample[2]), packet.stream_index, `${extension} track`);
      assert.equal((Number(sample[3]) & 1) !== 0, packet.flags.includes("K"), `${extension} key flag`);
      assert.equal(sample[4], String(packet.dts), `${extension} DTS`);
      assert.equal(sample[5], String(packet.pts), `${extension} PTS`);
      assert.equal(sample[6], String(packet.duration), `${extension} duration`);
      assert.equal(sample[7], String(packet.pos), `${extension} source offset`);
      assert.equal(sample[8], String(packet.size), `${extension} source length`);
    }
  }
  const malformed = path.join(temporary, "malformed.bin");
  await writeFile(malformed, Buffer.from("DKIF", "ascii"));
  const malformedResult = command(executable, [
    "--expect-open-status", "5", malformed,
  ], {
    env: sanitizerEnvironment(),
  });
  assert.equal(malformedResult.status, 0, malformedResult.stderr);
  assert.notEqual(mp4InputPath, null);
  const probeBudget = command(executable, [
    "--expect-probe-budget", "32", mp4InputPath,
  ], {
    env: sanitizerEnvironment(),
  });
  assert.equal(probeBudget.status, 0, probeBudget.stderr);

  const fuzzCases = encodedInputs.flatMap(([name, input]) => mutations(name, input));
  for (let index = 0; index < 12; index += 1) {
    const length = [1, 4, 16, 64, 256, 1024][index % 6];
    fuzzCases.push([`noise-${index}-${length}`, deterministicNoise(length, 0x51f15e + index)]);
  }
  for (const [index, [name, bytes]] of fuzzCases.entries()) {
    const fuzzFile = path.join(temporary, `fuzz-${String(index).padStart(3, "0")}-${name}.bin`);
    await writeFile(fuzzFile, bytes);
    const fuzz = command(executable, ["--fuzz-smoke", fuzzFile], {
      env: sanitizerEnvironment(),
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(fuzz.signal, null, `${name} terminated by ${fuzz.signal}\n${fuzz.stderr}`);
    assert.equal(fuzz.status, 0, `${name}\n${fuzz.stderr}`);
  }
  const mode = sanitizerFlags.length
    ? ` with ASan/UBSan${process.env.AV1SCOPE_NATIVE_LEAKS === "1" ? "/LSan" : ""}`
    : "";
  process.stdout.write(
    `real libavformat demux adapter matched ffprobe for IVF/MP4/WebM and survived ${fuzzCases.length} malformed cases${mode}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
