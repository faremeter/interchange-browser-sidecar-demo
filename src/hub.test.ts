import { expect, test } from "bun:test";

import {
  createWorkflowDeploymentRequest,
  ensureCatalogSource,
  withBrowserPlacement,
  type InferenceSource,
} from "./hub";

const source: InferenceSource = {
  id: "browser-demo-anthropic",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "test-key",
  model: "claude-haiku-4-5-20251001",
  quirks: { directBrowserAccess: true },
};

test("uses the created catalog offering as the deployment source id", async () => {
  const requests = scriptedRequests([
    response("POST", "/api/tenants/tnt_demo/providers", 201, {
      id: "provider",
      name: "Browser Demo Anthropic",
    }),
    response("POST", "/api/tenants/tnt_demo/credentials", 201, {
      id: "credential",
      name: "Browser Demo Anthropic Key",
    }),
    response("PATCH", "/api/tenants/tnt_demo/credentials/credential", 200, {}),
    response("POST", "/api/tenants/tnt_demo/catalog/models", 201, {
      id: "model",
      canonicalName: source.model,
    }),
    response("POST", "/api/tenants/tnt_demo/catalog/providers", 201, {
      id: "catalog-provider",
      name: "Browser Demo Anthropic",
    }),
    response("POST", "/api/tenants/tnt_demo/catalog/offerings", 201, {
      id: "offering",
      modelId: "model",
      providerId: "catalog-provider",
    }),
  ]);

  const catalogSource = await ensureCatalogSource(
    requests.request,
    "tnt_demo",
    source,
  );

  expect(catalogSource).toEqual({ ...source, id: "offering" });
  expect(requests.remaining()).toBe(0);
});

test("reuses catalog records and rotates the demo credential", async () => {
  const requests = scriptedRequests([
    response("POST", "/api/tenants/tnt_demo/providers", 409, {}),
    response(
      "GET",
      "/api/tenants/tnt_demo/providers?inherited=false&limit=100",
      200,
      { data: [{ id: "provider", name: "Browser Demo Anthropic" }] },
    ),
    response("POST", "/api/tenants/tnt_demo/credentials", 409, {}),
    response(
      "GET",
      "/api/tenants/tnt_demo/credentials?owner=org&limit=100",
      200,
      {
        data: [{ id: "credential", name: "Browser Demo Anthropic Key" }],
      },
    ),
    response("PATCH", "/api/tenants/tnt_demo/credentials/credential", 200, {}),
    response("POST", "/api/tenants/tnt_demo/catalog/models", 409, {}),
    response("GET", "/api/tenants/tnt_demo/catalog/models?limit=100", 200, {
      data: [{ id: "model", canonicalName: source.model }],
    }),
    response("POST", "/api/tenants/tnt_demo/catalog/providers", 409, {}),
    response("GET", "/api/tenants/tnt_demo/catalog/providers?limit=100", 200, {
      data: [{ id: "catalog-provider", name: "Browser Demo Anthropic" }],
    }),
    response("POST", "/api/tenants/tnt_demo/catalog/offerings", 409, {}),
    response("GET", "/api/tenants/tnt_demo/catalog/offerings?limit=100", 200, {
      data: [
        {
          id: "offering",
          modelId: "model",
          providerId: "catalog-provider",
        },
      ],
    }),
  ]);

  const catalogSource = await ensureCatalogSource(
    requests.request,
    "tnt_demo",
    source,
  );

  expect(catalogSource.id).toBe("offering");
  expect(requests.remaining()).toBe(0);
});

test("builds a pinned source-tree deployment request", () => {
  expect(createWorkflowDeploymentRequest("asset", "commit", source)).toEqual({
    source: {
      kind: "asset",
      assetId: "asset",
      package: { format: "source", commitSha: "commit" },
    },
    entry: "./workflow.mjs",
    sources: [source],
    defaultSource: source.id,
  });
});

test("adds browser placement without dropping tenant configuration", () => {
  expect(withBrowserPlacement({ existing: true })).toEqual({
    existing: true,
    sidecarPlacement: {
      sharing: "exclusive",
      reuse: "same-deployment",
    },
  });
});

type ScriptedResponse = {
  method: string;
  pathname: string;
  status: number;
  body: unknown;
};

function response(
  method: string,
  pathname: string,
  status: number,
  body: unknown,
): ScriptedResponse {
  return { method, pathname, status, body };
}

function scriptedRequests(script: ScriptedResponse[]) {
  const pending = [...script];
  return {
    async request(method: string, pathname: string) {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error(`Unexpected ${method} ${pathname}`);
      }
      expect({ method, pathname }).toEqual({
        method: next.method,
        pathname: next.pathname,
      });
      return {
        response: new Response(null, { status: next.status }),
        body: next.body,
      };
    },
    remaining: () => pending.length,
  };
}
