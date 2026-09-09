import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "scripts", "src", "public", "test"];
const files = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(entryPath);
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
}

for (const root of roots) {
  await collect(root);
}

files.sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`syntax checked ${files.length} JavaScript files\n`);
