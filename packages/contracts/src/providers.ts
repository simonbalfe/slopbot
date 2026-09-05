import { z } from "zod";

export const providers = {
  "openai-codex": { name: "OpenAI Codex", defaultModel: "gpt-5.6-sol" },
  nous: { name: "Nous Portal", defaultModel: "select-a-model" },
} as const;
export const ProviderIdSchema = z.enum(Object.keys(providers) as (keyof typeof providers)[]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const defaultProvider: ProviderId = "openai-codex";
export const defaultModel = providers[defaultProvider].defaultModel;
export const providerChoices = ProviderIdSchema.options.map((id) => ({ id, ...providers[id] }));
export const ModelSelectionSchema = z.object({
  provider: ProviderIdSchema.default(defaultProvider),
  model: z.string().trim().min(1).max(200).default(defaultModel),
});
