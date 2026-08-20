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
  computeLiveDefinitionHash,
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
  type Trigger,
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
import { inspectPage, inspectPageToolDefinition } from "./page-inspector";
import {
  createBrowserWorkflowRepo,
  restoreBrowserWorkflowRepo,
  type BrowserWorkflowRepo,
} from "./workflow-repo";

declare const __BROWSER_DEMO_CONVERSATION_ENABLED__: boolean;

const CONVERSATION_ENABLED =
  typeof __BROWSER_DEMO_CONVERSATION_ENABLED__ !== "undefined" &&
  __BROWSER_DEMO_CONVERSATION_ENABLED__;
const MANUAL_TRIGGER: Trigger = { type: "manual" };
const SECTION_ID = "debug_page";
const BODY_STEP_ID = "agent";
const AGENT_SYSTEM_PROMPT =
  "You are debugging the live browser page where this workflow runs. Always call inspect_page before answering. Use targeted CSS selectors for follow-up inspection when useful. Explain the observed page evidence, distinguish evidence from likely causes, and suggest a concrete next debugging step. Do not claim access to network traffic, console history, cookies, storage, or source maps, and do not claim to have changed the page.";
const AGENT_INFERENCE = {
  sources: [{ provider: "anthropic", model: "claude-haiku-4-5-20251001" }],
};

const inspectPageTool = defineTool<BaseEnv>({
  id: "@intx-spike/browser/inspect-page",
  definitions: [inspectPageToolDefinition],
  factory: (): ToolBundle => ({
    definitions: [inspectPageToolDefinition],
    async run(call: ToolCall, _signal: AbortSignal): Promise<ToolResult> {
      try {
        return {
          callId: call.id,
          content: JSON.stringify(inspectPage(call.arguments)),
          isError: false,
        };
      } catch (cause) {
        return {
          callId: call.id,
          content: cause instanceof Error ? cause.message : String(cause),
          isError: true,
        };
      }
    },
  }),
});

const agent = defineAgent({
  id: "browser-debug-agent",
  systemPrompt: AGENT_SYSTEM_PROMPT,
  tools: [inspectPageTool],
  capabilities: [],
  inference: AGENT_INFERENCE,
});

const bodyWorkflow = defineWorkflow({
  id: "browser-debug-workflow__debug_page",
  trigger: { type: "manual" },
  steps: { [BODY_STEP_ID]: step({ agent }) },
});

const authoredSection = onTrigger({
  on: { type: "manual" },
  body: bodyWorkflow,
});
const deployedSection: OnTriggerPrimitive = {
  ...authoredSection,
  body: { ref: bodyWorkflow.id },
};

/** Definition stored in the ordinary Hub workflow asset. */
export function createAuthoredWorkflow(conversationEnabled: boolean) {
  return defineWorkflow({
    id: "browser-debug-workflow",
    ...(conversationEnabled ? { trigger: MANUAL_TRIGGER } : {}),
    steps: conversationEnabled
      ? { [BODY_STEP_ID]: step({ agent, triggers: "unbounded" }) }
      : { [SECTION_ID]: authoredSection },
  });
}

export const authoredWorkflow = createAuthoredWorkflow(CONVERSATION_ENABLED);

/** Equivalent deployment projection consumed by the prebundled runtime. */
export const workflow = defineWorkflow({
  id: authoredWorkflow.id,
  ...(CONVERSATION_ENABLED ? { trigger: MANUAL_TRIGGER } : {}),
  steps: CONVERSATION_ENABLED
    ? { [BODY_STEP_ID]: step({ agent, triggers: "unbounded" }) }
    : { [SECTION_ID]: deployedSection },
});
const authoredWorkflowHash = computeLiveDefinitionHash(authoredWorkflow);

