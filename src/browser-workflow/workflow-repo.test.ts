import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import git from "isomorphic-git";

import { createBrowserIsogitStorage } from "@intx/storage-isogit/browser";
import {
  createIsogitStorage,
  createNodeIsogitRuntime,
} from "@intx/storage-isogit/node";

import { createBrowserWorkflowRepo } from "./workflow-repo";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("browser workflow repo restore", () => {
  test("preserves Hub paths, hydrates events, and commits on the restored ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-workflow-restore-"));
    temporaryDirectories.push(root);
    const sourceDir = join(root, "source");
    const targetDir = join(root, "target");
    const sourceRuntime = createNodeIsogitRuntime();
    const source = createIsogitStorage(sourceRuntime);
    await source.initRepo(sourceDir);

    const firstMessage = "<first@example.test>";
    const addressRoot = "addresses/run_parent%40acme.localhost";
    await writeTracked(sourceRuntime, sourceDir, {
      [`${addressRoot}/consumed/${firstMessage}.json`]: JSON.stringify({
        address: "run_parent@acme.localhost",
        consumedAt: 2,
        messageId: firstMessage,
        receivedAt: 1,
        runId: "run_parent",
      }),
      "runs/run_parent/events/1.json": JSON.stringify({
        seq: 1,
        type: "RunStarted",
        at: new Date(0).toISOString(),
        runId: "run_parent",
        definitionHash: "definition",
        trigger: { type: "manual", payload: "first" },
      }),
    });
    const sourceCommit = await git.commit({
      fs: sourceRuntime.fs,
      dir: sourceDir,
      author: { name: "hub", email: "hub@example.test" },
      message: "authoritative state",
    });
    const sourcePack = await source.createNegotiatedPack(
      sourceDir,
      [sourceCommit],
      [],
    );
    if (sourcePack === null) throw new Error("source pack was empty");

    const targetRuntime = createNodeIsogitRuntime();
    const targetBase = createIsogitStorage(targetRuntime);
    const storage = {
      ...targetBase,
      runtime: targetRuntime,
      fs: { promises: { mkdir, readFile, readdir, writeFile } },
    };
    // The production adapter uses LightningFS's promises facade. This test
    // supplies the same shape over an isolated Node runtime so it can exercise
    // real pack application and isomorphic-git index behavior under Bun.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional cross-runtime storage test adapter
    const browserStorage = storage as unknown as ReturnType<
      typeof createBrowserIsogitStorage
    >;
    const pushed: string[] = [];
    const repo = await createBrowserWorkflowRepo({
      repoId: { kind: "workflow-run", id: "run_parent-acme-localhost" },
      repoDirectory: targetDir,
      storage: browserStorage,
      async pushPack(args) {
        pushed.push(args.commitSha);
      },
    });
    await repo.restore({
      commitSha: sourceCommit,
      pack: sourcePack.pack,
      ref: "refs/heads/main",
      transferId: "restore-1",
    });

    expect((await repo.repoStore.read("run_parent")).map((event) => event.kind)).toEqual([
      "RunStarted",
    ]);

    await repo.claimCheck.enqueue({
      address: "run_parent@acme.localhost",
      messageId: "<second@example.test>",
      rawMessage: "c2Vjb25k",
    });
    expect(pushed).toHaveLength(1);
    const committedFiles = await git.listFiles({
      fs: targetRuntime.fs,
      dir: targetDir,
      ref: pushed[0],
    });
    expect(committedFiles).toContain(
      `${addressRoot}/consumed/${firstMessage}.json`,
    );
    expect(
      committedFiles.some((filepath) => filepath.startsWith(`${addressRoot}/inbox/`)),
    ).toBe(true);
    expect(committedFiles).toContain("runs/run_parent/events/1.json");
  });
});

async function writeTracked(
  runtime: ReturnType<typeof createNodeIsogitRuntime>,
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [filepath, value] of Object.entries(files)) {
    const absolute = join(directory, filepath);
    await mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
      recursive: true,
    });
    await writeFile(absolute, value);
    await git.add({ fs: runtime.fs, dir: directory, filepath });
  }
}
