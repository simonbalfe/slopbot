import { join } from "node:path";

import { z } from "zod";

const UrlListSchema = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1).max(16));
const OptionalStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

export const SlopBotEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  SLOPBOT_BIND_ADDRESS: z.string().min(1).default("127.0.0.1"),
  SLOPBOT_HOST: z.string().min(1).default("127.0.0.1"),
  SLOPBOT_WORKSPACE: z.string().min(1).optional(),
  SLOPBOT_WORKSPACE_PATH: z.string().min(1).default("./workspace"),
  SLOPBOT_DATA_DIR: z.string().min(1).optional(),
  SLOPBOT_SANDBOX_URLS: UrlListSchema.optional(),
  SLOPBOT_SANDBOX_PUBLIC_URLS: UrlListSchema.optional(),
  SLOPBOT_SANDBOX_API_KEY: OptionalStringSchema,
  PI_CODING_AGENT_DIR: OptionalStringSchema,
});

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
) {
  const env = SlopBotEnvSchema.parse(environment);
  const workspace = env.SLOPBOT_WORKSPACE ?? currentDirectory;
  return {
    env,
    port: env.PORT,
    hostname: env.SLOPBOT_HOST,
    workspace,
    dataDirectory: env.SLOPBOT_DATA_DIR ?? join(workspace, ".slopbot"),
    computer: env.SLOPBOT_SANDBOX_URLS
      ? {
          baseUrls: env.SLOPBOT_SANDBOX_URLS,
          publicUrls:
            env.SLOPBOT_SANDBOX_PUBLIC_URLS ?? env.SLOPBOT_SANDBOX_URLS,
          apiKey: env.SLOPBOT_SANDBOX_API_KEY,
        }
      : undefined,
  };
}

export type SlopBotConfig = ReturnType<typeof loadConfig>;
