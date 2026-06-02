/**
 * ONE-TIME INTERNAL: Enable Google Drive API in GCP project.
 * Call once via: POST https://probook.xtec9.xyz/api/internal/enable-drive
 * Delete this file after use.
 */
import { NextResponse } from 'next/server'
import { google } from 'googleapis'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
      : {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          project_id: 'production-booking-494605',
        }
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const su = google.serviceusage({ version: 'v1', auth })
    const projectId = credentials.project_id || 'production-booking-494605'
    const res = await su.services.enable({
      name: `projects/${projectId}/services/drive.googleapis.com`,
    })
    return NextResponse.json({ ok: true, httpStatus: res.status, operation: res.data })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 })
  }
}
