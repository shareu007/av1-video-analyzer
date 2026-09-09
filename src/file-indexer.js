import { open } from "node:fs/promises";

import { createIvfFileSnapshotInput } from "./ivf-file-indexer.js";
import { createContainerFileSnapshotInput } from "./container-file-indexer.js";
import { InputFormat } from "./model.js";
import { createRawFileSnapshotInput } from "./raw-file-indexer.js";

export async function createFileSnapshotInput(inputPath, options = {}) {
  const handle = await open(inputPath, "r");
  const prefix = Buffer.alloc(12);
  const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
  await handle.close();
  const header = prefix.subarray(0, bytesRead);
  if (header.length >= 4 && header.toString("ascii", 0, 4) === "DKIF") {
    return createIvfFileSnapshotInput(inputPath, options);
  }
  if (header.length >= 8 && header.toString("ascii", 4, 8) === "ftyp") {
    return createContainerFileSnapshotInput(inputPath, InputFormat.ISOBMFF, options);
  }
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return createContainerFileSnapshotInput(inputPath, InputFormat.MATROSKA, options);
  }
  return createRawFileSnapshotInput(inputPath, options);
}
