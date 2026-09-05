import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

type Provider = Parameters<ModelRuntime["registerProvider"]>[1];
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), scope: z.string().optional() });
const deviceSchema = z.object({ device_code: z.string().min(1), user_code: z.string().min(1), verification_uri: z.url().refine((value) => new URL(value).origin === "https://portal.nousresearch.com"), expires_in: z.number().positive(), interval: z.number().positive().default(5) });
const errorSchema = z.object({ error: z.string() });
const portal = "https://portal.nousresearch.com";
export const nousInference = "https://inference-api.nousresearch.com/v1";

export function nousProvider(clientId?: string, request: (url: string, init: RequestInit) => Promise<Response> = fetch): Provider {
  const requireClient = (): string => {
    if (!clientId) throw new Error("Set SLOPBOT_NOUS_CLIENT_ID to a Nous-approved client ID for SlopBot before signing in.");
    return clientId;
  };
  const post = (endpoint: string, fields: Record<string, string>, signal?: AbortSignal, refresh?: string): Promise<Response> => request(`${portal}${endpoint}`, {
    method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", ...(refresh ? { "x-nous-refresh-token": refresh } : {}) },
    body: new URLSearchParams(fields), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  const credentials = (value: unknown, previousRefresh?: string) => {
    const token = tokenSchema.parse(value);
    if (token.scope && !token.scope.split(/\s+/).includes("inference:invoke")) throw new Error("Nous did not grant inference:invoke access.");
    const refresh = token.refresh_token ?? previousRefresh;
    if (!refresh) throw new Error("Nous did not return a refresh token.");
    return { access: token.access_token, refresh, expires: Date.now() + token.expires_in * 1_000, clientId: requireClient() };
  };
  return {
    name: "Nous Portal", api: "openai-completions", baseUrl: nousInference, authHeader: true, models: [],
    oauth: {
      name: "Nous Portal", isSubscription: true,
      async login(callbacks) {
        const client = requireClient();
        const response = await post("/api/oauth/device/code", { client_id: client, scope: "inference:invoke" }, callbacks.signal);
        if (!response.ok) throw new Error(`Nous device login failed (HTTP ${response.status}). Check the registered client ID.`);
        const device = deviceSchema.parse(await response.json());
        callbacks.onDeviceCode({ userCode: device.user_code, verificationUri: device.verification_uri, expiresInSeconds: device.expires_in });
        const deadline = Date.now() + device.expires_in * 1_000;
        let interval = device.interval * 1_000;
        while (Date.now() < deadline) {
          await setTimeout(Math.min(interval, deadline - Date.now()), undefined, { signal: callbacks.signal });
          if (Date.now() >= deadline) break;
          const token = await post("/api/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client, device_code: device.device_code }, callbacks.signal);
          const payload: unknown = await token.json();
          if (token.ok) return credentials(payload);
          const error = errorSchema.parse(payload).error;
          if (error === "authorization_pending") continue;
          if (error === "slow_down") { interval += 5_000; continue; }
          throw new Error(error === "access_denied" ? "Nous login was denied." : "Nous login expired or failed. Try signing in again.");
        }
        throw new Error("Nous login expired. Try signing in again.");
      },
      async refreshToken(current, signal) {
        const client = requireClient();
        if (current["clientId"] !== client) throw new Error("Nous client ID changed. Sign in again.");
        const response = await post("/api/oauth/token", { grant_type: "refresh_token", client_id: client }, signal, current.refresh);
        if (!response.ok) throw new Error(`Nous refresh failed (HTTP ${response.status}). Sign in again.`);
        return credentials(await response.json(), current.refresh);
      },
      getApiKey: (current) => current.access,
    },
  };
}

const catalogSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1), name: z.string().optional(), context_length: z.number().int().positive().optional(),
  architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable().optional() }).optional(),
})) });
export async function nousModels(apiKey: string): Promise<NonNullable<Provider["models"]>> {
  const response = await fetch(`${nousInference}/models`, { redirect: "error", headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Nous model catalog failed (HTTP ${response.status})`);
  return catalogSchema.parse(await response.json()).data.map((model) => ({
    id: model.id, name: model.name ?? model.id, reasoning: false,
    input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
    contextWindow: model.context_length ?? 32_768, maxTokens: Math.min(model.top_provider?.max_completion_tokens ?? 4_096, model.context_length ?? 32_768),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}
