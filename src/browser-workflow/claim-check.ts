import { type } from "arktype";

const ClaimCheckEnvelope = type({
  messageId: "string > 0",
  receivedAt: "number >= 0",
  address: "string > 0",
  mailAuditRef: {
    store: "string > 0",
    path: "string > 0",
  },
  rawMessage: "string > 0",
});

const WatermarkEnvelope = type({ watermark: "number >= 0" });

export type BrowserClaimCheckMail = {
  address: string;
  messageId: string;
  rawMessage: string;
};

export type BrowserClaimCheckEnvelope = typeof ClaimCheckEnvelope.infer;

export type BrowserClaimCheckReads = {
  list(directory: string): Promise<string[]>;
  read(filepath: string): Promise<string | null>;
};

export type BrowserClaimCheckMutation<T> = {
  deletes: string[];
  puts: Record<string, string>;
  value: T;
};

export interface BrowserClaimCheckMutator {
  mutate<T>(
    message: string,
    compute: (
      reads: BrowserClaimCheckReads,
    ) => Promise<BrowserClaimCheckMutation<T>>,
  ): Promise<T>;
}

export type BrowserClaimCheck = {
  enqueue(mail: BrowserClaimCheckMail): Promise<"enqueued" | "already-present">;
  dequeue(
    address: string,
    messageId: string,
  ): Promise<BrowserClaimCheckEnvelope | null>;
  markConsumed(args: {
    address: string;
    messageId: string;
    runId: string;
  }): Promise<void>;
};

export function createBrowserClaimCheck(
  mutator: BrowserClaimCheckMutator,
  now: () => number = Date.now,
): BrowserClaimCheck {
  return {
    async enqueue(mail) {
      const paths = claimCheckPaths(mail.address);
      const receivedAt = now();
      return mutator.mutate(
        `enqueue inbox ${mail.address} ${mail.messageId}`,
        async (reads) => {
          const [inbox, processing, consumed] = await Promise.all([
            reads.list(paths.inbox),
            reads.list(paths.processing),
            reads.list(paths.consumed),
          ]);
          const queuedSuffix = `-${mail.messageId}.json`;
          if (
            inbox.some((name) => name.endsWith(queuedSuffix)) ||
            processing.some((name) => name.endsWith(queuedSuffix)) ||
            consumed.includes(`${mail.messageId}.json`)
          ) {
            return {
              deletes: [],
              puts: {},
              value: "already-present" as const,
            };
          }
          const envelope: BrowserClaimCheckEnvelope = {
            address: mail.address,
            messageId: mail.messageId,
            receivedAt,
            mailAuditRef: {
              store: "browser-workflow-run",
              path: `${encodeURIComponent(mail.address)}/${encodeURIComponent(mail.messageId)}`,
            },
            rawMessage: mail.rawMessage,
          };
          return {
            deletes: [],
            puts: {
              [`${paths.inbox}/${String(receivedAt)}-${mail.messageId}.json`]:
                JSON.stringify(envelope),
            },
            value: "enqueued" as const,
          };
        },
      );
    },

    async dequeue(address, messageId) {
      const paths = claimCheckPaths(address);
      return mutator.mutate(
        `dequeue ${address} ${messageId}`,
        async (reads) => {
          const suffix = `-${messageId}.json`;
          const filename = (await reads.list(paths.inbox)).find((name) =>
            name.endsWith(suffix),
          );
          if (filename === undefined) {
            return { deletes: [], puts: {}, value: null };
          }
          const inboxPath = `${paths.inbox}/${filename}`;
          const raw = await reads.read(inboxPath);
          if (raw === null) {
            throw new Error(
              `claim-check inbox entry disappeared: ${inboxPath}`,
            );
          }
          const envelope = ClaimCheckEnvelope.assert(JSON.parse(raw));
          return {
            deletes: [inboxPath],
            puts: { [`${paths.processing}/${filename}`]: raw },
            value: envelope,
          };
        },
      );
    },

    async markConsumed(args) {
      const paths = claimCheckPaths(args.address);
      await mutator.mutate(
        `consume ${args.address} ${args.messageId}`,
        async (reads) => {
          const suffix = `-${args.messageId}.json`;
          const filename = (await reads.list(paths.processing)).find((name) =>
            name.endsWith(suffix),
          );
          if (filename === undefined) {
            throw new Error(
              `claim_check_processing_not_found: address ${args.address} message ${args.messageId}`,
            );
          }
          const processingPath = `${paths.processing}/${filename}`;
          const raw = await reads.read(processingPath);
          if (raw === null) {
            throw new Error(
              `claim-check processing entry disappeared: ${processingPath}`,
            );
          }
          const envelope = ClaimCheckEnvelope.assert(JSON.parse(raw));
          const watermarkRaw = await reads.read(paths.watermark);
          const watermark =
            watermarkRaw === null
              ? 0
              : WatermarkEnvelope.assert(JSON.parse(watermarkRaw)).watermark;
          const consumedAt = now();
          return {
            deletes: [processingPath],
            puts: {
              [`${paths.consumed}/${args.messageId}.json`]: JSON.stringify({
                messageId: args.messageId,
                receivedAt: envelope.receivedAt,
                address: args.address,
                runId: args.runId,
                consumedAt,
                mailAuditRef: envelope.mailAuditRef,
              }),
              [paths.watermark]: JSON.stringify({ watermark }),
            },
            value: undefined,
          };
        },
      );
    },
  };
}

function claimCheckPaths(address: string) {
  const root = `addresses/${encodeURIComponent(address)}`;
  return {
    inbox: `${root}/inbox`,
    processing: `${root}/processing`,
    consumed: `${root}/consumed`,
    watermark: `${root}/watermark.json`,
  };
}
