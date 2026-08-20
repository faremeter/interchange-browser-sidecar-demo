export type BrowserWorkflowBuildOptions = {
  conversationEnabled?: boolean;
  entrypoint: string;
  target?: "browser" | "bun";
};

export type BrowserWorkflowBundle = {
  bytes: number;
  source: string;
};

/** Bundle the browser workflow and its runtime into one ESM file. */
export async function buildBrowserWorkflow(
  options: BrowserWorkflowBuildOptions,
): Promise<BrowserWorkflowBundle> {
  const build = await Bun.build({
    entrypoints: [options.entrypoint],
    target: options.target ?? "browser",
    format: "esm",
    conditions: ["intx-src"],
    define: {
      __BROWSER_DEMO_CONVERSATION_ENABLED__: String(
        options.conversationEnabled ?? false,
      ),
    },
  });
  if (!build.success) {
    throw new Error(
      build.logs
        .map((log) => (log instanceof Error ? log.message : String(log)))
        .join("\n"),
    );
  }
  const output = build.outputs[0];
  if (output === undefined) {
    throw new Error("browser workflow build produced no output");
  }
  return { bytes: output.size, source: await output.text() };
}
