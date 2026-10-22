// One automatic GitHub task shared by every render/open of the preloader. Validated imported files survive pause,
// close and refresh; only a fresh verification can turn them into this run's completion count.
import { createAssetImport, verifyImportedAssets } from './assetPack.js';
import { collectAssetUrls } from './assetDownload.js';
import { importedWorkerControlsPage, importSupport } from './assetCache.js';
import { loadGithubRelease, selectGithubRoutes } from './assetRelease.js';
import { createRemoteAssetArchive } from './assetArchive.js';

const initial = () => ({ phase: 'idle', bytes: 0, done: 0, total: 0, accepted: 0, reused: 0,
  failures: [], error: null, line: 'direct', transport: 'direct', source: 'github', mirrors: [], preparingBytes: 0, archiveBytes: 0 });
const coded = (code) => Object.assign(new Error(code), { code });

export function createAssetGithubDownload({ fetch: doFetch = (...args) => globalThis.fetch(...args),
  caches: cachesApi = globalThis.caches, supported = () => importSupport().ok,
  canServe = () => importedWorkerControlsPage(), loadRelease = loadGithubRelease, createArchive = createRemoteAssetArchive } = {}) {
  let state = initial(), running = null, controller = null, stopped = false, pendingStart = null, resumeGeneration = 0;
  let archive = null, archiveKey = null, activeImport = null, lastOptions = {}, notice = 0;
  const listeners = new Set();
  const publish = (patch, force = false) => {
    state = { ...state, ...patch };
    if (!force && Date.now() - notice < 100) return;
    notice = Date.now();
    for (const listener of listeners) listener(state);
  };
  async function requiredUrls(signal) {
    const manifests = [];
    for (const [url, optional] of [['/data/assets.json', false], ['/data/local-assets.json', true], ['/data/local-fx.json', true]]) {
      const response = await doFetch(url, { signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (optional && response.status === 404) { await response.body?.cancel?.(); manifests.push(null); continue; }
      if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw coded('manifest');
      let manifest;
      try { manifest = await response.json(); } catch { throw coded('manifest'); }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || (optional && !manifest.groups)) throw coded('manifest');
      manifests.push(manifest);
    }
    const urls = collectAssetUrls(...manifests);
    if (!urls.length) throw coded('manifest');
    return urls;
  }
  async function run(options) {
    const signal = controller.signal;
    const abort = () => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
    let offImport = null;
    try {
      if (!supported()) { publish({ phase: 'fallback', error: 'capability' }, true); return; }
      publish({ ...initial(), phase: 'preparing' }, true);
      const release = await loadRelease({ fetch: doFetch, signal });
      abort();
      if (!release) throw coded('release');
      const preference = ['auto', 'direct', 'custom'].includes(options.preference) ? options.preference : 'auto';
      if (preference === 'custom' && !release.relay?.mirrors?.some((mirror) => mirror.id === options.mirrorId)) throw coded('mirror');
      publish({ release, mirrors: release.relay?.mirrors || [], archiveBytes: release.size,
        line: preference === 'custom' ? 'custom' : selectGithubRoutes({ preference, country: release.country })[0] }, true);
      const urls = await requiredUrls(signal);
      publish({ phase: 'verifying', total: urls.length }, true);
      const before = await verifyImportedAssets({ fetch: doFetch, caches: cachesApi, signal, includePaths: true });
      abort();
      const existing = new Set(before.verifiedPaths), reused = urls.filter((url) => existing.has(url)).length;
      publish({ reused, done: reused }, true);
      if (reused === urls.length) {
        const usable = canServe();
        publish({ phase: usable ? 'complete' : 'fallback', error: usable ? null : 'worker' }, true);
        return;
      }
      const key = `${release.url}:${release.size}:${release.sha256 || ''}:${preference}:${options.mirrorId || ''}`;
      if (!archive || archiveKey !== key || archive.error) {
        archive = createArchive({ release, preference, mirrorId: options.mirrorId, fetch: doFetch, signal,
          onProgress(progress) {
            if (!controller.signal.aborted) publish({ ...progress, phase: progress.preparingBytes ? 'preparing' : 'downloading' });
          } });
        archiveKey = key;
      } else archive.setSignal(signal);
      activeImport = createAssetImport({ fetch: doFetch, caches: cachesApi });
      offImport = activeImport.subscribe((progress) => {
        if (!signal.aborted) publish({ phase: progress.phase === 'reading' ? 'preparing' : 'importing',
          done: Math.min(urls.length, Math.max(reused, progress.accepted)), accepted: Math.max(0, progress.accepted - reused) });
      });
      publish({ phase: 'downloading' }, true);
      await activeImport.start({ type: 'zip', data: archive, signal, skipUrls: existing });
      abort();
      const imported = activeImport.get();
      publish({ phase: 'verifying' }, true);
      const after = await verifyImportedAssets({ fetch: doFetch, caches: cachesApi, signal, includePaths: true });
      abort();
      const verified = new Set(after.verifiedPaths), missing = urls.filter((url) => !verified.has(url));
      const done = urls.length - missing.length;
      const error = imported.phase === 'error' ? (archive.error?.code || imported.error || 'network') : null;
      const failed = imported.failed + imported.rejected;
      const phase = !missing.length && !error && !failed ? (canServe() ? 'complete' : 'fallback') : done ? 'partial' : 'error';
      publish({ phase, done, accepted: Math.max(0, done - reused), logicalBytes: after.logicalBytes,
        error: phase === 'fallback' ? 'worker' : error || (missing.length ? 'missing' : failed ? 'content' : null),
        failures: missing.slice(0, 100).map((url) => ({ url, code: 'missing' })) }, true);
    } catch (error) {
      if (!signal.aborted) publish({ phase: state.done ? 'partial' : 'error', error: typeof error.code === 'string' ? error.code
        : error.name === 'QuotaExceededError' ? 'storage' : 'network' }, true);
    } finally {
      offImport?.(); activeImport = null;
      if (stopped || signal.aborted) publish({ phase: 'paused', error: null }, true);
    }
  }
  const api = {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start(options = lastOptions) {
      if (running) {
        if (!stopped) return running;
        if (!pendingStart) {
          const generation = ++resumeGeneration;
          const pending = running.then(() => {
            if (pendingStart === pending) pendingStart = null;
            if (generation === resumeGeneration) return api.start(options);
          });
          pendingStart = pending;
        }
        return pendingStart;
      }
      stopped = false; controller = new AbortController(); lastOptions = { ...options };
      running = run(lastOptions).finally(() => { running = null; });
      return running;
    },
    pause() {
      resumeGeneration++; pendingStart = null;
      if (running) { stopped = true; controller.abort(); activeImport?.cancel(); }
      return running || Promise.resolve();
    },
    cancel() { return api.pause(); },
    recheck(options) { api.pause(); return api.start(options || lastOptions); },
    async invalidate() { await api.pause(); archive = null; archiveKey = null; publish(initial(), true); },
  };
  return api;
}

export const assetGithubDownload = createAssetGithubDownload();
