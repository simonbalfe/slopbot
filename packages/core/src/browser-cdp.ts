import { z } from "zod";

import { textSchema } from "./protocol.ts";

const CdpTargetSchema = z.object({
  type: z.string(),
  webSocketDebuggerUrl: z.url(),
});
const CdpResponseSchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const EvaluationResultSchema = z.object({
  result: z.object({ value: z.unknown().optional(), description: z.string().optional() }),
});
const ScreenshotSchema = z.object({ data: z.string().min(1) });
const PointSchema = z.number().finite().min(0).max(16_384);
const ModifiersSchema = z.number().int().min(0).max(15).default(0);

export const BrowserCdpArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.url() }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("click"), selector: textSchema(1_000) }),
  z.object({ action: z.literal("type"), selector: textSchema(1_000), text: textSchema(8_000) }),
  z.object({ action: z.literal("evaluate"), expression: textSchema(8_000) }),
]);

export type BrowserCdpArguments = Readonly<z.infer<typeof BrowserCdpArgumentsSchema>>;

export const BrowserCdpInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["mousePressed", "mouseReleased"]),
    x: PointSchema,
    y: PointSchema,
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(1).max(2).default(1),
    modifiers: ModifiersSchema,
  }),
  z.object({
    type: z.literal("mouseWheel"),
    x: PointSchema,
    y: PointSchema,
    deltaX: z.number().finite().min(-10_000).max(10_000),
    deltaY: z.number().finite().min(-10_000).max(10_000),
    modifiers: ModifiersSchema,
  }),
  z.object({
    type: z.literal("key"),
    key: z.string().min(1).max(100),
    code: z.string().min(1).max(100),
    text: z.string().max(100),
    modifiers: ModifiersSchema,
  }),
]);

export type BrowserCdpInput = Readonly<z.infer<typeof BrowserCdpInputSchema>>;

export class BrowserCdp {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = z.url().parse(endpoint).replace(/\/$/, "");
  }

  async execute(input: BrowserCdpArguments): Promise<string> {
    switch (input.action) {
      case "navigate":
        await this.command("Page.navigate", { url: input.url });
        return `Navigated to ${input.url}`;
      case "snapshot":
        return this.evaluate("document.body?.innerText ?? ''");
      case "click":
        return this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(input.selector)}); if (!element) throw new Error('Selector not found'); element.scrollIntoView({ block: 'center' }); (element instanceof HTMLElement ? element : null)?.click(); return 'Clicked ${input.selector}'; })()`);
      case "type":
        await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(input.selector)}); if (!(element instanceof HTMLElement)) throw new Error('Editable selector not found'); element.scrollIntoView({ block: 'center' }); element.focus(); return true; })()`);
        await this.command("Input.insertText", { text: input.text });
        return `Typed into ${input.selector}`;
      case "evaluate":
        return this.evaluate(input.expression);
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const result = ScreenshotSchema.parse(await this.command("Page.captureScreenshot", { format: "png", fromSurface: true }));
    return Buffer.from(result.data, "base64");
  }

  async input(input: BrowserCdpInput): Promise<void> {
    if (input.type === "key") {
      const params = { key: input.key, code: input.code, modifiers: input.modifiers };
      await this.command("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      if (input.text) await this.command("Input.dispatchKeyEvent", { type: "char", text: input.text, ...params });
      await this.command("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      return;
    }
    await this.command("Input.dispatchMouseEvent", input);
  }

  private async evaluate(expression: string): Promise<string> {
    const response = EvaluationResultSchema.parse(await this.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }));
    const value = response.result.value ?? response.result.description ?? null;
    return typeof value === "string" ? value.slice(0, 12_000) : JSON.stringify(value).slice(0, 12_000);
  }

  private async command(method: string, params: Record<string, unknown>): Promise<unknown> {
    const target = z.array(CdpTargetSchema).parse(await (await fetch(`${this.endpoint}/json/list`)).json())
      .find((item) => item.type === "page");
    if (!target) throw new Error("No Chromium page is available");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      const timeout = setTimeout(() => fail(new Error("CDP request timed out")), 15_000);
      const fail = (error: Error): void => {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      };
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
      socket.onerror = () => fail(new Error("CDP connection failed"));
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return fail(new Error("Invalid CDP response"));
        const response = CdpResponseSchema.parse(JSON.parse(event.data));
        if (response.id !== 1) return;
        clearTimeout(timeout);
        socket.close();
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result ?? {});
      };
    });
  }
}
