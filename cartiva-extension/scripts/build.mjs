import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(extensionRoot, "dist");
const compiledRoot = resolve(extensionRoot, "build", "js");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "js"), { recursive: true });
await cp(compiledRoot, resolve(outputRoot, "js"), { recursive: true });
await cp(resolve(extensionRoot, "manifest.json"), resolve(outputRoot, "manifest.json"));
await cp(resolve(extensionRoot, "public"), outputRoot, { recursive: true });

console.log(`Cartiva extension built at ${outputRoot}`);
