import { type } from "arktype";

const InstallOptions = type({
  pairingCode: "string > 0",
  serverURL: "string.url",
});
const BrowserRegistrationResponse = type({ browserId: "string" });
const BrowserRequest = type({ browserId: "string" });
const BrowserProvisioningEvent = type({ kind: "'heartbeat'" })
  .or({
    kind: "'assigned'",
    allocationId: "string",
    generation: "number",
    tenantId: "string",
    anchorRunId: "string",
    sidecarId: "string",
    sidecarToken: "string",
    hubWebSocketURL: "string",
  })
  .or({
    kind: "'destroyed'",
    allocationId: "string",
    generation: "number",
  });
const BrowserHubLinkStatus = type({ kind: "'connecting'" })
  .or({ kind: "'connected'" })
  .or({ kind: "'deployed'", agentAddress: "string" })
  .or({
    kind: "'running'",
    agentAddress: "string",
    messageId: "string",
  })
  .or({
    kind: "'completed'",
    agentAddress: "string",
    messageId: "string",
    result: "unknown",
  })
  .or({ kind: "'error'", message: "string" });
const TriggerResponse = type({ messageId: "string" });

type BrowserHubLinkStatus = typeof BrowserHubLinkStatus.infer;

type BrowserWorkflowModule = {
  connect(options: {
    anchorRunId: string;
    databaseName: string;
    hubWebSocketURL: string;
    sidecarId: string;
    sidecarToken: string;
  }): Promise<void>;
  disconnect(): Promise<void>;
  subscribeStatus(listener: (status: unknown) => void): () => void;
};

export type DebugSidecarStatus =
  | { kind: "installing" }
  | { kind: "waiting-for-deployment" }
  | { kind: "ready"; agentAddress: string }
  | { kind: "running"; messageId: string }
  | { kind: "released" }
  | { kind: "error"; message: string }
  | { kind: "disconnected" };

export interface DebugSidecar {
  readonly status: DebugSidecarStatus;
  disconnect(): Promise<void>;
  run(prompt: string): Promise<unknown>;
  subscribeStatus(listener: (status: DebugSidecarStatus) => void): () => void;
}

type PendingRun = {
  resolve(result: unknown): void;
  reject(cause: unknown): void;
};

let activeInstall: Promise<DebugSidecar> | undefined;

export function install(options: unknown): Promise<DebugSidecar> {
  if (activeInstall !== undefined) return activeInstall;
  const installing = createDebugSidecar(InstallOptions.assert(options));
  activeInstall = installing;
  void installing.catch(() => {
    if (activeInstall === installing) activeInstall = undefined;
  });
  return installing;
}

