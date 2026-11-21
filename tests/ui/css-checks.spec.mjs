import { expect, test } from '@playwright/test';
import { assertStyleScript, checkLayoutScript, stylesScript } from '../../src/lib/cssChecks.ts';

const run = (page, body) => page.evaluate(`(function(){${body}})()`);

test('css checks find planted problems', async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; font: 16px sans-serif; background: #fff; }
      #btn { color: #fff; background: rgb(0, 128, 0); padding: 8px 16px; border-radius: 6px; }
      .low { color: #bbb; background: #fff; }
      .wide { width: 900px; background: #eee; }
      .clip { width: 80px; overflow: hidden; white-space: nowrap; }
      .tiny { width: 10px; height: 10px; display: inline-block; }
      .scroller { overflow-x: auto; width: 200px; } .scroller div { width: 600px; }
    </style>
    <button id="btn">Save</button>
    <p class="low">Hard to read text</p>
    <div class="wide">too wide block</div>
    <div class="clip">This sentence is much longer than its tiny box allows</div>
    <a class="tiny" href="#x"></a>
    <div class="scroller"><div>inside a scroller (must not be flagged)</div></div>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  `);
  await page.setViewportSize({ width: 400, height: 700 });

  const styles = JSON.parse(await run(page, stylesScript('#btn')));
  expect(styles.styles['background-color']).toBe('rgb(0, 128, 0)');
  expect(styles.styles['border-radius']).toBe('6px');

  const ok = JSON.parse(await run(page, assertStyleScript('#btn', 'background-color', '#008000')));
  expect(ok.pass).toBe(true);
  const px = JSON.parse(await run(page, assertStyleScript('#btn', 'border-radius', '6px')));
  expect(px.pass).toBe(true);
  const bad = JSON.parse(await run(page, assertStyleScript('#btn', 'color', 'red')));
  expect(bad.pass).toBe(false);
  const has = JSON.parse(await run(page, assertStyleScript('#btn', 'padding', '16px', true)));
  expect(has.pass).toBe(true);

  const report = JSON.parse(await run(page, checkLayoutScript()));
  const types = report.issues.map((i) => i.type);
  expect(types).toContain('horizontal-scroll');
  expect(types).toContain('overflows-viewport');
  expect(types).toContain('clipped-text');
  expect(types).toContain('low-contrast');
  expect(types).toContain('small-target');
  expect(types).toContain('broken-image');
  // the planted scroller and the accessible green button are fine
  expect(report.issues.filter((i) => /scroller/.test(i.element ?? '')).length).toBe(0);
  expect(report.issues.filter((i) => /#btn/.test(i.element ?? '') && i.type === 'low-contrast').length).toBe(0);
});
