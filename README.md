# Interchange browser sidecar demo

This is a standalone demo of an Interchange workflow and agent running inside
a browser tab. The Interchange Hub still owns deployment, trigger delivery,
authorization, and the durable workflow-run repository. The browser owns the
workflow runtime, agent loop, direct Anthropic request, browser-only tool, and
LightningFS working repository.

The browser runtime source lives in this repository. `bun start` bundles it in
memory against the sibling Interchange checkout and serves the result; no
generated JavaScript or workflow definition is checked in.

## Run the demo

Start a clean Interchange Hub without the production sidecar:

```bash
cd ../interchange
git apply ../interchange-browser-sidecar-demo/integration/interchange-hub.patch
bin/db-reset --clean
bin/dev --seed --no-sidecar
```

In another terminal, provision the identity used by the browser:

```bash
cd ../interchange
set -a
source .env
source .env.migrate
set +a

SIDECAR_ID=browser-demo \
SIDECAR_TOKEN=browser-demo-token \
bin/provision-sidecar
```

Then install and run this demo:

```bash
cd ../interchange-browser-sidecar-demo
bun install
ANTHROPIC_API_KEY=... bun start
```

Open <http://127.0.0.1:4174>.

Use only a temporary, restricted Anthropic key. Direct browser inference means
the key is sent to the tab in the deployment and is visible to anyone who can
inspect that tab.

## What the demo proves

- The browser registers directly on the Hub's ordinary sidecar WebSocket.
- The Hub delivers the deployment and trigger to the browser tab.
- The agent calls `browser_info`, which reads `navigator.userAgent` in the tab.
- The Anthropic request originates from the browser and appears in its network
  inspector.
- Workflow events are committed in LightningFS and pushed to the Hub using the
  existing workflow-run pack protocol.
- Closing the tab removes the execution host.

The Bun server builds and serves the browser runtime from TypeScript, publishes
the workflow definition exported by that same source, and calls ordinary Hub
APIs to deploy and trigger it. It does not execute the workflow or agent.

## Browser runtime source

The reviewable browser implementation is under `src/browser-workflow/`. It was
extracted from the Interchange browser-sidecar spike. The start and type-check
commands link the Interchange workspace packages into this repository, so run
`bun install` in that checkout first. Set `INTERCHANGE_SOURCE_DIR` if the
repositories are not siblings. The Hub definition and executable workflow are
exported from the same source module so they cannot drift independently.
