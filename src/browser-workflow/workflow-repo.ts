import git from "isomorphic-git";

import { createBrowserIsogitStorage } from "@intx/storage-isogit/browser";
import type { RepoId } from "@intx/types/sidecar";
import {
  createInMemoryRepoStore,
  type RepoStore,
  type WorkflowEvent,
} from "@intx/workflow";

import {
  createBrowserClaimCheck,
  type BrowserClaimCheck,
  type BrowserClaimCheckMutation,
  type BrowserClaimCheckReads,
} from "./claim-check";

const EVENTS_REF = "refs/heads/main";

export type CreateBrowserWorkflowRepoOpts = {
  storage: ReturnType<typeof createBrowserIsogitStorage>;
  repoId: RepoId;
  pushPack(args: {
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
  }): Promise<void>;
};

export type BrowserWorkflowRepo = {
  claimCheck: BrowserClaimCheck;
  repoStore: RepoStore;
};

export type RestoreBrowserWorkflowRepoOpts = {
  storage: ReturnType<typeof createBrowserIsogitStorage>;
  repoId: RepoId;
  pack: Uint8Array;
  ref: string;
  commitSha: string;
  transferId: string;
};

function workflowRepoDir(repoId: RepoId): string {
  return `/workflow-runs/${repoId.id}`;
}

/** Install the Hub-authoritative workflow-run ref before execution starts. */
export async function restoreBrowserWorkflowRepo(
  opts: RestoreBrowserWorkflowRepoOpts,
): Promise<void> {
  if (opts.repoId.kind !== "workflow-run") {
    throw new Error(
      `cannot restore ${opts.repoId.kind} as a workflow-run repo`,
    );
  }
  const storage = opts.storage;
  const repoDir = workflowRepoDir(opts.repoId);
  await storage.initRepo(repoDir);
  let current: string | null = null;
  try {
    current = await git.resolveRef({
      fs: storage.runtime.fs,
      dir: repoDir,
      ref: opts.ref,
    });
  } catch (cause) {
    if (!(cause instanceof Error) || cause.name !== "NotFoundError") {
      throw cause;
    }
  }
  if (current === opts.commitSha) return;
  await storage.applyPack(
    repoDir,
    opts.pack,
    opts.ref,
    opts.commitSha,
    opts.transferId,
  );
}

/**
 * Build the browser workflow's event store on a LightningFS Git repository.
 * Every append batch is one local commit and one ordinary workflow-run pack
 * push, so the hub observes the same event tree shape as a Bun sidecar.
 */
export async function createBrowserWorkflowRepo(
  opts: CreateBrowserWorkflowRepoOpts,
): Promise<BrowserWorkflowRepo> {
  const storage = opts.storage;
  const runtime = storage.storageRuntime;
  const repoDir = workflowRepoDir(opts.repoId);
  await storage.initRepo(repoDir);

  const memory = createInMemoryRepoStore();
  let commitQueue = Promise.resolve();
  let lastPushedCommitSha: string | undefined;

  async function mutate<T>(
    message: string,
    compute: (
      reads: BrowserClaimCheckReads,
    ) => Promise<BrowserClaimCheckMutation<T>>,
  ): Promise<T> {
    const task = commitQueue.then(async () => {
      const mutation = await compute({
        async list(directory) {
          try {
            return await storage.fs.promises.readdir(`${repoDir}/${directory}`);
          } catch (cause) {
            if (isMissing(cause)) return [];
            throw cause;
          }
        },
        async read(filepath) {
          try {
            return await storage.fs.promises.readFile(
              `${repoDir}/${filepath}`,
              "utf8",
            );
          } catch (cause) {
            if (isMissing(cause)) return null;
            throw cause;
          }
        },
      });
      if (
        mutation.deletes.length === 0 &&
        Object.keys(mutation.puts).length === 0
      ) {
        return mutation.value;
      }

      for (const filepath of mutation.deletes) {
        await git.remove({ fs: storage.runtime.fs, dir: repoDir, filepath });
      }
      for (const [filepath, value] of Object.entries(mutation.puts)) {
        const absolute = `${repoDir}/${filepath}`;
        await runtime.fs.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
          recursive: true,
        });
        await storage.fs.promises.writeFile(absolute, value);
        await git.add({ fs: storage.runtime.fs, dir: repoDir, filepath });
      }
      await commitAndPush(message);
      return mutation.value;
    });
    commitQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function commitAndPush(message: string): Promise<void> {
    const branch = await git.currentBranch({
      fs: storage.runtime.fs,
      dir: repoDir,
      fullname: true,
    });
    const commitSha = await git.commit({
      fs: storage.runtime.fs,
      dir: repoDir,
      noUpdateBranch: true,
      author: {
        name: "interchange-browser-sidecar",
        email: "browser-sidecar@interchange.local",
      },
      message,
    });
    await storage.runtime.flush?.();
    await git.writeRef({
      fs: storage.runtime.fs,
      dir: repoDir,
      ref: branch ?? "HEAD",
      value: commitSha,
      force: true,
    });
    await storage.runtime.flush?.();

    const built = await storage.createNegotiatedPack(
      repoDir,
      [commitSha],
      lastPushedCommitSha === undefined ? [] : [lastPushedCommitSha],
    );
    if (built === null) {
      throw new Error(`workflow-run pack for ${commitSha} was empty`);
    }
    await opts.pushPack({
      repoId: opts.repoId,
      pack: built.pack,
      ref: EVENTS_REF,
      commitSha,
    });
    lastPushedCommitSha = commitSha;
  }

  async function commitEvents(
    runId: string,
    events: readonly WorkflowEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const task = commitQueue.then(async () => {
      for (const event of events) {
        const filepath = `runs/${runId}/events/${String(event.seq)}.json`;
        const absolute = `${repoDir}/${filepath}`;
        await runtime.fs.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
          recursive: true,
        });
        const { kind, ...rest } = event;
        await storage.fs.promises.writeFile(
          absolute,
          JSON.stringify({ ...rest, seq: event.seq, type: kind }),
        );
        await git.add({ fs: storage.runtime.fs, dir: repoDir, filepath });
      }

      const first = events[0];
      const last = events[events.length - 1];
      if (first === undefined || last === undefined) return;
      await commitAndPush(
        events.length === 1
          ? `append workflow event ${first.kind} for run ${runId}`
          : `append ${String(events.length)} workflow events ${first.kind}..${last.kind} for run ${runId}`,
      );
      await memory.appendBatch(runId, events);
    });
    commitQueue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  return {
    claimCheck: createBrowserClaimCheck({ mutate }),
    repoStore: {
      read: memory.read.bind(memory),
      append(runId, event) {
        return commitEvents(runId, [event]);
      },
      appendBatch: commitEvents,
      subscribe: memory.subscribe.bind(memory),
    },
  };
}

function isMissing(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    Reflect.get(cause, "code") === "ENOENT"
  );
}
