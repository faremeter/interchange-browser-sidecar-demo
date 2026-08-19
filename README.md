# Interchange browser sidecar demo

This is a standalone demo that attaches an Interchange debugging workflow to a
live browser tab through its developer console. The Interchange Hub still owns
deployment, trigger delivery, per-run authorization grants, and the durable
workflow-run repository. The attached tab enforces those grants while owning
the workflow runtime, agent loop, direct Anthropic request, read-only page
inspection tool, and LightningFS working repository.

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

Prepare a clean Interchange Hub without the production sidecar:

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

Open <http://127.0.0.1:4174>, copy the generated one-time installation command,
and paste it into the developer console of a non-sensitive page you want to
debug. Once it resolves, ask the debugger from that console:

```js
await interchangeDebug.run(
  "Inspect this page and explain what could be causing the broken layout.",
);
```

By default, every `run()` call starts a fresh child workflow, matching the
original demo behavior. To keep one agent conversation across calls, start the
server with `BROWSER_DEMO_CONVERSATION=true`. The workflow then uses one
`triggers: "unbounded"` agent step; later `run()` calls resume it with its prior
turns still in context.

Disconnect the tab with `await interchangeDebug.disconnect()`.

Use only a temporary, restricted Anthropic key. Direct browser inference means
the key is sent to the tab in the deployment and is visible to anyone who can
inspect that tab. Page content returned by `inspect_page` is sent to the model,
so do not attach the debugger to a page containing data you cannot share.

The console installer is intentionally a prototype. Strict Content Security
Policy and HTTPS mixed-content rules can block the module, Hub WebSocket, or
model request. 

## What the demo proves

- A one-time, five-minute pairing code lets a target tab register without
  putting long-lived Hub credentials in the pasted command.
- Each installed tab receives its own workflow deployment and keeps its own
  long-lived parent run; repeated `run()` calls create children within it.
- The attached tab registers directly on the Hub's ordinary sidecar WebSocket.
- The workflow requests exclusive, same-deployment sidecar placement.
- Hub calls the linked `SidecarProvisioner` exported by this repository; it
  assigns Hub-generated, allocation-scoped credentials to the waiting browser
  tab.
- The demo registers the supplied Anthropic key as a tenant-owned catalog
  offering and deploys with that durable offering ID.
- The Hub delivers the deployment and trigger to the browser tab.
- The Hub delivers per-run grants that the browser enforces together with the
  bundled tool's standard authorization floor.
- The agent calls `inspect_page`, which reads the target tab's live DOM without
  exposing form values, cookies, storage, or URL query and fragment data.
- The Anthropic request originates from the browser and appears in its network
  inspector.
- Inbound triggers are durably claimed in LightningFS before the browser
  acknowledges them, then moved through the normal inbox, processing, and
  consumed states. Workflow events and claim-check evidence are pushed to the
  Hub using the existing workflow-run pack protocol.
- Closing the tab stops the execution host; Hub observes the WebSocket loss and
  runs its normal allocation release lifecycle after the reconnect grace.

The Bun server builds and serves the console installer and browser runtime from
TypeScript, publishes the workflow definition exported by that same source,
calls ordinary Hub APIs, and brokers provisioner assignments to paired tabs. It
does not inspect the page or execute the workflow or agent.

## Browser runtime source

The reviewable browser implementation is under `src/browser-workflow/`. It was
extracted from the Interchange browser-sidecar spike. The start and type-check
commands link the Interchange workspace packages into this repository, so run
`bun install` in that checkout first. Set `INTERCHANGE_SOURCE_DIR` if the
repositories are not siblings. The Hub definition and executable workflow are
exported from the same source module so they cannot drift independently.
