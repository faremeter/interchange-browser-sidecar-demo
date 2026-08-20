import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type } from "arktype";

const AssetResponse = type({ id: "string", name: "string" });
const AssetListResponse = AssetResponse.array();
const IdNameResponse = type({ id: "string", name: "string" });
const IdNameListResponse = type({ data: IdNameResponse.array() });
const ModelResponse = type({ id: "string", canonicalName: "string" });
const ModelListResponse = type({ data: ModelResponse.array() });
const OfferingResponse = type({
  id: "string",
  modelId: "string",
  providerId: "string",
});
const OfferingListResponse = type({ data: OfferingResponse.array() });
const DeploymentResponse = type({ id: "string" });
const GitTokenResponse = type({ secret: "string" });
const MailResponse = type({ messageId: "string" });
const PrincipalResponse = type({ tenantId: "string", tenantSlug: "string" });
const PrincipalListResponse = type({ data: PrincipalResponse.array() });
const TenantResponse = type({
  id: "string",
  "config?": "Record<string, unknown>",
});

const ASSET_NAME = "browser-debug-workflow";
const DEFAULT_TENANT_SLUG = "browser-demo";
const INFERENCE_PROVIDER_NAME = "Browser Demo Anthropic";
const INFERENCE_CREDENTIAL_NAME = "Browser Demo Anthropic Key";
const WORKFLOW_ENTRY = "./workflow.mjs";
const WORKFLOW_PACKAGE_NAME = "@intx-demo/browser-debug-workflow";

export type InferenceSource = {
  apiKey: string;
  baseURL: string;
  id: string;
  model: string;
  provider: "anthropic";
  quirks: { directBrowserAccess: true };
};

export type DemoHubClientOptions = {
  email?: string;
  hubURL: string;
  password?: string;
  tenantId?: string;
  tenantSlug?: string;
  workflowSource: string;
};

