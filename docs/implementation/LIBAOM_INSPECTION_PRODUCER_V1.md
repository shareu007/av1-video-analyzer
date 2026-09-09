# Instrumented libaom Inspection Producer v1

状态：固定 libaom v3.12.1 commit `10aece…`、inspection patch `6520bc…`、feature 127 producer、temporal-unit hidden/compound 解码与真实 Block Golden 均已验证。构建会生成并逐文件验证 artifact digest、BSD-2-Clause/AOM PATENTS inventory 与 CycloneDX 1.6 SBOM manifest。

## 边界

`native/include/av1scope_libaom_patch.h` 是固定 fork 唯一需要实现的私有 C11 接缝。fork 每个 decoder 实例保持完整 reference/CDF/entropy 状态，在 `decode_frame` 的同一线程同步发送逐块事件；不得把 libaom object、internal enum、allocator、callback 或 event pointer 留到调用结束之后。

adapter `native/libaom_inspection_adapter.c` 负责：

- 校验 patch ABI、feature flags、geometry、partition/mode、segment、reference、flags 与 MV reserved bits；
- 为每帧确定性分配连续 `block_id`；
- 按 `maximum_blocks_per_chunk` 批量转换为公共 88-byte BlockRecord v1 或追加兼容的 104-byte v2；
- 传播 callback backpressure、取消、deadline、malformed input 和 adapter error；
- 即使帧没有 block 也发送唯一 final chunk；
- 只向公共 adapter info 暴露 `libaom-inspect-v1`、feature flags 和固定 build ID。

test-only patch stub 覆盖三条事件、2-record chunk、qindex=255、MV/reference、非法 event、malformed、backpressure、取消和 C Worker→Node IPC。它不解码 AV1，也不能作为产品 producer 或 Block Golden。

## 上游 inspection producer

`native/libaom_builtin_inspection_patch.c` 直接使用 libaom 的 `AV1_SET_INSPECTION_CALLBACK`、`ifd_inspect` 和 `insp_mi_data`，不再要求 fork 重写 mode-info 导出。它在单线程 decoder session 中完成：

- 按 MI grid 去重并生成裁剪后的 luma coding-block geometry；
- 映射 intra/inter mode、最多两个 reference/MV、transform size/type、`current_qindex`、MI 坐标、compound type 与相对 base qindex 的 quant delta；
- 将 interpolation filter、CDEF primary/secondary 打包为稳定 `filter_summary`：bits 0..3=`filter[0]`、4..7=`filter[1]`、8..15=`cdef_level`、16..23=`cdef_strength`；
- 保持跨帧 reference/CDF/entropy 状态，传播 malformed、取消、deadline 和 callback backpressure；
- 只为 display frame 输出块；在同一 temporal unit 内按 `Av1DecodeReturn.buf` 解完 hidden/show-existing 子帧；
- 提供 feature mask `127`：partition、mode、MV、transform、coefficient、qindex、filter。

最小 patch 把既有 `MB_MODE_INFO.partition` 复制到 inspection grid，并在 luma coefficient token 解码时累计真实非零值；`compound_type`、MI 坐标和 quant delta 通过 BlockRecord v2 进入 Worker/Node/Overlay。

## 固定构建

项目提供失败即停的构建入口；默认要求干净的 libaom v3.12.1 和可选的精确 revision，在隔离 clone 自动应用固定 patch，构建 decoder-only、static、PIC、`CONFIG_INSPECTION=1` 产物，随后运行内置 smoke 和两例真实 Block Golden：

```bash
npm run native:build:inspection -- \
  --source /fixed/src/libaom-v3.12.1 \
  --expected-revision <40..64-hex>
```

dirty source 仅在其差量与固定 patch 完全一致时允许开发复用；其它差量失败即停。

release producer 最终必须实现全部七类 feature：partition、mode、motion vector、transform、coefficient、qindex、filter。build ID 是 canonical build inputs 的 SHA-256 前 40 个十六进制字符，完整输入/产物由 `av1scope-libaom-build-manifest` 绑定：源码 repository/revision/archive SHA-256、patch SHA-256、compiler/target、命令、CFLAGS、`SOURCE_DATE_EPOCH`、三个 native artifact SHA-256、license inventory 和 SBOM。

