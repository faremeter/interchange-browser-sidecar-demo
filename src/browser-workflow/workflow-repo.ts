import { type } from "arktype";
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
const EVENT_FILENAME = /^(0|[1-9][0-9]*)\.json$/;

const OnDiskEvent = type({
  seq: "number >= 0",
  type: "string",
  "[string]": "unknown",
});

const restoredCommits = new WeakMap<
  ReturnType<typeof createBrowserIsogitStorage>,
  Map<string, string>
>();

export type CreateBrowserWorkflowRepoOpts = {
  storage: ReturnType<typeof createBrowserIsogitStorage>;
  repoId: RepoId;
  /** Override used by isolated adapters and tests; browsers use the default. */
  repoDirectory?: string;
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
  restore(
    opts: Omit<RestoreBrowserWorkflowRepoOpts, "storage" | "repoId">,
  ): Promise<void>;
};

export type RestoreBrowserWorkflowRepoOpts = {
  storage: ReturnType<typeof createBrowserIsogitStorage>;
  repoId: RepoId;
  pack: Uint8Array;
  ref: string;
  commitSha: string;
  transferId: string;
  /** Override used by isolated adapters and tests; browsers use the default. */
  repoDirectory?: string;
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
  const repoDir = opts.repoDirectory ?? workflowRepoDir(opts.repoId);
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
  if (current !== opts.commitSha) {
    await storage.applyPack(
      repoDir,
      opts.pack,
      opts.ref,
      opts.commitSha,
      opts.transferId,
    );
  }

  // applyPack materializes the working tree and advances the ref, but it does
  // not rewrite isomorphic-git's index. This repository commits new workflow
  // events, so its index must also match the restored tree or the next commit
  // can accidentally delete paths that arrived from the Hub.
  const branch = opts.ref.startsWith("refs/heads/")
    ? opts.ref.slice("refs/heads/".length)
    : opts.ref;
  await git.checkout({
    fs: storage.runtime.fs,
    dir: repoDir,
    ref: branch,
    force: true,
  });
  await storage.runtime.flush?.();
  let commits = restoredCommits.get(storage);
  if (commits === undefined) {
    commits = new Map();
    restoredCommits.set(storage, commits);
  }
  commits.set(opts.repoId.id, opts.commitSha);
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
  const repoDir = opts.repoDirectory ?? workflowRepoDir(opts.repoId);
  await storage.initRepo(repoDir);

  const memory = createInMemoryRepoStore();
  let commitQueue = Promise.resolve();
  let lastPushedCommitSha = restoredCommits.get(storage)?.get(opts.repoId.id);
  if (lastPushedCommitSha !== undefined) {
    await hydrateEventStore(storage, repoDir, memory);
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = commitQueue.then(operation);
    commitQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function mutate<T>(
    message: string,
    compute: (
      reads: BrowserClaimCheckReads,
    ) => Promise<BrowserClaimCheckMutation<T>>,
  ): Promise<T> {
    return enqueue(async () => {
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
    try {
      await opts.pushPack({
        repoId: opts.repoId,
        pack: built.pack,
        ref: EVENTS_REF,
        commitSha,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `workflow-run push ${commitSha} from ${lastPushedCommitSha ?? "empty"} failed: ${detail}`,
        { cause },
      );
    }
    lastPushedCommitSha = commitSha;
  }

  async function commitEvents(
    runId: string,
    events: readonly WorkflowEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    await enqueue(async () => {
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
  }

  async function restore(
    restoreOpts: Omit<
      RestoreBrowserWorkflowRepoOpts,
      "storage" | "repoId"
    >,
  ): Promise<void> {
    await enqueue(async () => {
      await restoreBrowserWorkflowRepo({
        ...restoreOpts,
        repoId: opts.repoId,
        repoDirectory: repoDir,
        storage,
      });
      await hydrateEventStore(storage, repoDir, memory);

      // The received ref is the Hub's authoritative base. Negotiating the
      // next outgoing pack against it preserves every restored path instead
      // of proposing a new root commit that replaces the prior tree.
      lastPushedCommitSha = restoreOpts.commitSha;
    });
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
    restore,
  };
}

async function hydrateEventStore(
  storage: ReturnType<typeof createBrowserIsogitStorage>,
  repoDir: string,
  memory: RepoStore,
): Promise<void> {
  const runs = await listDirectory(storage, `${repoDir}/runs`);
  for (const runId of runs) {
    const existing = await memory.read(runId);
    if (existing.length > 0) continue;

    const runDir = `${repoDir}/runs/${runId}`;
    const children = await listDirectory(storage, runDir);
    const hasCombined = children.includes("events.jsonl");
    const hasPerEvent = children.includes("events");
    if (hasCombined && hasPerEvent) {
      throw new Error(
        `workflow-run ${runId} carries both events.jsonl and events/`,
      );
    }

    const events = hasCombined
      ? await readCombinedEvents(storage, `${runDir}/events.jsonl`)
      : await readPerEventEvents(storage, `${runDir}/events`);
    await memory.appendBatch(runId, events);
  }
}

async function readCombinedEvents(
  storage: ReturnType<typeof createBrowserIsogitStorage>,
  filepath: string,
): Promise<WorkflowEvent[]> {
  const raw = await storage.fs.promises.readFile(filepath, "utf8");
  const events = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) =>
      parseOnDiskEvent(line, `${filepath}:${String(index + 1)}`),
    );
  events.sort((left, right) => left.seq - right.seq);
  return events;
}

async function readPerEventEvents(
  storage: ReturnType<typeof createBrowserIsogitStorage>,
  directory: string,
): Promise<WorkflowEvent[]> {
  const filenames = await listDirectory(storage, directory);
  const events: WorkflowEvent[] = [];
  for (const filename of filenames) {
    const match = EVENT_FILENAME.exec(filename);
    const seqText = match?.[1];
    if (seqText === undefined) continue;
    const seq = Number.parseInt(seqText, 10);
    const filepath = `${directory}/${filename}`;
    const raw = await storage.fs.promises.readFile(filepath, "utf8");
    const event = parseOnDiskEvent(raw, filepath);
    if (event.seq !== seq) {
      throw new Error(
        `workflow-run event ${filepath} has seq ${String(event.seq)}, expected ${String(seq)}`,
      );
    }
    events.push(event);
  }
  events.sort((left, right) => left.seq - right.seq);
  return events;
}

function parseOnDiskEvent(raw: string, source: string): WorkflowEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`workflow-run event ${source} is not valid JSON`, {
      cause,
    });
  }
  const envelope = OnDiskEvent(parsed);
  if (envelope instanceof type.errors) {
    throw new Error(
      `workflow-run event ${source} is invalid: ${envelope.summary}`,
    );
  }
  if (!Number.isInteger(envelope.seq) || envelope.seq < 1) {
    throw new Error(
      `workflow-run event ${source} has invalid seq ${String(envelope.seq)}`,
    );
  }
  const { seq, type: kind, ...rest } = envelope;
  // This is the same open envelope used by Interchange's production
  // workflow-run adapter. The state machine validates the discriminated
  // event when it reduces the restored log.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated substrate envelope translated at its kind/type boundary
  return { ...rest, kind, seq } as unknown as WorkflowEvent;
}

async function listDirectory(
  storage: ReturnType<typeof createBrowserIsogitStorage>,
  directory: string,
): Promise<string[]> {
  try {
    return await storage.fs.promises.readdir(directory);
  } catch (cause) {
    if (isMissing(cause)) return [];
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
