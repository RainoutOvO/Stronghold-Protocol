// Automatic archive reads and the local importer share validation; only saved, verified assets count as ready.
import { html, Button, ProgressBar } from './components.js';
import { t } from '../../../shared/i18n.js';

export const GITHUB_ROUTE_PREF = 'sp.pref.assetGithubRoute';
export const GITHUB_MIRROR_PREF = 'sp.pref.assetGithubMirror';
export function readGithubRoute() {
  try {
    const value = localStorage.getItem(GITHUB_ROUTE_PREF);
    return ['auto', 'direct', 'custom'].includes(value) ? value : 'auto';
  } catch { return 'auto'; }
}
export function readGithubMirror() {
  try { return localStorage.getItem(GITHUB_MIRROR_PREF) || ''; } catch { return ''; }
}

function statusOf(state) {
  if (state.phase === 'complete') return t('GitHub 素材预载完成');
  if (state.phase === 'paused' || state.phase === 'cancelled') return t('素材下载已暂停');
  if (state.error === 'storage') return t('素材存储失败，请检查可用空间后重试。已保存的文件会保留。');
  if (state.phase === 'verifying') return t('正在核实已保存的素材…');
  if (state.phase === 'importing') return t('正在校验并保存素材…');
  if (state.phase === 'partial') return t('部分素材未能就绪，可重试或使用服务器补齐。');
  if (state.phase === 'error') return state.error === 'bad-zip' ? t('素材归档损坏，预载未完成。')
      : state.error === 'manifest' ? t('无法读取素材清单，请检查网络后重试。')
        : state.error === 'mirror' ? t('请选择服主配置的可信镜像。')
          : t('素材预载失败，请检查网络后重试。已保存的文件会保留。');
  if (state.phase === 'downloading') return t('正在获取素材…');
  if (state.phase === 'idle') return t('尚未开始预载');
  return t('正在准备素材…');
}

export function AssetGithubPanel({ state, route, mirrorId, onRoute, onMirror, onStart, onPause, onSupplement, disabled, busy }) {
  const mirrors = state.mirrors || state.release?.relay?.mirrors || [];
  const line = state.line === 'ghfast' ? 'ghfast.top' : state.line && state.line !== 'direct'
    ? mirrors.find((m) => m.id === state.line || m.id === mirrorId)?.label || t('自定义镜像')
    : state.transport === 'relay' ? t('GitHub 官方') : t('GitHub 直连');
  return html`<section aria-label=${t('从 GitHub 预载素材')} data-testid="asset-github-progress">
    <p role="status" data-testid="asset-github-status">${statusOf(state)}</p>
    <${ProgressBar} value=${state.done || 0} max=${state.total || 1}
      label=${t('已就绪 {done} / {total} 个文件', { done: state.done || 0, total: state.total || 0 })} />
    <p data-testid="asset-github-bytes">${t('已读取 {size} MB', { size: ((state.bytes || 0) / 1048576).toFixed(1) })}</p>
    ${state.phase === 'preparing' && state.preparingBytes > 0 ? html`<p class="t-lo" data-testid="asset-github-preparing">${t('服务器正在准备素材：{done} / {total} MB', {
      done: (state.preparingBytes / 1048576).toFixed(1), total: ((state.archiveBytes || 0) / 1048576).toFixed(1),
    })}</p>` : null}
    <p class="t-lo" data-testid="asset-github-line">${state.line ? t('当前线路：{line}', { line }) : t('正在选择线路…')}${state.transport === 'relay' ? t('（服务器中转）') : ''}</p>
    <div class="asset-import__row">
      ${busy ? html`<${Button} size="sm" disabled=${disabled} data-testid="asset-github-pause" onClick=${onPause}>${t('暂停下载')}<//>`
        : html`<${Button} size="sm" variant="primary" disabled=${disabled} data-testid="asset-github-resume" onClick=${onStart}>
          ${state.phase === 'complete' ? t('重新检查') : state.phase === 'paused' || state.phase === 'cancelled' ? t('继续下载素材') : t('重试下载')}<//>`}
      ${!busy && state.phase === 'partial' ? html`<${Button} size="sm" disabled=${disabled} data-testid="asset-github-supplement"
        onClick=${onSupplement}>${t('从服务器补齐')}<//>` : null}
    </div>
    ${state.failures?.length && !busy ? html`<details class="asset-download__errors"><summary>${t('查看失败文件')}</summary>
      <ul>${(state.failures || []).slice(0, 30).map((item, i) => html`<li key=${item.url || i}><code>${item.url || item.code || item.status || state.error}</code></li>`)}</ul>
    </details>` : null}
    <details class="asset-preload__advanced">
      <summary>${t('高级选项')}</summary>
      <label><input type="radio" name="asset-github-route" data-testid="asset-github-route-auto" value="auto" checked=${route === 'auto'} disabled=${disabled || busy}
        onChange=${() => onRoute('auto')} />${t('自动选择线路')}</label>
      <label><input type="radio" name="asset-github-route" data-testid="asset-github-route-direct" value="direct" checked=${route === 'direct'} disabled=${disabled || busy}
        onChange=${() => onRoute('direct')} />${t('始终使用 GitHub 直连')}</label>
      <label><input type="radio" name="asset-github-route" data-testid="asset-github-route-custom" value="custom" checked=${route === 'custom'} disabled=${disabled || busy}
        onChange=${() => onRoute('custom')} />${t('使用自定义镜像源')}</label>
      ${route === 'custom' ? mirrors.length ? html`<label>${t('可信镜像')}
        <select data-testid="asset-github-mirror" value=${mirrorId} disabled=${disabled || busy} onChange=${(e) => onMirror(e.currentTarget.value)}>
          <option value="">${t('请选择')}</option>${mirrors.map((m) => html`<option key=${m.id} value=${m.id}>${m.label || m.id}</option>`)}
        </select></label>` : html`<p class="t-lo">${t('服主尚未配置可信镜像。')}</p>` : null}
    </details>
  </section>`;
}