固定 v3.12.1 源码构建必须启用 inspection 和 PIC，并使用 static `libaom.a`，使内部 `ifd_*` 符号只链接进隔离 Worker/adapter，不进入公共产品 ABI：

```bash
cmake -S /fixed/src/libaom-v3.12.1 -B /fixed/build/libaom \
  -DCONFIG_INSPECTION=1 \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0
cmake --build /fixed/build/libaom --target aom

cmake -S native -B build/native \
  -DAV1SCOPE_LIBAOM_SOURCE_DIR=/fixed/src/libaom-v3.12.1 \
  -DAV1SCOPE_LIBAOM_BUILD_DIR=/fixed/build/libaom \
  -DAV1SCOPE_LIBAOM_LIBRARY=/fixed/build/libaom/libaom.a \
  -DAV1SCOPE_LIBAOM_BUILD_ID=<40-hex-build-id>
cmake --build build/native --target av1scope_inspection_worker
```

三项 `SOURCE_DIR/BUILD_DIR/LIBRARY` 是原子配置，并与预构建 `AV1SCOPE_LIBAOM_PATCH_LIBRARY`、`AV1SCOPE_INSPECTION_ADAPTER_LIBRARY` 互斥。仓库内 fixture 会实际编译同一 producer 源文件，并验证 feature mask 127、MI 去重、geometry、partition/coeff、双参考/MV、qindex=255、temporal-unit cursor、malformed 和 backpressure。

```bash
cmake -S native -B build/native \
  -DAV1SCOPE_LIBAOM_PATCH_LIBRARY=/fixed/lib/libav1scope_libaom_patch.a \
  -DAV1SCOPE_LIBAOM_BUILD_ID=<40-hex-build-id>
cmake --build build/native --target av1scope_inspection_worker
```

`AV1SCOPE_INSPECTION_ADAPTER_LIBRARY` 仍可接收完整的预构建公共 adapter；它与 `AV1SCOPE_LIBAOM_PATCH_LIBRARY` 互斥。

## 最小 fork 差量

上游 `insp_mi_data` 已覆盖 mode、MV、refs、block size、skip、segment、filter、transform、CDEF、current qindex、compound type。固定 patch 只增加：

1. 将已经存在的 `MB_MODE_INFO.partition` 复制到 inspection grid；
2. 在 luma token decode 中逐个累计真实非零 coefficient，并按 coding block 输出。

两个 hook 仅在 `CONFIG_INSPECTION=1` 下改变内部布局，公共 C ABI 不暴露 libaom 对象或 enum。

## Block Golden

`av1scope-block-golden-suite` manifest 绑定每个输入和 expected overlay 的 SHA-256、frame sample ranges、尺寸、来源许可与 producer build ID。验收脚本实际启动配置的 inspection Worker，要求：

- runtime producer 为 `libaom-inspect-v1`，build ID 完全一致，feature flags 为 127；
- 所有规范化 BlockRecord 与 canonical expected overlay 逐字段一致；
- Golden 集合实际出现 intra partition、inter MV、compound refs/type、MI coordinates、non-zero quant delta、segmentation + qindex（含合法 255）、transform + coefficient summary 和 filter summary。

```bash
AV1SCOPE_LIBAOM_BUILD_MANIFEST=/fixed/build-manifest.json \
AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST=/fixed/golden/manifest.json \
AV1SCOPE_NATIVE_INSPECTION_WORKER=/fixed/bin/av1scope_inspection_worker \
npm run check:libaom-release
```

缺少任何 manifest、artifact、Golden 或真实 Worker 时，普通 CI 明确报告 blocked；release gate 直接失败，不能用 test stub 降级通过。

同一 release gate 还会先生成无崩溃真实解码基线，再让 C11 intake helper 完整保存首轮请求并异常退出。父进程只对 crash 重试一次，新进程运行正式 Worker；门禁要求请求摘要一致、24 帧 BlockRecord 与基线逐项一致，并在成功 overlay provenance 中保留 attempts 与首次异常退出信息。该测试验证 supervisor 边界，不声称人为触发了 libaom 内部缺陷。
