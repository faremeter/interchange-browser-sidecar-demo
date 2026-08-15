import { describe, expect, test } from "bun:test";

import {
  createBrowserProvisioningBroker,
  type EnsureBrowserSidecarRequest,
} from "./browser-provisioning";

describe("browser provisioning broker", () => {
  test("assigns Hub credentials to waiting browser capacity", async () => {
    const broker = createBrowserProvisioningBroker();
    const browserId = broker.registerBrowser();
    broker.activateBrowser(browserId);

    expect(broker.ensure(ensureRequest())).toEqual({
      kind: "accepted",
      externalRef: browserId,
    });
    expect(await broker.nextEvent(browserId)).toEqual({
      kind: "assigned",
      allocationId: "allocation-1",
      generation: 1,
      tenantId: "tenant-1",
      anchorRunId: "run-1",
      sidecarId: "sidecar-1",
      sidecarToken: "secret-1",
      hubWebSocketURL: "ws://hub/api/sidecars/ws",
    });
  });

  test("makes ensure and destroy idempotent for one generation", async () => {
    const broker = createBrowserProvisioningBroker();
    const browserId = broker.registerBrowser();
    broker.activateBrowser(browserId);
    const request = ensureRequest();

    const first = broker.ensure(request);
    const repeated = broker.ensure(request);
    expect(repeated).toEqual(first);
    await broker.nextEvent(browserId);

    broker.destroy({
      allocationId: request.allocationId,
      generation: request.generation,
      sidecarId: request.sidecarId,
    });
    broker.destroy({
      allocationId: request.allocationId,
      generation: request.generation,
      sidecarId: request.sidecarId,
    });
    expect(await broker.nextEvent(browserId)).toEqual({
      kind: "destroyed",
      allocationId: request.allocationId,
      generation: request.generation,
    });
    expect(broker.ensure(request)).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
      retryable: false,
    });
  });

  test("fences older requests after assigning a replacement generation", () => {
    const broker = createBrowserProvisioningBroker();
    const browserId = broker.registerBrowser();
    broker.activateBrowser(browserId);
    const first = ensureRequest();
    broker.ensure(first);
    broker.destroy({
      allocationId: first.allocationId,
      generation: first.generation,
      sidecarId: first.sidecarId,
    });
    expect(
      broker.ensure({
        ...first,
        generation: 2,
        sidecarId: "sidecar-2",
        token: "secret-2",
      }),
    ).toEqual({ kind: "accepted", externalRef: browserId });

    expect(broker.ensure(first)).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
      retryable: false,
    });
  });
});

function ensureRequest(): EnsureBrowserSidecarRequest {
  return {
    allocationId: "allocation-1",
    generation: 1,
    tenantId: "tenant-1",
    anchorRunId: "run-1",
    sidecarId: "sidecar-1",
    token: "secret-1",
    hubWebSocketUrl: "ws://hub/api/sidecars/ws",
  };
}
