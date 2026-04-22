import { VISION_HINTS } from "../config.ts";

export function looksVisionCapable(model: string): boolean {
  return VISION_HINTS.some((re) => re.test(model));
}
