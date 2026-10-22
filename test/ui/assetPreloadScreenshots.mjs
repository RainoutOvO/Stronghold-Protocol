// Optional visual-QA artifacts; viewport changes are restored before the browser assertions continue.
import fs from 'node:fs';
import path from 'node:path';

export async function assetPreloadScreenshots(page, name) {
  const out = process.env.SP_ASSET_SCREENSHOTS;
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  const previous = page.viewport();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    await page.evaluate(async () => {
      await Promise.all((document.querySelector('.modal')?.getAnimations({ subtree: true }) || [])
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: path.join(out, `${name}-${viewport.width}.png`) });
  }
  await page.setViewport(previous);
}
