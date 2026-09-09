# Cache Recovery Rehearsal v1

## 命令与安全边界

```bash
av1scope rehearse-recovery <parent-snapshot-id> --snapshot-dir <root>
```

命令只读验证源 Snapshot Store，并在操作系统临时目录创建隔离克隆。它复制指定父 Snapshot、该父的已验证 Derived Syntax 和 Syntax Overlay 内容；源 store 不创建、删除或覆盖任何文件。临时克隆无论成功失败都会清理，输出不包含临时路径、绝对源路径或时间。

## 演练阶段

1. 完整重建并校验父 report snapshot ID；验证所有关联 Derived/Overlay 内容 ID与父绑定；
2. 形成稳定 checkpoint：父 ID、Frame/OBU 数、排序后的 Derived/Overlay ID；
3. 在隔离克隆创建 derived index，并注入一个损坏 index 与三个受识别的 staging 事务；
4. 先 dry-run，随后携带完全相同的 plan ID apply；要求候选数等于删除数且内容删除数为零；
5. 再次验证所有 checkpoint 内容；
6. 删除克隆的全部 index cache，调用正常 reader 自动重建；要求 index ID/entry 数与初建一致；
7. 最后再次验证克隆与源 checkpoint。

输出 `av1scope-cache-recovery-rehearsal` v1 报告，包含 checkpoint ID、内容数量、各阶段布尔结果、候选/删除数和派生索引稳定性。任何阶段不满足即命令失败，不输出伪造的通过报告。

## 它证明什么

该演练证明 Node reference Snapshot Store 的内容与可重建 cache 分离、精确 GC 计划、全 cache 丢失后的索引重建，以及操作期间源内容未改变。它不等同于 Windows/Linux 桌面安装包的二进制版本回滚，也不证明未来 SQLite schema downgrade；生产版本回滚仍需在 Tauri/Rust 安装包与迁移工具链可用后单独验收。