async function createDebugSidecar(
  options: typeof InstallOptions.infer,
): Promise<DebugSidecar> {
  const serverURL = new URL(options.serverURL);
  if (serverURL.protocol !== "http:" && serverURL.protocol !== "https:") {
    throw new Error("Debug sidecar server URL must use HTTP or HTTPS");
  }
  const workflowURL = new URL("/browser-workflow.js", serverURL);
  const candidate: unknown = await import(workflowURL.href);
  const workflow = requireBrowserWorkflowModule(candidate);

  const registrationResponse = await fetch(
    new URL("/api/browser/register", serverURL),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: options.pairingCode }),
    },
  );
  const registrationBody: unknown = await registrationResponse.json();
  if (!registrationResponse.ok) {
    throw responseError(registrationBody, registrationResponse.status);
  }
  const { browserId } = BrowserRegistrationResponse.assert(registrationBody);
  const abort = new AbortController();
  const listeners = new Set<(status: DebugSidecarStatus) => void>();
  const pendingRuns = new Map<string, PendingRun>();
  const completedRuns = new Map<string, unknown>();
  let currentStatus: DebugSidecarStatus = { kind: "installing" };
  let disconnected = false;
  let resolveDeployment: (() => void) | undefined;
  let rejectDeployment: ((cause: unknown) => void) | undefined;
  const deployment = new Promise<void>((resolve, reject) => {
    resolveDeployment = resolve;
    rejectDeployment = reject;
  });

  function publish(status: DebugSidecarStatus): void {
    currentStatus = status;
    for (const listener of listeners) listener(status);
  }

  function fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    publish({ kind: "error", message: error.message });
    rejectDeployment?.(error);
    rejectDeployment = undefined;
    rejectPendingRuns(error);
  }

  function rejectPendingRuns(cause: unknown): void {
    for (const pending of pendingRuns.values()) pending.reject(cause);
    pendingRuns.clear();
  }

  function handleWorkflowStatus(value: unknown): void {
    const status = BrowserHubLinkStatus.assert(value);
    switch (status.kind) {
      case "connecting":
      case "connected":
        return;
      case "deployed":
        publish({ kind: "ready", agentAddress: status.agentAddress });
        resolveDeployment?.();
        resolveDeployment = undefined;
        rejectDeployment = undefined;
        return;
      case "running":
        publish({ kind: "running", messageId: status.messageId });
        return;
      case "completed": {
        const pending = pendingRuns.get(status.messageId);
        if (pending === undefined) {
          completedRuns.set(status.messageId, status.result);
        } else {
          pendingRuns.delete(status.messageId);
          pending.resolve(status.result);
        }
        publish({ kind: "ready", agentAddress: status.agentAddress });
        return;
      }
      case "error":
        fail(new Error(status.message));
    }
  }

  const unsubscribe = workflow.subscribeStatus((status) => {
    try {
      handleWorkflowStatus(status);
    } catch (cause) {
      fail(cause);
    }
  });

  async function disconnect(): Promise<void> {
    if (disconnected) return;
    disconnected = true;
    abort.abort();
    unsubscribe();
    await workflow.disconnect();
    await fetch(new URL("/api/browser/unregister", serverURL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BrowserRequest.assert({ browserId })),
      keepalive: true,
    }).catch(() => undefined);
    const error = new Error("Debug sidecar disconnected");
    rejectDeployment?.(error);
    rejectDeployment = undefined;
    rejectPendingRuns(error);
    publish({ kind: "disconnected" });
    activeInstall = undefined;
  }

  const sidecar: DebugSidecar = Object.freeze({
    get status() {
      return currentStatus;
    },
    disconnect,
    async run(prompt: string) {
      if (disconnected) throw new Error("Debug sidecar is disconnected");
      if (currentStatus.kind !== "ready") {
        throw new Error(`Debug sidecar is ${currentStatus.kind}`);
      }
      const trimmed = prompt.trim();
      if (trimmed === "") throw new Error("Debug prompt cannot be empty");
      const response = await fetch(new URL("/api/trigger", serverURL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ browserId, prompt: trimmed }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw responseError(body, response.status);
      const { messageId } = TriggerResponse.assert(body);
      let result: unknown;
      if (completedRuns.has(messageId)) {
        result = completedRuns.get(messageId);
        completedRuns.delete(messageId);
      } else {
        result = await new Promise<unknown>((resolve, reject) => {
          pendingRuns.set(messageId, { resolve, reject });
        });
      }
      logRunResult(result);
      return result;
    },
    subscribeStatus(listener: (status: DebugSidecarStatus) => void) {
      listeners.add(listener);
      listener(currentStatus);
      return () => listeners.delete(listener);
    },
  });

  publish({ kind: "waiting-for-deployment" });
  void consumeProvisioningEvents({
    abort,
    browserId,
    fail,
    onReleased: () => publish({ kind: "released" }),
    serverURL,
    workflow,
  });
  try {
    const response = await fetch(new URL("/api/bootstrap", serverURL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BrowserRequest.assert({ browserId })),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw responseError(body, response.status);
    await deployment;
    return sidecar;
  } catch (cause) {
    await disconnect();
    throw cause;
  }
}

async function consumeProvisioningEvents(args: {
  abort: AbortController;
  browserId: string;
  fail(cause: unknown): void;
  onReleased(): void;
  serverURL: URL;
  workflow: BrowserWorkflowModule;
}): Promise<void> {
  try {
    while (!args.abort.signal.aborted) {
      const url = new URL("/api/browser/events", args.serverURL);
      url.searchParams.set("browserId", args.browserId);
      const response = await fetch(url, { signal: args.abort.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw responseError(body, response.status);
      const event = BrowserProvisioningEvent.assert(body);
      if (event.kind === "heartbeat") continue;
      if (event.kind === "destroyed") {
        await args.workflow.disconnect();
        args.onReleased();
        continue;
      }
      await args.workflow.connect({
        anchorRunId: event.anchorRunId,
        databaseName: `interchange-browser-debug-${event.allocationId}`,
        hubWebSocketURL: event.hubWebSocketURL,
        sidecarId: event.sidecarId,
        sidecarToken: event.sidecarToken,
      });
    }
  } catch (cause) {
    if (!args.abort.signal.aborted) args.fail(cause);
  }
}

function isBrowserWorkflowModule(
  value: unknown,
): value is BrowserWorkflowModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "connect") === "function" &&
    typeof Reflect.get(value, "disconnect") === "function" &&
    typeof Reflect.get(value, "subscribeStatus") === "function"
  );
}

function requireBrowserWorkflowModule(value: unknown): BrowserWorkflowModule {
  if (!isBrowserWorkflowModule(value)) {
    throw new Error("Browser workflow bundle has an invalid public API");
  }
  return value;
}

function responseError(body: unknown, status: number): Error {
  if (typeof body === "object" && body !== null) {
    const message = Reflect.get(body, "error");
    if (typeof message === "string") return new Error(message);
  }
  return new Error(`Debug sidecar request failed with ${String(status)}`);
}

function logRunResult(result: unknown): void {
  console.log("Interchange debug response:", readableResponse(result));
}

function readableResponse(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const output = Reflect.get(result, "output");
  if (typeof output !== "object" || output === null) return output;
  const reply = Reflect.get(output, "reply");
  return typeof reply === "string" ? reply : output;
}
