import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(extensionRoot, "build", "js"), { recursive: true, force: true });
await rm(resolve(extensionRoot, "dist"), { recursive: true, force: true });
