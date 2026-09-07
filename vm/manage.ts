import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const action = process.argv[2] ?? "up";
const limaVersion = "2.2.0";

const limaAssets = {
  "darwin-arm64": { archive: "Darwin-arm64", sha256: "bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3" },
  "darwin-x64": { archive: "Darwin-x86_64", sha256: "0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31" },
  "linux-arm64": { archive: "Linux-aarch64", sha256: "7c6a09c6844f55f811e9b7b2b60a6070a512c696c8ec752dfdb3c8ed50ed0364" },
  "linux-x64": { archive: "Linux-x86_64", sha256: "a0ea1ccf6b7335a900adb5f8d2b8384457965fecb1ba72f09b4e3e46d12f424a" },
} as const;

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command[0]} ${command[1]} failed`);
}

function findExecutable(name: string, fallbacks: readonly string[]): string | undefined {
  return Bun.which(name) ?? fallbacks.find((candidate) => Bun.file(candidate).size > 0);
}

function managedLimaPath(): string {
  const dataDirectory = process.env["SLOPBOT_DATA_DIR"] ?? join(homedir(), ".local", "share", "slopbot-data");
  return join(dataDirectory, "dependencies", `lima-${limaVersion}`, "bin", "limactl");
}

async function installLima(): Promise<string> {
  const platformKey = `${process.platform}-${process.arch}` as keyof typeof limaAssets;
  const asset = limaAssets[platformKey];
  if (!asset) throw new Error(`SlopBot supports Lima on macOS and Linux with arm64 or x64 CPUs; detected ${process.platform}/${process.arch}`);
  if (!findExecutable("tar", [])) throw new Error("The system tar command is required to unpack Lima");

  const destination = resolve(managedLimaPath(), "../..");
  if (existsSync(join(destination, "bin", "limactl"))) return join(destination, "bin", "limactl");
  const parent = resolve(destination, "..");
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".lima-download-"));
  try {
    const archive = join(temporary, "lima.tar.gz");
    const url = `https://github.com/lima-vm/lima/releases/download/v${limaVersion}/lima-${limaVersion}-${asset.archive}.tar.gz`;
    console.log(`Downloading Lima ${limaVersion} for ${process.platform}/${process.arch}…`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download Lima: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error("The downloaded Lima archive did not match its expected checksum");
    await Bun.write(archive, bytes);
    const extracted = join(temporary, "extracted");
    mkdirSync(extracted);
    await run(["tar", "-xzf", archive, "-C", extracted]);
    if (!existsSync(join(extracted, "bin", "limactl"))) throw new Error("The Lima archive did not contain limactl");
    renameSync(extracted, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return join(destination, "bin", "limactl");
}

async function ensureLinuxQemu(): Promise<void> {
  if (process.platform !== "linux") return;
  const binary = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  if (findExecutable(binary, [])) return;

  const privilege = typeof process.getuid === "function" && process.getuid() === 0 ? [] : ["sudo"];
  if (privilege.length > 0 && !findExecutable("sudo", [])) {
    throw new Error(`Lima needs ${binary}. Install QEMU with your Linux package manager, then run: slopbot computer setup`);
  }
  const installers = [
    { manager: "apt-get", commands: [["apt-get", "update"], ["apt-get", "install", "-y", "qemu-system"]] },
    { manager: "dnf", commands: [["dnf", "install", "-y", process.arch === "arm64" ? "qemu-system-aarch64-core" : "qemu-system-x86-core", "qemu-img"]] },
    { manager: "pacman", commands: [["pacman", "-Sy", "--needed", "--noconfirm", process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86"]] },
    { manager: "zypper", commands: [["zypper", "--non-interactive", "install", "qemu"]] },
  ] as const;
  const installer = installers.find(({ manager }) => findExecutable(manager, []));
  if (!installer) throw new Error(`Lima needs ${binary}. Install QEMU with your Linux package manager, then run: slopbot computer setup`);
  console.log(`Installing QEMU with ${installer.manager}…`);
  for (const command of installer.commands) await run([...privilege, ...command]);
  if (!findExecutable(binary, [])) throw new Error(`${installer.manager} completed, but ${binary} could not be found`);
}

async function requireLima(install: boolean): Promise<string> {
  const configured = process.env["SLOPBOT_LIMA_PATH"];
  const existing = findExecutable("limactl", configured ? [configured, managedLimaPath()] : [managedLimaPath()]);
  if (existing) return existing;
  if (!install) throw new Error("Lima is not installed. Run: slopbot computer setup");
  return installLima();
}

if (action === "open") {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (findExecutable(opener, [])) await run([opener, "http://127.0.0.1:6080/vnc/vnc.html"]);
  else console.log("Open http://127.0.0.1:6080/vnc/vnc.html in your browser");
} else if (action === "status") {
  const lima = await requireLima(false);
  await run([lima, "list", "slopbot"]);
} else if (action === "shell") {
  const lima = await requireLima(false);
  await run([lima, "shell", "--workdir=/workspace", "slopbot"]);
} else if (action === "stop") {
  const lima = await requireLima(false);
  await run([lima, "stop", "slopbot"]);
} else if (action === "up" || action === "setup") {
  const lima = await requireLima(action === "setup");
  await ensureLinuxQemu();
  const temporary = mkdtempSync(join(tmpdir(), "slopbot-vm-"));
  const guestArchive = `/tmp/${temporary.split("/").at(-1)}.tar`;
  try {
    const listing = Bun.spawn([lima, "list", "--format={{.Name}}"], { stdout: "pipe", stderr: "inherit" });
    const names = await new Response(listing.stdout).text();
    if (await listing.exited !== 0) throw new Error("Could not list Lima VMs");
    if (names.split("\n").includes("slopbot")) {
      await run([lima, "start", "-y", "slopbot"]);
    } else {
      const config = join(temporary, "lima.yaml");
      writeFileSync(config, JSON.stringify({
        base: ["template:_images/debian-13"],
        cpus: 2, memory: "3GiB", disk: "20GiB",
        user: { name: "slopbot", uid: userInfo().uid, home: "/home/slopbot", shell: "/bin/bash" },
        mounts: [{ location: resolve(process.env["SLOPBOT_WORKSPACE_PATH"] || join(homedir(), "workspace")), mountPoint: "/workspace", writable: true }],
        containerd: { system: false, user: false },
        portForwards: [
          { guestPort: 6080, hostPort: 6080 },
          { guestPort: 9322, hostPort: 9222 },
          { guestIP: "0.0.0.0", guestIPMustBeZero: false, proto: "any", guestPortRange: [1, 65535], ignore: true },
        ],
      }, null, 2));
      await run([lima, "start", "-y", "--name=slopbot", "--timeout=20m", config]);
    }
    const archive = join(temporary, "source.tar");
    const sourceArchive = Bun.spawn(["tar", "--exclude=node_modules", "--exclude=.git", "--exclude=.env*", "--exclude=data", "--exclude=workspace", "--exclude=.slopbot", "--exclude=ui-dist", "--exclude=dist", "--exclude=.DS_Store", "-cf", archive, "-C", root, "."], {
      cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (await sourceArchive.exited !== 0) throw new Error("Could not package the computer service");
    await run([lima, "copy", archive, `slopbot:${guestArchive}`]);
    await run([lima, "shell", "--workdir=/", "slopbot", "sh", "-eu", "-c", `
      staging=$(mktemp -d)
      source_archive=$1
      trap 'rm -rf "$staging"; rm -f "$source_archive"' EXIT
      tar -xf "$source_archive" -C "$staging"
      if ! cmp -s "$staging/vm/provision.sh" /opt/slopbot/vm/provision.sh; then
        sudo sh "$staging/vm/provision.sh"
      fi
      set -- -ac --delete --exclude=node_modules --exclude=ui-dist --exclude=dist
      if test -n "$(rsync "$@" --dry-run --itemize-changes "$staging/" /opt/slopbot/)"; then
        sudo systemctl stop slopbot-desktop
        rsync "$@" "$staging/" /opt/slopbot/
        cd /opt/slopbot
        bun install --frozen-lockfile
      fi
      sudo systemctl enable --now slopbot-desktop
    `, "sh", guestArchive]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:6080/health", { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      break;
    } catch (error) {
      if (attempt === 59) throw error;
      await Bun.sleep(1_000);
    }
  }
  console.log("Computer ready: http://127.0.0.1:6080/vnc/vnc.html");
} else {
  throw new Error("Usage: bun vm/manage.ts setup|up|status|open|shell|stop");
}
