export type EnsureBrowserSidecarRequest = {
  allocationId: string;
  generation: number;
  tenantId: string;
  anchorRunId: string;
  sidecarId: string;
  token: string;
  hubWebSocketUrl: string;
};

export type DestroyBrowserSidecarRequest = {
  allocationId: string;
  generation: number;
  sidecarId: string;
  externalRef?: string;
};

export type BrowserAssignment = {
  kind: "assigned";
  allocationId: string;
  generation: number;
  tenantId: string;
  anchorRunId: string;
  sidecarId: string;
  sidecarToken: string;
  hubWebSocketURL: string;
};

export type BrowserDestroyed = {
  kind: "destroyed";
  allocationId: string;
  generation: number;
};

export type BrowserProvisioningEvent = BrowserAssignment | BrowserDestroyed;

export type BrowserPairing = {
  pairingCode: string;
  expiresAt: number;
};

export type EnsureBrowserSidecarResult =
  | { kind: "accepted"; externalRef: string }
  | {
      kind: "rejected";
      code: string;
      message: string;
      retryable: boolean;
    };

type BrowserSlot = {
  id: string;
  available: boolean;
  deploymentWaiters: Array<{
    anchorRunId: string;
    reject(cause: unknown): void;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  events: BrowserProvisioningEvent[];
  waiters: Array<{
    resolve(event: BrowserProvisioningEvent | null): void;
    timer: ReturnType<typeof setTimeout>;
  }>;
};

type Assignment = {
  browserId: string;
  event: BrowserAssignment;
  destroyed: boolean;
};

const PAIRING_TTL_MS = 5 * 60_000;

export function createBrowserProvisioningBroker() {
  const browsers = new Map<string, BrowserSlot>();
  const assignments = new Map<string, Assignment>();
  const pairings = new Map<string, number>();

  function createPairing(): BrowserPairing {
    const now = Date.now();
    for (const [pairingCode, expiresAt] of pairings) {
      if (expiresAt <= now) pairings.delete(pairingCode);
    }
    const pairingCode = crypto.randomUUID();
    const expiresAt = now + PAIRING_TTL_MS;
    pairings.set(pairingCode, expiresAt);
    return { pairingCode, expiresAt };
  }

  function registerBrowser(pairingCode: string): string | null {
    const expiresAt = pairings.get(pairingCode);
    pairings.delete(pairingCode);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      return null;
    }
    const browserId = `browser_${crypto.randomUUID()}`;
    browsers.set(browserId, {
      id: browserId,
      available: false,
      deploymentWaiters: [],
      events: [],
      waiters: [],
    });
    return browserId;
  }

  function activateBrowser(browserId: string): void {
    const browser = requireBrowser(browserId);
    browser.available = true;
  }

  function deactivateBrowser(browserId: string): void {
    const browser = browsers.get(browserId);
    if (browser !== undefined) browser.available = false;
  }

  function waitForBrowserDeployment(
    browserId: string,
    anchorRunId: string,
    timeoutMs = 25_000,
  ): Promise<void> {
    const browser = requireBrowser(browserId);
    const assignment = findActiveAssignment(browserId);
    if (assignment !== undefined) {
      return assignment.event.anchorRunId === anchorRunId
        ? Promise.resolve()
        : Promise.reject(
            deploymentMismatch(
              browserId,
              assignment.event.anchorRunId,
              anchorRunId,
            ),
          );
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        anchorRunId,
        reject,
        resolve,
        timer: setTimeout(() => {
          const index = browser.deploymentWaiters.indexOf(waiter);
          if (index === -1) return;
          browser.deploymentWaiters.splice(index, 1);
          reject(
            new Error(
              `Browser ${browserId} did not receive deployment ${anchorRunId}`,
            ),
          );
        }, timeoutMs),
      };
      browser.deploymentWaiters.push(waiter);
    });
  }

  function assertBrowserCanTrigger(browserId: string): void {
    requireActiveAssignment(browserId);
  }

  function requireActiveAssignment(browserId: string): Assignment {
    requireBrowser(browserId);
    const assignment = findActiveAssignment(browserId);
    if (assignment === undefined) {
      throw new Error(`Browser ${browserId} has no active deployment`);
    }
    return assignment;
  }

  function unregisterBrowser(browserId: string): void {
    const browser = browsers.get(browserId);
    if (browser === undefined) return;
    browser.available = false;
    for (const waiter of browser.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    browser.waiters.length = 0;
    for (const waiter of browser.deploymentWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Browser ${browserId} unregistered`));
    }
    browser.deploymentWaiters.length = 0;
    browsers.delete(browserId);
  }

  function nextEvent(
    browserId: string,
    timeoutMs = 25_000,
  ): Promise<BrowserProvisioningEvent | null> {
    const browser = requireBrowser(browserId);
    const queued = browser.events.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = browser.waiters.indexOf(waiter);
          if (index === -1) return;
          browser.waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs),
      };
      browser.waiters.push(waiter);
    });
  }

  function ensure(
    request: EnsureBrowserSidecarRequest,
  ): EnsureBrowserSidecarResult {
    const existing = assignments.get(request.allocationId);
    let browser: BrowserSlot | undefined;
    if (existing !== undefined) {
      if (request.generation < existing.event.generation) {
        return staleGeneration(request, existing.event.generation);
      }
      if (request.generation === existing.event.generation) {
        return existing.destroyed
          ? staleGeneration(request, existing.event.generation)
          : { kind: "accepted", externalRef: existing.browserId };
      }
      if (!existing.destroyed) {
        destroyAssignment(existing);
      }
      browser = browsers.get(existing.browserId);
    }

    browser ??= [...browsers.values()].find((candidate) => candidate.available);
    if (browser === undefined) {
      return {
        kind: "rejected",
        code: "browser_capacity_unavailable",
        message: "No browser tab is waiting to host the allocation",
        retryable: true,
      };
    }

    const event: BrowserAssignment = {
      kind: "assigned",
      allocationId: request.allocationId,
      generation: request.generation,
      tenantId: request.tenantId,
      anchorRunId: request.anchorRunId,
      sidecarId: request.sidecarId,
      sidecarToken: request.token,
      hubWebSocketURL: request.hubWebSocketUrl,
    };
    browser.available = false;
    assignments.set(request.allocationId, {
      browserId: browser.id,
      event,
      destroyed: false,
    });
    settleDeploymentWaiters(browser, event);
    publish(browser, event);
    return { kind: "accepted", externalRef: browser.id };
  }

  function destroy(request: DestroyBrowserSidecarRequest): void {
    const assignment = assignments.get(request.allocationId);
    if (
      assignment === undefined ||
      request.generation < assignment.event.generation ||
      assignment.destroyed
    ) {
      return;
    }
    destroyAssignment(assignment);
  }

  function destroyAssignment(assignment: Assignment): void {
    assignment.destroyed = true;
    const browser = browsers.get(assignment.browserId);
    if (browser === undefined) return;
    publish(browser, {
      kind: "destroyed",
      allocationId: assignment.event.allocationId,
      generation: assignment.event.generation,
    });
  }

  function publish(browser: BrowserSlot, event: BrowserProvisioningEvent) {
    const waiter = browser.waiters.shift();
    if (waiter === undefined) {
      browser.events.push(event);
    } else {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }

  function requireBrowser(browserId: string): BrowserSlot {
    const browser = browsers.get(browserId);
    if (browser === undefined) {
      throw new Error(`Unknown browser registration ${browserId}`);
    }
    return browser;
  }

  function findActiveAssignment(browserId: string): Assignment | undefined {
    return [...assignments.values()].find(
      (candidate) => candidate.browserId === browserId && !candidate.destroyed,
    );
  }

  function settleDeploymentWaiters(
    browser: BrowserSlot,
    event: BrowserAssignment,
  ): void {
    for (const waiter of browser.deploymentWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (waiter.anchorRunId === event.anchorRunId) {
        waiter.resolve();
      } else {
        waiter.reject(
          deploymentMismatch(
            browser.id,
            event.anchorRunId,
            waiter.anchorRunId,
          ),
        );
      }
    }
  }

  return {
    activateBrowser,
    assertBrowserCanTrigger,
    createPairing,
    deactivateBrowser,
    destroy,
    ensure,
    nextEvent,
    registerBrowser,
    unregisterBrowser,
    waitForBrowserDeployment,
  };
}

function deploymentMismatch(
  browserId: string,
  actualAnchorRunId: string,
  expectedAnchorRunId: string,
): Error {
  return new Error(
    `Browser ${browserId} received deployment ${actualAnchorRunId}, expected ${expectedAnchorRunId}`,
  );
}

function staleGeneration(
  request: EnsureBrowserSidecarRequest,
  currentGeneration: number,
): EnsureBrowserSidecarResult {
  return {
    kind: "rejected",
    code: "stale_generation",
    message: `Allocation ${request.allocationId} generation ${String(request.generation)} is fenced by generation ${String(currentGeneration)}`,
    retryable: false,
  };
}
