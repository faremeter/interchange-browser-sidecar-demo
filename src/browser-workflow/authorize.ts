import { evaluateGrants } from "@intx/authz";
import { toolApprovalEffect, type ToolDeclaration } from "@intx/agent";
import type { GrantRule } from "@intx/types/authz";
import type { WorkflowAuthorizeFn } from "@intx/workflow";

export type CreateBrowserWorkflowAuthorizeOpts = {
  anchorRunId: string;
  getRunGrants(runId: string): readonly GrantRule[] | undefined;
  toolDefinitions: readonly ToolDeclaration[];
};

export function createBrowserWorkflowAuthorize(
  opts: CreateBrowserWorkflowAuthorizeOpts,
): WorkflowAuthorizeFn {
  const toolFloorGrants = opts.toolDefinitions.map(
    (definition): GrantRule => ({
      id: `floor:tool:${definition.name}`,
      resource: `tool:${definition.name}`,
      action: "invoke",
      effect: toolApprovalEffect(definition),
      origin: "creator",
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: null,
    }),
  );

  return async (resource, action) => {
    const runGrants = opts.getRunGrants(opts.anchorRunId);
    if (runGrants === undefined) {
      throw new Error(
        `browser workflow run ${opts.anchorRunId} has no Hub grants`,
      );
    }
    return evaluateGrants(
      [...runGrants, ...toolFloorGrants],
      resource,
      action,
    );
  };
}
