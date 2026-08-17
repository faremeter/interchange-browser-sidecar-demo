import { type } from "arktype";

declare const document: InspectorDocument;
declare const location: { origin: string; pathname: string };
declare const window: { innerHeight: number; innerWidth: number };

interface InspectorElement {
  classList: Iterable<string> & { length: number };
  getAttribute(name: string): string | null;
  id: string;
  tagName: string;
  textContent: string | null;
}

interface InspectorDocument {
  documentElement: { lang: string };
  querySelectorAll(selector: string): Iterable<InspectorElement>;
  title: string;
}

const InspectPageArgs = type({ "selector?": "string" });

const MAX_ELEMENTS = 20;
const MAX_TEXT_LENGTH = 8_000;

export const inspectPageToolDefinition = {
  name: "inspect_page",
  description:
    "Inspect matching elements in the live browser page without changing it. Omits form values, cookies, storage, query parameters, and URL fragments.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description:
          "CSS selector to inspect. Defaults to body. Use a narrower selector for follow-up investigation.",
      },
    },
    additionalProperties: false,
  },
};

export function inspectPage(args: unknown) {
  const { selector: rawSelector } = InspectPageArgs.assert(args);
  const selector = rawSelector?.trim() || "body";
  if (selector.length > 500) throw new Error("CSS selector is too long");
  const matches = [...document.querySelectorAll(selector)];
  let remainingTextLength = MAX_TEXT_LENGTH;
  const elements = matches.slice(0, MAX_ELEMENTS).map((element) => {
    const renderedText = Reflect.get(element, "innerText");
    const text = normalizeText(
      typeof renderedText === "string" ? renderedText : element.textContent,
    ).slice(0, remainingTextLength);
    remainingTextLength -= text.length;
    return compact({
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      classes:
        element.classList.length === 0
          ? undefined
          : [...element.classList].slice(0, 8),
      role: element.getAttribute("role") ?? undefined,
      ariaLabel: element.getAttribute("aria-label") ?? undefined,
      name: element.getAttribute("name") ?? undefined,
      type: element.getAttribute("type") ?? undefined,
      text: text === "" ? undefined : text,
    });
  });
  return {
    page: {
      title: document.title,
      url: `${location.origin}${location.pathname}`,
      language: document.documentElement.lang || undefined,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    },
    selector,
    matchCount: matches.length,
    truncated: matches.length > elements.length,
    elements,
  };
}

function normalizeText(value: string | null): string {
  return (value ?? "").replaceAll(/\s+/g, " ").trim();
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  );
}
