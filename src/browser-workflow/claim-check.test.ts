import { describe, expect, test } from "bun:test";

import {
  createBrowserClaimCheck,
  type BrowserClaimCheckMutator,
} from "./claim-check";

const ADDRESS = "run_demo@acme.localhost";
const MESSAGE_ID = "<mail-1@acme.localhost>";
const ADDRESS_ROOT = "addresses/run_demo%40acme.localhost";

describe("browser workflow claim-check", () => {
  test("moves mail through inbox, processing, and consumed", async () => {
    const store = createMemoryMutator();
    let time = 100;
    const claimCheck = createBrowserClaimCheck(store.mutator, () => time);

    await expect(
      claimCheck.enqueue({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        rawMessage: "cmF3LW1haWw=",
      }),
    ).resolves.toBe("enqueued");
    expect(store.paths()).toEqual([
      `${ADDRESS_ROOT}/inbox/100-${MESSAGE_ID}.json`,
    ]);

    const dequeued = await claimCheck.dequeue(ADDRESS, MESSAGE_ID);
    expect(dequeued).toMatchObject({
      address: ADDRESS,
      messageId: MESSAGE_ID,
      receivedAt: 100,
      rawMessage: "cmF3LW1haWw=",
    });
    expect(store.paths()).toEqual([
      `${ADDRESS_ROOT}/processing/100-${MESSAGE_ID}.json`,
    ]);

    time = 200;
    await claimCheck.markConsumed({
      address: ADDRESS,
      messageId: MESSAGE_ID,
      runId: "run_demo",
    });
    expect(store.paths()).toEqual([
      `${ADDRESS_ROOT}/consumed/${MESSAGE_ID}.json`,
      `${ADDRESS_ROOT}/watermark.json`,
    ]);
    expect(
      JSON.parse(store.required(`${ADDRESS_ROOT}/consumed/${MESSAGE_ID}.json`)),
    ).toMatchObject({
      address: ADDRESS,
      consumedAt: 200,
      messageId: MESSAGE_ID,
      receivedAt: 100,
      runId: "run_demo",
    });
    expect(store.commits).toEqual([
      `enqueue inbox ${ADDRESS} ${MESSAGE_ID}`,
      `dequeue ${ADDRESS} ${MESSAGE_ID}`,
      `consume ${ADDRESS} ${MESSAGE_ID}`,
    ]);
  });

  test("acknowledges a durable duplicate without dispatching it again", async () => {
    const store = createMemoryMutator();
    const claimCheck = createBrowserClaimCheck(store.mutator, () => 100);
    const mail = {
      address: ADDRESS,
      messageId: MESSAGE_ID,
      rawMessage: "cmF3LW1haWw=",
    };

    await expect(claimCheck.enqueue(mail)).resolves.toBe("enqueued");
    await expect(claimCheck.enqueue(mail)).resolves.toBe("already-present");
    await claimCheck.dequeue(ADDRESS, MESSAGE_ID);
    await expect(claimCheck.enqueue(mail)).resolves.toBe("already-present");
    await claimCheck.markConsumed({
      address: ADDRESS,
      messageId: MESSAGE_ID,
      runId: "run_demo",
    });
    await expect(claimCheck.enqueue(mail)).resolves.toBe("already-present");

    expect(store.commits).toHaveLength(3);
  });
});

function createMemoryMutator() {
  const files = new Map<string, string>();
  const commits: string[] = [];
  const mutator: BrowserClaimCheckMutator = {
    async mutate(message, compute) {
      const mutation = await compute({
        async list(directory) {
          const prefix = `${directory}/`;
          return [...files.keys()]
            .filter((filepath) => {
              if (!filepath.startsWith(prefix)) return false;
              return !filepath.slice(prefix.length).includes("/");
            })
            .map((filepath) => filepath.slice(prefix.length))
            .sort();
        },
        async read(filepath) {
          return files.get(filepath) ?? null;
        },
      });
      if (
        mutation.deletes.length > 0 ||
        Object.keys(mutation.puts).length > 0
      ) {
        for (const filepath of mutation.deletes) files.delete(filepath);
        for (const [filepath, value] of Object.entries(mutation.puts)) {
          files.set(filepath, value);
        }
        commits.push(message);
      }
      return mutation.value;
    },
  };
  return {
    commits,
    mutator,
    paths: () => [...files.keys()].sort(),
    required(filepath: string) {
      const value = files.get(filepath);
      if (value === undefined) throw new Error(`missing ${filepath}`);
      return value;
    },
  };
}
