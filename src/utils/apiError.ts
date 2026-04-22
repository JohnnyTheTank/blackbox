import OpenAI from "openai";

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

export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  if (err instanceof OpenAI.APIUserAbortError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError";
}

export function formatApiError(err: unknown): FormattedApiError {
  if (isAbortError(err)) {
    return { summary: "aborted", details: [], retryable: false, isAbort: true };
  }

  if (err instanceof OpenAI.APIConnectionError) {
    const cause = (err as { cause?: unknown }).cause;
    const details: string[] = [];
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

  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    const body = (err.error ?? undefined) as Record<string, unknown> | undefined;
    const bodyError = pickErrorObject(body);
    const bodyMessage = typeof bodyError?.message === "string" ? bodyError.message : undefined;

    const statusPart = status !== undefined ? `${status}` : "(no status)";
    const defaultStatusText = defaultStatusMessage(status);
    const msgPart = bodyMessage ?? stripStatusPrefix(err.message, status, defaultStatusText);
    const summary =
      msgPart && msgPart.length > 0
        ? `${statusPart} ${msgPart}`
        : `${statusPart}${defaultStatusText ? ` ${defaultStatusText}` : ""}`;

    const details: string[] = [];
    const bodyCode = bodyError?.code ?? err.code;
    if (bodyCode !== undefined && bodyCode !== null && String(bodyCode).length > 0) {
      details.push(`code: ${String(bodyCode)}`);
    }
    const bodyType = typeof bodyError?.type === "string" ? bodyError.type : err.type;
    if (bodyType) details.push(`type: ${bodyType}`);

    const provider = extractProvider(body, bodyError);
    if (provider) details.push(`provider: ${provider}`);

    const requestId = err.request_id ?? headerValue(err.headers, "x-request-id");
    if (requestId) details.push(`request id: ${requestId}`);

    const metadata = (bodyError?.metadata ?? body?.metadata) as
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

    const retryable =
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      (status !== undefined && status >= 500 && status < 600);

    return { summary, details, retryable, status, isAbort: false };
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
      // fall through to object access below
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
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function defaultStatusMessage(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  return STATUS_TEXT[status];
}

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
