// Public full-game ZIP discovery only. No user-supplied URL, token or archive bytes reach this metadata endpoint.
export const GITHUB_RELEASE_API = 'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest';
const DOWNLOAD_ROOT = 'https://github.com/sganggs/Stronghold-Protocol/releases/download/';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_RELEASE_BYTES = 8 * 1024 * 1024 * 1024;

/** Only the actual uploaded full package of this stable upstream release is eligible. */
export function githubReleaseMetadata(document) {
  if (!document || document.draft || document.prerelease || !/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(document.tag_name || '')) return null;
  const version = document.tag_name.slice(1);
  const name = `Stronghold-Protocol-v${version}.zip`;
  const url = `${DOWNLOAD_ROOT}${document.tag_name}/${name}`;
  const asset = Array.isArray(document.assets) && document.assets.find((item) => item?.name === name &&
    item.browser_download_url === url && item.state === 'uploaded' && Number.isSafeInteger(item.size) &&
    item.size > 0 && item.size <= MAX_RELEASE_BYTES);
  const sha256 = typeof asset?.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
  return asset ? Object.freeze({ version, name, url, size: asset.size, ...(sha256 ? { sha256 } : {}) }) : null;
}

/** Bounded streaming read: a compromised response cannot make discovery buffer a ZIP or an unbounded JSON body. */
async function readMetadata(response) {
  if (!response.ok || !/\bjson\b/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    return null;
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_METADATA_BYTES) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_METADATA_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return githubReleaseMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/** One in-flight public request; successful metadata lives 15 minutes and failures cool down for one minute. */
export function createGithubReleaseLookup({ fetch: fetchFn = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, ttlMs = 15 * 60 * 1000, failureTtlMs = 60 * 1000 } = {}) {
  let cached = null;
  let expires = 0;
  let pending = null;
  return async function getRelease() {
    if (now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(GITHUB_RELEASE_API, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol-asset-preload' },
        });
        cached = await readMetadata(response);
      } catch { cached = null; }
      finally {
        clearTimeout(timer);
        expires = now() + (cached ? ttlMs : failureTtlMs);
      }
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const getGithubRelease = createGithubReleaseLookup();
