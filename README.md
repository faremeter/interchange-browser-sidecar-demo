# Interchange browser sidecar demo

This is a standalone demo of an Interchange workflow and agent running inside
a browser tab. The Interchange Hub still owns deployment, trigger delivery,
authorization, and the durable workflow-run repository. The browser owns the
workflow runtime, agent loop, direct Anthropic request, browser-only tool, and
LightningFS working repository.

The browser runtime source lives in this repository. `bun start` bundles it in
memory against the sibling Interchange checkout and serves the result; no
generated JavaScript or workflow definition is checked in. This repository
includes the provisioner package `@intx/browser-sidecar-demo-provisioner`; a
small Hub patch links that package as a local dependency and registers it
directly.

## Run the demo

Install the demo dependencies and register its provisioner package with Bun:

```bash
cd ../interchange-browser-sidecar-demo
bun install
cd packages/provisioner
bun link
```

Start a clean Interchange Hub without the production sidecar:

```bash
cd ../interchange
git apply ../interchange-browser-sidecar-demo/integration/interchange-hub.patch
git apply ../interchange-browser-sidecar-demo/integration/interchange-browser-provisioner.patch
bun install
bin/db-reset --clean
```

Start the demo server in another terminal:

```bash
cd ../interchange-browser-sidecar-demo
BROWSER_DEMO_CONTROL_TOKEN=browser-demo-local \
ANTHROPIC_API_KEY=... \
bun start
```

Then start the Hub without the production sidecar:

```bash
cd ../interchange
BROWSER_DEMO_CONTROL_TOKEN=browser-demo-local \
bin/dev --seed --no-sidecar
```

Open <http://127.0.0.1:4174>.

Use only a temporary, restricted Anthropic key. Direct browser inference means
the key is sent to the tab in the deployment and is visible to anyone who can
inspect that tab.

## What the demo proves

- The browser registers directly on the Hub's ordinary sidecar WebSocket.
- The workflow requests exclusive, same-deployment sidecar placement.
- Hub calls the linked `SidecarProvisioner` exported by this repository; it
  assigns Hub-generated, allocation-scoped credentials to the waiting browser
  tab.
- The demo registers the supplied Anthropic key as a tenant-owned catalog
  offering and deploys with that durable offering ID.
- The Hub delivers the deployment and trigger to the browser tab.
- The agent calls `browser_info`, which reads `navigator.userAgent` in the tab.
- The Anthropic request originates from the browser and appears in its network
  inspector.
- Workflow events are committed in LightningFS and pushed to the Hub using the
  existing workflow-run pack protocol.
- Closing the tab stops the execution host; Hub observes the WebSocket loss and
  runs its normal allocation release lifecycle after the reconnect grace.

The Bun server builds and serves the browser runtime from TypeScript, publishes
the workflow definition exported by that same source, calls ordinary Hub APIs,
and brokers provisioner assignments to waiting tabs. It does not execute the
workflow or agent.

## Browser runtime source

The reviewable browser implementation is under `src/browser-workflow/`. It was
extracted from the Interchange browser-sidecar spike. The start and type-check
commands link the Interchange workspace packages into this repository, so run
`bun install` in that checkout first. Set `INTERCHANGE_SOURCE_DIR` if the
repositories are not siblings. The Hub definition and executable workflow are
exported from the same source module so they cannot drift independently.
