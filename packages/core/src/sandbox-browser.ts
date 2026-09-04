import { SandboxClient } from "@agent-infra/sandbox";
import { z } from "zod";

import { errorMessage, textSchema } from "./protocol.ts";

const PointSchema = z.number().finite().min(0).max(16_384);
const ResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});
const TextResponseSchema = ResponseSchema.extend({ data: z.string() });

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

type SdkResponse<T> =
  Readonly<{ ok: true; body: T }> | Readonly<{ ok: false; error: unknown }>;

function responseBody<T>(response: SdkResponse<T>): T {
  if (!response.ok) throw new Error(errorMessage(response.error));
  return response.body;
}

function responseText(value: unknown): string {
  const response = ResponseSchema.parse(value);
  if (response.success === false)
    throw new Error(response.message ?? "Sandbox browser request failed");
  if (typeof response.data === "string") return response.data;
  return response.message ?? JSON.stringify(response.data ?? "ok");
}

export class SandboxBrowser {
  private readonly client: SandboxClient;

  constructor(baseUrl: string, apiKey?: string) {
    const endpoint = z.url().parse(baseUrl).replace(/\/$/, "");
    this.client = new SandboxClient({
      baseUrl: endpoint,
      environment: endpoint,
      ...(apiKey ? { headers: { "X-AIO-API-Key": apiKey } } : {}),
    });
  }

  async connect(): Promise<void> {
    const response = ResponseSchema.parse(
      responseBody(await this.client.browser.getInfo()),
    );
    if (!response.data) throw new Error("Sandbox browser is unavailable");
  }

  async execute(input: BrowserArguments): Promise<string> {
    switch (input.action) {
      case "navigate":
        responseText(
          responseBody(
            await this.client.browserPage.navigate({ url: input.url }),
          ),
        );
        return `Navigated to ${input.url}`;
      case "snapshot":
        return TextResponseSchema.parse(
          responseBody(await this.client.browserPage.getText()),
        ).data;
      case "click":
        responseText(
          responseBody(
            await this.client.browserPage.click({ selector: input.selector }),
          ),
        );
        return `Clicked ${input.selector}`;
      case "type":
        responseText(
          responseBody(
            await this.client.browserPage.fill({
              selector: input.selector,
              text: input.text,
            }),
          ),
        );
        return `Typed into ${input.selector}`;
      case "evaluate":
        return responseText(
          responseBody(
            await this.client.browserPage.evaluate({
              expression: input.expression,
            }),
          ),
        );
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const binary: unknown = responseBody(
      await this.client.browserPage.screenshot({ format: "png" }),
    );
    if (
      !binary ||
      typeof binary !== "object" ||
      !("arrayBuffer" in binary) ||
      typeof binary.arrayBuffer !== "function"
    ) {
      throw new Error("Sandbox returned an invalid screenshot");
    }
    return new Uint8Array(await binary.arrayBuffer());
  }

  async input(input: BrowserInput): Promise<void> {
    switch (input.type) {
      case "click":
        responseText(
          responseBody(
            await this.client.browserPage.click({
              x: input.x,
              y: input.y,
              button: input.button,
              click_count: input.clickCount,
            }),
          ),
        );
        return;
      case "scroll": {
        const vertical = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
        const delta = vertical ? input.deltaY : input.deltaX;
        responseText(
          responseBody(
            await this.client.browserPage.scroll({
              direction: vertical
                ? delta < 0
                  ? "up"
                  : "down"
                : delta < 0
                  ? "left"
                  : "right",
              amount: Math.abs(delta),
            }),
          ),
        );
        return;
      }
      case "key":
        responseText(
          responseBody(
            await this.client.browserPage.pressKey({ key: input.key }),
          ),
        );
    }
  }
}
