// ZIP, directory and drop controls shared by the unified preloader. Files are verified locally, never uploaded.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, ProgressBar } from './components.js';
import { assetImport } from '../assetPack.js';
import { importedWorkerControlsPage, importSupport } from '../assetCache.js';
import { t } from '../../../shared/i18n.js';

function importStatus(state) {
  if (state.phase === 'reading') return t('正在读取素材包…');
  if (state.phase === 'importing') return t('正在校验并写入…');
  if (state.phase === 'complete') return t('导入完成');
  if (state.phase === 'partial') return t('导入结束，有文件未通过校验');
  if (state.phase === 'empty') return t('没有找到与服务器清单一致的素材。');
  if (state.phase === 'cancelled') return t('导入已取消');
  if (state.phase === 'error' && state.error === 'bad-zip') return t('素材包不是有效的 zip。');
  if (state.phase === 'error' && state.error === 'manifest') return t('无法读取素材清单，导入已停止。');
  if (state.phase === 'error' && state.error === 'storage') return t('素材存储失败，请检查可用空间后重试。已保存的文件会保留。');
  if (state.phase === 'error') return t('导入失败。');
  return '';
}

function walkEntry(entry, prefix, out, keepGoing) {
  if (!entry || !keepGoing()) return Promise.resolve();
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((file) => {
        if (keepGoing()) out.push({ path, read: async () => new Uint8Array(await file.arrayBuffer()) });
        resolve();
      }, () => resolve());
    });
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    return (async () => {
      for (;;) {
        const batch = await readBatch();
        if (!batch.length || !keepGoing()) break;
        for (const child of batch) await walkEntry(child, path, out, keepGoing);
      }
    })().catch(() => {});
  }
  return Promise.resolve();
}

async function walkHandle(dir, prefix, out, keepGoing) {
  for await (const [name, handle] of dir.entries()) {
    if (!keepGoing()) return;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      out.push({
        path,
        read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      });
    } else if (handle.kind === 'directory') {
      await walkHandle(handle, path, out, keepGoing);
    }
  }
}

