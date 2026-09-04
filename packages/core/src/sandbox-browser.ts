import { z } from "zod";

import { textSchema } from "./protocol.ts";

const PointSchema = z.number().finite().min(0).max(16_384);
const ResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

export const BrowserArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.url() }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("click"), selector: textSchema(1_000) }),
  z.object({
    action: z.literal("type"),
    selector: textSchema(1_000),
    text: textSchema(8_000),
  }),
  z.object({ action: z.literal("evaluate"), expression: textSchema(8_000) }),
]);

export const BrowserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: PointSchema,
    y: PointSchema,
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(2).default(1),
  }),
  z.object({
    type: z.literal("scroll"),
    deltaX: z.number().finite().min(-10_000).max(10_000),
    deltaY: z.number().finite().min(-10_000).max(10_000),
  }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(100) }),
]);

export type BrowserArguments = Readonly<z.infer<typeof BrowserArgumentsSchema>>;
export type BrowserInput = Readonly<z.infer<typeof BrowserInputSchema>>;

function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "ok");
}

export class SandboxBrowser {
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.endpoint = z.url().parse(baseUrl).replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async connect(): Promise<void> {
    if (!await this.request("/v1/browser/info"))
      throw new Error("Sandbox browser is unavailable");
  }

  async execute(input: BrowserArguments): Promise<string> {
    switch (input.action) {
      case "navigate":
        await this.request("/v1/browser/page/navigate", { url: input.url });
        return `Navigated to ${input.url}`;
      case "snapshot":
        return z.string().parse(await this.request("/v1/browser/page/text"));
      case "click":
        await this.request("/v1/browser/page/click", {
          selector: input.selector,
        });
        return `Clicked ${input.selector}`;
      case "type":
        await this.request("/v1/browser/page/fill", {
          selector: input.selector,
          text: input.text,
        });
        return `Typed into ${input.selector}`;
      case "evaluate":
        return responseText(
          await this.request("/v1/browser/page/evaluate", {
            expression: input.expression,
          }),
        );
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const response = await fetch(`${this.endpoint}/v1/browser/screenshot`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`Browser screenshot failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async input(input: BrowserInput): Promise<void> {
    switch (input.type) {
      case "click":
        await this.request("/v1/browser/page/click", {
          x: input.x,
          y: input.y,
          button: input.button,
          click_count: input.clickCount,
        });
        return;
      case "scroll": {
        const vertical = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
        const delta = vertical ? input.deltaY : input.deltaX;
        await this.request("/v1/browser/page/scroll", {
          direction: vertical
            ? delta < 0
              ? "up"
              : "down"
            : delta < 0
              ? "left"
              : "right",
          amount: Math.abs(delta),
        });
        return;
      }
      case "key":
        await this.request("/v1/browser/page/press_key", { key: input.key });
    }
  }

  private headers(): HeadersInit {
    return this.apiKey ? { "X-AIO-API-Key": this.apiKey } : {};
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...this.headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = ResponseSchema.parse(await response.json());
    if (!response.ok || !result.success)
      throw new Error(result.message ?? `Browser request failed: ${response.status}`);
    return result.data;
  }
}
