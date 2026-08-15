import { type } from "arktype";

type EnsureSidecarRequest = {
  readonly allocationId: string;
  readonly generation: number;
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly sidecarId: string;
  readonly token: string;
  readonly hubWebSocketUrl: string;
};

type DestroySidecarRequest = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly externalRef?: string;
};

const EnsureSidecarResponse = type({
  kind: "'accepted'",
  "externalRef?": "string",
}).or({
  kind: "'rejected'",
  code: "string",
  message: "string",
  retryable: "boolean",
});
const DestroySidecarResponse = type({ kind: "'destroyed'" }).or({
  kind: "'rejected'",
  code: "string",
  message: "string",
  retryable: "boolean",
});

const CONTROL_URL = Bun.env.BROWSER_DEMO_CONTROL_URL ?? "http://127.0.0.1:4174";
const CONTROL_TOKEN =
  Bun.env.BROWSER_DEMO_CONTROL_TOKEN ?? "local-browser-sidecar-demo";

export const sidecarProvisioner = {
  id: "browser-tab",
  apiVersion: 1 as const,
  bindingFingerprint: `browser-tab:${CONTROL_URL}`,
  async ensure(request: EnsureSidecarRequest) {
    return EnsureSidecarResponse.assert(
      await post("/api/provisioner/ensure", request),
    );
  },
  async destroy(request: DestroySidecarRequest) {
    return DestroySidecarResponse.assert(
      await post("/api/provisioner/destroy", request),
    );
  },
};

async function post(pathname: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${CONTROL_URL}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `Browser provisioner control request failed with ${String(response.status)}: ${JSON.stringify(result)}`,
    );
  }
  return result;
}
