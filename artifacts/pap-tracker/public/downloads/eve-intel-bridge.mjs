#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const POLL_MS = 1_000;
const HEARTBEAT_MS = 30_000;
const CONFIG_REFRESH_MS = 60_000;
const MAX_OUTBOX_EVENTS = 5_000;
const configDirectory = path.join(os.homedir(), ".eve-intel-bridge");
const configPath = path.join(configDirectory, "config.json");
const outboxPath = path.join(configDirectory, "outbox.json");
const startedAt = Date.now();
const files = new Map();
let remoteConfig = null;
let lastHeartbeatAt = 0;
let lastConfigAt = 0;
let stopped = false;
let pendingEvents = [];

function help() {
  console.log(`EVE Intel Bridge ${VERSION}

Usage:
  node eve-intel-bridge.mjs
  node eve-intel-bridge.mjs --reset

The bridge reads only the EVE chat-log files for channels allowed by your
corporation manager. Only lines containing a monitored solar-system name are
sent to the website. It never controls or modifies the EVE client.`);
}

function cleanServerUrl(value) {
  const url = new URL(value.trim());
  const localHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("生产网站必须使用HTTPS地址");
  }
  return url.origin;
}

function defaultChatLogDirectory() {
  const candidates = process.platform === "win32"
    ? [path.join(os.homedir(), "Documents", "EVE", "logs", "Chatlogs"), path.join(os.homedir(), "OneDrive", "Documents", "EVE", "logs", "Chatlogs")]
    : [path.join(os.homedir(), "Documents", "EVE", "logs", "Chatlogs")];
  return candidates[0];
}

