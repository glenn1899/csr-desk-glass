import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

test("outgoing fetches do not use redirect error or referrerPolicy", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = sourceFiles(root);
  assert.equal(files.length > 0, true);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(/referrerPolicy/.test(text), false, file);
    assert.equal(/redirect:\s*["']error["']/.test(text), false, file);
    for (const match of text.matchAll(/redirect:\s*["']([^"']+)["']/g)) {
      assert.equal(match[1], "manual", file);
    }
  }
});
