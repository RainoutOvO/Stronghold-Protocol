// The server discovers a real public full-game release. Downloading it is not the same as verifying/importing art.
const DOWNLOAD_ROOT = 'https://github.com/sganggs/Stronghold-Protocol/releases/download/';
const MAX_RELEASE_BYTES = 8 * 1024 * 1024 * 1024;
export const GITHUB_FAST_PREFIX = 'https://ghfast.top/';

export function releaseMetadata(value) {
  if (!value || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version || '')) return null;
  const name = `Stronghold-Protocol-v${value.version}.zip`;
  const url = `${DOWNLOAD_ROOT}v${value.version}/${name}`;
  if (value.name !== name || value.url !== url || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_RELEASE_BYTES) return null;
  const country = typeof value.country === 'string' && /^[A-Z]{2}$/.test(value.country) && value.country !== 'XX' ? value.country : null;
  const mirrors = Array.isArray(value.relay?.mirrors) ? value.relay.mirrors.filter((mirror) =>
    /^[a-z][a-z0-9_-]{0,31}$/.test(mirror?.id || '') && !['direct', 'ghfast', 'custom'].includes(mirror.id)
      && typeof mirror.label === 'string' && mirror.label.length <= 80).map(({ id, label }) => ({ id, label })) : [];
  const relay = { enabled: value.relay?.enabled === true,
    maxRangeBytes: Math.min(8 * 1024 * 1024, Number(value.relay?.maxRangeBytes) || 8 * 1024 * 1024), mirrors };
  const sha256 = /^[0-9a-f]{64}$/.test(value.sha256 || '') ? value.sha256 : null;
  return { version: value.version, name, url, size: value.size, country, relay, sha256 };
}

/** This is a tiny same-origin metadata request, never a ZIP transfer or a third-party IP lookup. */
export async function loadGithubRelease({ fetch: fetchFn = globalThis.fetch, timeoutMs = 10000, signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn('/asset-preload/github.json', {
      cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) return null;
    return releaseMetadata(await response.json());
  } catch { return null; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** No language/time-zone inference. country is an optional, explicitly configured trusted-edge hint. */
export function selectGithubRoutes({ preference = 'auto', country = null } = {}) {
  if (preference === 'direct') return ['direct'];
  return country === 'CN' ? ['ghfast', 'direct'] : ['direct', 'ghfast'];
}

/** A relay can fetch only the server's pinned public release and configured mirror IDs, never an arbitrary URL. */
export function githubRelayUrl(release, line = 'direct', mirrorId = null, status = false) {
  const metadata = releaseMetadata(release);
  if (!metadata?.relay.enabled || !['direct', 'ghfast', 'custom'].includes(line)) return null;
  if (line === 'custom' && !metadata.relay.mirrors.some((mirror) => mirror.id === mirrorId)) return null;
  const query = new URLSearchParams({ version: metadata.version, route: line });
  if (line === 'custom') query.set('id', mirrorId);
  return `/asset-preload/github/${status ? 'status' : 'archive'}?${query}`;
}

/** Proxy only this known public GitHub release download; no arbitrary URLs, query, credentials or fragment. */
export function githubDownloadUrl(release, route = 'direct') {
  const metadata = releaseMetadata(release);
  if (!metadata || !['direct', 'ghfast'].includes(route)) return null;
  return route === 'ghfast' ? GITHUB_FAST_PREFIX + metadata.url : metadata.url;
}
