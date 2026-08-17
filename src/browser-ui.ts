import { type } from "arktype";

declare const document: DemoDocument;

interface DemoElement {
  addEventListener(type: "click", listener: () => void): void;
  textContent: string | null;
}

interface DemoButtonElement extends DemoElement {
  disabled: boolean;
}

interface DemoTextAreaElement extends DemoElement {
  select(): void;
  value: string;
}

interface DemoDocument {
  getElementById(id: string): unknown;
}

const PairingResponse = type({
  expiresAt: "number",
  installCommand: "string",
  pairingCode: "string",
});

const command = requiredTextArea("install-command");
const copy = requiredButton("copy-command");
const refresh = requiredButton("refresh-pairing");
const status = requiredElement("pairing-status");

copy.addEventListener("click", () => {
  void copyCommand();
});
refresh.addEventListener("click", () => {
  void createPairing();
});

void createPairing();

async function createPairing(): Promise<void> {
  copy.disabled = true;
  refresh.disabled = true;
  status.textContent = "Creating a short-lived pairing code…";
  try {
    const response = await fetch("/api/pairings", { method: "POST" });
    const body: unknown = await response.json();
    if (!response.ok) throw responseError(body, response.status);
    const pairing = PairingResponse.assert(body);
    command.value = pairing.installCommand;
    status.textContent = `Ready. This command can be used once and expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}.`;
    copy.disabled = false;
  } catch (cause) {
    status.textContent = cause instanceof Error ? cause.message : String(cause);
  } finally {
    refresh.disabled = false;
  }
}

async function copyCommand(): Promise<void> {
  try {
    const clipboard = Reflect.get(navigator, "clipboard");
    const writeText =
      typeof clipboard === "object" && clipboard !== null
        ? Reflect.get(clipboard, "writeText")
        : undefined;
    if (typeof writeText !== "function") {
      throw new Error("Clipboard API is unavailable");
    }
    await Reflect.apply(writeText, clipboard, [command.value]);
    status.textContent =
      "Copied. Paste the command into the target tab's console.";
  } catch {
    command.select();
    status.textContent = "Select and copy the command manually.";
  }
}

function responseError(body: unknown, responseStatus: number): Error {
  if (typeof body === "object" && body !== null) {
    const message = Reflect.get(body, "error");
    if (typeof message === "string") return new Error(message);
  }
  return new Error(`Pairing request failed with ${String(responseStatus)}`);
}

function requiredElement(id: string): DemoElement {
  const element = document.getElementById(id);
  if (!isDemoElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function requiredTextArea(id: string): DemoTextAreaElement {
  const element = document.getElementById(id);
  if (!isDemoTextAreaElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function requiredButton(id: string): DemoButtonElement {
  const element = document.getElementById(id);
  if (!isDemoButtonElement(element)) throw new Error(`Missing #${id}`);
  return element;
}

function isDemoElement(value: unknown): value is DemoElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "textContent" in value &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function isDemoTextAreaElement(value: unknown): value is DemoTextAreaElement {
  return (
    isDemoElement(value) &&
    typeof Reflect.get(value, "value") === "string" &&
    typeof Reflect.get(value, "select") === "function"
  );
}

function isDemoButtonElement(value: unknown): value is DemoButtonElement {
  return (
    isDemoElement(value) && typeof Reflect.get(value, "disabled") === "boolean"
  );
}
