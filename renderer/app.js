const input = document.getElementById("input");
const translateBtn = document.getElementById("translate-btn");
const langBtns = Array.from(document.querySelectorAll(".lang-btn"));
const arrow = document.querySelector(".arrow");
const detectedHint = document.getElementById("detected-hint");
const swapBtn = document.getElementById("swap-btn");
const clearBtn = document.getElementById("clear-btn");
const copyBtn = document.getElementById("copy-btn");
const copiedTag = document.getElementById("copied-tag");
const result = document.getElementById("result");
const resultLang = document.getElementById("result-lang");
const errorBox = document.getElementById("error");
const closeBtn = document.getElementById("close-btn");
const minimizeBtn = document.getElementById("minimize-btn");
const dragHandle = document.getElementById("drag-handle");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const optAlwaysOnTop = document.getElementById("opt-alwaysontop");
const optRunAtStartup = document.getElementById("opt-runatstartup");
const optAutoTranslate = document.getElementById("opt-autotranslate");
const optAutoTranslateRephrase = document.getElementById("opt-autotranslate-rephrase");
const optAutoCopy = document.getElementById("opt-autocopy");
const optExternalHotkey = document.getElementById("opt-externalhotkey");
const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const hotkeyField = document.getElementById("hotkey-field");
const hotkeyErr = document.getElementById("hotkey-err");
const hintHotkey = document.getElementById("hint-hotkey");
const quotaTag = document.getElementById("quota-tag");
const quotaBanner = document.getElementById("quota-banner");
const quotaBannerText = document.getElementById("quota-banner-text");
const bannerClose = document.getElementById("banner-close");
const langPill = document.getElementById("lang-pill");
const modeBtns = Array.from(document.querySelectorAll(".mode-btn"));
const rephraseTarget = document.getElementById("rephrase-target");
const rephraseLang = document.getElementById("rephrase-lang");

const AR = { en: "English", ar: "Arabic" };

let direction = { source: "en", target: "ar" };
let mode = "translate";
let manualOverride = false;
let loadedInput = null;
let loading = false;
let autoTranslate = true;
let autoTranslateRephrase = true;
let autoCopy = false;
let externalHotkey = false;
let quotaBlocked = false;
let capturingHotkey = false;
let currentHotkey = "Ctrl+Alt+T";

function fmtTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

function setHintHotkey(label) {
  hintHotkey.textContent = label;
}

function updateQuotaTag(d) {
  if (d && typeof d.requests === "number") {
    quotaTag.textContent = `Today: ${d.requests} requests \u2022 ${fmtTokens(d.tokens)}`;
  }
}

function showQuotaBanner(text) {
  quotaBannerText.textContent = text;
  quotaBanner.classList.add("show");
}

function hideQuotaBanner() {
  quotaBanner.classList.remove("show");
}

function detectLang(text) {
  const arabic = /[\u0600-\u06FF]/g;
  const matches = text.match(arabic);
  if (matches && matches.length / Math.max(text.length, 1) > 0.1) return "ar";
  return "en";
}

function updatePill() {
  langBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === direction.source);
  });
  arrow.textContent = direction.source === "en" ? "\u2192" : "\u2190";
  if (mode !== "rephrase") resultLang.textContent = AR[direction.target];
}

function setMode(m) {
  clearTimeout(autoTimer);
  mode = m === "rephrase" ? "rephrase" : "translate";
  if (mode === "translate" && direction.target !== "en" && direction.target !== "ar") {
    direction.target = direction.source === "ar" ? "en" : "ar";
  }
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  langPill.classList.toggle("hidden", mode === "rephrase");
  swapBtn.classList.toggle("hidden", mode === "rephrase");
  rephraseTarget.classList.toggle("hidden", mode !== "rephrase");
  manualOverride = false;
  loadedInput = null;
  clearError();
  clearResult();
  updatePill();
}

function setDirection(source) {
  direction.source = source;
  direction.target = source === "en" ? "ar" : "en";
  updatePill();
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("show");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.remove("show");
}

function setResult(text, lang) {
  result.textContent = text;
  result.dir = lang === "ar" ? "rtl" : "ltr";
  result.classList.toggle("placeholder", !text);
  resultLang.textContent = AR[lang];
}

function displayLang() {
  if (mode === "rephrase") {
    const t = rephraseLang.value;
    return t === "auto" ? direction.source : t;
  }
  return direction.target;
}

