const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, Notification } = require("electron");
const { randomUUID } = require("crypto");
const { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync, unlinkSync } = require("fs");
const { spawn, execFileSync } = require("child_process");
const { join } = require("path");

const HOTKEY = process.env.TDN_HOTKEY || "Ctrl+Alt+T";
const AR_LANGS = { en: "English", ar: "Arabic" };
const ZEN_URL = "https://opencode.ai/zen/v1/chat/completions";
const MODEL = "big-pickle";
const UA_VERSION = process.env.TDN_UA_VERSION || "1.18.30";
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 460;
const MAX_WINDOW_WIDTH = 960;
const MAX_WINDOW_HEIGHT = 1200;
const UNLIMITED_SIZE = 10000;
const MAX_TOKENS = 1024;
const HISTORY_LIMIT = 50;

let win = null;
let tray = null;
let sessionId = null;
let hotkeyRegistered = null;
let settings = {};
let history = [];
let daily = { date: "", requests: 0, tokens: 0 };
let lastRate = null;
let rendererLoaded = false;
let pendingOpenTrayOptions = false;
let pendingFocusInput = false;

function settingsFile() {
  return join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    if (existsSync(settingsFile())) {
      return JSON.parse(readFileSync(settingsFile(), "utf8"));
    }
  } catch {}
  return {};
}

function saveSettings() {
  try {
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  } catch {}
}

function historyFile() {
  return join(app.getPath("userData"), "history.json");
}

function normalizeLang(l) {
  if (l === "en" || l === "English") return "en";
  if (l === "ar" || l === "Arabic") return "ar";
  return l;
}

function loadHistory() {
  try {
    if (existsSync(historyFile())) {
      const arr = JSON.parse(readFileSync(historyFile(), "utf8"));
      if (Array.isArray(arr)) {
        return arr
          .map((e) =>
            e && typeof e === "object"
              ? { ...e, source: normalizeLang(e.source), target: normalizeLang(e.target) }
              : e,
          )
          .filter(
            (e) =>
              e &&
              (e.source === "en" || e.source === "ar") &&
              ((e.mode === "rephrase" &&
                (e.target === "auto" || e.target === "en" || e.target === "ar")) ||
                (e.mode !== "rephrase" && (e.target === "en" || e.target === "ar"))),
          );
      }
    }
  } catch {}
  return [];
}

function saveHistory() {
  try {
    writeFileSync(historyFile(), JSON.stringify(history, null, 2), "utf8");
  } catch {}
}

