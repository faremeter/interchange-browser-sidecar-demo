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

const TriggerRequest = type({ prompt: "string" });
const BrowserRequest = type({ browserId: "string" });
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
let deployment: Awaited<ReturnType<typeof hub.bootstrap>> | undefined;
let bootstrapPromise:
  | Promise<Awaited<ReturnType<typeof hub.bootstrap>>>
  | undefined;

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return fileResponse("index.html", "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/browser-ui.js") {
        return javascriptResponse(browserUI);
      }
      if (request.method === "GET" && url.pathname === "/browser-workflow.js") {
        return javascriptResponse(browserWorkflow.source);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/browser/register"
      ) {
        return Response.json({ browserId: provisioning.registerBrowser() });
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        const { browserId } = BrowserRequest.assert(await request.json());
        provisioning.activateBrowser(browserId);
        return Response.json(await bootstrap());
      }
      if (request.method === "GET" && url.pathname === "/api/browser/events") {
        const browserId = url.searchParams.get("browserId");
        if (browserId === null || browserId === "") {
          return Response.json(
            { error: "browserId is required" },
            { status: 400 },
          );
        }
        const event = await provisioning.nextEvent(browserId);
        return Response.json(event ?? { kind: "heartbeat" });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/browser/unregister"
      ) {
        const { browserId } = BrowserRequest.assert(await request.json());
        provisioning.unregisterBrowser(browserId);
        return new Response(null, { status: 204 });
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
        const active = deployment ?? (await bootstrap());
        const body = TriggerRequest.assert(await request.json());
        const prompt = body.prompt.trim();
        if (prompt === "") {
          return Response.json(
            { error: "Prompt cannot be empty" },
            { status: 400 },
          );
        }
        return Response.json(await hub.trigger(active.deploymentId, prompt));
      }
      return new Response(null, { status: 404 });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 500 },
      );
    }
  },
});

process.stdout.write(
  `Browser sidecar demo available at http://${server.hostname}:${String(server.port)}\n`,
);

async function bootstrap() {
  if (deployment !== undefined) return deployment;
  bootstrapPromise ??= hub.bootstrap(inferenceSource());
  try {
    deployment = await bootstrapPromise;
    return deployment;
  } catch (cause) {
    bootstrapPromise = undefined;
    throw cause;
  }
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
    define: {
      __BROWSER_WORKFLOW_BUNDLE_URL__: JSON.stringify("/browser-workflow.js"),
    },
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
  return new Response(source, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
    },
  });
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
