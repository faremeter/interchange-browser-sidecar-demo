import { describe, expect, test } from "bun:test";

import type { GrantRule } from "@intx/types/authz";

import { createBrowserWorkflowAuthorize } from "./authorize";

const ANCHOR_RUN_ID = "run_demo";
const TOOL_DEFINITIONS = [{ name: "inspect_page" }];

describe("browser workflow authorization", () => {
  test("enforces the bundled tool floor after Hub grants arrive", async () => {
    const authorize = createAuthorize([]);

    await expect(
      authorize("tool:inspect_page", "invoke", {
        runId: "debug_page__0",
        stepId: "agent",
      }),
    ).resolves.toMatchObject({ effect: "allow" });
    await expect(
      authorize("tool:unknown", "invoke", {
        runId: "debug_page__0",
        stepId: "agent",
      }),
    ).resolves.toMatchObject({ effect: null });
  });

  test("lets an explicit Hub denial override the bundled tool floor", async () => {
    const authorize = createAuthorize([
      grant({
        id: "hub-deny-browser-info",
        resource: "tool:inspect_page",
        action: "invoke",
        effect: "deny",
      }),
    ]);

    await expect(
      authorize("tool:inspect_page", "invoke", {
        runId: "debug_page__0",
        stepId: "agent",
      }),
    ).resolves.toMatchObject({ effect: "deny" });
  });

  test("fails closed before the Hub grants are available", async () => {
    const authorize = createBrowserWorkflowAuthorize({
      anchorRunId: ANCHOR_RUN_ID,
      getRunGrants: () => undefined,
      toolDefinitions: TOOL_DEFINITIONS,
    });

    await expect(
      authorize("tool:inspect_page", "invoke", {
        runId: "debug_page__0",
        stepId: "agent",
      }),
    ).rejects.toThrow(`run ${ANCHOR_RUN_ID} has no Hub grants`);
  });
});

function createAuthorize(grants: readonly GrantRule[]) {
  return createBrowserWorkflowAuthorize({
    anchorRunId: ANCHOR_RUN_ID,
    getRunGrants: (runId) => (runId === ANCHOR_RUN_ID ? grants : undefined),
    toolDefinitions: TOOL_DEFINITIONS,
  });
}

function grant(
  overrides: Pick<GrantRule, "id" | "resource" | "action" | "effect">,
): GrantRule {
  return {
    ...overrides,
    origin: "invoker",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}
