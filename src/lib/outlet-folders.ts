/**
 * Outlet code → folder name mapping.
 *
 * The Shared Drive root (`DRIVE_FOOTAGE_ROOT`) and the Wasabi key prefix
 * (`WASABI_KEY_PREFIX`) both lay out files per-outlet. The folder names
 * in those storages don't always match the 3-letter Outlet.code in our
 * DB — historical naming choices the team made before this app existed.
 * This module is the single source of truth that the upload code consults
 * when computing the destination path.
 *
 * Confirmed with narasit.k on 2026-05-27:
 *   AGN → "Advertorial"          (NOT "Content Agency" which is Outlet.name)
 *   TSS → "the Secret Sauce"     (lowercase 'the' — intentional)
 *   POP → "THE STANDARD POP"     (NOT just "POP")
 *   NWS → "News"
 *   WLT → "Wealth"
 *   SPT → "Sport"
 *   POD → "Podcast"
 *   KND → "KND"
 *   LIF → "LIFE"
 *
 * If a new outlet is added later, append a line here AND rename the
 * Drive folder + Wasabi prefix to match. The inspect script
 * (`scripts/inspect-drive-outlets.ts`) will flag any mismatch.
 */

const OUTLET_FOLDER_BY_CODE: Record<string, string> = {
  AGN: 'Advertorial',
  TSS: 'the Secret Sauce',
  POP: 'THE STANDARD POP',
  NWS: 'News',
  WLT: 'Wealth',
  SPT: 'Sport',
  POD: 'Podcast',
  KND: 'KND',
  LIF: 'LIFE',
}

/**
 * Resolve the storage folder name for an outlet code. Falls back to the
 * raw code when the mapping is missing — better than silently using the
 * wrong folder, and the inspect script + the upload UI surface the gap
 * for triage.
 */
export function outletFolderName(outletCode: string): string {
  return OUTLET_FOLDER_BY_CODE[outletCode.toUpperCase()] ?? outletCode.toUpperCase()
}

/**
 * Does this code have a confirmed mapping, or are we just falling back
 * to the code itself? Used by the upload init endpoint to warn the
 * operator (or refuse) when an unmapped outlet attempts an upload.
 */
export function hasOutletFolderMapping(outletCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTLET_FOLDER_BY_CODE, outletCode.toUpperCase())
}

/**
 * Build the per-file storage path components that BOTH Wasabi and Drive
 * use. Single source of truth — if we ever change the layout (e.g. add
 * year segment, swap order), it changes in one place.
 *
 *   buildStoragePath('AGN', 'AGN-260423-EVT-01', 'Cam1', '001.mp4')
 *     → ['Advertorial', 'AGN-260423-EVT-01', 'Cam1', '001.mp4']
 *
 * Caller joins with '/' for Wasabi key, or walks the segments with
 * `ensureFolderPath` for Drive.
 */
export function buildStoragePath(
  outletCode: string,
  bookingCode: string,
  camera: string,
  filename: string,
): string[] {
  return [
    outletFolderName(outletCode),
    bookingCode,
    camera,
    filename,
  ]
}
