import { OpenRouter } from "@openrouter/agent";

import { OPENROUTER_API_KEY_ENV } from "./config.ts";

let cachedClient: OpenRouter | null = null;

export function getClient(): OpenRouter {
  if (cachedClient) return cachedClient;
  const apiKey = process.env[OPENROUTER_API_KEY_ENV];
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      `${OPENROUTER_API_KEY_ENV} is not set. Please create a .env file (see .env.example).`,
    );
  }
  cachedClient = new OpenRouter({
    apiKey,
    httpReferer: "https://github.com/JohnnyTheTank/blackbox",
    appTitle: "blackbox-cli-agent",
  });
  return cachedClient;
}
