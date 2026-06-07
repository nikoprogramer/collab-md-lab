import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import { marked } from "marked";

const WS_URL = import.meta.env.DEV
  ? "ws://localhost:3000"
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

const API_BASE = import.meta.env.DEV ? "http://localhost:3000" : "";

const PALETTE = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#6eeb83", light: "#6eeb8333" },
  { color: "#ffbc42", light: "#ffbc4233" },
  { color: "#ee6352", light: "#ee635233" },
  { color: "#c77dff", light: "#c77dff33" },
  { color: "#ff6b9d", light: "#ff6b9d33" },
  { color: "#ff8c42", light: "#ff8c4233" },
  { color: "#fcba28", light: "#fcba2833" },
  { color: "#4ecdc4", light: "#4ecdc433" },
  { color: "#8acb88", light: "#8acb8833" },
  { color: "#9ac2c9", light: "#9ac2c933" },
  { color: "#a78bfa", light: "#a78bfa33" },
];

function pickColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash = hash | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ── App state ────────────────────────────────────────────────────

let nickname = "";
let authToken = null;
let currentFile = null;
let ydoc = null;
let provider = null;
let editorView = null;

// Persisted color choice; null = derive from nickname hash
let selectedColorIndex = (() => {
  const v = localStorage.getItem("cursorColorIndex");
  return v !== null ? parseInt(v, 10) : null;
})();

function getEffectiveColor() {
  return selectedColorIndex !== null ? PALETTE[selectedColorIndex] : pickColor(nickname);
}

// ── DOM references ───────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const loginPage       = $("login-page");
const editorPage      = $("editor-page");
const nicknameInput   = $("nickname-input");
const loginBtn        = $("login-btn");
const fileListEl      = $("file-list");
const newFileBtn      = $("new-file-btn");
const editorContainer = $("editor-container");
const noFileMsg       = $("no-file-msg");
const previewPanel    = $("preview-panel");
const currentFileLabel = $("current-file");
const userLabel       = $("user-label");
const logoutBtn       = $("logout-btn");
const toolbar         = $("toolbar");
const settingsBtn     = $("settings-btn");
const settingsPanel   = $("settings-panel");
const colorSwatches   = $("color-swatches");

// ── Settings panel ────────────────────────────────────────────────

// Build colour swatches
PALETTE.forEach((c, i) => {
  const sw = document.createElement("button");
  sw.className = "color-swatch";
  sw.style.background = c.color;
  sw.title = c.color;
  sw.dataset.index = i;
  colorSwatches.appendChild(sw);
});

function syncSwatchActive() {
  colorSwatches.querySelectorAll(".color-swatch").forEach((sw) => {
    sw.classList.toggle("active", parseInt(sw.dataset.index, 10) === selectedColorIndex);
  });
}
syncSwatchActive();

colorSwatches.addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  selectedColorIndex = parseInt(sw.dataset.index, 10);
  localStorage.setItem("cursorColorIndex", selectedColorIndex);
  syncSwatchActive();
  // Apply immediately if a file is open
  if (provider) {
    const c = PALETTE[selectedColorIndex];
    provider.awareness.setLocalStateField("user", {
      name: nickname,
      color: c.color,
      colorLight: c.light,
    });
  }
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
    settingsPanel.classList.remove("open");
  }
});

// ── Auto-login (persisted token) ─────────────────────────────────

async function tryAutoLogin() {
  const token = localStorage.getItem("authToken");
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { localStorage.removeItem("authToken"); return; }
    const { username } = await res.json();
    authToken = token;
    enterEditor(username, true);
  } catch {}
}

tryAutoLogin();

// ── Enter editor ─────────────────────────────────────────────────

function enterEditor(name, isAccount = false) {
  nickname = name;
  loginPage.style.display = "none";
  editorPage.style.display = "flex";
  userLabel.textContent = nickname;
  logoutBtn.style.display = isAccount ? "inline-flex" : "none";
  loadFileList();
  setInterval(loadFileList, 3000);
}

