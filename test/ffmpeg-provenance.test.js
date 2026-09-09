import assert from "node:assert/strict";
import test from "node:test";

import {
  computeFfmpegBuildId,
  computeFfmpegSbomSerialNumber,
  validateFfmpegBuildManifest,
} from "../src/ffmpeg-provenance.js";

const digest = (value) => value.repeat(64);

function fixture() {
  const manifest = {
    schemaVersion: 1,
    kind: "av1scope-ffmpeg-build-manifest",
    source: {
      repository: "https://github.com/FFmpeg/FFmpeg.git",
      version: "7.1.5",
      tag: "n7.1.5",
      revision: "1".repeat(40),
      archive: { path: "sources/ffmpeg-n7.1.5.tar", sha256: digest("2") },
    },
    toolchain: {
      compiler: "cc",
      compilerVersion: "cc 14.2.0",
      target: "x86_64-linux-gnu",
    },
    build: {
      sourceDateEpoch: 1_750_000_000,
      license: "LGPL-2.1-or-later",
      configureFlags: [
        "--enable-shared",
        "--disable-static",
        "--disable-autodetect",
        "--disable-network",
        "--enable-libaom",
        "--prefix=/av1scope-ffmpeg",
      ],
      commands: [["configure", "${CONFIGURE_FLAGS}"], ["make", "-j4"], ["make", "install"]],
    },
    dependencies: {
      libaom: {
        version: "3.12.1",
        revision: "3".repeat(40),
        buildId: "4".repeat(40),
        librarySha256: digest("5"),
      },
      zlib: {
        version: "1.3.1",
        soname: "libz.so.1",
        librarySha256: digest("6"),
      },
    },
    features: {
      demuxers: ["mov", "matroska", "ivf", "av1"],
      decoders: ["libaom_av1"],
      encoders: ["rawvideo", "png"],
      muxers: ["rawvideo", "null", "image2pipe", "image2"],
      parsers: ["av1"],
      protocols: ["pipe", "file"],
      filters: ["select", "scale", "format"],
      bsfs: ["trace_headers"],
    },
    artifacts: {
      ffmpeg: { path: "bin/ffmpeg", sha256: digest("7") },
      ffprobe: { path: "bin/ffprobe", sha256: digest("8") },
      demuxAdapter: { path: "lib/libav1scope_ffmpeg_demux.so", sha256: digest("9") },
      demuxWorker: { path: "bin/av1scope_ffmpeg_demux_worker", sha256: digest("a") },
      libraries: [
        ["zlib", "1.3.1", "libz.so.1", "b"],
        ["libavutil", "59.39.100", "libavutil.so.59", "c"],
        ["libavformat", "61.7.103", "libavformat.so.61", "d"],
        ["libavfilter", "10.5.100", "libavfilter.so.10", "e"],
        ["libavcodec", "61.19.101", "libavcodec.so.61", "f"],
        ["libswscale", "8.3.100", "libswscale.so.8", "0"],
      ].map(([name, version, soname, value]) => ({
        name, version, soname, path: `lib/${soname}.full`, sha256: digest(value),
      })),
    },
    compliance: {
      licenses: [
        "Zlib",
        "LGPL-2.1-or-later",
        "LicenseRef-AOM-Patent-License-1.0",
        "BSD-2-Clause",
      ],
      bundleInventory: { path: "compliance/bundle-inventory.json", sha256: digest("0") },
      licenseInventory: { path: "compliance/license-inventory.json", sha256: digest("1") },
      sbom: { path: "compliance/sbom.cdx.json", sha256: digest("2") },
    },
  };
  manifest.buildId = computeFfmpegBuildId(manifest);
  return manifest;
}

test("FFmpeg manifest binds LGPL inputs, dependencies, artifacts and compliance", () => {
  const manifest = fixture();
  const first = validateFfmpegBuildManifest(manifest);
  const second = validateFfmpegBuildManifest(JSON.parse(JSON.stringify(manifest)));
  assert.equal(first.manifest.buildId, manifest.buildId);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(
    first.manifest.artifacts.libraries.map(({ name }) => name),
    ["libavcodec", "libavfilter", "libavformat", "libavutil", "libswscale", "zlib"],
  );
  assert.equal(
    computeFfmpegSbomSerialNumber("4".repeat(40)),
    "urn:uuid:920ece8c-0746-505b-b347-0cec044b6c56",
  );
  assert.match(computeFfmpegSbomSerialNumber(manifest.buildId), /^urn:uuid:[0-9a-f-]{36}$/u);
  assert.throws(() => computeFfmpegSbomSerialNumber("not-a-build-id"), /buildId/);
});

test("FFmpeg manifest rejects forbidden flags, path escape and incomplete evidence", () => {
  const forbidden = fixture();
  forbidden.build.configureFlags.push("--enable-gpl");
  assert.throws(() => validateFfmpegBuildManifest(forbidden), /forbidden/);

  const escaped = fixture();
  escaped.artifacts.ffmpeg.path = "../ffmpeg";
  assert.throws(() => validateFfmpegBuildManifest(escaped), /safe relative bundle path/);

  const missingLibrary = fixture();
  missingLibrary.artifacts.libraries.pop();
  assert.throws(() => validateFfmpegBuildManifest(missingLibrary), /every required bundle library/);

  const missingLicense = fixture();
  missingLicense.compliance.licenses = ["LGPL-2.1-or-later"];
  assert.throws(() => validateFfmpegBuildManifest(missingLicense), /missing BSD-2-Clause/);
});
