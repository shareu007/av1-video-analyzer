import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workspace = await readFile("rust/Cargo.toml", "utf8");
assert.match(workspace, /edition = "2024"/u);
assert.match(workspace, /rust-version = "1\.85"/u);
assert.match(workspace, /resolver = "2"/u);

const crates = [
  "av1-analysis",
  "av1-bits",
  "av1-ivf",
  "av1-model",
  "av1-native-demux",
  "av1-native-guard",
  "av1-native-sys",
  "av1-structural",
  "av1-worker-protocol",
];
for (const crate of crates) {
  assert.match(workspace, new RegExp(`"crates/${crate}"`, "u"));
  const manifest = await readFile(`rust/crates/${crate}/Cargo.toml`, "utf8");
  assert.match(manifest, new RegExp(`name = "${crate}"`, "u"));
  assert.match(manifest, /edition\.workspace = true/u);
  assert.match(manifest, /rust-version\.workspace = true/u);
}

for (const crate of [
  "av1-analysis", "av1-bits", "av1-ivf", "av1-model", "av1-native-guard",
  "av1-structural",
  "av1-worker-protocol",
]) {
  const source = await readFile(`rust/crates/${crate}/src/lib.rs`, "utf8");
  assert.match(source, /^#!\[forbid\(unsafe_code\)\]/u);
  assert.doesNotMatch(source, /\bunsafe\s*(?:\{|fn|extern|impl|trait)\b/u);
}

const nativeManifest = await readFile("rust/crates/av1-native-sys/Cargo.toml", "utf8");
assert.doesNotMatch(nativeManifest, /^links\s*=/mu);

const nativeSource = await readFile("rust/crates/av1-native-sys/src/lib.rs", "utf8");
assert.match(nativeSource, /pub type StatusCodeV1 = u32;/u);
assert.match(nativeSource, /\) -> StatusCodeV1;/u);
assert.doesNotMatch(nativeSource, /\) -> StatusV1;/u);
assert.match(nativeSource, /size_of::<BlockRecordV1>\(\), 88/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV1, flags\), 44/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV1, qindex\), 47/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV1, motion_vectors\), 64/u);
assert.match(nativeSource, /size_of::<BlockRecordV2>\(\), 104/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV2, detail_flags\), 88/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV2, mi_row\), 92/u);
assert.match(nativeSource, /offset_of!\(BlockRecordV2, compound_type\), 100/u);
assert.match(nativeSource, /size_of::<SampleV1>\(\), 64/u);
assert.match(nativeSource, /offset_of!\(SampleV1, source_range\), 48/u);

const cSmoke = await readFile("native/abi-smoke.c", "utf8");
assert.match(cSmoke, /sizeof\(av1scope_status_v1\) == 4/u);
assert.match(cSmoke, /sizeof\(av1scope_block_record_v1\) == 88/u);
assert.match(cSmoke, /offsetof\(av1scope_block_record_v1, flags\) == 44/u);
assert.match(cSmoke, /offsetof\(av1scope_block_record_v1, qindex\) == 47/u);
assert.match(cSmoke, /offsetof\(av1scope_block_record_v1, motion_vectors\) == 64/u);
assert.match(cSmoke, /sizeof\(av1scope_block_record_v2\) == 104/u);
assert.match(cSmoke, /offsetof\(av1scope_block_record_v2, detail_flags\) == 88/u);
assert.match(cSmoke, /sizeof\(av1scope_sample_v1\) == 64/u);
assert.match(cSmoke, /offsetof\(av1scope_sample_v1, source_range\) == 48/u);

const structural = await readFile("rust/crates/av1-structural/src/lib.rs", "utf8");
assert.match(structural, /\.checked_add\(length - 1\)/u);
assert.match(structural, /OBU_RECORD_LIMIT_REACHED/u);
assert.match(structural, /OBU_PAYLOAD_TRUNCATED/u);
assert.match(structural, /obu-structural-golden-v1\.tsv/u);
assert.match(structural, /LEB128_VALUE_TOO_LARGE/u);
assert.match(structural, /OBU_BOUNDARY_FROM_CONTAINER/u);

const sharedGolden = await readFile(
  "test/fixtures/obu-structural-golden-v1.tsv",
  "utf8",
);
assert.equal(
  sharedGolden.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")).length,
  14,
);

const ivfSource = await readFile("rust/crates/av1-ivf/src/lib.rs", "utf8");
assert.match(ivfSource, /ivf-index-golden-v1\.tsv/u);
assert.match(ivfSource, /IVF_FRAME_PAYLOAD_TRUNCATED/u);
assert.match(ivfSource, /FRAME_RECORD_LIMIT_REACHED/u);
assert.match(ivfSource, /checked_add\(actual_size\)/u);
const sharedIvfGolden = await readFile("test/fixtures/ivf-index-golden-v1.tsv", "utf8");
assert.equal(
  sharedIvfGolden.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")).length,
  10,
);

