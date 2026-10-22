// Capability descriptors for the unified preloader. Insecure browsers use the working server HTTP-cache path.
export const DEFAULT_PRELOAD_RECOMMENDED = 'server';
const SOURCE_IDS = ['server', 'import'];
const recommendation = (value) => SOURCE_IDS.includes(value) ? value : DEFAULT_PRELOAD_RECOMMENDED;

/** Browser capability, separate from the server owner's recommendation. */
export function preloadSources({ recommended = DEFAULT_PRELOAD_RECOMMENDED, importSupported = true } = {}) {
  const preferred = recommendation(recommended);
  return [
    { id: 'server', available: true, reason: null },
    { id: 'import', available: !!importSupported, reason: importSupported ? null : 'capability' },
  ].map((source) => ({ ...source, recommended: source.id === preferred }));
}

/** Fetch only a small, same-origin preference. An old/static host or a failed request keeps the default. */
export async function loadPreloadRecommendation({ fetch: fetchFn = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn('/asset-preload.json', { cache: 'no-store', credentials: 'same-origin',
      redirect: 'error', signal: controller.signal });
    if (!response.ok) return DEFAULT_PRELOAD_RECOMMENDED;
    return recommendation((await response.json())?.recommended);
  } catch {
    return DEFAULT_PRELOAD_RECOMMENDED;
  } finally {
    clearTimeout(timer);
  }
}
