# Interchange browser sidecar demo

This is a standalone demo of an Interchange workflow and agent running inside
a browser tab. The Interchange Hub still owns deployment, trigger delivery,
authorization, and the durable workflow-run repository. The browser owns the
workflow runtime, agent loop, direct Anthropic request, browser-only tool, and
LightningFS working repository.

The repository does not import or link any `@intx/*` packages. Its checked-in
`public/browser-workflow.js` is generated from the browser-sidecar example in
the Interchange repository.

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
bun install
ANTHROPIC_API_KEY=... bun start
```

Open <http://127.0.0.1:4174>.

Use only a temporary, restricted Anthropic key. Direct browser inference means
the key is sent to the tab in the deployment and is visible to anyone who can

## What the demo proves

- The browser registers directly on the Hub's ordinary sidecar WebSocket.
- The Hub delivers the deployment and trigger to the browser tab.
- The agent calls `browser_info`, which reads `navigator.userAgent` in the tab.
- The Anthropic request originates from the browser and appears in its network
  inspector.
- Workflow events are committed in LightningFS and pushed to the Hub using the
  existing workflow-run pack protocol.
- Closing the tab removes the execution host.

The Bun server only serves the demo, publishes its static `workflow.json`, and
calls ordinary Hub APIs to deploy and trigger it. It does not execute the
workflow or agent.

## Refresh the generated runtime

From the Interchange repository:

```bash
bun --conditions=intx-src \
  examples/browser-sidecar/src/export.ts \
  ../interchange-browser-sidecar-demo/public
```

Commit both generated files together because the Hub definition and executable
bundle describe the same workflow.
