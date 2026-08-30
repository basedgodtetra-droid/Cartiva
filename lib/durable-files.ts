import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import "./server-only-guard";

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Flush directory metadata after an atomic rename/remove. Node on Windows
 * cannot fsync directory handles; that platform is deliberately excluded from
 * production cart-write capability, while local development still gets a
 * flushed file plus atomic rename.
 */
export async function syncDurableDirectory(directory: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32"
      && process.env.NODE_ENV !== "production"
      && errorCode(error) === "EPERM"
    ) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function durableAtomicWriteFile(
  file: string,
  contents: string | Uint8Array,
  mode = 0o600,
) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, {
      mode,
      flag: "wx",
      flush: true,
    });
    await rename(temporary, file);
    await syncDurableDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function durableRename(source: string, destination: string) {
  await rename(source, destination);
  const sourceDirectory = path.dirname(source);
  const destinationDirectory = path.dirname(destination);
  await syncDurableDirectory(sourceDirectory);
  if (destinationDirectory !== sourceDirectory) {
    await syncDurableDirectory(destinationDirectory);
  }
}

export async function durableRemoveFile(file: string) {
  await rm(file, { force: true });
  try {
    await syncDurableDirectory(path.dirname(file));
  } catch (error) {
    // If the parent directory itself is absent, the target is definitively
    // absent too and there is no directory entry left to flush.
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}