function emptyHint() {
  return mode === "rephrase"
    ? "The rephrased text will appear here."
    : "The translation will appear here.";
}

function clearResult() {
  setResult(emptyHint(), displayLang());
}

let copiedTimer = null;

function flashCopied() {
  copiedTag.classList.add("show");
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => copiedTag.classList.remove("show"), 1400);
}

function reportDetected(text) {
  const lang = detectLang(text);
  detectedHint.textContent = text && text.trim() ? `Detected: ${AR[lang]}` : "";
  return lang;
}

async function translate() {
  const text = input.value.trim();
  if (!text || loading) return;
  clearTimeout(autoTimer);

  if (!manualOverride) {
    direction.source = reportDetected(text);
    if (mode === "translate") {
      direction.target = direction.source === "en" ? "ar" : "en";
    }
  }
  updatePill();

  loading = true;
  translateBtn.disabled = true;
  translateBtn.classList.add("loading");
  clearError();
  const outTarget = mode === "rephrase" ? rephraseLang.value : direction.target;
  setResult("", displayLang());

  const res = await window.translator.translate({
    text,
    mode,
    source: direction.source,
    target: outTarget,
  });

  loading = false;
  translateBtn.disabled = false;
  translateBtn.classList.remove("loading");

  if (res && res.ok) {
    quotaBlocked = false;
    hideQuotaBanner();
    if (res.daily) updateQuotaTag(res.daily);
    setResult(res.translation, displayLang());
    if (autoCopy && res.translation) {
      try {
        await navigator.clipboard.writeText(res.translation);
        flashCopied();
      } catch (_err) {}
    }
    refreshHistory();
  } else {
    const msg = (res && res.error) || "Translation failed";
    if (res && res.daily) updateQuotaTag(res.daily);
    showError(msg);
    setResult("Translation failed \u2014 try again in a moment.", displayLang());
    result.classList.add("placeholder");
    if (res && res.code === "free-limit") {
      quotaBlocked = true;
      clearTimeout(autoTimer);
      showQuotaBanner(
        "Free daily limit reached \u2014 translations are paused until the limit resets. Set the TDN_ZEN_KEY environment variable to keep going.",
      );
    } else if (res && res.code === "rate-limit") {
      showQuotaBanner("OpenCode Zen is rate-limiting requests right now. Slow down and try again shortly.");
    }
  }
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

let autoTimer = null;

input.addEventListener("input", () => {
  if (manualOverride && loadedInput !== null && input.value !== loadedInput) {
    manualOverride = false;
    loadedInput = null;
  }
  const lang = reportDetected(input.value);
  if (!manualOverride && input.value.trim()) setDirection(lang);
  clearError();
  autoGrow();
  clearTimeout(autoTimer);
  const autoOn = mode === "rephrase" ? autoTranslateRephrase : autoTranslate;
  if (input.value.trim() && autoOn && !quotaBlocked) {
    autoTimer = setTimeout(translate, 700);
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    translate();
  }
});

translateBtn.addEventListener("click", translate);

langBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    manualOverride = true;
    loadedInput = null;
    setDirection(btn.dataset.lang);
    remainingHint();
  });
});

modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function remainingHint() {
  detectedHint.textContent = input.value.trim()
    ? `Detected: ${AR[reportDetected(input.value)]}`
    : "";
}

swapBtn.addEventListener("click", () => {
  const cur = result.textContent;
  if (cur && !result.classList.contains("placeholder")) {
    setDirection(direction.target);
    manualOverride = true;
    input.value = cur;
    loadedInput = cur;
    reportDetected(input.value);
    autoGrow();
    setResult("", direction.target);
    input.focus();
  }
});

clearBtn.addEventListener("click", () => {
  input.value = "";
  autoGrow();
  clearResult();
  clearError();
  manualOverride = false;
  loadedInput = null;
  detectedHint.textContent = "";
  updatePill();
  input.focus();
});

copyBtn.addEventListener("click", async () => {
  const text = result.textContent;
  if (!text || result.classList.contains("placeholder")) return;
  try {
    await navigator.clipboard.writeText(text);
    flashCopied();
  } catch (_err) {
    showError("Could not copy to clipboard.");
  }
});

closeBtn.addEventListener("click", () => window.translator.hideWindow());
minimizeBtn.addEventListener("click", () => window.translator.minimizeWindow());
let dragState = null;
let lastDragEnd = 0;