// Mounted only while selected and visible: discard late picker results when the dialog closes.
export function AssetImportPanel({ imported, disabled = false, onCollecting, zipOnly = false }) {
  const folderRef = useRef(null);
  const zipRef = useRef(null);
  const live = useRef(true);
  const picking = useRef(false);
  const selection = useRef(0);
  const enabled = useRef(!disabled);
  enabled.current = !disabled;
  const [collecting, setCollecting] = useState(false);
  const [workerReady, setWorkerReady] = useState(importedWorkerControlsPage);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; assetImport.cancel(); };
  }, []);
  useEffect(() => {
    const changed = () => setWorkerReady(importedWorkerControlsPage());
    navigator.serviceWorker?.addEventListener('controllerchange', changed);
    changed();
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', changed);
  }, []);
  useEffect(() => {
    onCollecting?.(collecting);
    return () => onCollecting?.(false);
  }, [collecting]);
  const importBusy = collecting || ['reading', 'importing'].includes(imported.phase);
  const support = importSupport();
  const importText = collecting ? t('正在读取素材包…')
    : imported.accepted > 0 && !workerReady && ['complete', 'partial'].includes(imported.phase)
      ? t('素材已保存，但浏览器尚未启用素材缓存。请重新打开页面，或使用服务器预载。') : importStatus(imported);
  const showImportCounts = ['complete', 'partial', 'empty', 'cancelled', 'error'].includes(imported.phase)
    && (imported.accepted + imported.rejected + imported.skipped + imported.failed) > 0;

  const startFiles = (files) => {
    if (!live.current || !enabled.current || !files?.length || !support.ok) return;
    void assetImport.start({ type: 'files', files });
  };
  const onFolderInput = (event) => {
    const input = event.currentTarget;
    const files = [...(input.files || [])].map((file) => ({
      path: file.webkitRelativePath || file.name,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    }));
    input.value = '';
    startFiles(files);
  };
  const onZipInput = (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (live.current && !disabled && file && support.ok) void assetImport.start({ type: 'zip', data: file });
  };
  const chooseFolder = async () => {
    if (!live.current || disabled || !support.ok || importBusy || picking.current) return;
    picking.current = true;
    setCollecting(true);
    const id = ++selection.current;
    const keepGoing = () => live.current && selection.current === id;
    try {
      const picker = globalThis.showDirectoryPicker;
      if (typeof picker === 'function') {
        try {
          const dir = await picker();
          const files = [];
          await walkHandle(dir, dir.name || '', files, keepGoing);
          if (keepGoing()) startFiles(files);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      if (keepGoing()) folderRef.current?.click();
    } finally {
      if (selection.current === id) { picking.current = false; if (live.current) setCollecting(false); }
    }
  };
  const onDrop = async (event) => {
    event.preventDefault();
    if (!live.current || disabled || !support.ok || importBusy || picking.current) return;
    const dt = event.dataTransfer;
    if (!dt) return;
    const dropped = [...(dt.files || [])];
    if (dropped.length === 1 && /\.zip$/i.test(dropped[0].name)) {
      void assetImport.start({ type: 'zip', data: dropped[0] });
      return;
    }
    picking.current = true;
    setCollecting(true);
    const id = ++selection.current;
    const keepGoing = () => live.current && selection.current === id;
    try {
      const collected = [];
      let walked = false;
      for (const item of [...(dt.items || [])]) {
        if (!keepGoing()) return;
        const entry = item.webkitGetAsEntry?.();
        if (!entry) continue;
        walked = true;
        await walkEntry(entry, '', collected, keepGoing);
      }
      if (!walked) {
        for (const file of dropped) collected.push({
          path: file.webkitRelativePath || file.name,
          read: async () => new Uint8Array(await file.arrayBuffer()),
        });
      }
      if (keepGoing()) startFiles(collected);
    } finally {
      if (selection.current === id) { picking.current = false; if (live.current) setCollecting(false); }
    }
  };

  return html`<section class="asset-import-dialog" aria-label=${t('手动导入预载素材')}>
      ${!zipOnly ? html`<p class="t-lo">${t('选择素材包 zip 或素材文件夹，也可以拖入。文件通过服务器清单校验后保存在本机，不会上传。')}</p>` : null}
      ${support.ok ? html`
        <div class="asset-import__row">
          ${!zipOnly ? html`<${Button} size="sm" data-testid="asset-import-folder" disabled=${importBusy || disabled} onClick=${() => void chooseFolder()}>${t('选择文件夹')}<//>` : null}
          <${Button} size="sm" data-testid="asset-import-zip" disabled=${importBusy || disabled} onClick=${() => zipRef.current?.click()}>${zipOnly ? t('选择已下载的 ZIP') : t('选择 zip')}<//>
          ${importBusy ? html`<${Button} size="sm" data-testid="asset-import-cancel" onClick=${() => {
            selection.current++; picking.current = false; setCollecting(false); assetImport.cancel();
          }}>${t('取消导入')}<//>` : null}
        </div>
        <input class="asset-import__file" type="file" webkitdirectory=${true} multiple=${true} ref=${folderRef} tabindex="-1" aria-hidden="true"
          data-testid="asset-import-folder-input" onChange=${onFolderInput} />
        <input class="asset-import__file" type="file" accept=".zip,application/zip" ref=${zipRef} tabindex="-1" aria-hidden="true"
          data-testid="asset-import-zip-input" onChange=${onZipInput} />
        ${!zipOnly ? html`<div class="asset-import__drop" onDragOver=${(event) => event.preventDefault()} onDrop=${(event) => void onDrop(event)}>
          ${t('或把文件夹 / zip 拖到这里')}
        </div>` : null}
      ` : html`<p class="asset-import__reason" data-testid="asset-import-unavailable">${
        support.reason === 'insecure'
          ? t('导入需要 HTTPS 或 localhost。当前是 http 地址，浏览器不允许 Service Worker，所以不能导入。')
          : t('此浏览器不能导入本地素材。')
      }</p>`}
      <p role="status" data-testid="asset-import-status" class="asset-import__status">${importText}</p>
      ${importBusy || (imported.total > 0 && imported.phase !== 'idle') ? html`<${ProgressBar} value=${imported.done} max=${imported.total || 1} label=${t('已完成 {done} / {total} 个文件', { done: imported.done, total: imported.total })} />` : null}
      ${showImportCounts ? html`<p data-testid="asset-import-counts">${t('已导入 {accepted} 个，校验不符 {rejected} 个，跳过 {skipped} 个，无法读取 {failed} 个', {
        accepted: imported.accepted, rejected: imported.rejected, skipped: imported.skipped, failed: imported.failed,
      })}</p>` : null}
      ${imported.unsupported > 0 ? html`<p class="t-lo">${t('其中 {n} 个因压缩方式不支持被跳过', { n: imported.unsupported })}</p>` : null}
  </section>`;
}
