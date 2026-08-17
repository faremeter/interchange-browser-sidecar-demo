import { afterEach, describe, expect, test } from "bun:test";

import { inspectPage } from "./page-inspector";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  restoreGlobal("document", originalDocument);
  restoreGlobal("location", originalLocation);
  restoreGlobal("window", originalWindow);
});

describe("browser page inspector", () => {
  test("returns bounded page context without form values or URL secrets", () => {
    Object.defineProperties(globalThis, {
      document: {
        configurable: true,
        value: {
          title: "Checkout",
          documentElement: { lang: "en" },
          querySelectorAll(selector: string) {
            expect(selector).toBe("#checkout");
            return [
              {
                tagName: "FORM",
                id: "checkout",
                classList: ["stack", "checkout"],
                innerText: " Card number   Payment failed ",
                textContent: "ignored fallback",
                getAttribute(name: string) {
                  return name === "aria-label" ? "Checkout form" : null;
                },
                value: "4111111111111111",
              },
            ];
          },
        },
      },
      location: {
        configurable: true,
        value: {
          origin: "https://shop.example",
          pathname: "/checkout",
          search: "?token=secret",
          hash: "#private",
        },
      },
      window: {
        configurable: true,
        value: { innerWidth: 1280, innerHeight: 720 },
      },
    });

    const result = inspectPage({ selector: "#checkout" });

    expect(result).toEqual({
      page: {
        title: "Checkout",
        url: "https://shop.example/checkout",
        language: "en",
        viewport: { width: 1280, height: 720 },
      },
      selector: "#checkout",
      matchCount: 1,
      truncated: false,
      elements: [
        {
          tag: "form",
          id: "checkout",
          classes: ["stack", "checkout"],
          ariaLabel: "Checkout form",
          text: "Card number Payment failed",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("4111111111111111");
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });
});

function restoreGlobal(
  property: "document" | "location" | "window",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, property);
  } else {
    Object.defineProperty(globalThis, property, descriptor);
  }
}