// ── Logout ───────────────────────────────────────────────────────

logoutBtn.addEventListener("click", async () => {
  if (authToken) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch {}
    localStorage.removeItem("authToken");
    authToken = null;
  }
  window.location.reload();
});

// ── Auth tabs ─────────────────────────────────────────────────────

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    $("tab-guest").style.display   = target === "guest"   ? "flex" : "none";
    $("tab-account").style.display = target === "account" ? "flex" : "none";
    if (target === "guest") nicknameInput.focus();
    else $("auth-username").focus();
  });
});

// ── Guest login ───────────────────────────────────────────────────

loginBtn.addEventListener("click", handleGuestLogin);
nicknameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleGuestLogin();
});

function handleGuestLogin() {
  const base = nicknameInput.value.trim();
  if (!base) return;
  const suffix = String(Math.floor(Math.random() * 900) + 100);
  enterEditor(`${base}#${suffix}`, false);
}

// ── Account login / register ──────────────────────────────────────

let authMode = "login";

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    authMode = btn.dataset.mode;
    const isRegister = authMode === "register";
    $("auth-password2").style.display = isRegister ? "" : "none";
    $("auth-submit").textContent = isRegister ? "Zarejestruj się" : "Zaloguj się";
    $("auth-error").textContent = "";
    if (isRegister) $("auth-password").setAttribute("autocomplete", "new-password");
    else            $("auth-password").setAttribute("autocomplete", "current-password");
  });
});

$("auth-submit").addEventListener("click", handleAccountSubmit);
[$("auth-username"), $("auth-password"), $("auth-password2")].forEach((el) => {
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAccountSubmit(); });
});

async function handleAccountSubmit() {
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  const password2 = $("auth-password2").value;
  const errorEl = $("auth-error");
  errorEl.textContent = "";

  if (!username || !password) { errorEl.textContent = "Wypełnij wszystkie pola."; return; }

  if (authMode === "register") {
    if (password !== password2) { errorEl.textContent = "Hasła się nie zgadzają."; return; }
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }
      authToken = data.token;
      localStorage.setItem("authToken", data.token);
      enterEditor(data.username, true);
    } catch {
      errorEl.textContent = "Błąd połączenia z serwerem.";
    }
  } else {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }
      authToken = data.token;
      localStorage.setItem("authToken", data.token);
      enterEditor(data.username, true);
    } catch {
      errorEl.textContent = "Błąd połączenia z serwerem.";
    }
  }
}

// ── File list ────────────────────────────────────────────────────

async function loadFileList() {
  try {
    const res = await fetch(`${API_BASE}/api/files`);
    if (!res.ok) return;
    const files = await res.json();
    renderFileList(files);
  } catch {
    alert("Coś się zepsuło w serwerze.");
  }
}

function renderFileList(files) {
  fileListEl.innerHTML = "";
  files.forEach((name) => {
    const item = document.createElement("div");
    item.className = "file-item" + (name === currentFile ? " active" : "");
    item.addEventListener("click", () => openFile(name));

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-item-name";
    nameSpan.textContent = name;

    const delBtn = document.createElement("button");
    delBtn.className = "file-delete-btn";
    delBtn.textContent = "×";
    delBtn.title = "Usuń plik";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFile(name);
    });

    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    fileListEl.appendChild(item);
  });
}