dragHandle.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".title-actions")) return;
  dragState = { x: e.screenX, y: e.screenY, active: false };
  try {
    dragHandle.setPointerCapture(e.pointerId);
  } catch {}
});

dragHandle.addEventListener("mousemove", (e) => {
  if (!dragState) return;
  const dx = e.screenX - dragState.x;
  const dy = e.screenY - dragState.y;
  if (!dragState.active) {
    if (Math.hypot(dx, dy) < 4) return;
    dragState.active = true;
  }
  window.translator.dragMove(dx, dy);
  dragState.x = e.screenX;
  dragState.y = e.screenY;
});

dragHandle.addEventListener("mouseup", () => {
  if (dragState && dragState.active) lastDragEnd = Date.now();
  dragState = null;
});

dragHandle.addEventListener("dblclick", (e) => {
  if (e.target.closest(".title-actions")) return;
  if (Date.now() - lastDragEnd < 400) return;
  window.translator.toggleMaximize();
});

let optionsOpen = false;

function setOptionsOpen(open) {
  optionsOpen = open;
  settingsPanel.classList.toggle("open", open);
  settingsBtn.classList.toggle("active", open);
  if (open) setHistoryOpen(false);
}

settingsBtn.addEventListener("click", () => setOptionsOpen(!optionsOpen));

function applySettings(s) {
  if (typeof s.alwaysOnTop === "boolean") optAlwaysOnTop.checked = s.alwaysOnTop;
  if (typeof s.runAtStartup === "boolean") optRunAtStartup.checked = s.runAtStartup;
  if (typeof s.autoTranslate === "boolean") {
    autoTranslate = s.autoTranslate;
    optAutoTranslate.checked = s.autoTranslate;
  }
  if (typeof s.autoTranslateRephrase === "boolean") {
    autoTranslateRephrase = s.autoTranslateRephrase;
    optAutoTranslateRephrase.checked = s.autoTranslateRephrase;
  }
  if (typeof s.autoCopy === "boolean") {
    autoCopy = s.autoCopy;
    optAutoCopy.checked = s.autoCopy;
  }
  if (typeof s.externalHotkey === "boolean") {
    externalHotkey = s.externalHotkey;
    optExternalHotkey.checked = s.externalHotkey;
  }
  if (typeof s.hotkey === "string" && s.hotkey) {
    currentHotkey = s.hotkey;
    hotkeyField.textContent = s.hotkey;
    setHintHotkey(s.hotkey);
  }
}

async function refreshHistory() {
  const entries = await window.translator.getHistory();
  historyList.innerHTML = "";
  if (!entries || !entries.length) {
    historyEmpty.style.display = "block";
    return;
  }
  historyEmpty.style.display = "none";
  entries.forEach((e) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const body = document.createElement("div");
    body.className = "history-entry";
    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent =
      e.mode === "rephrase"
        ? `Rephrase \u2022 ${e.target === "auto" ? "Same language" : AR[e.target]}`
        : `${AR[e.source]} \u2192 ${AR[e.target]}`;
    const inLine = document.createElement("div");
    inLine.className = "history-in";
    inLine.dir = "auto";
    inLine.textContent = e.input;
    const outLine = document.createElement("div");
    outLine.className = "history-in";
    outLine.dir = "auto";
    outLine.textContent = e.output;
    body.append(meta, inLine, outLine);

    const copy = document.createElement("button");
    copy.className = "ghost-btn small";
    copy.textContent = "Copy";
    copy.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(e.output).catch(() => showError("Could not copy to clipboard."));
    });

    item.append(body, copy);
    item.addEventListener("click", () => loadHistoryEntry(e));
    historyList.append(item);
  });
}

function loadHistoryEntry(e) {
  const isRephrase = e.mode === "rephrase";
  const outLang = isRephrase
    ? e.target === "en" || e.target === "ar"
      ? e.target
      : e.source
    : e.target;
  direction = { source: e.source, target: e.target };
  setMode(isRephrase ? "rephrase" : "translate");
  if (isRephrase) rephraseLang.value = e.target === "en" || e.target === "ar" ? e.target : "auto";
  manualOverride = true;
  input.value = e.input;
  loadedInput = e.input;
  reportDetected(input.value);
  autoGrow();
  input.focus();
  setResult(e.output, outLang);
  setHistoryOpen(false);
}

let historyOpen = false;

function setHistoryOpen(open) {
  historyOpen = open;
  historyPanel.classList.toggle("open", open);
  historyBtn.classList.toggle("active", open);
  if (open) {
    setOptionsOpen(false);
    refreshHistory();
  }
}

