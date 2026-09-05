import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const lima = Bun.which("limactl") ?? "/opt/homebrew/bin/limactl";
const action = process.argv[2] ?? "up";

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command[0]} ${command[1]} failed`);
}

if (action === "shell") {
  await run([lima, "shell", "--workdir=/workspace", "slopbot"]);
} else if (action === "stop") {
  await run([lima, "stop", "slopbot"]);
} else if (action === "up") {
  const temporary = mkdtempSync(join(tmpdir(), "slopbot-vm-"));
  const guestArchive = `/tmp/${temporary.split("/").at(-1)}.tar`;
  try {
    const listing = Bun.spawn([lima, "list", "--format={{.Name}}"], { stdout: "pipe", stderr: "inherit" });
    const names = await new Response(listing.stdout).text();
    if (await listing.exited !== 0) throw new Error("Could not list Lima VMs. Install Lima with brew install lima.");
    if (names.split("\n").includes("slopbot")) {
      await run([lima, "start", "-y", "slopbot"]);
    } else {
      const config = join(temporary, "lima.yaml");
      writeFileSync(config, JSON.stringify({
        base: ["template:_images/debian-13"],
        vmType: "vz", cpus: 2, memory: "3GiB", disk: "20GiB",
        user: { name: "slopbot", uid: userInfo().uid, home: "/home/slopbot", shell: "/bin/bash" },
        mountType: "virtiofs",
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
    await run(["tar", "--no-xattrs", "--exclude=node_modules", "--exclude=.git", "--exclude=.env*", "--exclude=data", "--exclude=workspace", "--exclude=.slopbot", "--exclude=ui-dist", "--exclude=dist", "--exclude=.DS_Store", "-cf", archive, "-C", root, "."]);
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
  throw new Error("Usage: bun vm/manage.ts up|shell|stop");
}
