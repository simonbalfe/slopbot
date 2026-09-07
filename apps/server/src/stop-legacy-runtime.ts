import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const dataDirectory = resolve(process.env["SLOPBOT_DATA_DIR"] ?? join(root, "data", "runtime"));
const processFile = join(dataDirectory, "server-process.json");

async function stopMacRuntime(): Promise<void> {
  const label = "dev.slopbot.runtime";
  const domain = `gui/${userInfo().uid}`;
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (!existsSync(plist)) return;
  const child = Bun.spawn(["launchctl", "bootout", `${domain}/${label}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  rmSync(plist, { force: true });
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
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("apps/server/src/index.ts");
  } catch {
    return false;
  }
}

async function stopLinuxRuntime(): Promise<void> {
  const pid = readManagedPid();
  if (pid === undefined || !isManagedRuntime(pid)) {
    rmSync(processFile, { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && isManagedRuntime(pid); attempt++)
    await Bun.sleep(250);
  if (isManagedRuntime(pid)) process.kill(pid, "SIGKILL");
  rmSync(processFile, { force: true });
}

if (process.platform === "darwin") await stopMacRuntime();
else if (process.platform === "linux") await stopLinuxRuntime();