historyBtn.addEventListener("click", () => setHistoryOpen(!historyOpen));

clearHistoryBtn.addEventListener("click", async () => {
  await window.translator.clearHistory();
  refreshHistory();
});

function stopHotkeyCapture() {
  if (!capturingHotkey) return;
  capturingHotkey = false;
  hotkeyField.classList.remove("capturing");
  hotkeyField.textContent = currentHotkey;
}

async function commitHotkey(combo) {
  stopHotkeyCapture();
  const res = await window.translator.setHotkey(combo);
  if (res && res.ok) {
    currentHotkey = res.hotkey;
    hotkeyField.textContent = res.hotkey;
    setHintHotkey(res.hotkey);
    hotkeyErr.classList.remove("show");
  } else {
    hotkeyField.textContent = currentHotkey;
    hotkeyErr.textContent = (res && res.error) || `Could not register ${combo}`;
    hotkeyErr.classList.add("show");
  }
}

hotkeyField.addEventListener("click", () => {
  if (capturingHotkey) return;
  capturingHotkey = true;
  hotkeyErr.classList.remove("show");
  hotkeyField.textContent = "Press keys...";
  hotkeyField.classList.add("capturing");
});

hotkeyField.addEventListener("blur", stopHotkeyCapture);

function keyNameForCapture(e) {
  const code = e.code || "";
  const codeMatch = /^Digit([0-9])$/.exec(code) || /^Key([A-Z])$/.exec(code);
  if (codeMatch) return codeMatch[1];
  const codeMap = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
  };
  if (codeMap[code]) return codeMap[code];
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  if (e.key && e.key.length === 1) {
    let k = e.key;
    if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
    if (k === " ") k = "Space";
    return k;
  }
  return null;
}

(function init() {
  setMode("translate");
  autoGrow();
  input.focus();
  Promise.all([window.translator.getSettings(), window.translator.getQuota()]).then(
    ([s, q]) => {
      if (s) applySettings(s);
      if (q && q.daily) updateQuotaTag(q.daily);
      refreshHistory();
    },
  );
})();

optAlwaysOnTop.addEventListener("change", () => {
  window.translator.setSettings({ alwaysOnTop: optAlwaysOnTop.checked });
});

optRunAtStartup.addEventListener("change", () => {
  window.translator.setSettings({ runAtStartup: optRunAtStartup.checked });
});

optAutoTranslate.addEventListener("change", () => {
  autoTranslate = optAutoTranslate.checked;
  if (!autoTranslate && mode !== "rephrase") clearTimeout(autoTimer);
  window.translator.setSettings({ autoTranslate });
});

optAutoTranslateRephrase.addEventListener("change", () => {
  autoTranslateRephrase = optAutoTranslateRephrase.checked;
  if (!autoTranslateRephrase && mode === "rephrase") clearTimeout(autoTimer);
  window.translator.setSettings({ autoTranslateRephrase });
});

optAutoCopy.addEventListener("change", () => {
  autoCopy = optAutoCopy.checked;
  window.translator.setSettings({ autoCopy });
});

optExternalHotkey.addEventListener("change", async () => {
  const on = optExternalHotkey.checked;
  const res = await window.translator.setExternal(on);
  if (res && res.ok) {
    externalHotkey = on;
    hotkeyErr.classList.remove("show");
  } else {
    optExternalHotkey.checked = externalHotkey;
    hotkeyErr.textContent = (res && res.error) || "Could not start the external hotkey";
    hotkeyErr.classList.add("show");
  }
});

window.translator.onOpenOptions(() => {
  setOptionsOpen(true);
});

document.addEventListener("keydown", (e) => {
  if (capturingHotkey) {
    e.preventDefault();
    if (e.key === "Escape") {
      stopHotkeyCapture();
      return;
    }
    if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
      return;
    }
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    if (mods.length === 0) return;
    const key = keyNameForCapture(e);
    if (!key) return;
    commitHotkey([...mods, key].join("+"));
    return;
  }
  if (e.key === "Escape") window.translator.hideWindow();
});

window.translator.onFocusInput(() => {
  input.focus();
  input.select();
  autoGrow();
});

window.translator.onHotkeyUpdated((combo) => {
  currentHotkey = combo;
  hotkeyField.textContent = combo;
  setHintHotkey(combo);
});

bannerClose.addEventListener("click", hideQuotaBanner);