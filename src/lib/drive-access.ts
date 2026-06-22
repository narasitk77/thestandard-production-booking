/**
 * v1.84 — when we impersonate the uploader (domain-wide delegation) to make
 * Drive show the real person as a file's creator, a user who isn't a member of
 * the Shared Drive can't see/write the target folder. That surfaces as a 403
 * (permission) or 404 (notFound) from the Drive API. The upload path treats
 * those as "fall back to the default service subject" so uploads never break;
 * any OTHER error is a genuine failure and must propagate.
 *
 * Conservative by design: misclassifying a real access error as "not an access
 * error" would 502 an upload that should have fallen back, so we match broadly
 * (status code + reason + message).
 */
export function isDriveAccessError(e: any): boolean {
  const code = Number(e?.code ?? e?.status ?? e?.response?.status)
  if (code === 403 || code === 404) return true
  // Reason field is structured — safe to match "notfound" here.
  const reason = String(e?.errors?.[0]?.reason || '').toLowerCase()
  if (['permission', 'insufficient', 'notfound', 'forbidden'].some(k => reason.includes(k))) return true
  // Message is free text — only match unambiguous access phrases. (Deliberately
  // NOT "not found": "getaddrinfo ENOTFOUND" — a DNS failure — contains it.)
  const msg = String(e?.message || '').toLowerCase()
  return ['permission', 'insufficient', 'forbidden', 'does not have access'].some(k => msg.includes(k))
}
