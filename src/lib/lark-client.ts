// v1.212 — Lark (Feishu) Open API client: tenant token, Drive upload, Base records.
//
// This is a SECOND, larger door into Lark than src/lib/notify.ts. That one is a
// custom-bot webhook: one URL, no identity, text only — it cannot write a file
// or a record. Writing into Lark Drive or a Lark Base needs a **self-built app**
// (Developer Console → Create app → Add scopes → Publish → admin approves), so
// this module carries app_id/app_secret and mints a tenant_access_token.
//
// ⚠️ THE ONE RULE, inherited from notify.ts and paid for in production more than
// once: **Lark answers HTTP 200 for requests it REFUSED.** The real status is
// `code` in the JSON body (0 = ok). `res.ok` here means "the HTTP call happened",
// nothing more. Every helper below goes through larkFetch(), which fails closed
// on a non-zero code, an unparseable body, or a body with no `code` at all.
// Reporting an upload as successful when Lark dropped it is the exact failure
// this codebase keeps re-learning (v1.186: บันทึกที่รายงานไม่ตรงของจริง).

const DEFAULT_BASE = 'https://open.larksuite.com'

export class LarkError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly httpStatus: number,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'LarkError'
  }
}

export function larkBaseUrl(): string {
  // larksuite.com = Lark (international, incl. TH). feishu.cn = the China
  // deployment. An app created in one console does not exist in the other, so
  // this is a hard fork, not a mirror — hence an env var rather than a guess.
  return (process.env.LARK_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, '')
}

export function larkAppConfigured(): boolean {
  return Boolean(process.env.LARK_APP_ID?.trim() && process.env.LARK_APP_SECRET?.trim())
}

/* ───────────────────────────── tenant access token ─────────────────────────── */

let cachedToken: { value: string; expiresAtMs: number } | null = null

/** Reset the in-process token cache. Tests + the preflight endpoint use it. */
export function resetLarkTokenCache(): void {
  cachedToken = null
}

/**
 * Mint (or reuse) a tenant_access_token. Lark issues these for ~2h; we refresh
 * 5 minutes early so a long export cannot straddle an expiry mid-run.
 */
export async function larkTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs) return cachedToken.value

  const appId = process.env.LARK_APP_ID?.trim()
  const appSecret = process.env.LARK_APP_SECRET?.trim()
  if (!appId || !appSecret) {
    throw new LarkError(
      'LARK_APP_ID / LARK_APP_SECRET not set — the export needs a self-built Lark app, not the notify webhook',
      null, 0, 'auth/v3/tenant_access_token/internal',
    )
  }

  const endpoint = '/open-apis/auth/v3/tenant_access_token/internal'
  const res = await fetch(`${larkBaseUrl()}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const raw = await res.text().catch(() => '')
  let body: any = null
  try { body = JSON.parse(raw) } catch { /* handled next */ }
  if (!body || typeof body.code !== 'number') {
    throw new LarkError(`unreadable token response: ${raw.slice(0, 300)}`, null, res.status, endpoint)
  }
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new LarkError(`token refused (code ${body.code}): ${String(body.msg || '').slice(0, 200)}`, body.code, res.status, endpoint)
  }
  const ttlSec = Number(body.expire) > 0 ? Number(body.expire) : 7200
  cachedToken = { value: body.tenant_access_token, expiresAtMs: Date.now() + Math.max(60, ttlSec - 300) * 1000 }
  return cachedToken.value
}

/* ──────────────────────────────── request core ─────────────────────────────── */

type FetchOpts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** Pre-built multipart body; when set, `body` is ignored and no JSON header is sent. */
  form?: FormData
  timeoutMs?: number
}

/** Lark rate-limit codes worth a retry rather than a failed run. */
const RETRYABLE_CODES = new Set([99991400, 1254291, 1061045])

/**
 * One authenticated Open API call. Returns `data` on success; throws LarkError
 * otherwise — including for HTTP 200 with a non-zero `code`.
 */
export async function larkFetch<T = any>(endpoint: string, opts: FetchOpts = {}): Promise<T> {
  const token = await larkTenantToken()
  const url = `${larkBaseUrl()}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
  const method = opts.method || (opts.body || opts.form ? 'POST' : 'GET')

  const attempt = async (): Promise<T> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let payload: BodyInit | undefined
    if (opts.form) {
      payload = opts.form as unknown as BodyInit
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(opts.body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000)
    let res: Response
    try {
      res = await fetch(url, { method, headers, body: payload, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    const raw = await res.text().catch(() => '')
    let body: any = null
    try { body = JSON.parse(raw) } catch { /* handled next */ }

    // A body we cannot read is NOT proof of anything — fail closed.
    if (!body || typeof body.code !== 'number') {
      throw new LarkError(
        `${res.status} unreadable response: ${raw.slice(0, 300)}`,
        null, res.status, endpoint,
      )
    }
    if (body.code !== 0) {
      throw new LarkError(
        `refused (code ${body.code}): ${String(body.msg || '').slice(0, 300)}`,
        body.code, res.status, endpoint,
      )
    }
    return (body.data ?? body) as T
  }

  // Two retries with backoff, ONLY for rate limits. Everything else (missing
  // scope, wrong token, folder not shared with the app) fails immediately —
  // retrying a permission error just delays the truthful error message.
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      const retryable = err instanceof LarkError && err.code !== null && RETRYABLE_CODES.has(err.code)
      if (!retryable || i === 2) break
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

/* ─────────────────────────────── Lark Drive ────────────────────────────────── */

export const DRIVE_UPLOAD_ALL_LIMIT = 20 * 1024 * 1024 // Lark's documented cap for upload_all

/**
 * Upload one file into a Lark Drive folder.
 *
 * `folderToken` is the token in the folder URL (…/drive/folder/<token>), and the
 * app must be a collaborator on that folder with edit rights — an app with the
 * right SCOPE but no share on the folder gets a permission error, which is the
 * most common first-day failure. Scope needed: `drive:drive` (or `drive:file`).
 */
export async function larkUploadFile(args: {
  folderToken: string
  fileName: string
  content: Buffer
}): Promise<{ fileToken: string }> {
  if (args.content.length === 0) throw new LarkError('refusing to upload an empty snapshot', null, 0, 'drive/v1/files/upload_all')
  if (args.content.length > DRIVE_UPLOAD_ALL_LIMIT) {
    // Deliberately a hard error, not a silent truncation: the archive is the
    // whole point, and half an archive that reports success is worse than a
    // loud failure that a human fixes.
    throw new LarkError(
      `snapshot is ${(args.content.length / 1048576).toFixed(1)}MB, over Lark's 20MB upload_all limit — needs the chunked upload path`,
      null, 0, 'drive/v1/files/upload_all',
    )
  }
  const form = new FormData()
  form.append('file_name', args.fileName)
  form.append('parent_type', 'explorer')
  form.append('parent_node', args.folderToken)
  form.append('size', String(args.content.length))
  form.append('file', new Blob([new Uint8Array(args.content)]), args.fileName)

  const data = await larkFetch<{ file_token: string }>('/open-apis/drive/v1/files/upload_all', {
    form,
    timeoutMs: 300_000,
  })
  if (!data?.file_token) {
    throw new LarkError('upload returned code 0 but no file_token', 0, 200, 'drive/v1/files/upload_all')
  }
  return { fileToken: data.file_token }
}

/* ──────────────────────────────── Lark Base ────────────────────────────────── */

// Bitable field type ids (Lark Open API). Text covers anything we cannot type
// confidently — a wrong type is a hard write error, a stringified number is not.
export const LARK_FIELD_TEXT = 1
export const LARK_FIELD_NUMBER = 2
export const LARK_FIELD_DATETIME = 5
export const LARK_FIELD_CHECKBOX = 7

export type LarkTable = { table_id: string; name: string }
export type LarkField = { field_id: string; field_name: string; type: number }

export async function larkListTables(appToken: string): Promise<LarkTable[]> {
  const out: LarkTable[] = []
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) })
    const data = await larkFetch<{ items?: LarkTable[]; page_token?: string; has_more?: boolean }>(
      `/open-apis/bitable/v1/apps/${appToken}/tables?${qs}`,
    )
    out.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token : undefined
  } while (pageToken)
  return out
}

