import path from "node:path";
import fs from "node:fs";

export const WORKSPACE_ROOT: string = fs.realpathSync(process.cwd());

export function assertInside(userPath: string): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("Path is empty or invalid");
  }

  const abs = path.resolve(WORKSPACE_ROOT, userPath);

  let real = abs;
  if (fs.existsSync(abs)) {
    real = fs.realpathSync(abs);
  } else {
    const parent = path.dirname(abs);
    if (fs.existsSync(parent)) {
      real = path.join(fs.realpathSync(parent), path.basename(abs));
    }
  }

  if (real !== WORKSPACE_ROOT && !real.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(
      `Path is outside of workspace (${WORKSPACE_ROOT}): ${userPath}`,
    );
  }

  return real;
}

export function relToWorkspace(absPath: string): string {
  const rel = path.relative(WORKSPACE_ROOT, absPath);
  return rel.length === 0 ? "." : rel;
}