async function deleteFile(name) {
  if (!confirm(`Usunąć plik "${name}"?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!res.ok) { const data = await res.json(); alert(data.error); return; }
    if (name === currentFile) closeEditor();
    await loadFileList();
  } catch {
    alert("Nie udało się usunąć pliku.");
  }
}

function closeEditor() {
  currentFile = null;
  currentFileLabel.textContent = "Wybierz plik…";
  if (editorView) { editorView.destroy(); editorView = null; }
  if (provider)   { provider.destroy();   provider   = null; }
  if (ydoc)       { ydoc.destroy();       ydoc       = null; }
  editorContainer.style.display = "none";
  toolbar.style.display = "none";
  noFileMsg.style.display = "";
}

// ── New file ─────────────────────────────────────────────────────

newFileBtn.addEventListener("click", async () => {
  const raw = prompt("Nazwa nowego pliku (bez .md):");
  if (raw === null) return;
  const name = raw.trim();
  if (!name) return;
  try {
    const res = await fetch(`${API_BASE}/api/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    await loadFileList();
    openFile(data.name);
  } catch {
    alert("Nie udało się utworzyć pliku.");
  }
});

// ── Open file ────────────────────────────────────────────────────

function openFile(filename) {
  if (filename === currentFile) return;
  currentFile = filename;
  currentFileLabel.textContent = filename;

  if (editorView) { editorView.destroy(); editorView = null; }
  if (provider)   { provider.destroy();   provider   = null; }
  if (ydoc)       { ydoc.destroy();       ydoc       = null; }

  ydoc = new Y.Doc();
  provider = new WebsocketProvider(WS_URL, filename, ydoc);

  const userColor = getEffectiveColor();
  provider.awareness.setLocalStateField("user", {
    name: nickname,
    color: userColor.color,
    colorLight: userColor.light,
  });

  const ytext = ydoc.getText("content");

  noFileMsg.style.display = "none";
  editorContainer.style.display = "flex";
  toolbar.style.display = "flex";

  editorView = new EditorView({
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(ytext, provider.awareness),
    ],
    parent: editorContainer,
  });

  ytext.observe(() => {
    previewPanel.innerHTML = marked.parse(ytext.toString());
  });

  document.querySelectorAll(".file-item").forEach((el) => {
    el.classList.toggle("active", el.querySelector(".file-item-name")?.textContent === filename);
  });
}

// ── Toolbar ──────────────────────────────────────────────────────

function wrapSelection(view, before, after) {
  after = after ?? before;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

function prefixLine(view, prefix) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  if (line.text.startsWith(prefix)) {
    view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: "" } });
  } else {
    view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
  }
  view.focus();
}

function insertBlock(view, text) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text } });
  view.focus();
}

const TOOLBAR_ACTIONS = {
  bold:          (v) => wrapSelection(v, "**"),
  italic:        (v) => wrapSelection(v, "*"),
  strikethrough: (v) => wrapSelection(v, "~~"),
  code:          (v) => wrapSelection(v, "`"),
  h1:            (v) => prefixLine(v, "# "),
  h2:            (v) => prefixLine(v, "## "),
  h3:            (v) => prefixLine(v, "### "),
  quote:         (v) => prefixLine(v, "> "),
  ul:            (v) => prefixLine(v, "- "),
  ol:            (v) => prefixLine(v, "1. "),
  link: (v) => {
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    const text = sel || "tekst";
    v.dispatch({
      changes: { from, to, insert: `[${text}](url)` },
      selection: { anchor: from + text.length + 3, head: from + text.length + 6 },
    });
    v.focus();
  },
  codeblock: (v) => {
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    v.dispatch({
      changes: { from, to, insert: "```\n" + sel + "\n```" },
      selection: { anchor: from + 4, head: from + 4 + sel.length },
    });
    v.focus();
  },
  hr: (v) => insertBlock(v, "\n---\n"),
};

toolbar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !editorView) return;
  const action = TOOLBAR_ACTIONS[btn.dataset.action];
  if (action) action(editorView);
});

document.addEventListener("keydown", (e) => {
  if (!editorView) return;
  if (e.ctrlKey && e.key === "b") { e.preventDefault(); TOOLBAR_ACTIONS.bold(editorView); }
  if (e.ctrlKey && e.key === "i") { e.preventDefault(); TOOLBAR_ACTIONS.italic(editorView); }
});
