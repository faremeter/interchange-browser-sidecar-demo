import { type } from "arktype";

declare const __BROWSER_WORKFLOW_BUNDLE_URL__: string;
declare const document: DemoDocument;

type DemoEvent = { preventDefault(): void };

interface DemoElement {
  append(...nodes: DemoElement[]): void;
  className: string;
  dataset: Record<string, string | undefined>;
  prepend(...nodes: DemoElement[]): void;
  textContent: string | null;
}

interface DemoFormElement extends DemoElement {
  addEventListener(type: "submit", listener: (event: DemoEvent) => void): void;
}

interface DemoTextAreaElement extends DemoElement {
  value: string;
}

interface DemoButtonElement extends DemoElement {
  disabled: boolean;
}

interface DemoDocument {
  createElement(tag: "li" | "span"): DemoElement;
  getElementById(id: string): unknown;
}

const BootstrapResponse = type({ deploymentId: "string", tenantId: "string" });
const BrowserRegistrationResponse = type({ browserId: "string" });
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
const BrowserRequest = type({
  browserId: "string",
});
const TriggerResponse = type({ messageId: "string" });
const BrowserWorkflowResult = type({
  childEventKinds: "string[]",
  childRunId: "string",
  childRunIds: "string[]",
  deploymentId: "string",
  parentEventKinds: "string[]",
  parentRunId: "string",
  terminalStatus: "'completed' | 'failed' | 'cancelled'",
});

type BrowserHubLinkStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "deployed"; agentAddress: string }
  | { kind: "running"; agentAddress: string; messageId: string }
  | {
      kind: "completed";
      agentAddress: string;
      messageId: string;
      result: unknown;
    }
  | { kind: "error"; message: string };

type BrowserWorkflowModule = {
  connect(options: {
    databaseName: string;
    hubWebSocketURL: string;
    sidecarId: string;
    sidecarToken: string;
  }): Promise<void>;
  disconnect(): Promise<void>;
  subscribeStatus(listener: (status: BrowserHubLinkStatus) => void): () => void;
};

const connection = requiredHTMLElement("connection");
const deployment = requiredHTMLElement("deployment");
const execution = requiredHTMLElement("execution");
const form = requiredForm("prompt-form");
const prompt = requiredTextArea("prompt");
const result = requiredHTMLElement("result");
const submit = requiredButton("submit");
const timeline = requiredHTMLElement("timeline");
const userAgent = requiredHTMLElement("user-agent");

let activeMessageId: string | undefined;
let parentEventCount = 0;

userAgent.textContent = navigator.userAgent;
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void trigger(prompt.value);
});

try {
  await start();
} catch (cause) {
  showError(cause instanceof Error ? cause.message : String(cause));
}

async function start(): Promise<void> {
  const workflowBundleURL = getWorkflowBundleURL();
  appendTimeline("bundle.load", workflowBundleURL);
  const candidate: unknown = await import(workflowBundleURL);
  if (!isBrowserWorkflowModule(candidate)) {
    throw new Error("Browser workflow bundle has an invalid public API");
  }
  candidate.subscribeStatus(handleStatus);
  const response = await fetch("/api/browser/register", { method: "POST" });
  const body: unknown = await response.json();
  if (!response.ok) throw responseError(body, response.status);
  const { browserId } = BrowserRegistrationResponse.assert(body);
  setState(connection, "Waiting for allocation", "pending");
  appendTimeline("capacity.register", browserId);
  void consumeProvisioningEvents(candidate, browserId);
  await bootstrap(browserId);
}

function handleStatus(status: BrowserHubLinkStatus): void {
  switch (status.kind) {
    case "connecting":
      setState(connection, "Connecting", "pending");
      appendTimeline("ws.connect", "Opening sidecar WebSocket to Hub");
      break;
    case "connected":
      setState(connection, "Connected", "success");
      appendTimeline("sidecar.register", "Browser registered with Hub");
      break;
    case "deployed":
      setState(deployment, "Deployed", "success");
      setState(execution, "Ready", "success");
      submit.disabled = false;
      appendTimeline("agent.deploy", status.agentAddress);
      break;
    case "running":
      activeMessageId = status.messageId;
      setState(execution, "Running in this tab", "pending");
      submit.disabled = true;
      result.textContent = "The browser agent is calling its tool and model…";
      appendTimeline(
        "mail.inbound",
        `${status.messageId} -> ${status.agentAddress}`,
      );
      break;
    case "completed":
      if (
        activeMessageId !== undefined &&
        status.messageId !== activeMessageId
      ) {
        return;
      }
      setState(execution, "Completed", "success");
      submit.disabled = false;
      result.textContent = assistantReply(status.result);
      appendCompletedRun(status.result);
      break;
    case "error":
      showError(status.message);
      break;
  }
}

async function bootstrap(browserId: string): Promise<void> {
  setState(deployment, "Requesting exclusive placement", "pending");
  appendTimeline("asset.publish", "Publishing bundled workflow to Hub");
  appendTimeline("allocation.request", "exclusive / same-deployment");
  try {
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BrowserRequest.assert({ browserId })),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw responseError(body, response.status);
    const deployed = BootstrapResponse.assert(body);
    appendTimeline("deployment.pending", deployed.deploymentId);
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : String(cause));
  }
}

