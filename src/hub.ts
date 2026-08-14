import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type } from "arktype";

const AssetResponse = type({ id: "string", name: "string" });
const AssetListResponse = AssetResponse.array();
const DeploymentResponse = type({ id: "string" });
const GitTokenResponse = type({ secret: "string" });
const MailResponse = type({ messageId: "string" });
const PrincipalResponse = type({ tenantId: "string", tenantSlug: "string" });
const PrincipalListResponse = type({ data: PrincipalResponse.array() });

const ASSET_NAME = "browser-bundled-fact-check";

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
  workflowDefinition: Record<string, unknown>;
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
    const tenantSlug = options.tenantSlug ?? "acme";
    const principal = principals.data.find(
      (candidate) => candidate.tenantSlug === tenantSlug,
    );
    if (principal === undefined) {
      throw new Error(
        `Tenant ${tenantSlug} is not visible to the signed-in user`,
      );
    }
    tenantId = principal.tenantId;
    return tenantId;
  }

  async function bootstrap(source: InferenceSource) {
    const cookie = await authenticate();
    const resolvedTenantId = await resolveTenantId(cookie);
    const asset = await ensureWorkflowAsset(cookie, resolvedTenantId);
    await pushWorkflow(cookie, resolvedTenantId, asset.name);
    const deployment = DeploymentResponse.assert(
      await api(
        cookie,
        "POST",
        `/api/tenants/${resolvedTenantId}/workflows/deployments`,
        {
          assetId: asset.id,
          sources: [source],
          defaultSource: source.id,
        },
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
  ): Promise<void> {
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
      await writeFile(
        join(repoDirectory, "workflow.json"),
        `${JSON.stringify(options.workflowDefinition, null, 2)}\n`,
        "utf8",
      );
      await runGit(["add", "workflow.json"], repoDirectory, env);
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
): Promise<{ exitCode: number }> {
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
  return { exitCode };
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}