function addHistoryEntry(entry) {
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  saveHistory();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bumpDaily(tokens) {
  const t = todayStr();
  if (daily.date !== t) {
    daily = { date: t, requests: 0, tokens: 0 };
  }
  daily.requests += 1;
  daily.tokens += tokens || 0;
  settings.daily = daily;
  saveSettings();
  return daily;
}

function parseRateHeaders(headers) {
  const get = (...names) => {
    for (const n of names) {
      const v = headers.get(n);
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return null;
  };
  return {
    remaining: get("ratelimit-remaining", "x-ratelimit-remaining"),
    limit: get("ratelimit-limit", "x-ratelimit-limit"),
    reset: get("ratelimit-reset", "x-ratelimit-reset"),
    retryAfter: get("retry-after"),
  };
}

function summarizeRate(rate) {
  if (!rate) return null;
  const parts = [];
  if (rate.remaining !== null) parts.push(`remaining:${rate.remaining}`);
  if (rate.limit !== null) parts.push(`limit:${rate.limit}`);
  if (rate.reset !== null) parts.push(`reset:${rate.reset}`);
  if (rate.retryAfter !== null) parts.push(`retryAfter:${rate.retryAfter}`);
  if (parts.length === 0) return null;
  return parts.join(" ");
}

const MAX_APP_LOG = 512 * 1024;

function log(msg) {
  try {
    const file = join(app.getPath("userData"), "app.log");
    if (existsSync(file) && statSync(file).size > MAX_APP_LOG) {
      renameSync(file, join(app.getPath("userData"), "app.log.old"));
    }
  } catch {}
  try {
    appendFileSync(join(app.getPath("userData"), "app.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function getSessionId() {
  const file = join(app.getPath("userData"), "session-id.txt");
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf8").trim();
      if (saved) return saved;
    }
  } catch {}
  const id = randomUUID();
  try {
    writeFileSync(file, id, "utf8");
  } catch {}
  return id;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callZen(text, { mode, source, target, sourceName, targetName }) {
  let system;
  if (mode === "rephrase") {
    system =
      "You are a professional writing assistant. Rewrite the user's text using natural, clear, and well-written wording while keeping the original meaning. Keep the same intent and context. Improve grammar, vocabulary, and readability. Do not add unnecessary information. " +
      (target && target !== "auto"
        ? `Write the rephrased text in ${targetName}.`
        : "Keep the rephrased text in the same language as the input.") +
      " Return ONLY the rephrased text with no explanations, quotes, or extra words.";
  } else {
    system = `You are a professional translator between English and Arabic. Translate the user's text from ${sourceName} to ${targetName}. Return ONLY the translated text with no explanations, quotes, or extra words.`;
  }
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    temperature: 0.3,
    max_tokens: MAX_TOKENS,
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(ZEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `opencode/${UA_VERSION}`,
          "x-opencode-session": sessionId,
          ...(process.env.TDN_ZEN_KEY
            ? { Authorization: `Bearer ${process.env.TDN_ZEN_KEY}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      const rate = parseRateHeaders(resp.headers);
      if (rate) lastRate = rate;

      if (!resp.ok) {
        const rawErr = (data && data.error) || {};
        const msg = rawErr.message || `HTTP ${resp.status}`;
        const errSig = `${msg} ${rawErr.type || ""} ${rawErr.code || ""}`;
        const isFreeLimit =
          resp.status === 429 &&
          (/free/i.test(errSig) || errSig.includes("FreeUsageLimitError"));
        if (isFreeLimit) {
          const d = bumpDaily(0);
          log(`free-tier limit reached: ${msg} (${summarizeRate(rate) || "no rate headers"})`);
          return { ok: false, error: msg, code: "free-limit", rate, daily: d };
        }
        if ((resp.status === 429 || resp.status >= 500) && attempt === 0) {
          lastErr = {
            ok: false,
            error: msg,
            code: resp.status === 429 ? "rate-limit" : "server",
            rate,
          };
          log(`retrying after ${resp.status}: ${msg}`);
          await delay(1500);
          continue;
        }
        const d = bumpDaily(0);
        return {
          ok: false,
          error: msg,
          code: resp.status === 429 ? "rate-limit" : "error",
          rate,
          daily: d,
        };
      }

      const content =
        data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : "";
      const usage =
        data && data.usage && typeof data.usage.total_tokens === "number"
          ? data.usage
          : null;
      const translation = String(content).trim();
      const dailyNow = bumpDaily(usage ? usage.total_tokens : 0);
      if (translation) {
        addHistoryEntry({
          id: randomUUID(),
          mode,
          source,
          target,
          input: text,
          output: translation,
          ts: Date.now(),
        });
      }
      log(
        `${mode === "rephrase" ? "rephrase" : "translate"} ok: ${text.length} chars, tokens=${usage ? usage.total_tokens : "?"}, daily=${dailyNow.requests}`,
      );
      return {
        ok: true,
        translation,
        usage: usage
          ? {
              prompt: usage.prompt_tokens,
              completion: usage.completion_tokens,
              total: usage.total_tokens,
            }
          : null,
        daily: dailyNow,
        rate,
      };
    } catch (err) {
      if (attempt === 0) {
        await delay(1500);
        continue;
      }
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
  return lastErr || { ok: false, error: "Translation failed" };
}

function positionWindow() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  const b = win.getBounds();
  const w = Math.min(b.width, wa.width);
  const h = Math.min(b.height, wa.height);
  win.setBounds({
    x: Math.round(Math.min(Math.max(wa.x + (wa.width - w) / 2, wa.x), wa.x + wa.width - w)),
    y: Math.min(Math.max(wa.y + 32, wa.y), wa.y + wa.height - h),
    width: w,
    height: h,
  });
}

function openWindow() {
  if (!win) return;
  positionWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
  if (rendererLoaded) win.webContents.send("focus-input");
  else pendingFocusInput = true;
  setTimeout(() => {
    if (win && win.isVisible() && !win.isFocused()) {
      win.focus();
    }
  }, 300);
  log("show window");
}

function showWindow() {
  if (win && win.isVisible()) {
    win.hide();
    return;
  }
  openWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: MAX_WINDOW_WIDTH,
    maxHeight: MAX_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, "renderer", "index.html"));
  win.webContents.on("did-finish-load", () => {
    rendererLoaded = true;
    broadcastHotkey();
    if (pendingFocusInput) {
      pendingFocusInput = false;
      win.webContents.send("focus-input");
    }
    if (pendingOpenTrayOptions) {
      pendingOpenTrayOptions = false;
      win.webContents.send("options");
    }
  });
  log("window created");

  win.on("show", () => log("window shown"));
  win.on("hide", () => log("window hidden"));
  win.on("focus", () => log("window focused"));
  win.on("blur", () => log("window blurred"));
  win.on("minimize", () => log("window minimized"));

  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function broadcastHotkey() {
  if (win) {
    win.webContents.send("hotkey-updated", hotkeyRegistered || settings.hotkey || HOTKEY);
  }
}

function currentHotkeyLabel() {
  return hotkeyRegistered || settings.hotkey || HOTKEY;
}

function findAhk() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    join(pf, "AutoHotkey", "v2", "AutoHotkey64.exe"),
    join(pf, "AutoHotkey", "AutoHotkey64.exe"),
    join(pf86, "AutoHotkey", "v2", "AutoHotkey64.exe"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function ahkScriptFile() {
  return join(__dirname, "hotkey-launcher.ahk");
}

function launcherPidFile() {
  return join(app.getPath("userData"), "launcher.pid");
}

function toAhkHotkey(combo) {
  const parts = String(combo || "").split("+");
  const key = parts.pop();
  if (!key) return null;
  let prefix = "";
  for (const m of parts) {
    if (/^ctrl$/i.test(m)) prefix += "^";
    else if (/^alt$/i.test(m)) prefix += "!";
    else if (/^shift$/i.test(m)) prefix += "+";
    else if (/^(super|cmd|meta|win)$/i.test(m)) prefix += "#";
    else return null;
  }
  if (!prefix) return null;
  let expr;
  if (/^[A-Za-z]$/.test(key)) expr = `"${prefix}${key.toLowerCase()}"`;
  else if (/^[0-9]$/.test(key)) expr = `"${prefix}${key}"`;
  else if (/^F\d{1,2}$/i.test(key)) expr = `"${prefix}${key.toUpperCase()}"`;
  else if (/^space$/i.test(key)) expr = `"${prefix}Space"`;
  else if (key === "`") expr = `"${prefix}" . Chr(96)`;
  else if (/^[-=[\]\\;',./]$/.test(key)) expr = `"${prefix}${key}"`;
  else return null;
  return expr;
}

function buildAhkScript(ahkExpr, combo) {
  const runLine = `"${process.execPath}" "${app.getAppPath()}" --hotkey`;
  return (
    "#Requires AutoHotkey v2.0\n" +
    "#SingleInstance Force\n" +
    "; Generated by TheDarkNeptune Translator - do not edit by hand.\n" +
    `; Holds ${combo} and opens the translator, even when it is closed.\n` +
    `Hotkey(${ahkExpr}, (*) => Run('${runLine}'))\n`
  );
}

function launcherPid() {
  try {
    const p = parseInt(readFileSync(launcherPidFile(), "utf8").trim(), 10);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

function launcherProcessName(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const m = /^"([^"]+)"/.exec(String(out).trim());
    return m ? m[1].toLowerCase() : null;
  } catch {
    return undefined;
  }
}

function isLauncherAlive() {
  const pid = launcherPid();
  if (!pid) return false;
  const name = launcherProcessName(pid);
  return typeof name === "string" && name.includes("autohotkey");
}

function stopExternalHotkey() {
  const pid = launcherPid();
  if (!pid) return;
  const name = launcherProcessName(pid);
  if (name === undefined) {
    log(`external hotkey launcher state unknown (pid ${pid}), keeping pid file for retry`);
    return;
  }
  try {
    unlinkSync(launcherPidFile());
  } catch {}
  if (!name) {
    log(`external hotkey launcher already gone (pid ${pid})`);
    return;
  }
  if (!name.includes("autohotkey")) {
    log(`launcher pid ${pid} now belongs to ${name}, not killing`);
    return;
  }
  try {
    process.kill(pid);
    log(`external hotkey launcher stopped (pid ${pid})`);
  } catch (err) {
    log(`could not stop external hotkey launcher: ${err && err.message ? err.message : err}`);
  }
}

function ensureExternalHotkey() {
  try {
    const ahk = findAhk();
    if (!ahk) {
      return { ok: false, error: "AutoHotkey v2 not found. Install it, then try again." };
    }
    const combo = settings.hotkey || HOTKEY;
    const expr = toAhkHotkey(combo);
    if (!expr) {
      return { ok: false, error: `${combo} cannot be held by the external launcher` };
    }
    const content = buildAhkScript(expr, combo);
    let current = null;
    try {
      current = readFileSync(ahkScriptFile(), "utf8");
    } catch {}
    if (current === content && isLauncherAlive()) return { ok: true, kept: true };
    stopExternalHotkey();
    writeFileSync(ahkScriptFile(), content, "utf8");
    const child = spawn(ahk, [ahkScriptFile()], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(launcherPidFile(), String(child.pid), "utf8");
    log(`external hotkey launcher started (pid ${child.pid}, ${combo})`);
    return { ok: true };
  } catch (err) {
    log(`external hotkey launcher failed: ${err && err.message ? err.message : err}`);
    return { ok: false, error: "Could not start the external hotkey launcher" };
  }
}

function setExternalHotkey(on) {
  settings.externalHotkey = !!on;
  saveSettings();
  if (settings.externalHotkey) {
    if (hotkeyRegistered) {
      globalShortcut.unregister(hotkeyRegistered);
      hotkeyRegistered = null;
    }
    const r = ensureExternalHotkey();
    if (tray) tray.setToolTip(`TheDarkNeptune Translator (${currentHotkeyLabel()})`);
    broadcastHotkey();
    log(`external hotkey ${r.ok ? "enabled" : `failed: ${r.error}`}`);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  stopExternalHotkey();
  registerHotkey();
  log("external hotkey disabled, using internal hotkey");
  return { ok: true };
}

function tryRegisterHotkey(combo) {
  try {
    return globalShortcut.register(combo, showWindow);
  } catch {
    return false;
  }
}

function applyHotkey(combo) {
  const previous = hotkeyRegistered || settings.hotkey || HOTKEY;
  if (combo === previous && (!settings.externalHotkey || isLauncherAlive())) {
    return { ok: true, hotkey: previous };
  }
  globalShortcut.unregister(previous);
  if (settings.externalHotkey) {
    settings.hotkey = combo;
    saveSettings();
    const r = ensureExternalHotkey();
    log(`hotkey changed to ${combo} (${r.ok ? "external launcher" : `launcher failed: ${r.error}`})`);
    if (r.ok) {
      if (tray) tray.setToolTip(`TheDarkNeptune Translator (${currentHotkeyLabel()})`);
      broadcastHotkey();
      return { ok: true, hotkey: combo };
    }
  }
  const ok = tryRegisterHotkey(combo);
  if (!ok) {
    const fallbacks = [previous, HOTKEY, "CommandOrControl+Shift+T"];
    let rescued = null;
    for (const fb of fallbacks) {
      if (tryRegisterHotkey(fb)) {
        rescued = fb;
        break;
      }
    }
    hotkeyRegistered = rescued;
    if (rescued) settings.hotkey = rescued;
    saveSettings();
    if (tray) {
      tray.setToolTip(
        rescued
          ? `TheDarkNeptune Translator (${rescued})`
          : "TheDarkNeptune Translator (no hotkey registered)",
      );
    }
    broadcastHotkey();
    log(`hotkey ${combo} rejected (conflict), fell back to ${rescued || "none"}`);
    return { ok: false, error: `${combo} is already in use by another program` };
  }
  hotkeyRegistered = combo;
  settings.hotkey = combo;
  saveSettings();
  if (tray) tray.setToolTip(`TheDarkNeptune Translator (${combo})`);
  broadcastHotkey();
  log(`hotkey changed to ${combo}`);
  return { ok: true, hotkey: combo };
}

function registerHotkey() {
  if (settings.externalHotkey) {
    const r = ensureExternalHotkey();
    if (r.ok) {
      log(`external hotkey launcher holding ${settings.hotkey || HOTKEY}`);
      broadcastHotkey();
      return;
    }
    log(`external launcher failed (${r.error}), using internal hotkey`);
  } else {
    stopExternalHotkey();
  }
  const candidates = [settings.hotkey || HOTKEY, HOTKEY, "CommandOrControl+Shift+T"];
  for (const key of candidates) {
    const ok = tryRegisterHotkey(key);
    log(`hotkey ${key} register=${ok}`);
    if (ok) {
      hotkeyRegistered = key;
      if (key !== (settings.hotkey || HOTKEY)) log(`primary hotkey unavailable, using ${key}`);
      if (tray) tray.setToolTip(`TheDarkNeptune Translator (${key})`);
      broadcastHotkey();
      return;
    }
  }
  hotkeyRegistered = null;
  if (tray) tray.setToolTip("TheDarkNeptune Translator (no hotkey registered)");
  log(`no hotkey registered, tried: ${candidates.join(", ")}`);
}

function createTray() {
  const iconPath = join(__dirname, "assets", "tray.png");
  let image;
  if (existsSync(iconPath)) {
    image = nativeImage.createFromPath(iconPath);
  } else {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip(`TheDarkNeptune Translator (${currentHotkeyLabel()})`);

  const menu = Menu.buildFromTemplate([
    { label: "Show translator", click: openWindow },
    {
      label: "Options...",
      click: () => {
        openWindow();
        if (rendererLoaded) win.webContents.send("options");
        else pendingOpenTrayOptions = true;
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.on("double-click", openWindow);
  tray.on("right-click", () => tray.popUpContextMenu(menu));
}

ipcMain.handle("translate", async (_event, payload) => {
  const { text, mode, source, target } = payload || {};
  if (!text || !String(text).trim()) return { ok: false, error: "No text to translate" };
  const m = mode === "rephrase" ? "rephrase" : "translate";
  const src = source === "ar" ? "ar" : "en";
  const tgt =
    m === "rephrase"
      ? target === "en" || target === "ar"
        ? target
        : "auto"
      : target === "ar"
        ? "ar"
        : "en";
  const sourceName = AR_LANGS[src];
  const targetName = tgt === "auto" ? "" : AR_LANGS[tgt];
  return callZen(String(text).trim(), {
    mode: m,
    source: src,
    target: tgt,
    sourceName,
    targetName,
  });
});

ipcMain.handle("history:get", () => history);

ipcMain.handle("history:clear", () => {
  history = [];
  saveHistory();
  return history;
});

ipcMain.handle("quota:get", () => ({ daily, rateLimit: lastRate }));

ipcMain.handle("hotkey:set", (_event, combo) => {
  if (typeof combo !== "string" || !combo.trim()) {
    return { ok: false, error: "No shortcut provided" };
  }
  return applyHotkey(combo.trim());
});

ipcMain.handle("external:set", (_event, on) => setExternalHotkey(!!on));

ipcMain.handle("settings:get", () => settings);

ipcMain.handle("settings:set", (_event, patch) => {
  if (!patch || typeof patch !== "object") return settings;
  const merged = {};
  if (typeof patch.alwaysOnTop === "boolean") {
    merged.alwaysOnTop = patch.alwaysOnTop;
    if (win) win.setAlwaysOnTop(patch.alwaysOnTop);
  }
  if (typeof patch.autoTranslate === "boolean") {
    merged.autoTranslate = patch.autoTranslate;
  }
  if (typeof patch.autoTranslateRephrase === "boolean") {
    merged.autoTranslateRephrase = patch.autoTranslateRephrase;
  }
  if (typeof patch.autoCopy === "boolean") {
    merged.autoCopy = patch.autoCopy;
  }
  if (typeof patch.runAtStartup === "boolean") {
    merged.runAtStartup = patch.runAtStartup;
    app.setLoginItemSettings({
      openAtLogin: patch.runAtStartup,
      path: process.execPath,
      args: [app.getAppPath()],
    });
  }
  settings = { ...settings, ...merged };
  saveSettings();
  log(`settings updated: ${JSON.stringify(merged)}`);
  return settings;
});

ipcMain.on("hide-window", () => {
  if (win) win.hide();
});

ipcMain.on("minimize-window", () => {
  if (win) win.minimize();
});

ipcMain.on("drag-move", (_event, dx, dy) => {
  if (!win || win.isMaximized()) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.on("toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
    win.setMaximumSize(MAX_WINDOW_WIDTH, MAX_WINDOW_HEIGHT);
  } else {
    win.setMaximumSize(UNLIMITED_SIZE, UNLIMITED_SIZE);
    win.maximize();
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log("second instance, quitting");
  app.quit();
} else {
  log("single instance lock acquired");
  app.on("second-instance", (_event, commandLine) => {
    const viaHotkey =
      Array.isArray(commandLine) && commandLine.some((a) => a === "--hotkey");
    log(`second-instance event${viaHotkey ? " (hotkey)" : ""}, showing window`);
    if (viaHotkey) showWindow();
    else openWindow();
  });

  app.whenReady().then(() => {
    sessionId = getSessionId();
    app.setAppUserModelId("com.thedarkneptune.translator");
    settings = loadSettings();
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
    if (typeof settings.alwaysOnTop !== "boolean") settings.alwaysOnTop = false;
    if (typeof settings.autoTranslate !== "boolean") settings.autoTranslate = true;
    if (typeof settings.autoTranslateRephrase !== "boolean") {
      settings.autoTranslateRephrase = true;
    }
    if (typeof settings.autoCopy !== "boolean") settings.autoCopy = false;
    if (typeof settings.externalHotkey !== "boolean") settings.externalHotkey = false;
    if (typeof settings.hotkey !== "string" || !settings.hotkey) settings.hotkey = HOTKEY;
    history = loadHistory();
    if (
      settings.daily &&
      typeof settings.daily === "object" &&
      settings.daily.date === todayStr()
    ) {
      daily = {
        date: settings.daily.date,
        requests: typeof settings.daily.requests === "number" ? settings.daily.requests : 0,
        tokens: typeof settings.daily.tokens === "number" ? settings.daily.tokens : 0,
      };
    } else {
      daily = { date: todayStr(), requests: 0, tokens: 0 };
    }
    settings.daily = daily;
    if (typeof settings.runAtStartup !== "boolean") {
      settings.runAtStartup = app.getLoginItemSettings({
        path: process.execPath,
        args: [app.getAppPath()],
      }).openAtLogin;
    }
    app.setLoginItemSettings({
      openAtLogin: !!settings.runAtStartup,
      path: process.execPath,
      args: [app.getAppPath()],
    });
    saveSettings();
    log(`settings loaded: ${JSON.stringify(settings)}`);
    log(`app ready, running as ${app.getName()} v${app.getVersion()}`);
    createWindow();
    createTray();
    registerHotkey();
    log(
      `active hotkey: ${hotkeyRegistered || (settings.externalHotkey ? `${settings.hotkey || HOTKEY} (external launcher)` : "NONE")}`,
    );

    const launchedAtLogin =
      process.platform === "win32" &&
      app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] })
        .wasOpenedAtLogin;
    const launchedViaHotkey = process.argv.some((a) => a === "--hotkey");
    if (Notification.isSupported() && !launchedAtLogin && !launchedViaHotkey) {
      new Notification({
        title: "TheDarkNeptune Translator",
        body: hotkeyRegistered
          ? `Running in the background. Press ${hotkeyRegistered} to open the translator.`
          : "Running in the background, but no global hotkey could be registered. Open it from the tray icon.",
      }).show();
    }

    if (!launchedAtLogin) openWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else openWindow();
    });
  });

  app.on("will-quit", () => {
    log("quitting");
    globalShortcut.unregisterAll();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.isQuitting = true;
  });
}