export async function larkCreateTable(
  appToken: string,
  name: string,
  fields: { field_name: string; type: number }[],
): Promise<string> {
  const data = await larkFetch<{ table_id: string }>(`/open-apis/bitable/v1/apps/${appToken}/tables`, {
    body: { table: { name, default_view_name: 'Grid', fields } },
  })
  return data.table_id
}

export async function larkListFields(appToken: string, tableId: string): Promise<LarkField[]> {
  const out: LarkField[] = []
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) })
    const data = await larkFetch<{ items?: LarkField[]; page_token?: string; has_more?: boolean }>(
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${qs}`,
    )
    out.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token : undefined
  } while (pageToken)
  return out
}

export async function larkCreateField(
  appToken: string, tableId: string, field: { field_name: string; type: number },
): Promise<void> {
  await larkFetch(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { body: field })
}

/** Every record_id currently in the table — the delete list for a full refresh. */
export async function larkListRecordIds(appToken: string, tableId: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const qs = new URLSearchParams({ page_size: '500', ...(pageToken ? { page_token: pageToken } : {}) })
    const data = await larkFetch<{ items?: { record_id: string }[]; page_token?: string; has_more?: boolean }>(
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${qs}`,
    )
    ids.push(...(data.items || []).map((r) => r.record_id))
    pageToken = data.has_more ? data.page_token : undefined
  } while (pageToken)
  return ids
}

const DELETE_BATCH = 500
const CREATE_BATCH = 500

export async function larkDeleteRecords(appToken: string, tableId: string, recordIds: string[]): Promise<number> {
  let done = 0
  for (let i = 0; i < recordIds.length; i += DELETE_BATCH) {
    const chunk = recordIds.slice(i, i + DELETE_BATCH)
    await larkFetch(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
      body: { records: chunk },
    })
    done += chunk.length
  }
  return done
}

export async function larkCreateRecords(
  appToken: string, tableId: string, records: Record<string, unknown>[],
): Promise<number> {
  let done = 0
  for (let i = 0; i < records.length; i += CREATE_BATCH) {
    const chunk = records.slice(i, i + CREATE_BATCH)
    await larkFetch(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      body: { records: chunk.map((fields) => ({ fields })) },
    })
    done += chunk.length
  }
  return done
}