const analysisSource = await readFile("rust/crates/av1-analysis/src/lib.rs", "utf8");
assert.match(analysisSource, /input\.starts_with\(b"DKIF"\)/u);
assert.match(analysisSource, /allow_unsized_final_obu = true/u);
assert.match(analysisSource, /maximum_obus\.saturating_sub\(obus\.len\(\)\)/u);
assert.match(analysisSource, /OffsetOutsideInput/u);

const nativeGuard = await readFile("rust/crates/av1-native-guard/src/lib.rs", "utf8");
assert.match(nativeGuard, /UnknownStatus\(StatusCodeV1\)/u);
assert.match(nativeGuard, /checked_add\(sample\.source_range\.length\)/u);
assert.match(nativeGuard, /maximum_blocks_per_chunk/u);
assert.match(nativeGuard, /chunk\.records\.is_null\(\)/u);

const nativeDemux = await readFile("rust/crates/av1-native-demux/src/lib.rs", "utf8");
assert.match(nativeDemux, /pub struct DemuxHandle/u);
assert.match(nativeDemux, /impl Drop for DemuxHandle/u);
assert.match(nativeDemux, /catch_unwind/u);
assert.match(nativeDemux, /validate_sample\(&output, self\.limits\)/u);
assert.match(nativeDemux, /PhantomData<Rc<\(\)>>/u);
assert.match(nativeDemux, /output\.sample_id != self\.next_sample_id/u);
assert.match(nativeDemux, /bounded > u64::try_from\(isize::MAX\)/u);

const nativeWorker = await readFile("native/ffmpeg_demux_worker.c", "utf8");
assert.match(nativeWorker, /MAX_WORKER_INPUT_BYTES/u);
assert.match(nativeWorker, /MAX_WORKER_RECORDS/u);
assert.match(nativeWorker, /av1scope_apply_worker_limits/u);
assert.match(nativeWorker, /fgetc\(stdin\) != EOF/u);
assert.match(nativeWorker, /av1scope_apply_worker_sandbox/u);
const workerSandbox = await readFile("native/worker_sandbox.c", "utf8");
assert.match(workerSandbox, /PR_SET_NO_NEW_PRIVS/u);
assert.match(workerSandbox, /SECCOMP_MODE_FILTER/u);
assert.match(workerSandbox, /DENY_SYSCALL\(openat\)/u);
assert.match(workerSandbox, /DENY_SYSCALL\(socket\)/u);
const workerLimits = await readFile("native/worker_limits.c", "utf8");
assert.match(workerLimits, /RLIMIT_AS/u);
assert.match(workerLimits, /RLIMIT_CPU/u);
assert.match(workerLimits, /RLIMIT_CORE/u);
assert.match(workerLimits, /RLIMIT_NOFILE/u);
const nativeWorkerParent = await readFile("src/native-demux-worker.js", "utf8");
assert.match(nativeWorkerParent, /maximumCrashRetries = 1/u);
assert.match(nativeWorkerParent, /maximumRecords \+ 2/u);
assert.match(nativeWorkerParent, /child\.once\("close"/u);
assert.match(nativeWorkerParent, /child\.stdin\.write\(request\[0\]\)/u);
assert.match(nativeWorkerParent, /createNativeDemuxResponseDecoder/u);

const inspectionWorker = await readFile("native/inspection_worker.c", "utf8");
assert.match(inspectionWorker, /MAX_WORKER_BLOCKS/u);
assert.match(inspectionWorker, /av1scope_inspector_decode_frame_v2/u);
assert.match(inspectionWorker, /RESPONSE_RECORD_BYTES 112U/u);
assert.match(inspectionWorker, /av1scope_apply_worker_sandbox/u);
assert.match(inspectionWorker, /record->flags/u);
const inspectionWorkerParent = await readFile("src/native-inspection-worker.js", "utf8");
assert.match(inspectionWorkerParent, /maximumCrashRetries = 1/u);
assert.match(inspectionWorkerParent, /validateBlockOverlayDocument/u);
assert.match(inspectionWorkerParent, /NATIVE_INSPECTION_EXECUTABLE_CHANGED/u);

const workerProtocol = await readFile("rust/crates/av1-worker-protocol/src/lib.rs", "utf8");
assert.match(workerProtocol, /native-demux-worker-golden-v1\.tsv/u);
assert.match(workerProtocol, /NonCanonicalSigned32/u);
assert.match(workerProtocol, /range\.checked_end\(\)/u);
assert.match(workerProtocol, /maximum_records[\s\S]{0,80}\.checked_add\(2\)/u);
const workerGolden = await readFile(
  "test/fixtures/native-demux-worker-golden-v1.tsv",
  "utf8",
);
assert.equal(
  workerGolden.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")).length,
  10,
);
const workerRequestGolden = await readFile(
  "test/fixtures/native-demux-request-golden-v1.tsv",
  "utf8",
);
assert.equal(
  workerRequestGolden.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")).length,
  6,
);
assert.match(workerProtocol, /native-demux-request-golden-v1\.tsv/u);
assert.match(workerProtocol, /pub fn encode_request/u);

process.stdout.write("Rust 2024 source baseline contract checked (toolchain validation is separate)\n");