export const manifest = Object.freeze({
  workflowId: workflow.id,
  toolNames: ["inspect_page"],
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
  restoreWorkflowRepo: BrowserWorkflowRepo["restore"];
  scheduler: ReturnType<typeof createInMemoryScheduler>;
  signalChannel: SignalChannel;
  spawnSuspendableChild: SpawnSuspendableChild;
  turnOutputs: Map<string, unknown>;
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
      // Hub frames name the stable run by its full mail address; the browser
      // runtime indexes that same run by the allocation's local anchor.
      runGrants.set(deriveWorkflowRunId(frame.runId), frame.stepGrants);
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
      const runtime = activeRuntime;
      if (runtime?.agentAddress === args.agentAddress) {
        await runtime.restoreWorkflowRepo({
          commitSha: args.commitSha,
          pack: args.pack,
          ref: args.ref,
          transferId: args.transferId,
        });
      } else {
        // On reconnect the Hub may restore the authoritative run repo before
        // re-sending agent.deploy. Runtime construction below adopts this ref
        // and hydrates its in-memory event view from the checked-out tree.
        await restoreBrowserWorkflowRepo({ storage, ...args });
      }
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
  if (frame.workflow.approvedWireHash === undefined) {
    throw new Error("browser deployment has no approved workflow hash");
  }
  const bundledHash = await authoredWorkflowHash;
  if (frame.workflow.approvedWireHash !== bundledHash) {
    throw new Error(
      `browser workflow hash ${bundledHash} does not match approved hash ${frame.workflow.approvedWireHash}`,
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
): Promise<{ completion: Promise<unknown> | null }> {
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
): Promise<unknown> {
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
): Promise<unknown> {
  if (activeRuntime !== runtime) {
    throw new Error("browser sidecar received a trigger before deployment");
  }
  const parentLog = await runtime.repoStore.read(runtime.parentRunId);
  const childRunId = CONVERSATION_ENABLED
    ? undefined
    : `${SECTION_ID}__${String(
        parentLog.filter((event) => event.kind === "ChildSpawned").length,
      )}`;
  const subscriptionAbort = new AbortController();
  const rearmed = waitForRearm(
    runtime.repoStore,
    runtime.parentRunId,
    childRunId,
    subscriptionAbort.signal,
  );

  try {
    if (runtime.parentRun === undefined && parentLog.length === 0) {
      runtime.parentRun = runtimeRun(workflow, createParentEnv(runtime), {
        runId: runtime.parentRunId,
        triggerPayload: input,
        consumedMessageId: messageId,
      });
    } else {
      if (runtime.parentRun === undefined) {
        // The restored RepoStore is already canonical, so a seedless recovery
        // adopts its durable input park.
        runtime.parentRun = runtimeRun(workflow, createParentEnv(runtime), {
          runId: runtime.parentRunId,
        });
      }
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

  if (childRunId === undefined) {
    const output = runtime.turnOutputs.get(runtime.parentRunId);
    const turns = runtime.childTurns.get(runtime.parentRunId);
    if (output === undefined || turns === undefined) {
      throw new Error("browser conversation produced no turn result");
    }
    const updatedRunLog = await runtime.repoStore.read(runtime.parentRunId);
    return {
      deploymentId: runtime.deploymentId,
      output,
      runEventKinds: updatedRunLog.map((event) => event.kind),
      runId: runtime.parentRunId,
      turns,
    };
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
  const turnOutputs = new Map<string, unknown>();
  const authorize = createBrowserWorkflowAuthorize({
    anchorRunId: args.anchorRunId,
    getRunGrants: (runId) => runGrants.get(runId),
    toolDefinitions: inspectPageTool.definitions,
  });
  const invokeStep = createStepInvoker({
    authorize,
    childTurns,
    deploymentId: args.deploymentId,
    parentRunId: args.anchorRunId,
    source: args.source,
    storage: args.storage,
    turnOutputs,
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
    restoreWorkflowRepo: workflowRepo.restore,
    scheduler,
    signalChannel,
    spawnSuspendableChild: async () => {
      throw new Error("browser child spawner is not initialized");
    },
    turnOutputs,
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
  turnOutputs: Map<string, unknown>;
}): StepInvoker {
  return async (request) => {
    const runId = request.authzContext.runId;
    if (runId === undefined) {
      throw new Error("browser workflow step has no run id");
    }
    const stepId = request.authzContext.stepId ?? "step";
    const workdir = CONVERSATION_ENABLED
      ? `/deployments/${args.deploymentId}/runs/${runId}/${stepId}`
      : `/deployments/${args.deploymentId}/runs/${args.parentRunId}/children/${runId}/${stepId}`;
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

    let output: unknown;
    try {
      const input =
        request.resume?.kind === "input"
          ? request.resume.decision
          : request.input;
      const result = await runningAgent.send(encodeInput(input), {
        signal: request.signal,
      });
      if (result.type === "suspended") {
        throw new Error(
          "browser workflow spike does not support approval suspension",
        );
      }
      output = { reply: result.reply, turn: result.turn };
      return { output };
    } finally {
      await runningAgent.close();
      const state = await agentStore.load();
      args.childTurns.set(runId, state.turns);
      if (output !== undefined) {
        args.turnOutputs.set(runId, output);
      }
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

async function waitForRearm(
  repoStore: RepoStore,
  parentRunId: string,
  childRunId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  let childCompleted = childRunId === undefined;
  for await (const { event } of repoStore.subscribe(parentRunId, {
    from: "head",
    signal,
  })) {
    if (
      childRunId !== undefined &&
      event.kind === "ChildCompleted" &&
      event.childRunId === childRunId
    ) {
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
  throw new Error(`browser deployment stopped before rearming ${parentRunId}`);
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
