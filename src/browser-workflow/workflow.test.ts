import { expect, test } from "bun:test";

import { computeLiveDefinitionHash, projectLiveToInert } from "@intx/workflow";

import { createAuthoredWorkflow } from "./workflow";

test("projects the browser tool into both workflow modes", () => {
  for (const conversationEnabled of [false, true]) {
    const projection = projectLiveToInert(
      createAuthoredWorkflow(conversationEnabled),
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain("@intx-spike/browser/inspect-page");
    expect(serialized).not.toContain("sidecarPlacement");
  }
});

test("conversation mode has its own approved definition hash", async () => {
  const [childHash, conversationHash] = await Promise.all([
    computeLiveDefinitionHash(createAuthoredWorkflow(false)),
    computeLiveDefinitionHash(createAuthoredWorkflow(true)),
  ]);
  expect(conversationHash).not.toBe(childHash);
});
