// One title entry and one Modal. Task singletons outlive the dialog; rendering never starts a transfer.
import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, confirmDialog } from './components.js';
import { AssetDownloadProgress } from './assetDownload.js';
import { AssetImportPanel } from './assetImport.js';
import { assetDownload } from '../assetDownload.js';
import { assetImport, pruneImportedAssets, verifyImportedAssets } from '../assetPack.js';
import { askPersistStorage, clearImportedAssets, countImportedFiles, importSupport, storageEstimate } from '../assetCache.js';
import { DEFAULT_PRELOAD_RECOMMENDED, loadPreloadRecommendation, preloadSources } from '../assetSources.js';
import { t } from '../../../shared/i18n.js';

export function AssetPreloadButton() {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(null);
  const [recommended, setRecommended] = useState(DEFAULT_PRELOAD_RECOMMENDED);
  const [download, setDownload] = useState(() => assetDownload.get());
  const [imported, setImported] = useState(() => assetImport.get());
  const [info, setInfo] = useState(null);
  const [verified, setVerified] = useState(null);
  const [note, setNote] = useState('');
  const [managing, setManaging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [persisted, setPersisted] = useState(null);
  const live = useRef(true);
  const transition = useRef(false);
  const operation = useRef(null);
  const verifyAbort = useRef(null);
  const support = importSupport();
  const downloadBusy = ['preparing', 'downloading'].includes(download.phase);
  const importBusy = collecting || ['reading', 'importing'].includes(imported.phase);
  const busy = downloadBusy || importBusy || managing || leaving;

  useLayoutEffect(() => {
    if (!open) return;
    // Replacing source controls removes the previously focused button; keep focus inside the same Modal.
    document.querySelector('.asset-preload .modal__body button:not(:disabled)')?.focus();
    transition.current = false;
  }, [open, source]);

  useEffect(() => {
    live.current = true;
    const offDownload = assetDownload.subscribe(setDownload);
    const offImport = assetImport.subscribe(setImported);
    return () => {
      live.current = false;
      offDownload(); offImport();
      assetDownload.pause(); assetImport.cancel(); verifyAbort.current?.abort();
    };
  }, []);
  // Only the tiny preference endpoint and local index/estimate, never asset bodies on open.
  useEffect(() => {
    if (!open) return undefined;
    let stop = false;
    loadPreloadRecommendation().then((value) => { if (!stop) setRecommended(value); });
    return () => { stop = true; };
  }, [open]);
  useEffect(() => {
    if (!open || importBusy || managing) return undefined;
    let stop = false;
    Promise.all([support.ok ? countImportedFiles() : Promise.resolve(null), storageEstimate()])
      .then(([count, estimate]) => { if (!stop) setInfo({ count, usage: estimate?.usage ?? null }); });
    return () => { stop = true; };
  }, [open, imported.phase, managing]);
  useEffect(() => {
    if (importBusy) setVerified(null);
    if (imported.accepted <= 0 || !['complete', 'partial'].includes(imported.phase)) return;
    askPersistStorage().then((value) => { if (live.current) setPersisted(value); });
  }, [imported.phase]);

  const stopTasks = async () => {
    verifyAbort.current?.abort();
    await Promise.all([assetDownload.pause(), assetImport.cancel(), operation.current]);
  };
  const leave = async (close) => {
    if (transition.current) return;
    transition.current = true;
    setLeaving(true);
    try {
      await stopTasks();
      if (!live.current) return;
      if (close) setOpen(false);
      else setSource(null);
    } finally {
      transition.current = false;
      if (live.current) setLeaving(false);
    }
  };
  const choose = (id) => {
    if (transition.current || busy || !preloadSources({ recommended, importSupported: support.ok }).find((item) => item.id === id)?.available) return;
    transition.current = true;
    setSource(id);
    if (id === 'server') void assetDownload.start();
  };
  const manage = (kind) => {
    if (operation.current || busy) return;
    const task = async () => {
      if (kind !== 'verify') {
        const confirmed = await confirmDialog({
          title: kind === 'clear' ? t('清除已导入的素材') : t('清理旧版本素材'),
          text: kind === 'clear'
            ? t('删除本浏览器可管理的导入素材。服务器下载使用的 HTTP 缓存不会被清除。')
            : t('删除本浏览器中当前版本用不到的导入素材，保留仍在使用的文件。HTTP 缓存不会被清除。'),
          okText: t('确认清除'), danger: true,
        });
        if (!confirmed || !live.current) return;
      }
      setNote(''); setVerified(null);
      try {
        if (kind === 'verify') {
          verifyAbort.current = new AbortController();
          const result = await verifyImportedAssets({ signal: verifyAbort.current.signal });
          if (live.current) setVerified(result);
        } else if (kind === 'clear') {
          const cleared = await clearImportedAssets();
          if (live.current) {
            setNote(cleared ? t('已清除可管理的导入素材；HTTP 缓存由浏览器管理。') : t('清理失败，请重试。'));
            setPersisted(null);
          }
        } else {
          const result = await pruneImportedAssets();
          if (live.current) setNote(t('已清理 {n} 个旧版本文件。', { n: result.removedFiles }));
        }
        await assetDownload.invalidate();
      } catch (error) {
        if (live.current && error?.name !== 'AbortError') setNote(t('无法检查或清理素材，请重试。'));
      } finally { verifyAbort.current = null; }
    };
    setManaging(true);
    operation.current = task().finally(() => {
      operation.current = null;
      if (live.current) setManaging(false);
    });
  };
  const checkUpdates = () => {
    if (busy) return;
    setSource('server');
    void assetDownload.recheck();
  };
  const labels = { server: t('从服务器预载素材'), import: t('手动导入预载素材') };

  return html`<div class="title-assets__item">
    <${Button} variant="secondary" block=${true} size="sm" data-testid="asset-preload" onClick=${() => {
      setVerified(null); setNote(''); setOpen(true);
    }}>${t('资源预载')}<//>
    <${Modal} open=${open} title=${t('资源预载')} closeOnBackdrop=${false} class="asset-preload"
      onClose=${() => void leave(true)} actions=${html`
        ${source ? html`<${Button} size="sm" data-testid="asset-preload-sources" disabled=${leaving || managing}
          onClick=${() => void leave(false)}>${downloadBusy ? t('暂停并更换来源') : importBusy ? t('取消并更换来源') : t('更换来源')}<//>` : null}
        <${Button} size="sm" data-testid="asset-preload-close" disabled=${leaving} onClick=${() => void leave(true)}>
          ${leaving ? t('正在停止…') : downloadBusy ? t('暂停并关闭') : importBusy ? t('取消并关闭') : t('关闭')}<//>`}>
      ${!source ? html`<div class="asset-preload__sources" data-testid="asset-preload-sources-list">
        ${preloadSources({ recommended, importSupported: support.ok }).map((item) => html`
          <${Button} key=${item.id} variant="secondary" block=${true} disabled=${busy || !item.available}
            data-testid=${`asset-source-${item.id}`} onClick=${() => choose(item.id)}>
            <span>${labels[item.id]}</span><span class="asset-preload__recommendation-slot">${item.recommended
              ? html`<span class="asset-preload__recommended">${t('推荐')}</span>` : null}</span>
          <//>`)}
        ${!support.ok ? html`<p class="t-lo" data-testid="asset-import-unavailable">${support.reason === 'insecure'
          ? t('此地址支持服务器预载；浏览器不支持在普通 HTTP 下导入本地素材。') : t('此浏览器不支持导入本地素材，请使用服务器预载。')}</p>` : null}
      </div>` : source === 'server' ? html`
        <${AssetDownloadProgress} state=${download} disabled=${managing || leaving} />`
        : html`<${AssetImportPanel} imported=${imported} disabled=${managing || leaving}
          onCollecting=${(value) => { if (live.current) setCollecting(value); }} />`}
      <details class="asset-preload__management" data-testid="asset-preload-management">
        <summary>${t('素材管理')}</summary>
        ${info?.count != null ? html`<p data-testid="asset-preload-index">${t('导入索引记录 {count} 个文件（尚未核实）', { count: info.count })}</p>` : null}
        ${verified ? html`<p role="status" data-testid="asset-preload-verified">${t('已校验当前版本 {count} 个文件，逻辑大小 {size} MB；缺失 {missing}，校验不符 {invalid}', {
          count: verified.verifiedFiles, size: (verified.logicalBytes / 1048576).toFixed(1),
          missing: verified.missingFiles, invalid: verified.invalidFiles,
        })}</p>` : null}
        ${info?.usage != null ? html`<p class="t-lo">${t('站点存储估算 {size} MB（包含本站其他数据）', { size: (info.usage / 1048576).toFixed(1) })}</p>` : null}
        <p class="t-lo">${t('服务器预载使用浏览器 HTTP 缓存，无法在此统计或删除；重新检查可增量补齐当前素材。')}</p>
        <div class="asset-import__row">
          <${Button} size="sm" disabled=${busy} data-testid="asset-preload-update" onClick=${checkUpdates}>${t('检查资源更新')}<//>
          ${support.ok ? html`
            <${Button} size="sm" disabled=${busy} data-testid="asset-preload-verify" onClick=${() => manage('verify')}>${t('核实已导入素材')}<//>
            <${Button} size="sm" disabled=${busy} data-testid="asset-preload-prune" onClick=${() => manage('prune')}>${t('清理旧版本素材')}<//>
            <${Button} size="sm" disabled=${busy} data-testid="asset-import-clear" onClick=${() => manage('clear')}>${t('清除已导入的素材')}<//>` : null}
        </div>
        ${managing ? html`<p role="status">${t('正在检查或清理素材…')}</p>` : null}
        ${note ? html`<p role="status" data-testid="asset-preload-note">${note}</p>` : null}
        ${persisted === true ? html`<p class="t-lo">${t('已请求浏览器尽量保留这些素材。')}</p>` : null}
        ${persisted === false ? html`<p class="t-lo">${t('浏览器可能在存储空间不足时清掉导入的素材。')}</p>` : null}
      </details>
    <//>
  </div>`;
}
