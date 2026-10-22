// Bounded random access to the one public release archive. No whole-archive arrayBuffer, opaque CORS response,
// credentials, arbitrary target URL, or successful status without a matching Content-Range is accepted.
import { githubDownloadUrl, githubRelayUrl, releaseMetadata, selectGithubRoutes } from './assetRelease.js';

export const ARCHIVE_BLOCK_BYTES = 512 * 1024;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const failure = (code) => Object.assign(new Error(code), { code });

function trustedFinalUrl(raw, requested, _line, relay) {
  if (!raw) return true; // injected test fetches; a browser Response always carries its final URL
  try {
    const url = new URL(raw, globalThis.location?.origin || 'http://localhost');
    if (relay) return url.href === new URL(requested, globalThis.location?.origin || 'http://localhost').href;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return false;
    if (url.href === requested) return true;
    return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
      && /^\/github-production-release-asset(?:-[^/]+)?\//.test(url.pathname);
  } catch { return false; }
}

/**
 * `type/size/read/part` is an explicit protocol consumed by assetPack.openZip. A small LRU coalesces adjacent entry
 * headers/bodies. Every request is <= 8 MiB; a 200 whole-file answer is cancelled before its body is read.
 */
export function createRemoteAssetArchive({ release, preference = 'auto', mirrorId = null,
  fetch: doFetch = (...args) => globalThis.fetch(...args), signal, onProgress,
  blockBytes = ARCHIVE_BLOCK_BYTES, cacheBlocks = 16, timeoutMs = 15000, relayTimeoutMs = 16 * 60 * 1000,
  retries = 1 } = {}) {
  const metadata = releaseMetadata(release);
  if (!metadata) throw failure('release');
  let currentSignal = signal, candidate = 0, receivedBytes = 0, epoch = 0, lastError = null;
  const blocks = new Map(), tags = new Map();
  const lines = preference === 'custom' ? ['custom'] : selectGithubRoutes({ preference, country: metadata.country });
  const candidates = [];
  if (preference !== 'custom') for (const line of lines) candidates.push({ line, transport: 'direct', url: githubDownloadUrl(metadata, line) });
  for (const line of lines) {
    const url = githubRelayUrl(metadata, line, mirrorId);
    if (url) candidates.push({ line, transport: 'relay', url });
  }
  if (!candidates.length) throw failure(preference === 'custom' ? 'mirror' : 'network');
  const width = Math.max(1024, Math.min(MAX_RANGE_BYTES, blockBytes, metadata.relay.maxRangeBytes));
  const abort = () => { if (currentSignal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
  const publish = (extra = {}) => onProgress?.({ bytes: receivedBytes, line: candidates[candidate]?.line || lines[0],
    transport: candidates[candidate]?.transport || 'direct', ...extra });

  async function range(offset, length) {
    for (; candidate < candidates.length; candidate++) {
      const route = candidates[candidate];
      for (let attempt = 0; attempt <= retries; attempt++) {
        abort();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const outerSignal = currentSignal;
        outerSignal?.addEventListener('abort', cancel, { once: true });
        if (outerSignal?.aborted) cancel();
        const timer = setTimeout(cancel, route.transport === 'relay' ? relayTimeoutMs : timeoutMs);
        let poll = null, polling = false;
        if (route.transport === 'relay') {
          const statusUrl = githubRelayUrl(metadata, route.line, mirrorId, true);
          poll = setInterval(() => {
            if (polling || controller.signal.aborted) return;
            polling = true;
            doFetch(statusUrl, { signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
              .then(async (response) => {
                if (response.ok) {
                  const status = await response.json();
                  if (status.phase === 'preparing' && Number.isSafeInteger(status.receivedBytes) && status.receivedBytes >= 0
                    && status.totalBytes === metadata.size) publish({ preparingBytes: status.receivedBytes, archiveBytes: metadata.size });
                }
              }).catch(() => {}).finally(() => { polling = false; });
          }, 1000);
        }
        publish();
        try {
          const response = await doFetch(route.url, { signal: controller.signal,
            headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: 'no-store',
            credentials: route.transport === 'relay' ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer',
            redirect: route.transport === 'relay' ? 'error' : 'follow', mode: route.transport === 'relay' ? 'same-origin' : 'cors' });
          const expectedRange = `bytes ${offset}-${offset + length - 1}/${metadata.size}`;
          if (response.status !== 206 || ['opaque', 'opaqueredirect'].includes(response.type)
            || response.headers.get('content-range') !== expectedRange
            || Number(response.headers.get('content-length')) !== length
            || /text\/html/i.test(response.headers.get('content-type') || '')
            || !trustedFinalUrl(response.url, route.url, route.line, route.transport === 'relay')) {
            await response.body?.cancel?.();
            throw failure('range');
          }
          const tag = response.headers.get('etag');
          const key = `${route.transport}:${route.line}`;
          if ((tags.has(key) && tags.get(key) !== tag) || (tag && /^W\//i.test(tag))) {
            await response.body?.cancel?.(); throw failure('archive-changed');
          }
          if (tag) tags.set(key, tag);
          const reader = response.body?.getReader?.();
          if (!reader) throw failure('range');
          const result = new Uint8Array(length);
          let at = 0;
          try {
            for (;;) {
              abort();
              const next = await reader.read();
              if (next.done) break;
              if (at + next.value.byteLength > length) { await reader.cancel(); throw failure('range'); }
              result.set(next.value, at); at += next.value.byteLength; receivedBytes += next.value.byteLength;
              publish();
            }
          } finally { reader.releaseLock(); }
          if (at !== length) throw failure('range');
          lastError = null;
          return result;
        } catch (error) {
          if (outerSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          lastError = error?.code ? error : failure('network');
          if (lastError.code === 'archive-changed') throw lastError;
          // Range/CORS/CSP failures are not improved by repeating the same public request. Transient failures retry once.
          if (lastError.code === 'range' || attempt === retries) break;
        } finally {
          clearTimeout(timer); if (poll) clearInterval(poll);
          controller.abort(); outerSignal?.removeEventListener('abort', cancel);
        }
      }
      blocks.clear(); epoch++;
    }
    throw lastError || failure('network');
  }

  async function block(index) {
    const key = `${epoch}:${index}`;
    if (blocks.has(key)) {
      const hit = blocks.get(key); blocks.delete(key); blocks.set(key, hit); return hit;
    }
    const offset = index * width, length = Math.min(width, metadata.size - offset);
    const bytes = await range(offset, length);
    blocks.set(`${epoch}:${index}`, bytes);
    while (blocks.size > Math.max(1, cacheBlocks)) blocks.delete(blocks.keys().next().value);
    return bytes;
  }
  async function read(offset, length) {
    abort();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || length > 256 * 1024 * 1024 || offset + length > metadata.size) throw failure('range');
    // Restart an individual read if its route changed, so a returned buffer never mixes origins/validators.
    for (let restarted = 0; restarted <= candidates.length; restarted++) {
      const startEpoch = epoch, result = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const pos = offset + written, index = Math.floor(pos / width);
        const chunk = await block(index);
        const start = pos % width, count = Math.min(chunk.length - start, length - written);
        result.set(chunk.subarray(start, start + count), written); written += count;
      }
      if (epoch === startEpoch) return result;
    }
    throw failure('archive-changed');
  }
  return {
    type: 'asset-archive', size: metadata.size, read,
    setSignal(next) { currentSignal = next; },
    get error() { return lastError; },
    part(offset, length) {
      return { stream: () => {
        let at = 0, cancelled = false;
        return new ReadableStream({ async pull(controller) {
          if (cancelled) return;
          if (at >= length) { controller.close(); return; }
          try {
            const count = Math.min(width, length - at), bytes = await read(offset + at, count);
            if (!cancelled) { at += count; controller.enqueue(bytes); }
          } catch (error) { if (!cancelled) controller.error(error); }
        }, cancel() { cancelled = true; } });
      } };
    },
  };
}
