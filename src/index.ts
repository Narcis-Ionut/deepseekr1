// DeepSeek-only Worker using GitHub deploys.
// Serves static UI from /public via env.ASSETS and proxies /api/chat to DeepSeek.

const SYS_PROMPT =
  "You are a helpful, friendly assistant. Keep answers concise and accurate.";

interface Env {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_MODEL?: string;      // e.g. "deepseek-chat"
  ALLOWED_ORIGINS?: string;     // "*" or "https://site1.com,https://site2.com"
  ASSETS: { fetch(req: Request): Promise<Response> }; // static assets binding
}

function cors(origin: string, allowed?: string) {
  let allow = "*";
  if (allowed && allowed !== "*") {
    const list = allowed.split(",").map(s => s.trim());
    allow = list.includes(origin) ? origin : list[0] || "*";
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function okJSON(data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function badJSON(status: number, data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function handleOptions(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, { status: 204, headers: cors(origin, env.ALLOWED_ORIGINS) });
}

async function handleChat(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  const baseHeaders = cors(origin, env.ALLOWED_ORIGINS);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badJSON(400, { error: { message: "Invalid JSON body" } }, baseHeaders);
  }

  const {
    messages = [],
    model = env.DEEPSEEK_MODEL || "deepseek-chat",
    stream = true,
    temperature,
    top_p,
    max_tokens,
    presence_penalty,
    frequency_penalty,
    stop,
    response_format,
  } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return badJSON(400, { error: { message: "messages[] is required" } }, baseHeaders);
  }

  const hasSystem = messages.some((m: any) => m.role === "system");
  const finalMessages = hasSystem ? messages : [{ role: "system", content: SYS_PROMPT }, ...messages];

  const payload: any = { model, messages: finalMessages, stream };
  if (temperature !== undefined) payload.temperature = temperature;
  if (top_p !== undefined) payload.top_p = top_p;
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  if (presence_penalty !== undefined) payload.presence_penalty = presence_penalty;
  if (frequency_penalty !== undefined) payload.frequency_penalty = frequency_penalty;
  if (stop !== undefined) payload.stop = stop;
  if (response_format !== undefined) payload.response_format = response_format;

  // Prefer Authorization header (BYOK) else use Worker secret
  const headerKey =
    (request.headers.get("authorization") || request.headers.get("Authorization"))?.replace(/^[Bb]earer\s+/, "");
  const apiKey = headerKey || env.DEEPSEEK_API_KEY;

  if (!apiKey) return badJSON(401, { error: { message: "Missing DEEPSEEK_API_KEY" } }, baseHeaders);

  const dsURL = "https://api.deepseek.com/v1/chat/completions";

  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  } as RequestInit as RequestInit & { duplex: "half" };
  (init as any).duplex = "half"; // enable streaming on Workers

  const dsRes = await fetch(dsURL, init);

  // Non-stream passthrough
  if (!stream) {
    const text = await dsRes.text();
    return new Response(text, {
      status: dsRes.status,
      headers: {
        "content-type": dsRes.headers.get("content-type") || "application/json; charset=utf-8",
        ...baseHeaders,
      },
    });
  }

  // Stream (SSE) passthrough, or return error body if not ok
  if (!dsRes.ok && dsRes.body) {
    const text = await dsRes.text();
    return new Response(text, {
      status: dsRes.status,
      headers: { "content-type": "application/json; charset=utf-8", ...baseHeaders },
    });
  }

  return new Response(dsRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      ...baseHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleOptions(request, env);

    // Serve your /public UI (index.html + chat.js) via ASSETS
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/health") {
      const origin = request.headers.get("Origin") || "*";
      return okJSON({ ok: true, ts: Date.now() }, cors(origin, env.ALLOWED_ORIGINS));
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
