import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
if (process.argv[2] === "uninstall") {
  const uninstall = Bun.spawn(["sh", join(root, "uninstall.sh"), ...process.argv.slice(3)], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await uninstall.exited);
}
if (process.argv[2] === "computer") {
  const requested = process.argv[3] ?? "status";
  const actions = {
    setup: "setup",
    start: "up",
    status: "status",
    open: "open",
    shell: "shell",
    stop: "stop",
  } as const;
  const isComputerAction = (value: string): value is keyof typeof actions => Object.hasOwn(actions, value);
  if (!isComputerAction(requested)) {
    console.error("Usage: slopbot computer setup|start|status|open|shell|stop");
    process.exit(1);
  }
  const action = actions[requested];
  const computer = Bun.spawn([process.execPath, join(root, "vm/manage.ts"), action], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await computer.exited);
}
const temporary = mkdtempSync(join(tmpdir(), "slopbot-start-"));
const log = join(temporary, "startup.log");
const descriptor = openSync(log, "w", 0o600);
if (process.stdout.isTTY) process.stdout.write("\x1b[90mStarting SlopBot…\x1b[0m");
const setup = Bun.spawn([process.execPath, "run", "up"], { cwd: root, stdout: descriptor, stderr: descriptor });
const code = await setup.exited;
closeSync(descriptor);
if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
if (code !== 0) {
  console.error(`SlopBot could not start. Details: ${log}`);
  process.exit(code);
}
rmSync(temporary, { recursive: true, force: true });
const chat = Bun.spawn([process.execPath, join(import.meta.dir, "chat.ts"), ...process.argv.slice(2)], {
  cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exitCode = await chat.exited;
