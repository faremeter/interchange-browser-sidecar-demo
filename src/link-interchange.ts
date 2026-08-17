import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";

const interchangeDirectory = path.resolve(
  Bun.env.INTERCHANGE_SOURCE_DIR ??
    path.join(import.meta.dir, "../../interchange"),
);
const packageNames = [
  "agent",
  "authz",
  "crypto",
  "mime",
  "pack-transport",
  "storage-isogit",
  "types",
  "workflow",
  "workflow-deploy",
];
const targetScope = path.join(interchangeDirectory, "node_modules/@intx");
const linkScope = path.join(import.meta.dir, "../node_modules/@intx");

if (!(await isDirectory(targetScope))) {
  throw new Error(
    `Interchange workspace packages are unavailable at ${targetScope}; run bun install in ${interchangeDirectory} first`,
  );
}

await mkdir(linkScope, { recursive: true });
for (const packageName of packageNames) {
  const target = path.join(targetScope, packageName);
  const link = path.join(linkScope, packageName);
  await ensureDirectoryLink(target, link);
}

async function ensureDirectoryLink(target: string, link: string) {
  try {
    const existingTarget = await readlink(link);
    if (path.resolve(path.dirname(link), existingTarget) !== target) {
      throw new Error(
        `${link} already points to ${existingTarget}; remove it before linking ${target}`,
      );
    }
  } catch (cause) {
    if (isMissing(cause)) {
      await symlink(target, link, "dir");
    } else {
      throw cause;
    }
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

function isMissing(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    Reflect.get(cause, "code") === "ENOENT"
  );
}
