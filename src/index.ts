// DeepSeek Reasoner + D1 chat storage (create/list/get/delete/send with streaming).
// Serves static UI from /public via env.ASSETS.

const SYS_PROMPT =
  "You are a helpful, friendly assistant. Keep answers concise and accurate.";
const DS_MODEL = "deepseek-reasoner";
type AgentSlug =
  | "general"
  | "graphic_designer"
  | "seo_specialist"
  | "seo_designer"
  | "js_cloudflare_dev";

const AGENTS: Record<AgentSlug, { label: string; system: string }> = {
  general: {
    label: "General",
    system:
      "You're a versatile assistant. Be concise by default. Ask clarifying questions only when needed.",
  },
  graphic_designer: {
    label: "Graphic Designer",
    system:
      "You are a senior graphic designer. Think visually; propose concepts, layouts, color palettes, and typography. Provide export specs (size, DPI, color space) and asset checklists. Keep suggestions actionable.",
  },
  seo_specialist: {
    label: "SEO Specialist",
    system:
      "You are an SEO specialist. Provide technical and content SEO: audits, checklists, internal linking plans, schema markup, and keyword-driven outlines. Return concise action items with measurable outcomes.",
  },
  seo_designer: {
    label: "SEO + Designer",
    system:
      "You are a hybrid SEO + visual designer. Balance discoverability and visual impact. Provide on-page SEO (titles, meta, H1–H3, alt text) and social/OG image specs with style directions and accessibility notes.",
  },
  js_cloudflare_dev: {
    label: "JS + Cloudflare Dev",
    system:
      "You are a software developer focused on JavaScript and the Cloudflare stack (Workers, Pages, D1, KV, R2). Provide TypeScript-friendly code, edge-safe patterns (no Node-only APIs), and minimal deps.",
  },
};

function normalizeAgent(a: any): AgentSlug {
  return (
    [
      "general",
      "graphic_designer",
      "seo_specialist",
      "seo_designer",
      "js_cloudflare_dev",
    ] as const
  ).includes(a)
    ? a
    : "general";
}

function buildSystem(agent: AgentSlug): string {
  return [SYS_PROMPT, AGENTS[agent]?.system].filter(Boolean).join("\n\n");
}

interface Env {
  DEEPSEEK_API_KEY: string;
  ALLOWED_ORIGINS?: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB: D1Database; // D1 binding name must be DB
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

function okJSON(data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function badJSON(
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function handleOptions(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    status: 204,
    headers: cors(origin, env.ALLOWED_ORIGINS),
  });
}

// ---------------- D1 helpers ----------------
async function createChat(
  env: Env,
  title?: string,
  agent: AgentSlug = "general"
) {
  if (!env.DB) throw new Error("D1 binding 'DB' missing");
  const chatId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO chats (id, title, agent, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(chatId, title ?? null, agent, now)
    .run();
  return chatId;
}
async function getChat(env: Env, chatId: string) {
  return await env.DB.prepare(
    "SELECT id, title, agent, created_at FROM chats WHERE id = ?1"
  )
    .bind(chatId)
    .first<{
      id: string;
      title: string | null;
      agent: string | null;
      created_at: number;
    }>();
}

async function chatExists(env: Env, chatId: string) {
  const r = await env.DB.prepare("SELECT id FROM chats WHERE id = ?1")
    .bind(chatId)
    .first();
  return !!r;
}

async function getMessages(env: Env, chatId: string, limit = 1000) {
  const res = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC LIMIT ?2"
  )
    .bind(chatId, limit)
    .all<{
      role: "system" | "user" | "assistant";
      content: string;
      created_at: number;
    }>();
  return res.results ?? [];
}

async function insertMessage(
  env: Env,
  chatId: string,
  role: "system" | "user" | "assistant",
  content: string
) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(chatId, role, content, now)
    .run();
}

async function updateChatTitleIfEmpty(
  env: Env,
  chatId: string,
  fromText: string
) {
  const title = fromText.trim().slice(0, 48);
  await env.DB.prepare(
    "UPDATE chats SET title = COALESCE(NULLIF(title,''), ?2) WHERE id = ?1 AND (title IS NULL OR title = '')"
  )
    .bind(chatId, title)
    .run();
}

async function listChats(env: Env, limit = 100, offset = 0) {
  const sql = `
    SELECT
      c.id,
      COALESCE(NULLIF(c.title, ''), 'Untitled') AS title,
      c.agent,
      c.created_at,
      COALESCE(MAX(m.created_at), c.created_at) AS last_activity,
      COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    GROUP BY c.id
    ORDER BY last_activity DESC
    LIMIT ?1 OFFSET ?2
  `;
  const res = await env.DB.prepare(sql).bind(limit, offset).all<{
    id: string;
    title: string;
    agent: string | null;
    created_at: number;
    last_activity: number;
    message_count: number;
  }>();
  return res.results ?? [];
}

async function deleteChat(env: Env, chatId: string) {
  // Cascade may or may not be enforced; delete messages explicitly for safety
  await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?1")
    .bind(chatId)
    .run();
  await env.DB.prepare("DELETE FROM chats WHERE id = ?1").bind(chatId).run();
}

// ---------------- Routes ----------------
async function routeCreateChat(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {}
    const agent = normalizeAgent(body?.agent);
    const chatId = await createChat(env, body?.title, agent);
    return okJSON({ chat_id: chatId }, cors(origin, env.ALLOWED_ORIGINS));
  } catch (e: any) {
    return badJSON(
      500,
      { error: { message: String(e?.message || e) } },
      cors(origin, env.ALLOWED_ORIGINS)
    );
  }
}