async function consumeProvisioningEvents(
  workflow: BrowserWorkflowModule,
  browserId: string,
): Promise<void> {
  while (true) {
    try {
      const response = await fetch(
        `/api/browser/events?browserId=${encodeURIComponent(browserId)}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) throw responseError(body, response.status);
      const event = BrowserProvisioningEvent.assert(body);
      if (event.kind === "heartbeat") continue;
      if (event.kind === "destroyed") {
        appendTimeline(
          "provisioner.destroy",
          `${event.allocationId} generation ${String(event.generation)}`,
        );
        await workflow.disconnect();
        setState(connection, "Allocation released", "pending");
        setState(deployment, "Released", "pending");
        submit.disabled = true;
        continue;
      }

      appendTimeline(
        "provisioner.ensure",
        `${event.allocationId} generation ${String(event.generation)}`,
      );
      appendTimeline("allocation.anchor", event.anchorRunId);
      appendTimeline("credential.issue", event.sidecarId);
      await workflow.connect({
        databaseName: `interchange-browser-sidecar-${event.allocationId}`,
        hubWebSocketURL: event.hubWebSocketURL,
        sidecarId: event.sidecarId,
        sidecarToken: event.sidecarToken,
      });
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
  }
}

async function trigger(value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed === "") return;
  submit.disabled = true;
  result.textContent = "Delivering prompt through the Hub…";
  appendTimeline("trigger.request", trimmed);
  try {
    const response = await fetch("/api/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: trimmed }),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw responseError(body, response.status);
    const triggered = TriggerResponse.assert(body);
    activeMessageId = triggered.messageId;
    appendTimeline("trigger.message", triggered.messageId);
  } catch (cause) {
    submit.disabled = false;
    showError(cause instanceof Error ? cause.message : String(cause));
  }
}

function appendCompletedRun(value: unknown): void {
  const completed = BrowserWorkflowResult(value);
  if (completed instanceof type.errors) {
    appendTimeline("protocol.error", completed.summary);
    return;
  }
  const parentEvents = completed.parentEventKinds.slice(parentEventCount);
  parentEventCount = completed.parentEventKinds.length;
  appendTimeline("repo", `workflow-run/${completed.deploymentId}`);
  appendTimeline("parent.run", completed.parentRunId);
  appendTimeline(
    "parent.events",
    parentEvents.length === 0 ? "no new events" : parentEvents.join(" -> "),
  );
  appendTimeline(
    "child.run",
    `${completed.childRunId} (${completed.terminalStatus}); all: ${completed.childRunIds.join(", ")}`,
  );
  appendTimeline("child.events", completed.childEventKinds.join(" -> "));
  appendTimeline("repo.push", `workflow-run/${completed.deploymentId} -> Hub`);
}

function assistantReply(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return JSON.stringify(value);
  }
  const turns = Reflect.get(value, "turns");
  if (!Array.isArray(turns)) return JSON.stringify(value, null, 2);
  for (const turn of turns.toReversed()) {
    if (
      typeof turn !== "object" ||
      turn === null ||
      Reflect.get(turn, "role") !== "assistant"
    ) {
      continue;
    }
    const content = Reflect.get(turn, "content");
    if (!Array.isArray(content)) continue;
    const text = content.flatMap((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        Reflect.get(block, "type") === "text"
      ) {
        const blockText = Reflect.get(block, "text");
        return typeof blockText === "string" ? [blockText] : [];
      }
      return [];
    });
    if (text.length > 0) return text.join("\n");
  }
  return JSON.stringify(value, null, 2);
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

function appendTimeline(kind: string, message: string): void {
  const item = document.createElement("li");
  const label = document.createElement("span");
  const text = document.createElement("span");
  label.className = "timeline-label";
  label.textContent = kind;
  text.textContent = message;
  item.append(label, text);
  timeline.prepend(item);
}

function setState(
  element: DemoElement,
  text: string,
  state: "pending" | "success" | "error",
): void {
  element.textContent = text;
  element.dataset["state"] = state;
}

function showError(message: string): void {
  setState(execution, "Failed", "error");
  result.textContent = message;
  appendTimeline("error", message);
}

function responseError(body: unknown, status: number): Error {
  if (typeof body === "object" && body !== null) {
    const message = Reflect.get(body, "error");
    if (typeof message === "string") return new Error(message);
  }
  return new Error(`Demo request failed with ${String(status)}`);
}

function getWorkflowBundleURL(): string {
  return __BROWSER_WORKFLOW_BUNDLE_URL__;
}

function requiredHTMLElement(id: string): DemoElement {
  const element = document.getElementById(id);
  if (!isDemoElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function requiredForm(id: string): DemoFormElement {
  const element = document.getElementById(id);
  if (!isDemoFormElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function requiredTextArea(id: string): DemoTextAreaElement {
  const element = document.getElementById(id);
  if (!isDemoTextAreaElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function requiredButton(id: string): DemoButtonElement {
  const element = document.getElementById(id);
  if (!isDemoButtonElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function isDemoElement(value: unknown): value is DemoElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "textContent" in value &&
    typeof Reflect.get(value, "append") === "function"
  );
}

function isDemoFormElement(value: unknown): value is DemoFormElement {
  return (
    isDemoElement(value) &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function isDemoTextAreaElement(value: unknown): value is DemoTextAreaElement {
  return (
    isDemoElement(value) && typeof Reflect.get(value, "value") === "string"
  );
}

function isDemoButtonElement(value: unknown): value is DemoButtonElement {
  return (
    isDemoElement(value) && typeof Reflect.get(value, "disabled") === "boolean"
  );
}
