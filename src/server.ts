import path from "node:path";

import { type } from "arktype";

import {
  createBrowserProvisioningBroker,
  type DestroyBrowserSidecarRequest,
  type EnsureBrowserSidecarRequest,
} from "./browser-provisioning";
import { buildBrowserWorkflow } from "./browser-workflow/build";
import { authoredWorkflow } from "./browser-workflow/workflow";
import { createDemoHubClient, type InferenceSource } from "./hub";

const TriggerRequest = type({ browserId: "string", prompt: "string" });
const BrowserRequest = type({ browserId: "string" });
const BrowserPairingRequest = type({ pairingCode: "string" });
const EnsureBrowserSidecarRequest = type({
  allocationId: "string",
  generation: "number",
  tenantId: "string",
  anchorRunId: "string",
  sidecarId: "string",
  token: "string",
  hubWebSocketUrl: "string",
});
const DestroyBrowserSidecarRequest = type({
  allocationId: "string",
  generation: "number",
  sidecarId: "string",
  "externalRef?": "string",
});
const WorkflowDefinition = type("Record<string, unknown>");

const HOST = Bun.env.BROWSER_DEMO_HOST ?? "127.0.0.1";
const PORT = readPort(Bun.env.BROWSER_DEMO_PORT ?? "4174");
const HUB_HTTP_URL = Bun.env.BROWSER_HUB_HTTP_URL ?? "http://127.0.0.1:3000";
const CONTROL_TOKEN =
  Bun.env.BROWSER_DEMO_CONTROL_TOKEN ?? "local-browser-sidecar-demo";
const PUBLIC_DIRECTORY = path.join(import.meta.dir, "../public");

const workflowDefinition = WorkflowDefinition.assert(authoredWorkflow);
const browserWorkflow = await buildBrowserWorkflow({
  entrypoint: path.join(import.meta.dir, "browser-workflow/workflow.ts"),
});
const browserUI = await buildBrowserUI();
const debugSidecar = await buildBrowserWorkflow({
  entrypoint: path.join(import.meta.dir, "debug-sidecar.ts"),
});
const provisioning = createBrowserProvisioningBroker();
const hub = createDemoHubClient({
  hubURL: HUB_HTTP_URL,
  workflowDefinition,
  ...(Bun.env.BROWSER_HUB_EMAIL !== undefined && {
    email: Bun.env.BROWSER_HUB_EMAIL,
  }),
  ...(Bun.env.BROWSER_HUB_PASSWORD !== undefined && {
    password: Bun.env.BROWSER_HUB_PASSWORD,
  }),
  ...(Bun.env.BROWSER_TENANT_ID !== undefined && {
    tenantId: Bun.env.BROWSER_TENANT_ID,
  }),
  ...(Bun.env.BROWSER_TENANT_SLUG !== undefined && {
    tenantSlug: Bun.env.BROWSER_TENANT_SLUG,
  }),
});
type Deployment = Awaited<ReturnType<typeof hub.bootstrap>>;

const deployments = new Map<string, Promise<Deployment>>();
let deploymentQueue = Promise.resolve();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (
        request.method === "OPTIONS" &&
        isBrowserAccessiblePath(url.pathname)
      ) {
        return withBrowserAccess(new Response(null, { status: 204 }));
      }
      if (request.method === "GET" && url.pathname === "/") {
        return fileResponse("index.html", "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/browser-ui.js") {
        return javascriptResponse(browserUI);
      }
      if (request.method === "GET" && url.pathname === "/browser-workflow.js") {
        return javascriptResponse(browserWorkflow.source);
      }
      if (request.method === "GET" && url.pathname === "/debug-sidecar.js") {
        return javascriptResponse(debugSidecar.source);
      }
      if (request.method === "POST" && url.pathname === "/api/pairings") {
        const pairing = provisioning.createPairing();
        return Response.json({
          ...pairing,
          installCommand: createInstallCommand(url.origin, pairing.pairingCode),
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/browser/register"
      ) {
        const { pairingCode } = BrowserPairingRequest.assert(
          await request.json(),
        );
        const browserId = provisioning.registerBrowser(pairingCode);
        if (browserId === null) {
          return withBrowserAccess(
            Response.json(
              { error: "Invalid or expired browser pairing code" },
              { status: 401 },
            ),
          );
        }
        return withBrowserAccess(Response.json({ browserId }));
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        const { browserId } = BrowserRequest.assert(await request.json());
        return withBrowserAccess(
          Response.json(await bootstrapBrowser(browserId)),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/browser/events") {
        const browserId = url.searchParams.get("browserId");
        if (browserId === null || browserId === "") {
          return withBrowserAccess(
            Response.json({ error: "browserId is required" }, { status: 400 }),
          );
        }
        const event = await provisioning.nextEvent(browserId);
        return withBrowserAccess(Response.json(event ?? { kind: "heartbeat" }));
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/browser/unregister"
      ) {
        const { browserId } = BrowserRequest.assert(await request.json());
        provisioning.unregisterBrowser(browserId);
        deployments.delete(browserId);
        return withBrowserAccess(new Response(null, { status: 204 }));
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/provisioner/ensure"
      ) {
        const unauthorized = authorizeProvisioner(request);
        if (unauthorized !== null) return unauthorized;
        const body: EnsureBrowserSidecarRequest =
          EnsureBrowserSidecarRequest.assert(await request.json());
        return Response.json(provisioning.ensure(body));
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/provisioner/destroy"
      ) {
        const unauthorized = authorizeProvisioner(request);
        if (unauthorized !== null) return unauthorized;
        const body: DestroyBrowserSidecarRequest =
          DestroyBrowserSidecarRequest.assert(await request.json());
        provisioning.destroy(body);
        return Response.json({ kind: "destroyed" });
      }
      if (request.method === "POST" && url.pathname === "/api/trigger") {
        const body = TriggerRequest.assert(await request.json());
        provisioning.assertBrowserCanTrigger(body.browserId);
        const prompt = body.prompt.trim();
        if (prompt === "") {
          return withBrowserAccess(
            Response.json({ error: "Prompt cannot be empty" }, { status: 400 }),
          );
        }
        const activeDeployment = deployments.get(body.browserId);
        if (activeDeployment === undefined) {
          throw new Error(`Browser ${body.browserId} has no deployment`);
        }
        const active = await activeDeployment;
        return withBrowserAccess(
          Response.json(await hub.trigger(active.deploymentId, prompt)),
        );
      }
      return new Response(null, { status: 404 });
    } catch (cause) {
      const response = Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 500 },
      );
      return isBrowserAccessiblePath(url.pathname)
        ? withBrowserAccess(response)
        : response;
    }
  },
});

