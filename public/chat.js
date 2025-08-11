// Neural Chat frontend — deepseek-reasoner + D1 storage + sidebar chat list

const messagesEl      = document.getElementById("messages-container");
const inputEl         = document.getElementById("user-input");
const sendBtn         = document.getElementById("send-btn");
const typingEl        = document.getElementById("typing-indicator");
const loadingBar      = document.getElementById("loading-bar");
const newChatBtn      = document.getElementById("new-chat-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const exportChatBtn   = document.getElementById("export-chat-btn");
const msgCountEl      = document.getElementById("message-count");
const tokenCountEl    = document.getElementById("token-count");
const chatListEl      = document.getElementById("chat-list");

let chatId = null;
let sending = false;
let estTokens = 0;

// ------- init -------
(async function init() {
  try {
    chatId = localStorage.getItem("neural_chat_id");
    if (!chatId) {
      chatId = await createChat();
      localStorage.setItem("neural_chat_id", chatId);
    }
    await refreshChats();
    await loadChat(chatId);
    highlightActiveChat(chatId);
  } catch (e) {
    addBubble("assistant", "❌ Could not create or load chat (storage not ready).");
    console.error(e);
    sendBtn.disabled = true;
    inputEl.disabled = true;
  }
})();

// ------- API helpers -------
async function createChat(title) {
  const res = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title || null }),
  });
  if (!res.ok) throw new Error("Failed to create chat");
  const json = await res.json();
  return json.chat_id;
}

async function loadChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) throw new Error("Failed to load chat");
  const json = await res.json();
  renderMessages(json.messages || []);
  highlightActiveChat(id);
}

async function refreshChats() {
  const res = await fetch("/api/chats");
  if (!res.ok) return;
  const { data } = await res.json();
  renderChatList(data || []);
}

async function deleteChat(id) {
  const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete chat");
}

// ------- UI wiring -------
inputEl.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});
sendBtn.addEventListener("click", onSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
});

newChatBtn?.addEventListener("click", onNewChat);
clearHistoryBtn?.addEventListener("click", onNewChat);
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

chatListEl.addEventListener("click", async (e) => {
  const item = e.target.closest(".chat-item");
  if (!item) return;

  const id = item.dataset.id;

  // delete button?
  if (e.target.closest(".icon.delete")) {
    const confirmDelete = confirm("Delete this chat?");
    if (!confirmDelete) return;
    try {
      await deleteChat(id);
      if (id === chatId) {
        // switch to a new chat
        chatId = await createChat();
        localStorage.setItem("neural_chat_id", chatId);
        await refreshChats();
        await loadChat(chatId);
      } else {
        await refreshChats();
        highlightActiveChat(chatId);
      }
    } catch (err) {
      console.error(err);
    }
    return;
  }

  // switch chat
  if (id && id !== chatId) {
    chatId = id;
    localStorage.setItem("neural_chat_id", chatId);
    await loadChat(chatId);
    highlightActiveChat(chatId);
  }
});

// ------- actions -------
async function onNewChat() {
  chatId = await createChat();
  localStorage.setItem("neural_chat_id", chatId);
  await refreshChats();
  await loadChat(chatId);
}

async function onSend() {
  const text = (inputEl.value || "").trim();
  if (!text || sending || !chatId) return;

  sending = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  typingEl.classList.add("active");
  loadingBar.classList.add("active");

  addBubble("user", text);
  inputEl.value = ""; inputEl.style.height = "auto";

  const assistantNode = addBubble("assistant", "");
  let full = "";
  let stored = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, content: text, stream: true }),
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
          if (j && j.__stored) { stored = true; continue; } // ✅ server sentinel
          const delta = j?.choices?.[0]?.delta?.content || "";
          if (delta) { full += delta; appendText(assistantNode, delta); }
        } catch {}
      }
    }

    // Reload after storage confirmed (or fallback slight delay)
    if (stored) {
      await loadChat(chatId);
    } else {
      setTimeout(() => loadChat(chatId).catch(()=>{}), 300);
    }
    await refreshChats();

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

// ------- render helpers -------
function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  estTokens = 0;
  for (const m of msgs) addBubble(m.role, m.content);
  msgCountEl && (msgCountEl.textContent = String(msgs.length));
}

function renderChatList(rows) {
  chatListEl.innerHTML = "";
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "chat-item";
    div.dataset.id = r.id;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.title || "Untitled";

    const right = document.createElement("div");
    right.className = "actions";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = String(r.message_count);

    const del = document.createElement("div");
    del.className = "icon delete";
    del.title = "Delete";
    del.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

    right.appendChild(meta);
    right.appendChild(del);

    div.appendChild(title);
    div.appendChild(right);

    chatListEl.appendChild(div);
  }
  highlightActiveChat(chatId);
}

function highlightActiveChat(id) {
  [...chatListEl.querySelectorAll(".chat-item")].forEach((n) => {
    n.classList.toggle("active", n.dataset.id === id);
  });
}

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
  msgCountEl && (msgCountEl.textContent = String((Number(msgCountEl.textContent)||0)+1));

  return textEl;
}

function appendText(node, chunk) {
  node.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const words = chunk.split(/\s+/).filter(Boolean).length;
  estTokens += Math.max(1, Math.round(words * 1.3));
  tokenCountEl && (tokenCountEl.textContent = String(estTokens));
}
