import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_BROWSER, browserLabel, browserSettingNote, cypressBrowserOf, engineOf, isBrowser, isFirefoxFamily, matchBrowser, resolveBrowser } from '../src/extensions/e2e/engine/browsers.ts';

const browser = (id, name, channel, displayName, version) => ({ id, name, family: 'chromium', channel, displayName, version, path: `/browsers/${id}.exe` });
const INSTALLED = [
  browser('edge', 'edge', 'stable', 'Edge', '120.0.2210.61'),
  browser('chrome', 'chrome', 'stable', 'Chrome', '120.0.6099.71'),
  browser('chrome-canary', 'chrome', 'canary', 'Chrome Canary', '122.0.6200.0'),
  browser('brave', 'brave', 'stable', 'Brave', ''),
];

test('matchBrowser finds a browser by id, Cypress name (stable first) or display name', () => {
  assert.deepEqual(matchBrowser(INSTALLED, 'chrome-canary'), { id: 'chrome-canary' });
  assert.deepEqual(matchBrowser(INSTALLED, 'Chrome'), { id: 'chrome' }, 'the name picks the stable channel');
  assert.deepEqual(matchBrowser(INSTALLED, 'chrome canary'), { id: 'chrome-canary' });
  assert.deepEqual(matchBrowser(INSTALLED, ' BRAVE '), { id: 'brave' });
  assert.deepEqual(matchBrowser(INSTALLED, 'auto'), { id: AUTO_BROWSER });
  assert.deepEqual(matchBrowser(INSTALLED, ''), { id: AUTO_BROWSER });
});

test('matchBrowser explains what is installed when the browser is not', () => {
  const r = matchBrowser(INSTALLED, 'firefox');
  assert.ok('error' in r);
  assert.match(r.error, /"firefox" is not installed/);
  assert.match(r.error, /edge, chrome, chrome-canary, brave/);
  assert.match(matchBrowser([], 'chrome').error, /no supported browser .* was found/);
});

test('Auto resolves to the first installed browser; a pick resolves to itself', () => {
  assert.equal(resolveBrowser(INSTALLED, AUTO_BROWSER)?.id, 'edge');
  assert.equal(resolveBrowser(INSTALLED, 'brave')?.id, 'brave');
  assert.equal(resolveBrowser(INSTALLED, 'vivaldi'), undefined);
  assert.equal(resolveBrowser([], AUTO_BROWSER), undefined);
});

test('labels and Cypress.browser carry the name, channel and major version', () => {
  assert.equal(browserLabel(INSTALLED[1]), 'Chrome 120');
  assert.equal(browserLabel(INSTALLED[3]), 'Brave', 'no version known: just the name');
  assert.deepEqual(cypressBrowserOf(INSTALLED[2]), {
    name: 'chrome', family: 'chromium', channel: 'canary', version: '122.0.6200.0', majorVersion: 122,
    displayName: 'Chrome Canary', path: '/browsers/chrome-canary.exe', isHeaded: true, isHeadless: false,
  });
  assert.equal(cypressBrowserOf(INSTALLED[3]).majorVersion, '');
  const generic = cypressBrowserOf(undefined);
  assert.equal(generic.family, 'chromium');
  assert.equal(generic.displayName, 'Test browser');
});

const FIREFOX = { id: 'firefox', name: 'firefox', family: 'firefox', channel: 'stable', displayName: 'Firefox', version: '133.0.3', path: '/browsers/firefox.exe' };
const FIREFOX_DEV = { id: 'firefox-dev', name: 'firefox', family: 'firefox', channel: 'dev', displayName: 'Firefox Developer Edition', version: '134.0b9', path: '/browsers/firefox-dev.exe' };

test('Firefox is matched by name (stable first), id and display name', () => {
  const list = [...INSTALLED, FIREFOX_DEV, FIREFOX];
  assert.deepEqual(matchBrowser(list, 'firefox'), { id: 'firefox' }, 'the name picks the stable channel even when listed later');
  assert.deepEqual(matchBrowser(list, 'firefox-dev'), { id: 'firefox-dev' });
  assert.deepEqual(matchBrowser(list, 'Firefox Developer Edition'), { id: 'firefox-dev' });
  assert.deepEqual(matchBrowser([FIREFOX_DEV], 'firefox'), { id: 'firefox-dev' }, 'any channel when there is no stable one');
});

test('Auto prefers a Chromium browser and falls back to Firefox', () => {
  assert.equal(resolveBrowser([FIREFOX, ...INSTALLED], AUTO_BROWSER)?.id, 'edge');
  assert.equal(resolveBrowser([FIREFOX, FIREFOX_DEV], AUTO_BROWSER)?.id, 'firefox');
  assert.equal(resolveBrowser([FIREFOX], 'firefox')?.family, 'firefox');
});

