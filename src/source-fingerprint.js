import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const SOURCE_FINGERPRINT_ALGORITHM = "sha256-first-last-64k-v1";
const SAMPLE_BYTES = 64 * 1024;

export async function computeSourceFingerprint(inputPath) {
  const handle = await open(inputPath, "r");
  try {
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size)) throw new RangeError("input file size exceeds safe integer precision");
    const firstLength = Math.min(SAMPLE_BYTES, size);
    const lastStart = Math.max(firstLength, size - SAMPLE_BYTES);
    const lastLength = Math.max(0, size - lastStart);
    const first = Buffer.alloc(firstLength);
    const last = Buffer.alloc(lastLength);
    if (firstLength > 0) await handle.read(first, 0, firstLength, 0);
    if (lastLength > 0) await handle.read(last, 0, lastLength, lastStart);
    const digest = createHash("sha256")
      .update(`av1scope-source-v1\0${size}\0`)
      .update(first)
      .update(last)
      .digest("hex");
    return { algorithm: SOURCE_FINGERPRINT_ALGORITHM, digest };
  } finally {
    await handle.close();
  }
}