export function createDemoHubClient(options: DemoHubClientOptions) {
  let sessionCookie: string | undefined;
  let tenantId: string | undefined;

  async function authenticate(): Promise<string> {
    if (sessionCookie !== undefined) return sessionCookie;
    const response = await fetch(`${options.hubURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: options.email ?? "alice@example.com",
        password: options.password ?? "password123",
      }),
    });
    if (!response.ok) {
      throw new Error(`Hub sign-in failed with ${String(response.status)}`);
    }
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined || cookie === "") {
      throw new Error("Hub sign-in did not return a session cookie");
    }
    sessionCookie = cookie;
    return cookie;
  }

  async function resolveTenantId(cookie: string): Promise<string> {
    if (tenantId !== undefined) return tenantId;
    if (options.tenantId !== undefined && options.tenantId !== "") {
      tenantId = options.tenantId;
      return tenantId;
    }
    const principals = PrincipalListResponse.assert(
      await api(cookie, "GET", "/api/me/principals"),
    );
    const tenantSlug = options.tenantSlug ?? DEFAULT_TENANT_SLUG;
    const principal = principals.data.find(
      (candidate) => candidate.tenantSlug === tenantSlug,
    );
    if (principal === undefined) {
      if (options.tenantSlug !== undefined) {
        throw new Error(
          `Tenant ${tenantSlug} is not visible to the signed-in user`,
        );
      }
      tenantId = TenantResponse.assert(
        await api(cookie, "POST", "/api/tenants", {
          name: "Browser Sidecar Demo",
          slug: tenantSlug,
        }),
      ).id;
      return tenantId;
    }
    tenantId = principal.tenantId;
    return tenantId;
  }

  async function bootstrap(source: InferenceSource) {
    const cookie = await authenticate();
    const resolvedTenantId = await resolveTenantId(cookie);
    await ensureExclusivePlacement(cookie, resolvedTenantId);
    const catalogSource = await ensureCatalogSource(
      (method, pathname, body) => rawAPI(cookie, method, pathname, body),
      resolvedTenantId,
      source,
    );
    const asset = await ensureWorkflowAsset(cookie, resolvedTenantId);
    const commitSha = await pushWorkflow(cookie, resolvedTenantId, asset.name);
    const deployment = DeploymentResponse.assert(
      await api(
        cookie,
        "POST",
        `/api/tenants/${resolvedTenantId}/workflows/deployments`,
        createWorkflowDeploymentRequest(asset.id, commitSha, catalogSource),
      ),
    );
    return { deploymentId: deployment.id, tenantId: resolvedTenantId };
  }

  async function trigger(deploymentId: string, prompt: string) {
    const cookie = await authenticate();
    const resolvedTenantId = await resolveTenantId(cookie);
    return MailResponse.assert(
      await api(
        cookie,
        "POST",
        `/api/tenants/${resolvedTenantId}/workflows/${deploymentId}/mail`,
        { content: prompt },
      ),
    );
  }

  async function ensureExclusivePlacement(
    cookie: string,
    resolvedTenantId: string,
  ): Promise<void> {
    const tenant = TenantResponse.assert(
      await api(cookie, "GET", `/api/tenants/${resolvedTenantId}`),
    );
    await api(cookie, "PATCH", `/api/tenants/${resolvedTenantId}`, {
      config: withBrowserPlacement(tenant.config ?? {}),
    });
  }

  async function ensureWorkflowAsset(cookie: string, resolvedTenantId: string) {
    const created = await rawAPI(
      cookie,
      "POST",
      `/api/tenants/${resolvedTenantId}/assets`,
      { kind: "workflow", name: ASSET_NAME },
    );
    if (created.response.status === 201) {
      return AssetResponse.assert(created.body);
    }
    if (created.response.status !== 409) {
      throw apiError("create browser workflow asset", created);
    }
    const assets = AssetListResponse.assert(
      await api(
        cookie,
        "GET",
        `/api/tenants/${resolvedTenantId}/assets?kind=workflow`,
      ),
    );
    const existing = assets.find((candidate) => candidate.name === ASSET_NAME);
    if (existing === undefined) {
      throw new Error(
        `Hub reported duplicate asset ${ASSET_NAME}, but did not list it`,
      );
    }
    return existing;
  }

  async function pushWorkflow(
    cookie: string,
    resolvedTenantId: string,
    assetName: string,
  ): Promise<string> {
    const token = GitTokenResponse.assert(
      await api(cookie, "POST", `/api/tenants/${resolvedTenantId}/git-tokens`, {
        name: `browser-sidecar-demo-${crypto.randomUUID()}`,
        resource: "asset:*",
        refPattern: "**",
        actions: ["can_read", "can_push"],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    );

    const root = await mkdtemp(join(tmpdir(), "browser-sidecar-demo-"));
    const repoDirectory = join(root, "repo");
    const askpass = join(root, "askpass.sh");
    try {
      await writeFile(
        askpass,
        `#!/bin/sh\nprintf '%s\\n' '${shellSingleQuote(token.secret)}'\n`,
        "utf8",
      );
      await chmod(askpass, 0o700);
      const remote = `${options.hubURL}/api/tenants/${resolvedTenantId}/assets/workflow/${assetName}.git`;
      const env = {
        ...process.env,
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Browser sidecar demo",
        GIT_AUTHOR_EMAIL: "browser-demo@interchange.local",
        GIT_COMMITTER_NAME: "Browser sidecar demo",
        GIT_COMMITTER_EMAIL: "browser-demo@interchange.local",
      };
      await runGit(
        ["-c", "credential.helper=", "clone", remote, repoDirectory],
        root,
        env,
      );
      await rm(join(repoDirectory, "workflow.json"), { force: true });
      await Promise.all([
        writeFile(
          join(repoDirectory, "package.json"),
          `${JSON.stringify(
            {
              name: WORKFLOW_PACKAGE_NAME,
              version: "0.1.0",
              type: "module",
              interchange: { workflow: WORKFLOW_ENTRY },
            },
            null,
            2,
          )}\n`,
          "utf8",
        ),
        writeFile(
          join(repoDirectory, WORKFLOW_ENTRY),
          options.workflowSource,
          "utf8",
        ),
      ]);
      await runGit(["add", "--all"], repoDirectory, env);
      const diff = await runGit(
        ["diff", "--cached", "--quiet"],
        repoDirectory,
        env,
        true,
      );
      if (diff.exitCode !== 0) {
        await runGit(
          ["commit", "-m", "Update browser sidecar demo workflow"],
          repoDirectory,
          env,
        );
        await runGit(
          ["-c", "credential.helper=", "push", remote, "HEAD:main"],
          repoDirectory,
          env,
        );
      }
      return (
        await runGit(["rev-parse", "HEAD"], repoDirectory, env)
      ).stdout.trim();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function api(
    cookie: string,
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<unknown> {
    const result = await rawAPI(cookie, method, pathname, body);
    if (!result.response.ok) throw apiError(`${method} ${pathname}`, result);
    return result.body;
  }

  async function rawAPI(
    cookie: string,
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ response: Response; body: unknown }> {
    const response = await fetch(`${options.hubURL}${pathname}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { response, body: parsed };
  }

  return { bootstrap, trigger };
}

type APIResult = { response: Response; body: unknown };
type HubRequest = (
  method: string,
  pathname: string,
  body?: unknown,
) => Promise<APIResult>;

export function withBrowserPlacement<T extends Record<string, unknown>>(
  config: T,
) {
  return {
    ...config,
    sidecarPlacement: {
      sharing: "exclusive" as const,
      reuse: "same-deployment" as const,
    },
  };
}

export function createWorkflowDeploymentRequest(
  assetId: string,
  commitSha: string,
  source: InferenceSource,
) {
  return {
    source: {
      kind: "asset" as const,
      assetId,
      package: { format: "source" as const, commitSha },
    },
    entry: WORKFLOW_ENTRY,
    sources: [source],
    defaultSource: source.id,
  };
}

export async function ensureCatalogSource(
  request: HubRequest,
  tenantId: string,
  source: InferenceSource,
): Promise<InferenceSource> {
  const provider = await createOrFind({
    request,
    createPath: `/api/tenants/${tenantId}/providers`,
    createBody: {
      name: INFERENCE_PROVIDER_NAME,
      plugin: source.provider,
      apiBaseUrl: source.baseURL,
    },
    listPath: `/api/tenants/${tenantId}/providers?inherited=false&limit=100`,
    response: IdNameResponse,
    listResponse: IdNameListResponse,
    matches: (candidate) => candidate.name === INFERENCE_PROVIDER_NAME,
    label: "browser demo integration provider",
  });
  const credential = await createOrFind({
    request,
    createPath: `/api/tenants/${tenantId}/credentials`,
    createBody: {
      providerId: provider.id,
      name: INFERENCE_CREDENTIAL_NAME,
      type: "api_key",
      secret: source.apiKey,
      scopes: ["chat"],
    },
    listPath: `/api/tenants/${tenantId}/credentials?owner=org&limit=100`,
    response: IdNameResponse,
    listResponse: IdNameListResponse,
    matches: (candidate) => candidate.name === INFERENCE_CREDENTIAL_NAME,
    label: "browser demo credential",
  });
  await successfulRequest(
    request,
    "PATCH",
    `/api/tenants/${tenantId}/credentials/${credential.id}`,
    { secret: source.apiKey, status: "active" },
  );
  const model = await createOrFind({
    request,
    createPath: `/api/tenants/${tenantId}/catalog/models`,
    createBody: { canonicalName: source.model, displayName: source.model },
    listPath: `/api/tenants/${tenantId}/catalog/models?limit=100`,
    response: ModelResponse,
    listResponse: ModelListResponse,
    matches: (candidate) => candidate.canonicalName === source.model,
    label: `model ${source.model}`,
  });
  const catalogProvider = await createOrFind({
    request,
    createPath: `/api/tenants/${tenantId}/catalog/providers`,
    createBody: {
      name: INFERENCE_PROVIDER_NAME,
      plugin: source.provider,
      baseURL: source.baseURL,
      credentialId: credential.id,
    },
    listPath: `/api/tenants/${tenantId}/catalog/providers?limit=100`,
    response: IdNameResponse,
    listResponse: IdNameListResponse,
    matches: (candidate) => candidate.name === INFERENCE_PROVIDER_NAME,
    label: "browser demo catalog provider",
  });
  const offering = await createOrFind({
    request,
    createPath: `/api/tenants/${tenantId}/catalog/offerings`,
    createBody: {
      modelId: model.id,
      providerId: catalogProvider.id,
      capabilities: ["function-calling"],
      quirks: source.quirks,
    },
    listPath: `/api/tenants/${tenantId}/catalog/offerings?limit=100`,
    response: OfferingResponse,
    listResponse: OfferingListResponse,
    matches: (candidate) =>
      candidate.modelId === model.id &&
      candidate.providerId === catalogProvider.id,
    label: "browser demo catalog offering",
  });
  return { ...source, id: offering.id };
}

type ResponseSchema<T> = { assert(value: unknown): T };

async function createOrFind<T>(args: {
  request: HubRequest;
  createPath: string;
  createBody: unknown;
  listPath: string;
  response: ResponseSchema<T>;
  listResponse: ResponseSchema<{ data: T[] }>;
  matches(candidate: T): boolean;
  label: string;
}): Promise<T> {
  const created = await args.request("POST", args.createPath, args.createBody);
  if (created.response.status === 201) {
    return args.response.assert(created.body);
  }
  if (created.response.status !== 409) {
    throw apiError(`create ${args.label}`, created);
  }
  const listed = await successfulRequest(args.request, "GET", args.listPath);
  const existing = args.listResponse.assert(listed).data.find(args.matches);
  if (existing === undefined) {
    throw new Error(
      `Hub reported duplicate ${args.label}, but did not list it`,
    );
  }
  return existing;
}

async function successfulRequest(
  request: HubRequest,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const result = await request(method, pathname, body);
  if (!result.response.ok) throw apiError(`${method} ${pathname}`, result);
  return result.body;
}

function apiError(
  operation: string,
  result: { response: Response; body: unknown },
): Error {
  return new Error(
    `${operation} failed with ${String(result.response.status)}: ${JSON.stringify(result.body)}`,
  );
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  allowFailure = false,
): Promise<{ exitCode: number; stdout: string }> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${stderr || stdout}`);
  }
  return { exitCode, stdout };
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}
