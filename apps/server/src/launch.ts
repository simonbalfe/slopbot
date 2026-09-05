import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
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
