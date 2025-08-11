// src/index.ts — DeepSeek Reasoner + D1 storage (create chat, fetch chat, send message)

const SYS_PROMPT = "You are a helpful, friendly assistant. Keep answers concise and accurate.";
const DS_MODEL = "deepseek-reasoner"; // hard-lock the model here

interface Env {
  DEEPSEEK_API_KEY: string;
  ALLOWED_ORIGINS?: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB: D1Database;
}

function cors(origin: string, allowed?: string) {
  let allow = "*";
  if (allowed && allowed !== "*") {
    const list = allowed.split(",").map((s) => s.trim());
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

// --- D1 helpers ---
async function createChat(env: Env, title?: string) {
  const chatId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO chats (id, title, created_at) VALUES (?1, ?2, ?3)"
  ).bind(chatId, title ?? null, now).run();
  return chatId;
}

async function getMessages(env: Env, chatId: string, limit = 1000) {
  const res = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC LIMIT ?2"
  ).bind(chatId, limit).all<{ role: string; content: string; created_at: number }>();
  return res.results ?? [];
}

async function insertMessage(env: Env, chatId: string, role: "system" | "user" | "assistant", content: string) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(chatId, role, content, now).run();
}

// --- Routes ---
async function routeCreateChat(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  let body: any = {};
  try { body = await request.json(); } catch {}
  const chatId = await createChat(env, body?.title);
  return okJSON({ chat_id: chatId }, cors(origin, env.ALLOWED_ORIGINS));
}

async function routeGetChat(request: Request, env: Env, chatId: string) {
  const origin = request.headers.get("Origin") || "*";
  // Verify chat exists (optional)
  const row = await env.DB.prepare("SELECT id FROM chats WHERE id = ?1").bind(chatId).first();
  if (!row) return badJSON(404, { error: { message: "Chat not found" } }, cors(origin, env.ALLOWED_ORIGINS));

  const messages = await getMessages(env, chatId);
  return okJSON({ chat_id: chatId, messages }, cors(origin, env.ALLOWED_ORIGINS));
}

async function routeChat(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  const baseHeaders = cors(origin, env.ALLOWED_ORIGINS);

  let body: any;
  try { body = await request.json(); }
  catch { return badJSON(400, { error: { message: "Invalid JSON body" } }, baseHeaders); }

  const chatId: string = body?.chat_id;
  const content: string = (body?.content ?? "").trim();
  const stream: boolean = body?.stream !== false; // default true

  if (!chatId) return badJSON(400, { error: { message: "chat_id is required" } }, baseHeaders);
  if (!content) return badJSON(400, { error: { message: "content is required" } }, baseHeaders);

  // ensure chat exists
  const chatExists = await env.DB.prepare("SELECT id FROM chats WHERE id = ?1").bind(chatId).first();
  if (!chatExists) return badJSON(404, { error: { message: "Chat not found" } }, baseHeaders);

  // Insert user message now
  await insertMessage(env, chatId, "user", content);

  // Build history from DB (last 30)
  const history = await getMessages(env, chatId, 1000);
  const last30 = history.slice(-30);
  const finalMessages = [
    { role: "system", content: SYS_PROMPT },
    ...last30,
    { role: "user", content },
  ];

  const apiKey =
    (request.headers.get("authorization") || request.headers.get("Authorization"))?.replace(/^[Bb]earer\s+/, "") ||
    env.DEEPSEEK_API_KEY;
  if (!apiKey) return badJSON(401, { error: { message: "Missing DEEPSEEK_API_KEY" } }, baseHeaders);

  const payload: any = {
    model: DS_MODEL, // forced
    messages: finalMessages,
    stream,
  };

  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  } as RequestInit as RequestInit & { duplex: "half" };
  (init as any).duplex = "half";

  const dsRes = await fetch("https://api.deepseek.com/v1/chat/completions", init);

  if (!stream) {
    const text = await dsRes.text();
    // Try to store assistant message from non-stream JSON
    try {
      const json = JSON.parse(text);
      const msg = json?.choices?.[0]?.message?.content;
      if (msg) await insertMessage(env, chatId, "assistant", msg);
    } catch {}
    return new Response(text, {
      status: dsRes.status,
      headers: { "content-type": dsRes.headers.get("content-type") || "application/json; charset=utf-8", ...baseHeaders },
    });
  }

  if (!dsRes.ok && dsRes.body) {
    const text = await dsRes.text();
    return new Response(text, { status: dsRes.status, headers: { "content-type": "application/json; charset=utf-8", ...baseHeaders } });
  }

  // Stream passthrough + capture content to store
  const reader = dsRes.body!.getReader();
  const sseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    ...baseHeaders,
  };

  let buffer = "";
  let assistant = "";
  const streamOut = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        // store at end
        if (assistant.trim()) {
          await insertMessage(env, chatId, "assistant", assistant);
        }
        return;
      }
      // Push original bytes to client
      controller.enqueue(value);

      // Decode and parse SSE chunk for our own capture
      const chunk = new TextDecoder().decode(value);
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.replace(/^data:\s?/, "");
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content || "";
          if (delta) assistant += delta;
        } catch { /* ignore non-JSON */ }
      }
    },
    cancel() {
      // no-op
    }
  });

  return new Response(streamOut, { status: 200, headers: sseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleOptions(request, env);

    // Static assets (your UI)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/health") {
      const origin = request.headers.get("Origin") || "*";
      return okJSON({ ok: true, ts: Date.now(), model: DS_MODEL }, cors(origin, env.ALLOWED_ORIGINS));
    }

    if (url.pathname === "/api/chats" && request.method === "POST") {
      return routeCreateChat(request, env);
    }

    const chatMatch = url.pathname.match(/^\/api\/chats\/([0-9a-fA-F-]+)$/);
    if (chatMatch && request.method === "GET") {
      return routeGetChat(request, env, chatMatch[1]);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return routeChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
