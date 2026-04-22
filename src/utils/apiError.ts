import {
  ConnectionError,
  OpenRouterError,
  RequestAbortedError,
  RequestTimeoutError,
} from "@openrouter/sdk/models/errors";

import { AbortError } from "./abort.ts";

export type FormattedApiError = {
  summary: string;
  details: string[];
  retryable: boolean;
  status?: number;
  isAbort: boolean;
};

const RETRYABLE_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "UND_ERR_SOCKET",
]);

// HTTP status codes that map to OpenRouterError subclasses known to be
// safely retryable: 408 timeout, 409 conflict (rare on LLM endpoints),
// 429 rate-limit, and the 5xx family commonly used by upstream providers.
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 524, 529]);

export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (err instanceof RequestAbortedError) return true;
  if (err instanceof RequestTimeoutError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "RequestAbortedError";
}

export function formatApiError(err: unknown): FormattedApiError {
  if (isAbortError(err)) {
    return { summary: "aborted", details: [], retryable: false, isAbort: true };
  }

  if (err instanceof ConnectionError) {
    const details: string[] = [];
    const cause = err.cause;
    const causeCode = nodeErrnoCode(cause);
    if (causeCode) details.push(`code: ${causeCode}`);
    const causeMsg = cause instanceof Error ? cause.message : undefined;
    if (causeMsg && causeMsg !== err.message) {
      details.push(`cause: ${truncate(causeMsg, 300)}`);
    }
    return {
      summary: `Network error — ${err.message}`,
      details,
      retryable: true,
      isAbort: false,
    };
  }

  if (err instanceof OpenRouterError) {
    const status = err.statusCode;
    const parsed = parseBody(err.body, err.contentType);
    const bodyError = pickErrorObject(parsed);
    const bodyMessage =
      typeof bodyError?.message === "string" ? bodyError.message : undefined;

    const statusPart = `${status}`;
    const defaultStatusText = STATUS_TEXT[status];
    const msgPart =
      bodyMessage ?? stripStatusPrefix(err.message, status, defaultStatusText);
    const summary =
      msgPart && msgPart.length > 0
        ? `${statusPart} ${msgPart}`
        : `${statusPart}${defaultStatusText ? ` ${defaultStatusText}` : ""}`;

    const details: string[] = [];
    const bodyCode = bodyError?.code;
    if (bodyCode !== undefined && bodyCode !== null && String(bodyCode).length > 0) {
      details.push(`code: ${String(bodyCode)}`);
    }
    const bodyType = typeof bodyError?.type === "string" ? bodyError.type : undefined;
    if (bodyType) details.push(`type: ${bodyType}`);

    const provider = extractProvider(parsed, bodyError);
    if (provider) details.push(`provider: ${provider}`);

    const requestId = headerValue(err.headers, "x-request-id");
    if (requestId) details.push(`request id: ${requestId}`);

    const metadata = (bodyError?.metadata ?? parsed?.metadata) as
      | Record<string, unknown>
      | undefined;
    if (metadata && typeof metadata === "object") {
      const raw = metadata.raw;
      if (typeof raw === "string" && raw.trim().length > 0) {
        details.push(`raw: ${truncate(raw.trim(), 400)}`);
      }
      const reasons = metadata.reasons;
      if (Array.isArray(reasons) && reasons.length > 0) {
        details.push(`reasons: ${reasons.map((r) => String(r)).join(", ")}`);
      }
    }

    return {
      summary,
      details,
      retryable: RETRYABLE_STATUS_CODES.has(status),
      status,
      isAbort: false,
    };
  }

  if (err instanceof Error) {
    const code = nodeErrnoCode(err);
    const details: string[] = [];
    if (code) details.push(`code: ${code}`);
    return {
      summary: err.message || err.name || "Unknown error",
      details,
      retryable: code !== undefined && RETRYABLE_NODE_CODES.has(code),
      isAbort: false,
    };
  }

  return {
    summary: String(err) || "Unknown error",
    details: [],
    retryable: false,
    isAbort: false,
  };
}

function parseBody(
  body: string | undefined,
  contentType: string | undefined,
): Record<string, unknown> | undefined {
  if (!body || body.length === 0) return undefined;
  const looksJson =
    (contentType ?? "").includes("json") ||
    body.trimStart().startsWith("{") ||
    body.trimStart().startsWith("[");
  if (!looksJson) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore — non-JSON body
  }
  return undefined;
}

function pickErrorObject(
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const inner = body.error;
  if (inner && typeof inner === "object") {
    return inner as Record<string, unknown>;
  }
  return body;
}

function extractProvider(
  body: Record<string, unknown> | undefined,
  bodyError: Record<string, unknown> | undefined,
): string | undefined {
  const candidates: unknown[] = [
    bodyError?.provider,
    bodyError?.provider_name,
    (bodyError?.metadata as Record<string, unknown> | undefined)?.provider_name,
    (bodyError?.metadata as Record<string, unknown> | undefined)?.provider,
    body?.provider,
    (body?.metadata as Record<string, unknown> | undefined)?.provider_name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const getFn = (headers as { get?: unknown }).get;
  if (typeof getFn === "function") {
    try {
      const v = (getFn as (k: string) => string | null).call(headers, name);
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // fall through to plain-object access below
    }
  }
  if (typeof headers === "object") {
    const obj = headers as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lower) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return v;
        if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      }
    }
  }
  return undefined;
}

function nodeErrnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} more chars)`;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  524: "Edge Network Timeout",
  529: "Provider Overloaded",
};

function stripStatusPrefix(
  message: string | undefined,
  status: number | undefined,
  defaultText: string | undefined,
): string | undefined {
  if (!message) return undefined;
  let m = message.trim();
  if (status !== undefined && m.startsWith(String(status))) {
    m = m.slice(String(status).length).trim();
  }
  if (defaultText && m.toLowerCase() === defaultText.toLowerCase()) {
    return undefined;
  }
  return m.length > 0 ? m : undefined;
}
