import { signEd25519 } from "@intx/crypto";
import { createPackReceiver, createPackSender } from "@intx/pack-transport";
import { hexDecode, hexEncode } from "@intx/types";
import {
  HubFrame,
  type AgentDeployFrame,
  type MailInboundFrame,
  type PackRejectReason,
  type RepoId,
  type RunGrantsFrame,
  type SidecarFrame,
} from "@intx/types/sidecar";
import type { KeyPair } from "@intx/types/runtime";
import { type } from "arktype";

/** Minimal browser adapter for the existing sidecar WebSocket protocol. */

export type BrowserHubLinkStatus =
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

export type BrowserHubLink = {
  close(): void;
  connect(): Promise<void>;
  pushWorkflowRunPack(args: {
    agentAddress: string;
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
  }): Promise<void>;
};

export type CreateBrowserHubLinkOpts = {
  hubURL: string;
  sidecarId: string;
  token: string;
  getKeyPair(address: string): Promise<KeyPair | null>;
  onDeploy(frame: AgentDeployFrame): Promise<KeyPair>;
  onMailInbound(
    frame: MailInboundFrame,
    messageId: string,
  ): Promise<{ completion: Promise<unknown> | null }>;
  onRunGrants(frame: RunGrantsFrame): Promise<void>;
  onWorkflowRunPack(args: {
    agentAddress: string;
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
    transferId: string;
  }): Promise<void>;
  onStatus(status: BrowserHubLinkStatus): void;
};

const CONNECTION_LOST = "browser sidecar connection lost";

