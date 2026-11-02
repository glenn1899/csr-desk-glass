import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".html")) return nextLoad(url, context);
  const text = await readFile(fileURLToPath(url), "utf8");
  return {
    format: "module",
    source: `export default ${JSON.stringify(text)};\n`,
    shortCircuit: true,
  };
}
