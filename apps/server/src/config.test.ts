import { expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

test("loads defaults and sandbox URLs", () => {
  const config = loadConfig(
    {
      SLOPBOT_SANDBOX_URLS: "http://lead:8080, http://worker:8080",
      SLOPBOT_SANDBOX_PUBLIC_URLS:
        "http://localhost:6080,http://localhost:6081",
    },
    "/tmp/slopbot",
  );
  expect(config.port).toBe(4317);
  expect(config.computer?.baseUrls).toEqual([
    "http://lead:8080",
    "http://worker:8080",
  ]);
});