export function createBrowserHubLink(
  opts: CreateBrowserHubLinkOpts,
): BrowserHubLink {
  let ws: WebSocket | null = null;
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let packCounter = 0;
  let messageQueue = Promise.resolve();
  const packReceiver = createPackReceiver();
  const packSender = createPackSender({ sendFrame: send });

  function send(frame: SidecarFrame): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error(CONNECTION_LOST);
    }
    ws.send(JSON.stringify(frame));
  }

  async function answerChallenge(
    frame: Extract<typeof HubFrame.infer, { type: "challenge" }>,
  ): Promise<void> {
    const responses: { address: string; signature: string }[] = [];
    for (const challenge of frame.challenges) {
      const keyPair = await opts.getKeyPair(challenge.address);
      if (keyPair === null) continue;
      const nonce = hexDecode(challenge.nonce);
      const address = new TextEncoder().encode(challenge.address);
      const payload = new Uint8Array(nonce.length + address.length);
      payload.set(nonce);
      payload.set(address, nonce.length);
      responses.push({
        address: challenge.address,
        signature: hexEncode(await signEd25519(keyPair.privateKey, payload)),
      });
    }
    send({ type: "challenge.response", responses });
  }

  async function handleDeploy(frame: AgentDeployFrame): Promise<void> {
    try {
      const keyPair = await opts.onDeploy(frame);
      send({
        type: "agent.deploy.ack",
        agentAddress: frame.agentAddress,
        publicKey: hexEncode(keyPair.publicKey),
      });
      opts.onStatus({ kind: "deployed", agentAddress: frame.agentAddress });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      send({
        type: "agent.error",
        agentAddress: frame.agentAddress,
        error: message,
      });
      opts.onStatus({ kind: "error", message });
    }
  }

  async function handleMail(frame: MailInboundFrame): Promise<void> {
    const messageId = frame.messageId ?? crypto.randomUUID();
    const accepted = await opts.onMailInbound(frame, messageId);
    if (frame.messageId !== undefined) {
      send({
        type: "mail.inbound.ack",
        agentAddress: frame.agentAddress,
        messageId: frame.messageId,
      });
    }
    if (accepted.completion === null) return;
    opts.onStatus({
      kind: "running",
      agentAddress: frame.agentAddress,
      messageId,
    });
    void accepted.completion.then(
      (result) => {
        opts.onStatus({
          kind: "completed",
          agentAddress: frame.agentAddress,
          messageId,
          result,
        });
      },
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        opts.onStatus({ kind: "error", message });
      },
    );
  }

  function rejectInboundPack(
    frame: Extract<
      typeof HubFrame.infer,
      { type: "repo.pack.push" | "repo.pack.done" }
    >,
    reason: PackRejectReason,
  ): void {
    send({
      type: "repo.pack.reject",
      agentAddress: frame.agentAddress,
      repoId: frame.repoId,
      transferId: frame.transferId,
      reason,
    });
  }

  async function handleMessage(data: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw new Error("hub sent invalid JSON");
    }
    const frame = HubFrame(raw);
    if (frame instanceof type.errors) {
      throw new Error(`hub sent an invalid frame: ${frame.summary}`);
    }

    switch (frame.type) {
      case "agent.deploy":
        await handleDeploy(frame);
        return;
      case "agent.undeploy":
        send({
          type: "agent.undeploy.ack",
          agentAddress: frame.agentAddress,
          statePushed: false,
        });
        return;
      case "challenge":
        await answerChallenge(frame);
        return;
      case "challenge.failed":
        throw new Error(`hub rejected ${frame.address}: ${frame.reason}`);
      case "mail.inbound":
        await handleMail(frame);
        return;
      case "run.grants":
        await opts.onRunGrants(frame);
        return;
      case "repo.pack.push": {
        const reason = packReceiver.handlePush(frame);
        if (reason !== null) rejectInboundPack(frame, reason);
        return;
      }
      case "repo.pack.done": {
        const received = packReceiver.handleDone(frame);
        if (received === null) {
          rejectInboundPack(frame, "corrupt");
          return;
        }
        try {
          if (frame.repoId.kind === "workflow-run") {
            if (frame.mountPath !== undefined) {
              throw new Error(
                "workflow-run restore packs cannot carry mountPath",
              );
            }
            await opts.onWorkflowRunPack({
              agentAddress: frame.agentAddress,
              repoId: frame.repoId,
              pack: received.pack,
              ref: received.ref,
              commitSha: received.commitSha,
              transferId: frame.transferId,
            });
          }
          // Runtime code, workflow definitions, and tools are bundled ahead
          // of time. Ordinary agent-state and mounted asset packs still cross
          // the established deployment barrier, but need no materialization.
          send({
            type: "repo.pack.ack",
            agentAddress: frame.agentAddress,
            repoId: frame.repoId,
            transferId: frame.transferId,
          });
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          send({
            type: "repo.pack.reject",
            agentAddress: frame.agentAddress,
            repoId: frame.repoId,
            transferId: frame.transferId,
            reason: message.startsWith("sha_mismatch")
              ? "sha_mismatch"
              : "corrupt",
          });
          opts.onStatus({ kind: "error", message });
        }
        return;
      }
      case "repo.pack.ack":
        packSender.handleAck(frame);
        return;
      case "repo.pack.reject":
        packSender.handleReject(frame);
        return;
      case "pong":
      case "signal.correlation.register.ack":
        return;
      case "signal.deliver":
      case "drain.deliver":
      case "sync.request":
      case "workflow.probe.request":
        throw new Error(`browser spike does not support ${frame.type}`);
      case "sources.update":
      case "credentials.update":
        send({
          type: "session.error",
          requestId: frame.requestId,
          error: `browser spike does not support ${frame.type}`,
        });
        return;
      default: {
        const exhaustive: never = frame;
        throw new Error(`unsupported hub frame: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  function handleMessageFailure(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    opts.onStatus({ kind: "error", message });
  }

  function isPackResponse(data: string): boolean {
    try {
      const raw: unknown = JSON.parse(data);
      if (typeof raw !== "object" || raw === null) return false;
      const frameType = Reflect.get(raw, "type");
      return frameType === "repo.pack.ack" || frameType === "repo.pack.reject";
    } catch {
      return false;
    }
  }

  async function pushWorkflowRunPack(args: {
    agentAddress: string;
    repoId: RepoId;
    pack: Uint8Array;
    ref: string;
    commitSha: string;
  }): Promise<void> {
    async function sendOnce(): Promise<void> {
      packCounter += 1;
      await packSender.send({
        ...args,
        transferId: `browser-workflow-run-${String(packCounter)}`,
      });
    }

    try {
      await sendOnce();
    } catch (firstCause) {
      if (
        firstCause instanceof Error &&
        firstCause.message === CONNECTION_LOST
      ) {
        throw firstCause;
      }
      // The ordinary hub lazily creates the workflow-run repo while handling
      // the first pack. Its genesis ref can make that first CAS reject; the
      // production HubLink retries the identical pack once for the same race.
      await sendOnce();
    }
  }

  function connect(): Promise<void> {
    if (closed) {
      return Promise.reject(new Error("browser hub link is closed"));
    }
    opts.onStatus({ kind: "connecting" });
    return new Promise<void>((resolve, reject) => {
      const connection = new WebSocket(opts.hubURL);
      ws = connection;
      connection.addEventListener("open", () => {
        if (ws !== connection) return;
        send({
          type: "register",
          sidecarId: opts.sidecarId,
          token: opts.token,
          agentAddresses: [],
        });
        pingTimer = setInterval(() => send({ type: "ping" }), 15_000);
        opts.onStatus({ kind: "connected" });
        resolve();
      });
      connection.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        if (isPackResponse(event.data)) {
          void handleMessage(event.data).catch(handleMessageFailure);
          return;
        }
        messageQueue = messageQueue
          .then(() => handleMessage(event.data))
          .catch(handleMessageFailure);
      });
      connection.addEventListener("error", () => {
        if (connection.readyState !== WebSocket.OPEN) {
          reject(new Error(`failed to connect to hub at ${opts.hubURL}`));
        }
      });
      connection.addEventListener("close", () => {
        if (ws === connection) ws = null;
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        packReceiver.reset();
        packSender.cancelAll(CONNECTION_LOST);
      });
    });
  }

  function close(): void {
    closed = true;
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    ws?.close();
    ws = null;
    packReceiver.reset();
    packSender.cancelAll("browser hub link closed");
  }

  return { close, connect, pushWorkflowRunPack };
}
