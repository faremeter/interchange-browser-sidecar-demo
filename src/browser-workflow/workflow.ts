import {
  createAgent,
  createDefaultDirectorRegistry,
  defineAgent,
  defineTool,
  type BaseEnv,
  type ToolBundle,
} from "@intx/agent";
import { generateKeyPair } from "@intx/crypto";
import { parseMailToEmail } from "@intx/mime";
import { createBrowserIsogitStorage } from "@intx/storage-isogit/browser";
import { base64Decode, deriveWorkflowRunId } from "@intx/types";
import type { GrantRule } from "@intx/types/authz";
import type { AgentDeployFrame, MailInboundFrame } from "@intx/types/sidecar";
import type {
  ConversationTurn,
  InferenceSource,
  KeyPair,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";
import {
  createInMemoryBlobSubstrate,
  createInMemoryScheduler,
  createInMemorySignalChannel,
  createNoopDrainController,
  defineWorkflow,
  onTrigger,
  runtimeRun,
  step,
  type OnTriggerPrimitive,
  type RepoStore,
  type RunResult,
  type SignalChannel,
  type SpawnChildWorkflow,
  type SpawnSuspendableChild,
  type StepInvoker,
  type WorkflowRun,
  type WorkflowAuthorizeFn,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import { deriveWorkflowRunRepoId } from "@intx/workflow-deploy";

import {
  createBrowserHubLink,
  type BrowserHubLink,
  type BrowserHubLinkStatus,
} from "./hub-link";
import { createBrowserWorkflowAuthorize } from "./authorize";
import type { BrowserClaimCheck } from "./claim-check";
import { createBrowserWorkflowRepo } from "./workflow-repo";
import { restoreBrowserWorkflowRepo } from "./workflow-repo";

const SECTION_ID = "fact_check";
const BODY_STEP_ID = "agent";
const AGENT_SYSTEM_PROMPT =
  "Always call browser_info first. Then assess the user's claim from model knowledge. Clearly label it true, false, misleading, or unverifiable and give a concise explanation. Say that browser execution was verified, but do not claim you browsed or checked external sources.";
const AGENT_INFERENCE = {
  sources: [{ provider: "anthropic", model: "claude-haiku-4-5-20251001" }],
};

const browserInfoTool = defineTool<BaseEnv>({
  id: "@intx-spike/browser/info",
  definitions: [{ name: "browser_info" }],
  factory: (): ToolBundle => ({
    definitions: [
      {
        name: "browser_info",
        description: "Report the browser user agent executing this workflow",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    async run(call: ToolCall, _signal: AbortSignal): Promise<ToolResult> {
      return {
        callId: call.id,
        content: JSON.stringify({ userAgent: navigator.userAgent }),
        isError: false,
      };
    },
  }),
});

const agent = defineAgent({
  id: "browser-bundled-agent",
  systemPrompt: AGENT_SYSTEM_PROMPT,
  tools: [browserInfoTool],
  capabilities: [],
  inference: AGENT_INFERENCE,
});

// The Hub needs the declarative shape for deployment and source resolution,
// but the executable browser_info factory lives only in the downloaded
// bundle. Keeping it out of workflow.json is the point of prebundling code.
const hubAgent = defineAgent({
  id: agent.id,
  systemPrompt: AGENT_SYSTEM_PROMPT,
  tools: [],
  capabilities: [],
  inference: AGENT_INFERENCE,
});

const bodyWorkflow = defineWorkflow({
  id: "browser-bundled-workflow__fact_check",
  trigger: { type: "manual" },
  steps: { [BODY_STEP_ID]: step({ agent }) },
});

const hubBodyWorkflow = defineWorkflow({
  id: bodyWorkflow.id,
  trigger: { type: "manual" },
  steps: { [BODY_STEP_ID]: step({ agent: hubAgent }) },
});

const authoredSection = onTrigger({
  on: { type: "manual" },
  body: hubBodyWorkflow,
});
const deployedSection: OnTriggerPrimitive = {
  ...authoredSection,
  body: { ref: bodyWorkflow.id },
};

/** Definition stored in the ordinary Hub workflow asset. */
export const authoredWorkflow = defineWorkflow({
  id: "browser-bundled-workflow",
  sidecarPlacement: { sharing: "exclusive", reuse: "same-deployment" },
  steps: { [SECTION_ID]: authoredSection },
});

/** Equivalent deployment projection consumed by the prebundled runtime. */
export const workflow = defineWorkflow({
  id: authoredWorkflow.id,
  sidecarPlacement: { sharing: "exclusive", reuse: "same-deployment" },
  steps: { [SECTION_ID]: deployedSection },
});

export const manifest = Object.freeze({
  workflowId: workflow.id,
  toolNames: ["browser_info"],
});

export type ConnectBrowserWorkflowOptions = {
  anchorRunId: string;
  databaseName: string;
  hubWebSocketURL: string;
  sidecarId: string;
  sidecarToken: string;
};

export type BrowserWorkflowResult = {
  childEventKinds: string[];
  childRunId: string;
  childRunIds: string[];
  deploymentId: string;
  output: unknown;
  parentEventKinds: string[];
  parentRunId: string;
  terminalStatus: "completed" | "failed" | "cancelled";
  turns: ConversationTurn[];
};

type BrowserDeploymentRuntime = {
  agentAddress: string;
  blobs: ReturnType<typeof createInMemoryBlobSubstrate>;
  claimCheck: BrowserClaimCheck;
  childResults: Map<string, Promise<RunResult>>;
  childTurns: Map<string, ConversationTurn[]>;
  deploymentId: string;
  invokeStep: StepInvoker;
  newId: (prefix: string) => string;
  authorize: WorkflowAuthorizeFn;
  parentRun: WorkflowRun | undefined;
  parentRunId: string;
  repoStore: RepoStore;
  scheduler: ReturnType<typeof createInMemoryScheduler>;
  signalChannel: SignalChannel;
  spawnSuspendableChild: SpawnSuspendableChild;
};

let activeRuntime: BrowserDeploymentRuntime | undefined;
let activeHubLink: BrowserHubLink | undefined;
let triggerQueue = Promise.resolve();
let connectPromise: Promise<void> | undefined;
const deploymentKeys = new Map<string, KeyPair>();
const runGrants = new Map<string, readonly GrantRule[]>();
const statusListeners = new Set<(status: BrowserHubLinkStatus) => void>();

export function subscribeStatus(
  listener: (status: BrowserHubLinkStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function connect(options: ConnectBrowserWorkflowOptions): Promise<void> {
  if (connectPromise !== undefined) return connectPromise;
  const storage = createBrowserIsogitStorage(options.databaseName);
  const link = createBrowserHubLink({
    hubURL: options.hubWebSocketURL,
    sidecarId: options.sidecarId,
    token: options.sidecarToken,
    getKeyPair: async (address) => deploymentKeys.get(address) ?? null,
    onDeploy: (frame) => deploy(frame, storage, link, options.anchorRunId),
    onMailInbound: handleMailInbound,
    onRunGrants: async (frame) => {
      runGrants.set(frame.runId, frame.stepGrants);
    },
    onWorkflowRunPack: async (args) => {
      const expectedRepoId = deriveWorkflowRunRepoId(args.agentAddress);
      if (
        args.repoId.kind !== "workflow-run" ||
        args.repoId.id !== expectedRepoId
      ) {
        throw new Error(
          `workflow-run repo ${args.repoId.id} does not match ${args.agentAddress}`,
        );
      }
      await restoreBrowserWorkflowRepo({
        storage,
        ...args,
      });
    },
    onStatus: (status) => {
      for (const listener of statusListeners) listener(status);
    },
  });
  activeHubLink = link;
  connectPromise = link.connect();
  return connectPromise;
}

export async function disconnect(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  activeHubLink?.close();
  activeHubLink = undefined;
  connectPromise = undefined;
  deploymentKeys.clear();
  triggerQueue = Promise.resolve();
  if (runtime?.parentRun !== undefined) {
    void runtime.parentRun.cancel("self", "sidecar allocation destroyed");
    await runtime.parentRun.complete.catch(() => undefined);
  }
  runGrants.clear();
}

async function deploy(
  frame: AgentDeployFrame,
  storage: ReturnType<typeof createBrowserIsogitStorage>,
  hubLink: BrowserHubLink,
  anchorRunId: string,
): Promise<KeyPair> {
  const existingKey = deploymentKeys.get(frame.agentAddress);
  if (frame.provisionStep === true) {
    const keyPair = existingKey ?? (await generateKeyPair());
    deploymentKeys.set(frame.agentAddress, keyPair);
    return keyPair;
  }
  if (frame.workflow === undefined) {
    throw new Error("browser bundle requires a workflow deployment frame");
  }
  if (frame.workflow.definition.id !== workflow.id) {
    throw new Error(
      `browser bundle contains ${workflow.id}, but the hub deployed ${frame.workflow.definition.id}`,
    );
  }
  const deployedRunId = deriveWorkflowRunId(frame.agentAddress);
  if (deployedRunId !== anchorRunId) {
    throw new Error(
      `browser allocation anchor ${anchorRunId} does not match deployment address ${frame.agentAddress}`,
    );
  }
  if (activeRuntime !== undefined) {
    if (activeRuntime.agentAddress !== frame.agentAddress) {
      throw new Error(
        "one browser bundle instance can host only one workflow deployment",
      );
    }
    const keyPair = deploymentKeys.get(frame.agentAddress);
    if (keyPair === undefined) {
      throw new Error("active browser deployment lost its signing key");
    }
    return keyPair;
  }

  const source = resolveBodySource(frame);
  const keyPair = existingKey ?? (await generateKeyPair());
  deploymentKeys.set(frame.agentAddress, keyPair);
  const deploymentId = deriveWorkflowRunRepoId(frame.agentAddress);
  activeRuntime = await createRuntime({
    agentAddress: frame.agentAddress,
    anchorRunId,
    deploymentId,
    hubLink,
    source,
    storage,
  });
  return keyPair;
}

function resolveBodySource(frame: AgentDeployFrame): InferenceSource {
  const deployed = frame.workflow;
  if (deployed === undefined) {
    throw new Error("workflow deployment has no source projection");
  }
  const body = deployed.referencedDefinitions?.find(
    (candidate) => candidate.definition.id === bodyWorkflow.id,
  );
  const source =
    body?.sources[BODY_STEP_ID]?.[0] ??
    deployed.sources[BODY_STEP_ID]?.[0] ??
    Object.values(deployed.sources)[0]?.[0];
  if (source === undefined) {
    throw new Error(
      `hub deployment did not pin an inference source for ${bodyWorkflow.id}/${BODY_STEP_ID}`,
    );
  }
  return source;
}

async function handleMailInbound(
  frame: MailInboundFrame,
  messageId: string,
): Promise<{ completion: Promise<BrowserWorkflowResult> | null }> {
  const runtime = activeRuntime;
  if (runtime === undefined || runtime.agentAddress !== frame.agentAddress) {
    throw new Error(
      `no browser deployment is registered for ${frame.agentAddress}`,
    );
  }
  const outcome = await runtime.claimCheck.enqueue({
    address: frame.agentAddress,
    messageId,
    rawMessage: frame.rawMessage,
  });
  if (outcome === "already-present") return { completion: null };
  return { completion: queueTrigger(runtime, messageId) };
}

function parseTriggerInput(rawMessage: string, messageId: string): string {
  const parsed = parseMailToEmail(base64Decode(rawMessage), messageId);
  const textPart = parsed.textBody[0];
  const text =
    (textPart === undefined
      ? undefined
      : parsed.bodyValues[textPart.partId]?.value) ?? parsed.subject;
  if (text === null || text === undefined || text.trim() === "") {
    throw new Error("workflow trigger mail has no text content");
  }
  return text;
}

function queueTrigger(
  runtime: BrowserDeploymentRuntime,
  messageId: string,
): Promise<BrowserWorkflowResult> {
  const result = triggerQueue.then(async () => {
    const envelope = await runtime.claimCheck.dequeue(
      runtime.agentAddress,
      messageId,
    );
    if (envelope === null) {
      throw new Error(`browser claim-check lost queued mail ${messageId}`);
    }
    const completed = await triggerWorkflow(
      runtime,
      parseTriggerInput(envelope.rawMessage, messageId),
      messageId,
    );
    await runtime.claimCheck.markConsumed({
      address: runtime.agentAddress,
      messageId,
      runId: runtime.parentRunId,
    });
    return completed;
  });
  triggerQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function triggerWorkflow(
  runtime: BrowserDeploymentRuntime,
  input: string,
  messageId: string,
): Promise<BrowserWorkflowResult> {
  if (activeRuntime !== runtime) {
    throw new Error("browser sidecar received a trigger before deployment");
  }
  const parentLog = await runtime.repoStore.read(runtime.parentRunId);
  const childIndex = parentLog.filter(
    (event) => event.kind === "ChildSpawned",
  ).length;
  const childRunId = `${SECTION_ID}__${String(childIndex)}`;
  const subscriptionAbort = new AbortController();
  const rearmed = waitForChildAndRearm(
    runtime.repoStore,
    runtime.parentRunId,
    childRunId,
    subscriptionAbort.signal,
  );

  try {
    if (runtime.parentRun === undefined) {
      runtime.parentRun = runtimeRun(workflow, createParentEnv(runtime), {
        runId: runtime.parentRunId,
        triggerPayload: input,
        consumedMessageId: messageId,
      });
    } else {
      const signalName = findInputSignal(parentLog);
      await runtime.parentRun.signal(signalName, input, messageId);
    }

    await Promise.race([
      rearmed,
      runtime.parentRun.complete.then(
        (result) => {
          throw new Error(
            `browser deployment parent ended ${result.terminalStatus}`,
          );
        },
        (cause: unknown) => {
          throw new Error("browser deployment parent crashed", { cause });
        },
      ),
    ]);
  } finally {
    subscriptionAbort.abort();
  }

  const childResultPromise = runtime.childResults.get(childRunId);
  if (childResultPromise === undefined) {
    throw new Error(`browser deployment did not start child ${childRunId}`);
  }
  const childResult = await childResultPromise;
  const turns = runtime.childTurns.get(childRunId);
  if (turns === undefined) {
    throw new Error(`browser deployment child ${childRunId} has no turns`);
  }
  const [updatedParentLog, childLog] = await Promise.all([
    runtime.repoStore.read(runtime.parentRunId),
    runtime.repoStore.read(childRunId),
  ]);

  return {
    childEventKinds: childLog.map((event) => event.kind),
    childRunId,
    childRunIds: updatedParentLog.flatMap((event) =>
      event.kind === "ChildSpawned" ? [event.childRunId] : [],
    ),
    deploymentId: runtime.deploymentId,
    output: childResult.outputs[BODY_STEP_ID],
    parentEventKinds: updatedParentLog.map((event) => event.kind),
    parentRunId: runtime.parentRunId,
    terminalStatus: childResult.terminalStatus,
    turns,
  };
}

async function createRuntime(args: {
  agentAddress: string;
  anchorRunId: string;
  deploymentId: string;
  hubLink: BrowserHubLink;
  source: InferenceSource;
  storage: ReturnType<typeof createBrowserIsogitStorage>;
}): Promise<BrowserDeploymentRuntime> {
  const workflowRepo = await createBrowserWorkflowRepo({
    repoId: { kind: "workflow-run", id: args.deploymentId },
    storage: args.storage,
    pushPack: (pack) =>
      args.hubLink.pushWorkflowRunPack({
        agentAddress: args.agentAddress,
        ...pack,
      }),
  });
  const repoStore = workflowRepo.repoStore;
  const signalChannel = createInMemorySignalChannel();
  const blobs = createInMemoryBlobSubstrate();
  const clock = () => new Date();
  let nextId = 0;
  const newId = (prefix: string) => {
    nextId += 1;
    return `${prefix}-${String(nextId)}`;
  };
  const scheduler = createInMemoryScheduler({ repoStore, clock });
  const childResults = new Map<string, Promise<RunResult>>();
  const childTurns = new Map<string, ConversationTurn[]>();
  const authorize = createBrowserWorkflowAuthorize({
    anchorRunId: args.anchorRunId,
    getRunGrants: (runId) => runGrants.get(runId),
    toolDefinitions: browserInfoTool.definitions,
  });
  const invokeStep = createStepInvoker({
    authorize,
    childTurns,
    deploymentId: args.deploymentId,
    parentRunId: args.anchorRunId,
    source: args.source,
    storage: args.storage,
  });

  const runtime: BrowserDeploymentRuntime = {
    agentAddress: args.agentAddress,
    blobs,
    claimCheck: workflowRepo.claimCheck,
    childResults,
    childTurns,
    deploymentId: args.deploymentId,
    invokeStep,
    newId,
    authorize,
    parentRun: undefined,
    parentRunId: args.anchorRunId,
    repoStore,
    scheduler,
    signalChannel,
    spawnSuspendableChild: async () => {
      throw new Error("browser child spawner is not initialized");
    },
  };
  runtime.spawnSuspendableChild = createChildSpawner(runtime, clock);
  return runtime;
}

function createStepInvoker(args: {
  authorize: WorkflowAuthorizeFn;
  childTurns: Map<string, ConversationTurn[]>;
  deploymentId: string;
  parentRunId: string;
  source: InferenceSource;
  storage: ReturnType<typeof createBrowserIsogitStorage>;
}): StepInvoker {
  return async (request) => {
    const childRunId = request.authzContext.runId;
    if (childRunId === undefined) {
      throw new Error("browser workflow step has no child run id");
    }
    const workdir = `/deployments/${args.deploymentId}/runs/${args.parentRunId}/children/${childRunId}/${request.authzContext.stepId ?? "step"}`;
    const agentStore = await args.storage.createIsogitStore(workdir);
    const runningAgent = await createAgent(request.agent, {
      sources: [args.source],
      defaultSource: args.source.id,
      storage: agentStore,
      audit: agentStore,
      workdir,
      directors: createDefaultDirectorRegistry(),
      authorize: (resource, action) =>
        args.authorize(resource, action, request.authzContext),
    });

    try {
      const result = await runningAgent.send(encodeInput(request.input), {
        signal: request.signal,
      });
      if (result.type === "suspended") {
        throw new Error(
          "browser workflow spike does not support approval suspension",
        );
      }
      return { output: { reply: result.reply, turn: result.turn } };
    } finally {
      await runningAgent.close();
      const state = await agentStore.load();
      args.childTurns.set(childRunId, state.turns);
    }
  };
}

function createChildSpawner(
  runtime: BrowserDeploymentRuntime,
  clock: () => Date,
): SpawnSuspendableChild {
  return async (request) => {
    if (request.definitionRef !== bodyWorkflow.id) {
      throw new Error(
        `browser deployment cannot resolve child definition ${request.definitionRef}`,
      );
    }

    const childSignalChannel = createInMemorySignalChannel({
      newId: () => runtime.newId("child-signal"),
    });
    const childRun = runtimeRun(
      bodyWorkflow,
      createChildEnv(runtime, childSignalChannel, clock),
      {
        runId: request.childRunId,
        ...(request.resumeFromEvents === undefined
          ? { triggerPayload: request.input }
          : { resumeFromEvents: request.resumeFromEvents }),
      },
    );
    runtime.childResults.set(request.childRunId, childRun.complete);

    const cancelChild = (): void => {
      void childRun.cancel("self", "parent cancelled");
    };
    if (request.signal.aborted) {
      cancelChild();
    } else {
      request.signal.addEventListener("abort", cancelChild, { once: true });
    }

    return {
      async next() {
        try {
          const result = await childRun.complete;
          return { kind: "terminal", terminalStatus: result.terminalStatus };
        } finally {
          request.signal.removeEventListener("abort", cancelChild);
        }
      },
      async resume() {
        throw new Error("browser workflow spike does not support approvals");
      },
      deliverSignal(name, payload, signalId) {
        return childRun.signal(name, payload, signalId);
      },
    };
  };
}

function createParentEnv(
  runtime: BrowserDeploymentRuntime,
): WorkflowRuntimeEnv {
  return {
    repoStore: runtime.repoStore,
    scheduler: runtime.scheduler,
    signalChannel: runtime.signalChannel,
    blobs: runtime.blobs,
    directors: createDefaultDirectorRegistry(),
    authorize: runtime.authorize,
    invokeStep: runtime.invokeStep,
    spawnChild: unsupportedChildWorkflow,
    spawnSuspendableChild: runtime.spawnSuspendableChild,
    clock: () => new Date(),
    newId: runtime.newId,
    drain: createNoopDrainController(workflow),
  };
}

function createChildEnv(
  runtime: BrowserDeploymentRuntime,
  signalChannel: SignalChannel,
  clock: () => Date,
): WorkflowRuntimeEnv {
  return {
    repoStore: runtime.repoStore,
    scheduler: runtime.scheduler,
    signalChannel,
    blobs: runtime.blobs,
    directors: createDefaultDirectorRegistry(),
    authorize: runtime.authorize,
    invokeStep: runtime.invokeStep,
    spawnChild: unsupportedChildWorkflow,
    clock,
    newId: runtime.newId,
    drain: createNoopDrainController(bodyWorkflow),
  };
}

async function waitForChildAndRearm(
  repoStore: RepoStore,
  parentRunId: string,
  childRunId: string,
  signal: AbortSignal,
): Promise<void> {
  let childCompleted = false;
  for await (const { event } of repoStore.subscribe(parentRunId, {
    from: "head",
    signal,
  })) {
    if (event.kind === "ChildCompleted" && event.childRunId === childRunId) {
      childCompleted = true;
      continue;
    }
    if (
      childCompleted &&
      event.kind === "SignalAwaited" &&
      event.parkKind === "input"
    ) {
      return;
    }
  }
  throw new Error(`browser deployment stopped before rearming ${childRunId}`);
}

function findInputSignal(
  events: Awaited<ReturnType<RepoStore["read"]>>,
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "SignalAwaited" && event.parkKind === "input") {
      return event.signalName;
    }
  }
  throw new Error("browser deployment parent is not waiting for a trigger");
}

const unsupportedChildWorkflow: SpawnChildWorkflow = async () => {
  throw new Error("browser workflow spike does not support childWorkflow");
};

function encodeInput(input: unknown): string {
  if (typeof input === "string") return input;
  const encoded = JSON.stringify(input);
  if (encoded === undefined) {
    throw new Error("workflow input must be JSON-serializable");
  }
  return encoded;
}
