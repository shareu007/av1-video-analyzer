# AV1Scope

An AV1 bitstream analyzer with a local browser interface and a command-line tool for codec development and media debugging.

## Features

- Inspect AV1 streams in IVF, MP4, WebM, and raw low-overhead OBU files.
- Explore frame timelines, OBU structure, header fields, byte ranges, and diagnostics.
- Preview decoded frames and compare streams using Y-PSNR, MAE, and global SSIM.
- Visualize coding blocks, quantization, and motion vectors with an optional instrumented libaom worker.
- Export JSON/CSV reports and index large files using paginated snapshots.

## Quick start

Requires Node.js 20+ and FFmpeg/ffprobe on `PATH` for container analysis, previews, and comparisons. The Node.js application has no third-party npm dependencies.

```bash
npm run gui
```

Open **http://127.0.0.1:4173**, then drop a video file or load the built-in sample.

```bash
# Analyze a stream
node bin/av1scope.mjs analyze input.ivf --output report.json

# Index a large file
node bin/av1scope.mjs index large.webm --snapshot-dir .av1scope-cache

# Compare two streams
node bin/av1scope.mjs compare reference.ivf candidate.ivf --output metrics.json
```

## Development

```bash
npm run ci          # Project checks and tests
npm run check:rust  # Optional Rust workspace checks; requires Rust tooling
```

See [native setup](native/README.md), the [Rust workspace](rust/README.md), and the [GUI checklist](docs/GUI_QUICK_CHECK.md) for more details.

## Status and limitations

The runnable application is a Node.js reference implementation with optional native workers and a Rust core under development. Detailed block inspection requires a separately built, instrumented libaom worker. The structural parser does not decode tile entropy data.

The GUI is intended for local use and has no built-in authentication. Native release validation requires additional build artifacts and provenance configuration.

## License

Currently `UNLICENSED`; no open-source license has been granted.
