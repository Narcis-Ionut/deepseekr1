// public/chat.js

// ---- DOM ----
const messagesEl   = document.getElementById("messages-container");
const inputEl      = document.getElementById("user-input");
const sendBtn      = document.getElementById("send-btn");
const typingEl     = document.getElementById("typing-indicator");
const loadingBar   = document.getElementById("loading-bar");
const modelSelect  = document.getElementById("model-select");
const clearBtn     = document.getElementById("clear-history-btn");
const exportBtn    = document.getElementById("export-chat-btn");
const msgCountEl   = document.getElementById("message-count");
const tokenCountEl = document.getElementById("token-count");

// ---- State ----
let history = [
  { role: "assistant", content: "Welcome to Neural Chat! I’m your AI assistant. Ask me anything or tell me what you’d like to build." }
];
let sending = false;
let estTokens = 0;

// ---- Helpers ----
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
  return textEl; // return node to stream into
}

function pushHistory(msg) {
  history.push(msg);
  try { localStorage.setItem("neural_chat_history", JSON.stringify(history)); } catch {}
  msgCountEl && (msgCountEl.textContent = String(history.length));
}

function appendText(node, chunk) {
  node.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // naive token estimate
  estTokens += Math.max(1, Math.round(chunk.split(/\s+/).length * 1.3));
  tokenCountEl && (tokenCountEl.textContent = String(estTokens));
}

function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

// ---- UI wiring ----
if (!messagesEl || !inputEl || !sendBtn) {
  console.error("Chat UI elements not found. Check IDs match index.html.");
}

inputEl.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

sendBtn.addEventListener("click", onSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
});

clearBtn?.addEventListener("click", () => {
  history = [{ role: "assistant", content: "New chat started. How can I help?" }];
  messagesEl.innerHTML = "";
  addBubble("assistant", history[0].content);
  pushHistory({ role: "system", content: "reset" });
});

exportBtn?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `neural-chat-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- Send flow ----
async function onSend() {
  const text = (inputEl.value || "").trim();
  if (!text || sending) return;

  sending = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  typingEl.classList.add("active");
  loadingBar.classList.add("active");

  pushHistory({ role: "user", content: text });
  addBubble("user", text);
  inputEl.value = ""; inputEl.style.height = "auto";

  const assistantNode = addBubble("assistant", "");
  let full = "";

  try {
    const model = (modelSelect && modelSelect.value) || "deepseek-chat";

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: lastN(history, 30) })
    });

    if (!res.ok) {
      const err = await res.text();
      appendText(assistantNode, `❌ Error ${res.status}\n${err}`);
      pushHistory({ role: "assistant", content: `Error ${res.status}` });
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
        const dataLine = evt.split("\n").find(l => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.replace(/^data:\s?/, "");
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content || "";
          if (delta) { full += delta; appendText(assistantNode, delta); }
        } catch { /* ignore non-JSON */ }
      }
    }

    pushHistory({ role: "assistant", content: full || assistantNode.textContent || "" });

  } catch (e) {
    appendText(assistantNode, `\n❌ Network error: ${e.message}`);
    pushHistory({ role: "assistant", content: `Network error: ${e.message}` });
  } finally {
    typingEl.classList.remove("active");
    loadingBar.classList.remove("active");
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    sending = false;
  }
}
