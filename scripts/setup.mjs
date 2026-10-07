// One-time setup for a fresh clone: `npm run setup`.
// Plain Node with no dependencies, so it runs before anything is installed, on any OS.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const say = (msg = "") => console.log(msg);
const step = (msg) => say(`\n▸ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: isWindows, ...opts });
const quiet = (cmd, args) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: isWindows });

say("Ms. Minutes · setup");

// 1. Node
step("Checking Node.js");
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  fail(
    `Node ${process.versions.node} is too old. Install Node 24 (LTS) from https://nodejs.org and run this again.`,
  );
}
say(`  Node ${process.versions.node} ✓`);

// 2. Dependencies, through corepack's pnpm (no global install, no PATH changes needed)
step("Installing dependencies (a minute or two the first time)");
if (quiet("corepack", ["--version"]).status !== 0) {
  fail("corepack is missing. It ships with Node; reinstall Node 24 from https://nodejs.org.");
}
const install = run("corepack", ["pnpm", "install", "--frozen-lockfile"], {
  env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
});
if (install.status !== 0) fail("Installing dependencies failed (see the errors above).");

// 3. .env
step("Settings (.env)");
const envPath = join(root, ".env");
let env;
if (existsSync(envPath)) {
  say("  .env already exists, keeping it.");
  env = readFileSync(envPath, "utf8");
} else {
  copyFileSync(join(root, ".env.example"), envPath);
  env = readFileSync(envPath, "utf8");
  const set = (key, value) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
  };

  let name = "";
  let key = process.env.ANTHROPIC_API_KEY ?? "";
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name = (await rl.question("  What should she call you? ")).trim();
    if (!key) {
      key = (
        await rl.question("  Claude API key (press Enter to skip and use a free local model): ")
      ).trim();
    }
    rl.close();
  }
  set("USER_NAME", name || "friend");
  set("TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (key) {
    set("LLM_PROVIDER", "claude");
    set("ANTHROPIC_API_KEY", key);
  } else {
    set("LLM_PROVIDER", "ollama");
  }
  writeFileSync(envPath, env);
  say(`  Wrote .env (thinking with ${key ? "Claude" : "Ollama, a local model"}).`);
}

// 4. Ollama, when she thinks locally
const read = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
if ((read("LLM_PROVIDER") ?? "claude") === "ollama") {
  step("Local model (Ollama)");
  const models = [read("OLLAMA_MODEL") || "qwen2.5:3b", "nomic-embed-text"];
  if (quiet("ollama", ["--version"]).status !== 0) {
    say("  Ollama isn't installed. Install it from https://ollama.com/download, then run:");
    for (const m of models) say(`    ollama pull ${m}`);
    say("  (or just run `npm run setup` again afterwards).");
  } else {
    const have = quiet("ollama", ["list"]).stdout ?? "";
    for (const m of models) {
      const tag = m.includes(":") ? m : `${m}:latest`;
      if (have.includes(tag)) {
        say(`  ${m} ✓`);
        continue;
      }
      say(`  Downloading ${m}…`);
      if (run("ollama", ["pull", m]).status !== 0) {
        say(`  Couldn't pull ${m}. Is Ollama running? Open the Ollama app, then run setup again.`);
      }
    }
  }
}

say(`
✓ Setup done.

  Start her:   npm start
  (brain and face together; your browser opens http://localhost:5179, then click Begin)

  The first time she speaks and listens she downloads her voice and hearing (~600 MB).
  To skip that, set TTS_PROVIDER=none and STT_PROVIDER=none in .env.
`);
