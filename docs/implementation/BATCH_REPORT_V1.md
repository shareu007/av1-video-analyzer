# Batch Analysis Report v1

## 命令

```bash
av1scope batch <directory> [--recursive] [--extensions obu,ivf,mp4,webm] \
  [--jobs 2] [--max-files 10000] [--max-file-bytes 268435456] \
  [--snapshot-dir ./snapshots] [--csv] [--output batch.json]
```

目录先完整枚举，再按稳定 Unicode code-point 顺序分析。默认扩展名为 `.av1,.ivf,.m4v,.mkv,.mov,.mp4,.obu,.webm`，比较时不区分大小写；不跟随 symlink。`--recursive` 缺省关闭。匹配文件超过 `--max-files` 会在启动分析前拒绝，单文件超过 `--max-file-bytes` 则记录稳定失败并继续其他文件。

## 确定性

- `files` 永远按规范化 `/` 分隔的相对路径排序；完成顺序不受 `--jobs` 影响；
- 报告不写 wall-clock 时间、耗时、绝对路径、临时目录或原始异常文本；
- 每个已读取文件保存完整内容 SHA-256；失败只保存稳定 code 和固定消息；
- 配置不保存 `jobs`，因此相同输入和语义配置在不同并发度下产生字节一致的 canonical JSON；
- JSON/CSV `--output` 使用同目录临时文件 + rename，默认拒绝覆盖；
- `--snapshot-dir` 为每个成功分析冻结完整不可变 Snapshot，并只在 batch row 保存 snapshot ID。

## JSON 形状

```text
schemaVersion: 1
kind: "av1scope-batch-analysis"
rootName: string
configuration: {
  recursive, extensions, maxFiles, maxFileBytes,
  maxObus, maxSyntaxNodes, maxFrames, snapshotStore
}
files: BatchFileResult[]
summary: BatchSummary
provenance: { parser, parserVersion, implementation }
```

成功 row 包含 relative path、SHA-256、byte length、`ok|diagnostics`、format、complete、尺寸、Frame/OBU/Syntax 数量、frame/OBU/diagnostic 分类计数、Tile Group/Tile 数量和可选 snapshot ID。操作失败 row 的 `status=failed`，并带 `failure.code`；它不会伪造分析计数。

汇总包含匹配/忽略/成功/诊断/失败/完整文件数，总字节、Frame/OBU/Syntax/错误/警告/Tile 数，以及 format/diagnostic code 计数。

## CSV 与退出码

CSV 每个文件一行，使用 RFC 4180 风格双引号转义。它是机器批量导入视图，不包含 JSON 的嵌套分类计数。

- `0`：没有操作失败；普通 AV1 诊断被写入报告；
- `1`：至少一个文件发生读取、大小预算、ffprobe 或分析操作失败；其余结果仍完整输出；
- `2`：使用 `--strict` 且没有操作失败，但至少一个报告含 error/fatal 诊断。

## 当前边界

Batch 是有界并发的 eager 分析，每个 worker 最多完整读取一个 `maxFileBytes` 输入。超过默认 256 MiB 的单文件应使用 `av1scope index` 流式建立 Snapshot。Batch 不替代未来 Rust scheduler 的按字节背压、进程沙箱或断点任务队列。
