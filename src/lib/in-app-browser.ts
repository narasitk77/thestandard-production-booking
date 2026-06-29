// Google's OAuth blocks sign-in from embedded webviews ("Use secure browsers"
// policy → Error 403: disallowed_useragent). For us the common trigger is a link
// shared in LINE/Messenger/etc. opening in that app's in-app browser. We can't
// bypass Google's wall — but we can detect the webview on /login and tell the
// user to open the page in Safari/Chrome first.

const IN_APP_PATTERNS: RegExp[] = [
  /\bLine\//i,                 // LINE (the big one for THE STANDARD)
  /FBAN|FBAV|FB_IAB|FBIOS/i,   // Facebook
  /Messenger/i,                // FB Messenger
  /Instagram/i,                // Instagram
  /MicroMessenger/i,           // WeChat
  /TikTok|musical_ly|Bytedance/i, // TikTok
  /KAKAOTALK/i,                // KakaoTalk
  /; ?wv\)/,                   // generic Android System WebView
]

/** True when the user agent looks like an in-app browser Google's OAuth rejects. */
export function isInAppBrowser(ua: string | null | undefined): boolean {
  if (!ua) return false
  return IN_APP_PATTERNS.some((re) => re.test(ua))
}
