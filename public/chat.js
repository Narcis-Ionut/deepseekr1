// public/chat.js — reasoner only + D1-backed history

const messagesEl     = document.getElementById("messages-container");
const inputEl        = document.getElementById("user-input");
const sendBtn        = document.getElementById("send-btn");
const typingEl       = document.getElementById("typing-indicator");
const loadingBar     = document.getElementById("loading-bar");
const newChatBtn     = document.getElementById("new-chat-btn");
const clearHistoryBtn= document.getElementById("clear-history-btn");
const exportChatBtn  = document.getElementById("export-chat-btn");
const messageCountEl = document.getElementById("message-count");
const tokenCountEl   = document.getElementById("token-count");

let chatId = null;
let sending = false;
let estTokens = 0;

// Init
(async function init() {
  chatId = localStorage.getItem("neural_chat_id");
  if (!chatId) {
    chatId = await createChat();
    localStorage.setItem("neural_chat_id", chatId);
  }
  await loadChat(chatId);
})();

// Create a chat
async function createChat(title) {
  const res = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title || null })
  });
  if (!res.ok) throw new Error("Failed to create chat");
  const json = await res.json();
  return json.chat_id;
}

// Load messages
async function loadChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) {
    // If old chat missing (e.g., DB reset), create fresh
    chatId = await createChat();
    localStorage.setItem("neural_chat_id", chatId);
    return loadChat(chatId);
  }
  const json = await res.json();
  renderMessages(json.messages || []);
}

function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  for (const m of msgs) addBubble(m.role, m.content);
  messageCountEl && (messageCountEl.textContent = String(msgs.length));
  // rough token estimate
  estTokens = Math.round((msgs.map(x => x.content).join(" ").split(/\s+/).length || 0) * 1.3);
  tokenCountEl && (tokenCountEl.textContent = String(estTokens));
}

// UI wiring
inputEl.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});
sendBtn.addEventListener("click", onSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
});
newChatBtn?.addEventListener("click", async () => {
  chatId = await createChat();
  localStorage.setItem("neural_chat_id", chatId);
  await loadChat(chatId);
});
clearHistoryBtn?.addEventListener("click", async () => {
  chatId = await createChat("New chat");
  localStorage.setItem("neural_chat_id", chatId);
  await loadChat(chatId);
});
exportChatBtn?.addEventListener("click", async () => {
  const res = await fetch(`/api/chats/${chatId}`);
  if (!res.ok) return;
  const data = await res.json();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `neural-chat-${chatId}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Send + stream
async function onSend() {
  const text = (inputEl.value || "").trim();
  if (!text || sending) return;

  sending = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  typingEl.classList.add("active");
  loadingBar.classList.add("active");

  // Show user message locally (server also stores it)
  addBubble("user", text);
  inputEl.value = ""; inputEl.style.height = "auto";

  const assistantNode = addBubble("assistant", "");
  let full = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, content: text, stream: true })
    });

    if (!res.ok) {
      const err = await res.text();
      appendText(assistantNode, `❌ Error ${res.status}\n${err}`);
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
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
          if (delta) { full += delta; appendText(assistantNode, delta); }
        } catch {}
      }
    }

    // After stream finishes, refresh from server to be in sync
    await loadChat(chatId);

  } catch (e) {
    appendText(assistantNode, `\n❌ Network error: ${e.message}`);
  } finally {
    typingEl.classList.remove("active");
    loadingBar.classList.remove("active");
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    sending = false;
  }
}

// Render helpers
function addBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  const msgWrap = document.createElement("div");
  msgWrap.className = "message-wrapper";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "U" : "AI";

  const content = document.createElement("div");
  content.className = "message-content";

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.textContent = text || "";

  content.appendChild(textEl);
  msgWrap.appendChild(avatar);
  msgWrap.appendChild(content);
  wrap.appendChild(msgWrap);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // stats
  const words = (text || "").split(/\s+/).filter(Boolean).length;
  estTokens += Math.max(1, Math.round(words * 1.3));
  tokenCountEl && (tokenCountEl.textContent = String(estTokens));
  messageCountEl && (messageCountEl.textContent = String((Number(messageCountEl.textContent)||0)+1));

  return textEl;
}

function appendText(node, chunk) {
  node.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const words = chunk.split(/\s+/).filter(Boolean).length;
  estTokens += Math.max(1, Math.round(words * 1.3));
  tokenCountEl && (tokenCountEl.textContent = String(estTokens));
}
