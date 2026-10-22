// Server progress inside the unified preload dialog. Only an explicit source/resume action starts the queue.
import { html, Button, ProgressBar } from './components.js';
import { assetDownload } from '../assetDownload.js';
import { t } from '../../../shared/i18n.js';

export function AssetDownloadProgress({ state, disabled = false }) {
  const busy = ['preparing', 'downloading'].includes(state.phase);
  const status = state.phase === 'idle' ? t('尚未开始预载')
    : state.phase === 'complete' ? t('本次素材下载完成')
    : state.phase === 'preparing' ? t('正在读取素材清单…')
      : state.phase === 'paused' ? t('素材下载已暂停')
        : state.phase === 'error' ? t('无法读取素材清单，请检查网络后重试。')
          : state.phase === 'partial' ? t('有 {n} 个素材下载失败', { n: state.failures.length })
            : t('正在下载素材…');
  const ready = state.done || 0;
  return html`<section class="asset-download" aria-label=${t('从服务器预载素材')}>
    <p role="status" data-testid="asset-download-status">${status}</p>
    <${ProgressBar} value=${ready} max=${state.total || 1} label=${t('已完成 {done} / {total} 个文件', { done: ready, total: state.total })} />
    <p>${t('已读取 {size} MB（含浏览器缓存）', { size: (state.bytes / 1048576).toFixed(1) })}</p>
    ${state.total > 0 ? html`<p>${t('已就绪 {ready}，缺少 {missing}', { ready, missing: Math.max(0, state.total - ready) })}</p>` : null}
    <p class="t-lo">${t('本次已就绪数量包含已读取的文件和可用的导入素材；浏览器可能清理缓存。')}</p>
    <div class="asset-import__row">
      ${busy ? html`<${Button} size="sm" data-testid="asset-download-pause" onClick=${() => assetDownload.pause()}>${t('暂停下载')}<//>`
        : html`<${Button} size="sm" variant="primary" disabled=${disabled} data-testid="asset-download-resume"
            onClick=${() => void assetDownload.start()}>
          ${state.phase === 'idle' ? t('开始预载') : state.phase === 'complete' ? t('重新检查') : state.phase === 'paused' ? t('继续下载素材') : t('重试下载')}<//>`}
    </div>
    ${state.localMissing ? html`<p class="t-lo">${t('服务器未提供额外的本地素材包，将使用基础素材。')}</p>` : null}
    ${state.failures.length ? html`<div class="asset-download__errors">
      <p>${t('下载未完成。请重试；若文件持续缺失，请联系服主补齐素材。')}</p>
      <details><summary>${t('查看失败文件')}</summary><ul>
        ${state.failures.slice(0, 30).map((item) => html`<li key=${item.url}><code>${item.url}</code> (${item.status})</li>`)}
      </ul></details>
    </div>` : null}
  </section>`;
}