async function routeListChats(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  const rows = await listChats(env, limit, offset);
  return okJSON({ data: rows }, cors(origin, env.ALLOWED_ORIGINS));
}

async function routeGetChat(request: Request, env: Env, chatId: string) {
  const origin = request.headers.get("Origin") || "*";
  const chat = await getChat(env, chatId);
  if (!chat)
    return badJSON(
      404,
      { error: { message: "Chat not found" } },
      cors(origin, env.ALLOWED_ORIGINS)
    );
  const messages = await getMessages(env, chatId);
  return okJSON(
    { chat_id: chatId, agent: chat.agent || "general", messages },
    cors(origin, env.ALLOWED_ORIGINS)
  );
}

async function routeDeleteChat(request: Request, env: Env, chatId: string) {
  const origin = request.headers.get("Origin") || "*";
  if (!(await chatExists(env, chatId))) {
    return badJSON(
      404,
      { error: { message: "Chat not found" } },
      cors(origin, env.ALLOWED_ORIGINS)
    );
  }
  await deleteChat(env, chatId);
  return okJSON({ ok: true }, cors(origin, env.ALLOWED_ORIGINS));
}

async function routeChat(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "*";
  const baseHeaders = cors(origin, env.ALLOWED_ORIGINS);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badJSON(
      400,
      { error: { message: "Invalid JSON body" } },
      baseHeaders
    );
  }

  const chatId: string = body?.chat_id;
  const content: string = (body?.content ?? "").trim();
  const stream: boolean = body?.stream !== false; // default true

  if (!chatId) {
    return badJSON(
      400,
      { error: { message: "chat_id is required" } },
      baseHeaders
    );
  }
  if (!content) {
    return badJSON(
      400,
      { error: { message: "content is required" } },
      baseHeaders
    );
  }
  if (!(await chatExists(env, chatId))) {
    return badJSON(404, { error: { message: "Chat not found" } }, baseHeaders);
  }

  // Fetch chat info to determine agent/persona
  const chat = await getChat(env, chatId);
  const agentSlug = normalizeAgent(chat?.agent);
  const systemPrompt = buildSystem(agentSlug);

  // Save user message
  await insertMessage(env, chatId, "user", content);

  // Set chat title if empty (first user message)
  await updateChatTitleIfEmpty(env, chatId, content);

  // Build recent history (last 30 messages) from DB
  const history = await getMessages(env, chatId, 1000);
  const last30 = history.slice(-30);

  // Final messages with correct system prompt
  const finalMessages = [{ role: "system", content: systemPrompt }, ...last30];

  // Get API key
  const apiKey =
    (
      request.headers.get("authorization") ||
      request.headers.get("Authorization")
    )?.replace(/^[Bb]earer\s+/, "") || env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return badJSON(
      401,
      { error: { message: "Missing DEEPSEEK_API_KEY" } },
      baseHeaders
    );
  }

  const payload: any = {
    model: DS_MODEL,
    messages: finalMessages,
    stream,
  };

  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  } as RequestInit & { duplex: "half" };
  (init as any).duplex = "half";

  const dsRes = await fetch(
    "https://api.deepseek.com/v1/chat/completions",
    init
  );

  // Non-streaming mode
  if (!stream) {
    const text = await dsRes.text();
    try {
      const json = JSON.parse(text);
      const msg = json?.choices?.[0]?.message?.content;
      if (msg) await insertMessage(env, chatId, "assistant", msg);
    } catch {}
    return new Response(text, {
      status: dsRes.status,
      headers: {
        "content-type":
          dsRes.headers.get("content-type") ||
          "application/json; charset=utf-8",
        ...baseHeaders,
      },
    });
  }

  // Streaming mode
  if (!dsRes.ok && dsRes.body) {
    const text = await dsRes.text();
    return new Response(text, {
      status: dsRes.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...baseHeaders,
      },
    });
  }

  const reader = dsRes.body!.getReader();
  const sseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...baseHeaders,
  };

  let buffer = "";
  let assistant = "";
  const encoder = new TextEncoder();

  const streamOut = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (assistant.trim()) {
          await insertMessage(env, chatId, "assistant", assistant);
        }
        controller.enqueue(encoder.encode(`data: {"__stored": true}\n\n`));
        controller.close();
        return;
      }

      controller.enqueue(value);

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
        } catch {}
      }
    },
  });

  return new Response(streamOut, { status: 200, headers: sseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleOptions(request, env);

    // Static UI
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Health
    if (url.pathname === "/api/health") {
      const origin = request.headers.get("Origin") || "*";
      return okJSON(
        { ok: true, model: DS_MODEL, dbBound: !!env.DB },
        cors(origin, env.ALLOWED_ORIGINS)
      );
    }

    // Chats collection
    if (url.pathname === "/api/chats" && request.method === "POST")
      return routeCreateChat(request, env);
    if (url.pathname === "/api/chats" && request.method === "GET")
      return routeListChats(request, env);

    // Single chat
    const getMatch = url.pathname.match(/^\/api\/chats\/([0-9a-fA-F-]+)$/);
    if (getMatch && request.method === "GET")
      return routeGetChat(request, env, getMatch[1]);
    if (getMatch && request.method === "DELETE")
      return routeDeleteChat(request, env, getMatch[1]);

    // Send message
    if (url.pathname === "/api/chat" && request.method === "POST")
      return routeChat(request, env);

    return new Response("Not found", { status: 404 });
  },
};
