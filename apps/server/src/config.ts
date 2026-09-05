import { join } from "node:path";

import { z } from "zod";

const OptionalStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

export const SlopBotEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  SLOPBOT_NOUS_CLIENT_ID: OptionalStringSchema,
  SLOPBOT_HOST: z.string().min(1).default("127.0.0.1"),
  SLOPBOT_WORKSPACE: z.string().min(1).optional(),
  SLOPBOT_DATA_DIR: z.string().min(1).optional(),
  SLOPBOT_COMPUTER_URL: z.url().optional(),
  SLOPBOT_COMPUTER_VIEW_URL: z.url().optional(),
  SLOPBOT_COMPUTER_API_KEY: OptionalStringSchema,
});

function resolveConfig(
  environment: NodeJS.ProcessEnv,
  currentDirectory: string,
) {
  const env = SlopBotEnvSchema.parse(environment);
  const workspace = env.SLOPBOT_WORKSPACE ?? currentDirectory;
  return {
    port: env.PORT,
    hostname: env.SLOPBOT_HOST,
    workspace,
    dataDirectory: env.SLOPBOT_DATA_DIR ?? join(currentDirectory, ".slopbot"),
    computer: env.SLOPBOT_COMPUTER_URL
      ? {
          baseUrls: [env.SLOPBOT_COMPUTER_URL],
          publicUrls: [env.SLOPBOT_COMPUTER_VIEW_URL ?? env.SLOPBOT_COMPUTER_URL],
          apiKey: env.SLOPBOT_COMPUTER_API_KEY,
        }
      : undefined,
  };
}

export type SlopBotConfig = ReturnType<typeof resolveConfig>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
): SlopBotConfig {
  return resolveConfig(environment, currentDirectory);
}