test('Cypress.browser and Cypress.isBrowser for Firefox', () => {
  const ff = cypressBrowserOf(FIREFOX);
  assert.deepEqual(ff, { name: 'firefox', family: 'firefox', channel: 'stable', version: '133.0.3', majorVersion: 133, displayName: 'Firefox', path: '/browsers/firefox.exe', isHeaded: true, isHeadless: false });
  assert.equal(cypressBrowserOf(FIREFOX_DEV).majorVersion, 134, '"134.0b9" still has a major version');
  assert.equal(isFirefoxFamily(ff), true);
  assert.equal(isFirefoxFamily(cypressBrowserOf(INSTALLED[0])), false);
  assert.equal(isBrowser(ff, 'firefox'), true);
  assert.equal(isBrowser(ff, 'Firefox'), true);
  assert.equal(isBrowser(ff, 'chrome'), false);
  assert.equal(isBrowser(ff, { family: 'firefox' }), true);
  assert.equal(isBrowser(ff, { family: 'firefox', channel: 'dev' }), false);
  assert.equal(isBrowser(ff, ['chrome', 'firefox']), true);
  assert.equal(isBrowser(ff, '!firefox'), false);
  assert.equal(isBrowser(ff, ['!chrome', '!edge']), true);
  assert.equal(isBrowser(cypressBrowserOf(INSTALLED[1]), { family: 'chromium' }), true);
});

test('Chromium-only settings explain themselves only where they do less', () => {
  assert.equal(browserSettingNote('video', { family: 'chromium' }), '');
  assert.equal(browserSettingNote('chromeWebSecurity', undefined), '');
  assert.match(browserSettingNote('video', { family: 'firefox' }), /Chromium only.*skip the video/, 'Firefox over BiDi by default');
  assert.equal(browserSettingNote('video', PW_FIREFOX), '', 'Playwright Firefox records video');
  assert.equal(browserSettingNote('video', PW_WEBKIT), '');
  assert.match(browserSettingNote('chromeWebSecurity', { family: 'firefox', engine: 'bidi' }), /Chromium only.*CORS/);
  assert.match(browserSettingNote('chromeWebSecurity', PW_FIREFOX), /CORS/);
  assert.match(browserSettingNote('chromeWebSecurity', PW_WEBKIT), /WebKit has no switch/);
  assert.equal(browserSettingNote('chromeWebSecurity', { family: 'chromium', engine: 'playwright' }), '');
});

const PW_FIREFOX = { id: 'pw-firefox', name: 'firefox', family: 'firefox', channel: 'stable', displayName: 'Playwright Firefox', version: '159.0', path: '/ms-playwright/firefox-1572', engine: 'playwright' };
const PW_WEBKIT = { id: 'pw-webkit', name: 'webkit', family: 'webkit', channel: 'stable', displayName: 'Playwright WebKit', version: '', path: '/ms-playwright/webkit-2388', engine: 'playwright' };

test('Playwright builds: engine, matching, Auto and Cypress.browser', () => {
  assert.equal(engineOf(PW_WEBKIT), 'playwright');
  assert.equal(engineOf(FIREFOX), 'bidi', 'no engine from an older backend: Firefox is BiDi');
  assert.equal(engineOf(INSTALLED[0]), 'cdp');
  const list = [...INSTALLED, FIREFOX, PW_FIREFOX, PW_WEBKIT];
  assert.deepEqual(matchBrowser(list, 'webkit'), { id: 'pw-webkit' });
  assert.deepEqual(matchBrowser(list, 'firefox'), { id: 'firefox' }, 'the installed Firefox before the Playwright build');
  assert.deepEqual(matchBrowser(list, 'pw-firefox'), { id: 'pw-firefox' });
  assert.deepEqual(matchBrowser(list, 'Playwright Firefox'), { id: 'pw-firefox' });
  assert.equal(resolveBrowser([PW_WEBKIT, FIREFOX], AUTO_BROWSER)?.id, 'firefox', 'Auto never prefers a Playwright build');
  assert.equal(resolveBrowser([PW_WEBKIT], AUTO_BROWSER)?.id, 'pw-webkit');
  const wk = cypressBrowserOf(PW_WEBKIT);
  assert.equal(wk.family, 'webkit');
  assert.equal(wk.displayName, 'Playwright WebKit');
  assert.equal(isBrowser(wk, 'webkit'), true);
  assert.equal(isBrowser(wk, { family: 'webkit' }), true);
  assert.equal(browserLabel(PW_FIREFOX), 'Playwright Firefox 159');
});
