#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const installDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxBin = join(installDir, "node_modules", ".bin", "tsx");
const entry = join(installDir, "src", "index.ts");

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (err) => {
  console.error(`Failed to launch blackbox: ${err.message}`);
  console.error(
    `Expected tsx at: ${tsxBin}. Run 'npm install' inside ${installDir}.`,
  );
  process.exit(1);
});