async function promptForConfig() {
  const prompt = createInterface({ input, output });
  try {
    console.log("\nEVE预警桥接器首次配对\n");
    const serverUrl = cleanServerUrl(await prompt.question("军团网站地址（例如 https://example.com）："));
    const code = (await prompt.question("网站生成的一次性配对码：")).trim();
    const proposedName = `${os.hostname()}-intel`;
    const name = (await prompt.question(`设备名称（默认 ${proposedName}）：`)).trim() || proposedName;
    const proposedDirectory = defaultChatLogDirectory();
    const chatLogDirectory = (await prompt.question(`EVE聊天日志目录（默认 ${proposedDirectory}）：`)).trim() || proposedDirectory;
    const channelInput = (await prompt.question("预警频道名称（多个频道使用英文逗号分隔，也可稍后在网站设置）：")).trim();
    const channelNames = channelInput.split(",").map((value) => value.trim()).filter(Boolean);
    const response = await fetch(`${serverUrl}/api/system-monitoring/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `EVE-Intel-Bridge/${VERSION}` },
      body: JSON.stringify({ code, name, platform: `${process.platform}/${process.arch}`, channelNames }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.token !== "string") {
      throw new Error(result.error || `配对失败（HTTP ${response.status}）`);
    }
    return {
      serverUrl,
      token: result.token,
      bridgeId: result.bridgeId,
      corporationId: result.corporationId,
      chatLogDirectory: path.resolve(chatLogDirectory),
      pairedAt: new Date().toISOString(),
    };
  } finally {
    prompt.close();
  }
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!parsed.serverUrl || !parsed.token || !parsed.chatLogDirectory) throw new Error("配置不完整");
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`现有配置无法使用：${error.message}`);
    const config = await promptForConfig();
    await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return config;
  }
}

async function api(config, endpoint, init = {}) {
  const response = await fetch(`${config.serverUrl}/api/system-monitoring/bridge${endpoint}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": `EVE-Intel-Bridge/${VERSION}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function loadOutbox() {
  try {
    const parsed = JSON.parse(await fs.readFile(outboxPath, "utf8"));
    pendingEvents = Array.isArray(parsed) ? parsed.slice(-MAX_OUTBOX_EVENTS) : [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`未能读取待发送队列，将从空队列继续：${error.message}`);
    pendingEvents = [];
  }
}

async function persistOutbox() {
  await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${outboxPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(pendingEvents)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, outboxPath);
}

async function flushOutbox(config) {
  while (pendingEvents.length > 0) {
    const batch = pendingEvents.slice(0, 100);
    const result = await api(config, "/events", {
      method: "POST",
      body: JSON.stringify({ events: batch }),
    });
    pendingEvents.splice(0, batch.length);
    await persistOutbox();
    console.log(`[${new Date().toLocaleTimeString()}] 已上传 ${result.accepted} 条，重复 ${result.duplicates} 条，忽略 ${result.ignored} 条；待发送 ${pendingEvents.length} 条`);
  }
}

function decode(buffer, encoding) {
  if (encoding === "utf16le") return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

async function detectFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const headerLength = Math.min(stat.size, 16_384);
    const buffer = Buffer.alloc(headerLength);
    await handle.read(buffer, 0, headerLength, 0);
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
    const header = decode(buffer, encoding);
    const channelName = header.match(/(?:Channel Name|频道名称)\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
    return { offset: stat.size, encoding, channelName, remainder: "", initializedAt: Date.now() };
  } finally {
    await handle.close();
  }
}

function containsSystem(message, systemName) {
  const escaped = systemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9-])${escaped}($|[^A-Z0-9-])`, "i").test(message);
}

function parseChatLine(line) {
  const match = line.match(/^\[\s*(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\]\s+([^>]+?)\s*>\s*(.+)$/);
  if (!match) return null;
  const occurredAt = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { occurredAt, reporterCharacterName: match[7].trim(), message: match[8].trim() };
}

async function scanFile(config, filePath, state) {
  const stat = await fs.stat(filePath);
  if (stat.size < state.offset) {
    const replacement = await detectFile(filePath);
    files.set(filePath, replacement);
    return [];
  }
  if (stat.size === state.offset) return [];
  const length = stat.size - state.offset;
  const handle = await fs.open(filePath, "r");
  let buffer;
  try {
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);
  } finally {
    await handle.close();
  }
  state.offset = stat.size;
  const text = state.remainder + decode(buffer, state.encoding);
  const lines = text.split(/\r?\n/);
  state.remainder = lines.pop() || "";
  if (!state.channelName) {
    const channel = text.match(/(?:Channel Name|频道名称)\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (channel) state.channelName = channel;
  }
  const channels = new Set((remoteConfig?.channelNames || []).map((value) => value.toLocaleLowerCase()));
  if (!state.channelName || channels.size === 0 || !channels.has(state.channelName.toLocaleLowerCase())) return [];
  const systems = remoteConfig?.monitoredSystems || [];
  return lines.flatMap((line) => {
    const parsed = parseChatLine(line);
    if (!parsed || parsed.occurredAt.getTime() < startedAt - 10_000) return [];
    if (!systems.some((system) => containsSystem(parsed.message, system.solarSystemName))) return [];
    return [{
      channelName: state.channelName,
      reporterCharacterName: parsed.reporterCharacterName,
      message: parsed.message,
      occurredAt: parsed.occurredAt.toISOString(),
    }];
  });
}

async function scanDirectory(config) {
  const entries = await fs.readdir(config.chatLogDirectory, { withFileTypes: true });
  const logFiles = entries.filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".txt"));
  const events = [];
  for (const entry of logFiles) {
    const filePath = path.join(config.chatLogDirectory, entry.name);
    if (!files.has(filePath)) {
      const state = await detectFile(filePath);
      state.offset = 0;
      files.set(filePath, state);
      continue;
    }
    events.push(...await scanFile(config, filePath, files.get(filePath)));
  }
  if (events.length > 0) {
    pendingEvents.push(...events);
    if (pendingEvents.length > MAX_OUTBOX_EVENTS) {
      const dropped = pendingEvents.length - MAX_OUTBOX_EVENTS;
      pendingEvents = pendingEvents.slice(-MAX_OUTBOX_EVENTS);
      console.warn(`待发送队列超过上限，已丢弃最旧的 ${dropped} 条情报。`);
    }
    await persistOutbox();
  }
  await flushOutbox(config);
}

async function refreshRemoteConfig(config) {
  remoteConfig = await api(config, "/config");
  lastConfigAt = Date.now();
}

async function heartbeat(config, lastError = null) {
  await api(config, "/heartbeat", { method: "POST", body: JSON.stringify({ lastError }) });
  lastHeartbeatAt = Date.now();
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }
  if (process.argv.includes("--reset")) {
    await fs.rm(configPath, { force: true });
    await fs.rm(outboxPath, { force: true });
    console.log("桥接器配对配置和待发送队列已删除。重新运行即可再次配对。");
    return;
  }
  const config = await loadConfig();
  await loadOutbox();
  const directory = await fs.stat(config.chatLogDirectory).catch(() => null);
  if (!directory?.isDirectory()) throw new Error(`找不到聊天日志目录：${config.chatLogDirectory}`);
  await refreshRemoteConfig(config);
  await heartbeat(config);
  console.log(`\n桥接器已连接：${remoteConfig.corporationName}`);
  console.log(`监控星系：${remoteConfig.monitoredSystems.map((item) => item.solarSystemName).join(", ") || "尚未设置"}`);
  console.log(`允许频道：${remoteConfig.channelNames.join(", ") || "尚未设置（不会上传任何消息）"}`);
  console.log("按 Ctrl+C 停止。\n");

  const initialEntries = await fs.readdir(config.chatLogDirectory, { withFileTypes: true });
  for (const entry of initialEntries) {
    if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".txt")) {
      const filePath = path.join(config.chatLogDirectory, entry.name);
      files.set(filePath, await detectFile(filePath));
    }
  }

  while (!stopped) {
    let lastError = null;
    try {
      if (Date.now() - lastConfigAt >= CONFIG_REFRESH_MS) await refreshRemoteConfig(config);
      await scanDirectory(config);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toLocaleTimeString()}] ${lastError}`);
    }
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      try { await heartbeat(config, lastError); } catch (error) { console.error(`心跳失败：${error.message}`); }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

main().catch((error) => {
  console.error(`桥接器启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
