// Runs the brain and the browser body together and opens her page: `npm start`.
// `npm start -- --lan` also serves the page to other machines (e.g. over Tailscale);
// `--no-open` skips opening the browser.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lan = process.argv.includes("--lan");
const open = !process.argv.includes("--no-open");
const webPort = 5179;

const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const vite = join(root, "node_modules/vite/bin/vite.js");
if (!existsSync(tsx) || !existsSync(vite)) {
  console.error("\n✗ Dependencies aren't installed. Run `npm run setup` first.\n");
  process.exit(1);
}
if (!existsSync(join(root, ".env"))) {
  console.error("\n✗ No .env yet. Run `npm run setup` first.\n");
  process.exit(1);
}

const children = [];
function start(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${label}] ${line}`)
      .join("\n");
  child.stdout.on("data", (d) => console.log(prefix(d)));
  child.stderr.on("data", (d) => console.error(prefix(d)));
  child.on("exit", (code) => {
    console.log(`[${label}] stopped${code ? ` (exit ${code})` : ""}`);
    stop(code ?? 0);
  });
  children.push(child);
}

function stop(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

// The brain reads .env itself; we only need its port to know when it's up.
process.loadEnvFile(join(root, ".env"));
const brain = `http://127.0.0.1:${process.env.PORT || 7700}`;
const url = `http://localhost:${webPort}/`;

start("brain", [tsx, "--env-file-if-exists=.env", "apps/brain/src/main.ts"]);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${brain}/health`)).ok) break;
  } catch {
    // not up yet
  }
  if (i === 60) console.log("[start] the brain is slow to wake; still waiting…");
  await new Promise((r) => setTimeout(r, 500));
}

// Then her face, which forwards /ws and /api to the brain.
process.env.BRAIN_ORIGIN = brain;
start("face", [
  vite,
  "apps/web-body",
  "--port",
  String(webPort),
  "--strictPort",
  ...(lan ? ["--host"] : []),
]);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`\n  Ms. Minutes is up → ${url}  (click Begin · Ctrl+C to stop)\n`);
if (lan) {
  console.log(
    "  On other machines use the Network address above. The microphone only works on\n" +
      "  localhost or https, so type to her there.\n",
  );
}
const opener =
  process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
if (open) {
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