process.stdout.write(
  `Browser sidecar demo available at http://${server.hostname}:${String(server.port)}\n`,
);

function bootstrapBrowser(browserId: string): Promise<Deployment> {
  const existing = deployments.get(browserId);
  if (existing !== undefined) return existing;

  const created = enqueueDeployment(browserId);
  deployments.set(browserId, created);
  void created.catch(() => {
    if (deployments.get(browserId) === created) deployments.delete(browserId);
  });
  return created;
}

function enqueueDeployment(browserId: string): Promise<Deployment> {
  const created = deploymentQueue.then(async () => {
    provisioning.activateBrowser(browserId);
    try {
      const deployment = await hub.bootstrap(inferenceSource());
      await provisioning.waitForBrowserDeployment(
        browserId,
        deployment.deploymentId,
      );
      return deployment;
    } catch (cause) {
      provisioning.deactivateBrowser(browserId);
      throw cause;
    }
  });
  deploymentQueue = created.then(
    () => undefined,
    () => undefined,
  );
  return created;
}

function inferenceSource(): InferenceSource {
  const apiKey = Bun.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY is required for the browser demo");
  }
  return {
    id: "browser-demo-anthropic",
    provider: "anthropic",
    baseURL: "https://api.anthropic.com",
    apiKey,
    model: Bun.env.BROWSER_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    quirks: { directBrowserAccess: true },
  };
}

async function buildBrowserUI(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "browser-ui.ts")],
    target: "browser",
    format: "esm",
  });
  if (!built.success) {
    throw new Error(
      built.logs
        .map((log) => (log instanceof Error ? log.message : String(log)))
        .join("\n"),
    );
  }
  const output = built.outputs[0];
  if (output === undefined) {
    throw new Error("Browser UI build produced no output");
  }
  return output.text();
}

function fileResponse(filename: string, contentType: string): Response {
  return new Response(Bun.file(path.join(PUBLIC_DIRECTORY, filename)), {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
    },
  });
}

function javascriptResponse(source: string): Response {
  return withBrowserAccess(
    new Response(source, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      },
    }),
  );
}

function createInstallCommand(origin: string, pairingCode: string): string {
  const moduleURL = `${origin}/debug-sidecar.js`;
  return `globalThis.interchangeDebug = await import(${JSON.stringify(moduleURL)}).then(({ install }) => install({ serverURL: ${JSON.stringify(origin)}, pairingCode: ${JSON.stringify(pairingCode)} }))`;
}

function isBrowserAccessiblePath(pathname: string): boolean {
  return (
    pathname === "/browser-workflow.js" ||
    pathname === "/debug-sidecar.js" ||
    pathname === "/api/bootstrap" ||
    pathname === "/api/trigger" ||
    pathname.startsWith("/api/browser/")
  );
}

function withBrowserAccess(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "content-type");
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.set("access-control-allow-private-network", "true");
  return response;
}

function authorizeProvisioner(request: Request): Response | null {
  if (request.headers.get("authorization") === `Bearer ${CONTROL_TOKEN}`) {
    return null;
  }
  return Response.json({ error: "Unauthorized provisioner" }, { status: 401 });
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid BROWSER_DEMO_PORT: ${value}`);
  }
  return port;
}
