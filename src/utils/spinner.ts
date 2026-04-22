import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../config.ts";

export type Spinner = {
  start: (label?: string) => void;
  stop: () => void;
  log: (line: string) => void;
};

export function createSpinner(): Spinner {
  const isTTY = Boolean(process.stdout.isTTY);
  let timer: NodeJS.Timeout | null = null;
  let frame = 0;
  let label = "working…";

  const clearLine = (): void => {
    if (!isTTY) return;
    process.stdout.write("\r\x1b[2K");
  };

  const render = (): void => {
    if (!isTTY) return;
    const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1b[2K\x1b[2m${f} ${label}\x1b[0m`);
  };

  return {
    start(next?: string) {
      if (!isTTY || timer) return;
      if (next) label = next;
      frame = 0;
      render();
      timer = setInterval(() => {
        frame += 1;
        render();
      }, SPINNER_INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    },
    log(line: string) {
      clearLine();
      process.stdout.write(`${line}\n`);
      if (timer) render();
    },
  };
}
