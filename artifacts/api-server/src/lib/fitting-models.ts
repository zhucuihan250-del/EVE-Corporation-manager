import { createHash } from "node:crypto";
import modelData from "../data/eve-fitting-models.json";

type ModelRecord = { graphicId: number; categoryId: number; groupId: number; dna: string | null; resourcePath: string | null };
const records = modelData.types as Record<string, ModelRecord>;
type ResourceSource = { build: string | number; Resolve(path: string): { record: { checksum?: string; uncompressedSize?: number }; sourceUrl: string }; Fetch(path: string): Promise<{ bytes: ArrayBuffer; resolution: { record: { checksum?: string; uncompressedSize?: number } } }> };
const MAX_RESOURCE = 32 * 1024 * 1024;
const MAX_CACHE = 32 * 1024 * 1024;
const cache = new Map<string, { bytes: Buffer; etag: string }>();
let cacheBytes = 0, active = 0;
const waiting: Array<{ resume: () => void; timer: NodeJS.Timeout }> = [];
const inflight = new Map<string, Promise<{ bytes: Buffer; etag: string }>>();
let sourcePromise: Promise<ResourceSource> | null = null;
let retryAfter = 0;

export class FittingModelError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Only game renderer assets, never arbitrary URLs or client/account files. */
export function validateFittingResourcePath(value: string): string {
  if (value.length > 320 || !/^(?:dx9|dx11|graphics|fisfx|effect\.dx11|effect\.gles2|effect\.webgl2|texture|textures)\/[a-z0-9_/.\-]+\.(?:black|gr2|cmf|dds|png|sm_hi|sm_lo|sm_depth|sm_json)$/i.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new FittingModelError(400, "FITTING_MODEL_INVALID_PATH", "模型资源路径无效。");
  }
  return `res:/${value.toLowerCase()}`;
}

export function getFittingModel(typeId: number, subsystems: number[] = []) {
  const base = records[typeId];
  if (!base || ![6, 65].includes(base.categoryId)) throw new FittingModelError(404, "FITTING_MODEL_NOT_FOUND", "该舰船暂没有可用的 3D 模型。");
  let dna = base.dna;
  if (base.groupId === 963 && dna && subsystems.length) {
    const parts = dna.split(":"), hulls = [parts[0]];
    for (const id of subsystems) {
      const subsystem = records[id];
      if (subsystem?.categoryId !== 32 || !subsystem.dna) continue;
      // Four current strategic-cruiser subsystem variants share their hull prefix.
      const subHull = subsystem.dna.split(":")[0];
      if (subHull.startsWith(parts[0].slice(0, 4))) hulls.push(subHull);
    }
    if (hulls.length > 1) dna = `${hulls.join(";")}:${parts[1]}:${parts[2]}`;
  }
  return { typeId, graphicId: base.graphicId, dna, resourcePath: base.resourcePath, sdeBuildNumber: modelData.sdeBuildNumber };
}

async function source(): Promise<ResourceSource> {
  if (!sourcePromise) {
    if (Date.now() < retryAfter) throw new FittingModelError(503, "FITTING_MODEL_UPSTREAM_UNAVAILABLE", "EVE 模型资源暂不可用，请稍后重试。");
    sourcePromise = (async () => {
      // The index subpath does not load the optional SQLite tools. No game or
      // corporation credentials are sent; only public CCP client files are read.
      const packagePath = "@carbonenginejs/tools-core/index";
      const { CjsToolIndex } = await import(packagePath);
      const ccpFetch: typeof fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.protocol !== "https:" || !["binaries.eveonline.com", "resources.eveonline.com"].includes(url.hostname)
          || url.username || url.password || url.port) throw new Error("Untrusted model resource origin");
        return fetch(input, { ...init, redirect: "error" });
      };
      const indexes = new CjsToolIndex({ fetch: ccpFetch, cache: null, maxPayloadBytes: MAX_RESOURCE, maxIndexBytes: 64 * 1024 * 1024, requestTimeoutMs: 30_000 });
      return await indexes.OpenTarget("eve", "latest") as ResourceSource;
    })().catch(() => {
      sourcePromise = null; retryAfter = Date.now() + 30_000;
      throw new FittingModelError(503, "FITTING_MODEL_UPSTREAM_UNAVAILABLE", "EVE 模型资源暂不可用，请稍后重试。");
    });
  }
  return sourcePromise;
}

export async function getFittingModelSource() { return { clientBuild: Number((await source()).build) }; }

async function acquire() {
  if (active >= 4) {
    if (waiting.length >= 128) throw new FittingModelError(503, "FITTING_MODEL_BUSY", "3D 模型正在加载，请稍后重试。");
    await new Promise<void>((resolve, reject) => {
      const entry = { resume: resolve, timer: setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new FittingModelError(503, "FITTING_MODEL_BUSY", "3D 模型正在加载，请稍后重试。"));
      }, 15_000) };
      entry.timer.unref(); waiting.push(entry);
    });
  } else active++;
}
function release() { const next = waiting.shift(); if (next) { clearTimeout(next.timer); next.resume(); } else active--; }

export async function getFittingResource(build: number, path: string) {
  const logical = validateFittingResourcePath(path);
  const key = `${build}:${logical}`, cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  const existing = inflight.get(key);
  if (existing) return existing;
  if (inflight.size >= 132) throw new FittingModelError(503, "FITTING_MODEL_BUSY", "3D 模型正在加载，请稍后重试。");
  const promise = (async () => {
    await acquire();
    try {
      const src = await source();
      if (Number(src.build) !== build) throw new FittingModelError(409, "FITTING_MODEL_BUILD_CHANGED", "模型资源版本已更新，请重新加载预览。");
      const resolution = src.Resolve(logical);
      if (!resolution || !/^https:\/\/(?:resources|binaries)\.eveonline\.com\//.test(resolution.sourceUrl)) throw new FittingModelError(404, "FITTING_MODEL_RESOURCE_NOT_FOUND", "没有找到该模型资源。");
      if ((resolution.record.uncompressedSize ?? 0) > MAX_RESOURCE) throw new FittingModelError(413, "FITTING_MODEL_RESOURCE_TOO_LARGE", "模型资源超过加载上限。");
      const payload = await src.Fetch(logical), bytes = Buffer.from(payload.bytes);
      // The index facade verifies payload size and checksum; retain an
      // independent verification before serving the indexed payload to a browser.
      const checksum = resolution.record.checksum;
      if (bytes.length > MAX_RESOURCE || (resolution.record.uncompressedSize !== undefined && bytes.length !== resolution.record.uncompressedSize)
        || (checksum && createHash("md5").update(bytes).digest("hex") !== checksum.toLowerCase())) throw new FittingModelError(502, "FITTING_MODEL_RESOURCE_INVALID", "模型资源完整性检查失败。");
      const entry = { bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
      while (cacheBytes + bytes.length > MAX_CACHE && cache.size) { const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest); }
      cache.set(key, entry); cacheBytes += bytes.length;
      return entry;
    } catch (error) {
      if (error instanceof FittingModelError) throw error;
      throw new FittingModelError(502, "FITTING_MODEL_RESOURCE_UNAVAILABLE", "EVE 模型资源加载失败，请重试。");
    } finally { release(); }
  })();
  inflight.set(key, promise);
  try { return await promise; } finally { inflight.delete(key); }
}
