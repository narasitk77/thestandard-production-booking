import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInAppBrowser } from '../in-app-browser'

test('isInAppBrowser: flags in-app webviews Google OAuth blocks', () => {
  // LINE (iOS) — the real one from the incident
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Line/14.6.0'), true)
  // Facebook in-app
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/450.0]'), true)
  // Messenger
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile MessengerForiOS'), true)
  // Instagram
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Instagram 300.0'), true)
  // generic Android System WebView
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36'), true)
})

test('isInAppBrowser: passes real browsers (no false positives)', () => {
  // Safari iOS
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), false)
  // Chrome Android (note: NOT a "wv" build)
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'), false)
  // Chrome desktop
  assert.equal(isInAppBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'), false)
  assert.equal(isInAppBrowser(''), false)
  assert.equal(isInAppBrowser(null), false)
})
