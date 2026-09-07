import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { SlopBotEnvSchema } from "./config.ts";

const root = resolve(import.meta.dir, "../../..");
const env = SlopBotEnvSchema.parse(process.env);
const data = resolve(root, env.SLOPBOT_DATA_DIR ?? "data/runtime");
const label = "dev.slopbot.runtime";
const domain = `gui/${userInfo().uid}`;
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const processFile = join(data, "server-process.json");
const action = process.argv[2] ?? "up";

function runtimeEnvironment(): Record<string, string> {
  return {
    HOME: homedir(),
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    PORT: String(env.PORT),
    SLOPBOT_HOST: env.SLOPBOT_HOST,
    SLOPBOT_WORKSPACE: env.SLOPBOT_WORKSPACE ?? join(homedir(), "workspace"),
    SLOPBOT_DATA_DIR: data,
    SLOPBOT_COMPUTER_URL: env.SLOPBOT_COMPUTER_URL ?? "http://127.0.0.1:6080",
    SLOPBOT_COMPUTER_VIEW_URL: env.SLOPBOT_COMPUTER_VIEW_URL ?? env.SLOPBOT_COMPUTER_URL ?? "http://127.0.0.1:6080",
    ...(env.SLOPBOT_COMPUTER_API_KEY ? { SLOPBOT_COMPUTER_API_KEY: env.SLOPBOT_COMPUTER_API_KEY } : {}),
  };
}

async function waitForRuntime(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${env.PORT}/health`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      if (attempt === 59) throw new Error(`Runtime did not start; inspect ${join(data, "server-error.log")}`, { cause: error });
      await Bun.sleep(500);
    }
  }
}

async function launchctl(args: string[], required = true): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: required ? "inherit" : "ignore" });
  const code = await child.exited;
  if (required && code !== 0) throw new Error(`launchctl ${args[0]} failed (${code})`);
  return code;
}

async function manageLaunchd(): Promise<void> {
  if (action === "stop") {
    if (await launchctl(["print", `${domain}/${label}`], false) === 0) await launchctl(["bootout", `${domain}/${label}`]);
    return;
  }
  if (action !== "up" && action !== "restart") throw new Error("Usage: bun apps/server/src/service.ts up|stop|restart");

  mkdirSync(data, { recursive: true, mode: 0o700 });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const config = {
    Label: label,
    ProgramArguments: [process.execPath, join(root, "apps/server/src/index.ts")],
    WorkingDirectory: root,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    EnvironmentVariables: runtimeEnvironment(),
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
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  await waitForRuntime();
}

function readManagedPid(): number | undefined {
  if (!existsSync(processFile)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(processFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
    const pid = Reflect.get(parsed, "pid");
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isManagedRuntime(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(root) && command.includes("apps/server/src/index.ts");
  } catch {
    return false;
  }
}

async function stopPortableRuntime(): Promise<void> {
  const pid = readManagedPid();
  if (pid === undefined || !isManagedRuntime(pid)) {
    rmSync(processFile, { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!isManagedRuntime(pid)) break;
    await Bun.sleep(250);
  }
  if (isManagedRuntime(pid)) process.kill(pid, "SIGKILL");
  rmSync(processFile, { force: true });
}

async function managePortableRuntime(): Promise<void> {
  if (action === "stop") {
    await stopPortableRuntime();
    return;
  }
  if (action !== "up" && action !== "restart") throw new Error("Usage: bun apps/server/src/service.ts up|stop|restart");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (action === "restart") await stopPortableRuntime();
  const existing = readManagedPid();
  if (existing === undefined || !isManagedRuntime(existing)) {
    const stdout = openSync(join(data, "server.log"), "a", 0o600);
    const stderr = openSync(join(data, "server-error.log"), "a", 0o600);
    try {
      const child = Bun.spawn([process.execPath, join(root, "apps/server/src/index.ts")], {
        cwd: root,
        env: runtimeEnvironment(),
        stdin: "ignore",
        stdout,
        stderr,
        detached: true,
      });
      child.unref();
      writeFileSync(processFile, JSON.stringify({ pid: child.pid }), { mode: 0o600 });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  }
  await waitForRuntime();
}

if (process.platform === "darwin") await manageLaunchd();
else if (process.platform === "linux") await managePortableRuntime();
else throw new Error(`SlopBot currently supports macOS and Linux; detected ${process.platform}`);

console.log(action === "stop" ? "SlopBot runtime stopped." : "SlopBot runtime is running natively.");
