import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("the default UI and all bundled client messages use English", async () => {
  const directory = new URL("../public/", import.meta.url);
  const html = await readFile(new URL("index.html", directory), "utf8");
  assert.match(html, /<html lang="en">/);
  for (const file of await readdir(directory)) {
    if (!/\.(html|js)$/.test(file)) continue;
    const source = await readFile(new URL(file, directory), "utf8");
    assert.doesNotMatch(source, /\p{Script=Han}/u, `${file} contains untranslated client text`);
  }
});
