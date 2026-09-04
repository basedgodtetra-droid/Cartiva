import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function excludedTrackedFiles(paths: string[]) {
  return execFileSync("git", [
    "ls-files", "--cached", "--ignored", "--exclude-from=.vercelignore", "--", ...paths,
  ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true })
    .split(/\r?\n/).filter(Boolean);
}

describe("deployment source boundaries", () => {
  it("never excludes tracked application routes or their shared source", () => {
    expect(excludedTrackedFiles([
      "app", "components", "lib", "packages/shared", "config", "worker",
    ])).toEqual([]);
  });

  it("still excludes the separate root mobile client and extension", () => {
    const excluded = excludedTrackedFiles(["mobile", "cartiva-extension"]);
    expect(excluded.some((path) => path.startsWith("mobile/"))).toBe(true);
    expect(excluded.some((path) => path.startsWith("cartiva-extension/"))).toBe(true);
  });
});
