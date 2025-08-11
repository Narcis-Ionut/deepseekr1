/**
 * Neural Chat frontend (DeepSeek via /api/chat, SSE streaming)
 * Matches the IDs/classes in index.html and keeps your styles.
 */

// DOM
const messagesEl = document.getElementById("messages-container");
const inputEl = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const typingEl = document.getElementById("typing-indicator");
const loadingBar = document.getElementById("loading-bar");
const modelSelect = document.getElementById("model-select");
const newChatBtn = document.getElementById("new-chat-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const exportChatBtn = document.getElementById("export-chat-btn");
const messageCountEl = document.getElementById("message-count");
const tokenCountEl = document.getElementById("token-count");

// State
let history = [
  { role: "assistant", content: "Welcome to Neural Chat! I’m your AI assistant. Ask me anything or tell me what you’d like to build." }
];
let sending = false;
let estTokens = 0;

// Restore previous (optional)
try {
  const saved = localStorage.getItem("neural_chat_history");
  if (saved) {
    history = JSON.parse(saved);
    // Re-render
    messagesEl.innerHTML = "";
    for (const m of history) addBubble(m.role, m.content);
    updateStats();
  }
} catch {}

// Auto-resize textarea
inputEl.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

// Send on click / Enter
sendBtn.addEventListener("click", onSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
});

// Quick actions
newChatBtn?.addEventListener("click", resetChat);
clearHistoryBtn?.addEventListener("click", resetChat);
exportChatBtn?.addEventListener("click", exportChat);

// Smooth(er) scroll
messagesEl.addEventListener("wheel", (e) => {
  // Keep the nice smooth feel without locking page scrolling
  // e.preventDefault(); // optional
  messagesEl.scrollTop += e.deltaY * 0.5;
});

async function onSend() {
  const text = (inputEl.value || "").trim();
  if (!text || sending) return;

  sending = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  typingEl.classList.add("active");
  loadingBar.classList.add("active");

  pushHistory({ role: "user", content: text });
  inputEl.value = "";
  inputEl.style.height = "auto";

  // Create assistant bubble to stream into
  const assistantNode = addBubble("assistant", "");

  try {
    const model = modelSelect?.value || "deepseek-chat";

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: lastN(history, 30),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      appendText(assistantNode, `❌ Error ${res.status}\n${errText}`);
      pushHistory({ role: "assistant", content: `Error ${res.status}` });
      return;
    }

    // SSE streaming parser
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split Server-Sent Events by double newline
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const evt of events) {
        // Find "data:" line
        const line = evt.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.replace(/^data:\s?/, "");
        if (payload === "[DONE]") continue;

        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            appendText(assistantNode, delta);
          }
        } catch {
          // not JSON – ignore
        }
      }
    }

    // Save assistant message
    pushHistory({ role: "assistant", content: full || assistantNode.textContent || "" });

  } catch (err) {
    appendText(assistantNode, `\n❌ Network error: ${err.message}`);
    pushHistory({ role: "assistant", content: `Network error: ${err.message}` });
  } finally {
    typingEl.classList.remove("active");
    loadingBar.classList.remove("active");
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

function addBubble(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const avatar = role === "user" ? "U" : "AI";

  // Build elements to avoid XSS
  const msgWrap = document.createElement("div");
  msgWrap.className = "message-wrapper";

  const avatarEl = document.createElement("div");
  avatarEl.className = "avatar";
  avatarEl.textContent = avatar;

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.textContent = text || "";

  contentEl.appendChild(textEl);
  msgWrap.appendChild(avatarEl);
  msgWrap.appendChild(contentEl);
  wrapper.appendChild(msgWrap);

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Return the text element so we can append to it during stream
  return textEl;
}

function appendText(textNode, chunk) {
  textNode.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // naive token estimate
  estTokens += Math.max(1, Math.round(chunk.split(/\s+/).length * 1.3));
  tokenCountEl.textContent = estTokens.toString();
}

function pushHistory(msg) {
  history.push(msg);
  updateStats();
  try { localStorage.setItem("neural_chat_history", JSON.stringify(history)); } catch {}
}

function updateStats() {
  messageCountEl.textContent = history.length.toString();
  // re-estimate roughly from whole history
  estTokens = Math.round(history.map(m => m.content).join(" ").split(/\s+/).length * 1.3);
  tokenCountEl.textContent = estTokens.toString();
}

function resetChat() {
  history = [
    { role: "assistant", content: "New chat started. How can I help?" }
  ];
  messagesEl.innerHTML = "";
  for (const m of history) addBubble(m.role, m.content);
  updateStats();
  try { localStorage.setItem("neural_chat_history", JSON.stringify(history)); } catch {}
}

function exportChat() {
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `neural-chat-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function lastN(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}
