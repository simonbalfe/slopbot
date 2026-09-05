import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { SlopBotEnvSchema } from "./config.ts";

const root = resolve(import.meta.dir, "../../..");
const env = SlopBotEnvSchema.parse(process.env);
const data = resolve(root, env.SLOPBOT_DATA_DIR ?? "data/runtime");
const label = "dev.slopbot.runtime";
const domain = `gui/${userInfo().uid}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const action = process.argv[2] ?? "up";

async function launchctl(args: string[], required = true): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: required ? "inherit" : "ignore" });
  const code = await child.exited;
  if (required && code !== 0) throw new Error(`launchctl ${args[0]} failed (${code})`);
  return code;
}

if (process.platform !== "darwin") throw new Error("This service helper uses macOS launchd. Run bun run start:server for a foreground runtime on other platforms.");
if (action === "stop") {
  if (await launchctl(["print", `${domain}/${label}`], false) === 0) await launchctl(["bootout", `${domain}/${label}`]);
} else if (action === "up" || action === "restart") {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  const config = {
    Label: label,
    ProgramArguments: [process.execPath, join(root, "apps/server/src/index.ts")],
    WorkingDirectory: root,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    EnvironmentVariables: {
      HOME: homedir(),
      ...(env.SLOPBOT_NOUS_CLIENT_ID ? { SLOPBOT_NOUS_CLIENT_ID: env.SLOPBOT_NOUS_CLIENT_ID } : {}),
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      PORT: String(env.PORT),
      SLOPBOT_HOST: env.SLOPBOT_HOST,
      SLOPBOT_WORKSPACE: env.SLOPBOT_WORKSPACE ?? join(homedir(), "workspace"),
      SLOPBOT_DATA_DIR: data,
      SLOPBOT_COMPUTER_URL: env.SLOPBOT_COMPUTER_URL ?? "http://127.0.0.1:6080",
      SLOPBOT_COMPUTER_VIEW_URL: env.SLOPBOT_COMPUTER_VIEW_URL ?? env.SLOPBOT_COMPUTER_URL ?? "http://127.0.0.1:6080",
      ...(env.SLOPBOT_COMPUTER_API_KEY ? { SLOPBOT_COMPUTER_API_KEY: env.SLOPBOT_COMPUTER_API_KEY } : {}),
    },
    StandardOutPath: join(data, "server.log"),
    StandardErrorPath: join(data, "server-error.log"),
  };
  const temporary = mkdtempSync(join(tmpdir(), "slopbot-service-"));
  try {
    const candidate = join(temporary, "runtime.plist");
    writeFileSync(candidate, JSON.stringify(config), { mode: 0o600 });
    const convert = Bun.spawn(["plutil", "-convert", "xml1", candidate], { stderr: "inherit" });
    if (await convert.exited !== 0) throw new Error("Could not create the runtime service definition");
    const contents = readFileSync(candidate, "utf8");
    const changed = !existsSync(plist) || readFileSync(plist, "utf8") !== contents;
    const loaded = await launchctl(["print", `${domain}/${label}`], false) === 0;
    if (loaded && changed) await launchctl(["bootout", `${domain}/${label}`]);
    if (changed) writeFileSync(plist, contents, { mode: 0o600 });
    if (!loaded || changed) {
      for (let attempt = 0; await launchctl(["bootstrap", domain, plist], false) !== 0; attempt++) {
        if (attempt === 9) throw new Error(`Could not load ${plist}`);
        await Bun.sleep(500);
      }
    } else if (action === "restart") await launchctl(["kickstart", "-k", `${domain}/${label}`]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${env.PORT}/health`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      break;
    } catch (error) {
      if (attempt === 59) throw new Error(`Runtime did not start; inspect ${join(data, "server-error.log")}`, { cause: error });
      await Bun.sleep(500);
    }
  }
  console.log("SlopBot runtime is running natively.");
} else {
  throw new Error("Usage: bun apps/server/src/service.ts up|stop|restart");
}
