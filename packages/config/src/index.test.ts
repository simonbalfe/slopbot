import { expect, test } from "bun:test";

import { loadConfig } from "./index.ts";

test("loads defaults and optional computer settings", () => {
  expect(loadConfig({}, "/work")).toMatchObject({
    port: 4317,
    hostname: "127.0.0.1",
    workspace: "/work",
    dataDirectory: "/work/.slopbot",
  });
  expect(
    loadConfig({ SLOPBOT_SANDBOX_URLS: "http://lead:8080,http://worker:8080" })
      .computer?.baseUrls,
  ).toEqual(["http://lead:8080", "http://worker:8080"]);
});
