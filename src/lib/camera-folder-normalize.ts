/**
 * v1.147.3 — one-off admin sweep: normalize camera-folder names across the
 * footage drives to the canonical vocab (CAM-A..、AUDIO/DRONE/SWITCHER/PHOTO/
 * SCREEN). Crew hand-make folders like "Cam A" / "cam-b" / "Audio" when
 * dumping cards; the merge/detect tooling recognizes them loosely, but the
 * trees read messy and downstream name-matching (sound-merge's CAMERAISH_RE,
 * per-EP camera mirroring) only fully engages on canonical names.
 *
 * Scope: folders inside the two Shared Drives we own footage in — the VIDEO
 * tree (DRIVE_FOOTAGE_ROOT's drive) and the Production Team landing drive.
 * Strictly renames EXACT variants only ("Cam A", "camera-b", "audio"); a name
 * with any extra text ("Cam A ของพี่ต้น") is left alone and reported.
 *
 * Collision-safe: if the parent already has a folder with the canonical name,
 * we do NOT rename (Drive allows same-name siblings — that's how the landing
 * dedupe mess happened); those are reported for manual merge instead.
 */
import { logAudit } from './audit'
import {
  findFoldersByNameContains, getFolderDriveId, listChildFolders, renameDriveItem, hasDriveCredentials,
} from './google-drive'

const PRODUCTION_TEAM_ROOT = process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'

// Exact-variant matchers. Single-letter cam slot (a-z — crew can exceed CAM-D
// on big shoots), optional "era", and AT LEAST one space/dot/underscore/dash
// separator — zero-separator would swallow real words like "camp".
const CAM_RE = /^cam(?:era)?[\s._-]+([a-z])$/i
const SPECIAL_RE = /^(audio|drone|switcher|photo|screen)$/i

/**
 * The canonical name this folder SHOULD have, or null when it's already
 * canonical / not a camera-ish name at all. Pure — unit tested.
 */
export function canonicalCameraName(raw: string): string | null {
  const name = raw.trim()
  const cam = name.match(CAM_RE)
  if (cam) {
    const canon = `CAM-${cam[1].toUpperCase()}`
    return canon === name ? null : canon
  }
  const special = name.match(SPECIAL_RE)
  if (special) {
    const canon = special[1].toUpperCase()
    return canon === name ? null : canon
  }
  return null
}

export type CameraNormalizeResult = {
  dryRun: boolean
  searched: number
  inScope: number
  plan: Array<{ id: string; from: string; to: string }>
  collisions: Array<{ id: string; from: string; to: string; reason: string }>
  renamed: number
  errors: Array<{ id: string; from: string; error: string }>
  skippedOverCap: number
}

const MAX_PER_RUN = 300

export async function runCameraFolderNormalize(opts: { dryRun?: boolean } = {}): Promise<CameraNormalizeResult> {
  const dryRun = !!opts.dryRun
  const result: CameraNormalizeResult = {
    dryRun, searched: 0, inScope: 0, plan: [], collisions: [], renamed: 0, errors: [], skippedOverCap: 0,
  }
  if (!hasDriveCredentials()) throw new Error('Drive ยังไม่ได้ตั้งค่า credentials')

  // Restrict the blast radius to the two Shared Drives we own footage in —
  // an allDrives name search can surface other teams' drives.
  const footageRoot = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  const allowedDrives = new Set<string>()
  for (const rootId of [footageRoot, PRODUCTION_TEAM_ROOT]) {
    if (!rootId) continue
    const driveId = await getFolderDriveId(rootId).catch(() => null)
    if (driveId) allowedDrives.add(driveId)
  }
  if (allowedDrives.size === 0) throw new Error('resolve driveId ของ root ไม่ได้เลย')

  // One search term per vocab family; 'cam' also matches 'camera'. Scoped
  // per-drive (corpora:'drive') and fired in parallel — the terms are broad
  // tokens, and an org-wide allDrives crawl blew the 60s proxy timeout.
  const seen = new Map<string, { id: string; name: string; parents: string[]; driveId?: string | null }>()
  const terms = ['cam', 'audio', 'drone', 'switcher', 'photo', 'screen']
  const searches = await Promise.all(
    Array.from(allowedDrives).flatMap(driveId => terms.map(term => findFoldersByNameContains(term, { driveId }))),
  )
  for (const hits of searches) {
    for (const h of hits) if (!seen.has(h.id)) seen.set(h.id, h)
  }
  result.searched = seen.size

  const candidates = Array.from(seen.values())
    .filter(f => f.driveId && allowedDrives.has(f.driveId))
    .map(f => ({ ...f, to: canonicalCameraName(f.name) }))
    .filter((f): f is typeof f & { to: string } => !!f.to)
  result.inScope = candidates.length

  const toProcess = candidates.slice(0, MAX_PER_RUN)
  result.skippedOverCap = candidates.length - toProcess.length

  // Same-parent canonical-sibling check — list each parent only once.
  // v1.149 — ALSO dedupe within the plan itself: two variants of the same slot
  // under one parent ("Cam A" + "camera-a") both pass the live-sibling check
  // (neither is named CAM-A yet), and renaming both manufactures exactly the
  // same-name-sibling mess this sweep exists to prevent. First one wins; the
  // rest are reported for manual merge.
  const siblingsByParent = new Map<string, Array<{ id: string; name: string }>>()
  const plannedTargets = new Set<string>()
  for (const f of toProcess) {
    const parent = f.parents?.[0]
    let action: 'rename' | 'collision' = 'rename'
    let reason = 'canonical sibling already exists — ต้อง merge มือ'
    if (parent) {
      if (!siblingsByParent.has(parent)) {
        siblingsByParent.set(parent, await listChildFolders(parent).catch(() => []))
      }
      const siblings = siblingsByParent.get(parent)!
      if (siblings.some(s => s.id !== f.id && s.name.trim() === f.to)) action = 'collision'
    }
    const targetKey = `${parent ?? '(no-parent)'} ${f.to}`
    if (action === 'rename' && plannedTargets.has(targetKey)) {
      action = 'collision'
      reason = 'อีก variant ใน run นี้ rename เป็นชื่อเดียวกันแล้ว — ต้อง merge มือ'
    }
    if (action === 'collision') {
      result.collisions.push({ id: f.id, from: f.name, to: f.to, reason })
      continue
    }
    plannedTargets.add(targetKey)
    result.plan.push({ id: f.id, from: f.name, to: f.to })
  }

  if (dryRun) return result

  for (const p of result.plan) {
    try {
      await renameDriveItem(p.id, p.to)
      result.renamed++
    } catch (e: any) {
      result.errors.push({ id: p.id, from: p.from, error: e?.message || String(e) })
    }
  }

  logAudit({
    actorEmail: 'camera-normalize',
    action: 'drive.normalize_camera_folders',
    entityType: 'Drive',
    entityId: 'footage-drives',
    changes: {
      renamed: result.renamed, collisions: result.collisions.length, errors: result.errors.length,
      sample: result.plan.slice(0, 30).map(p => `${p.from} → ${p.to}`),
    },
  })
  return result
}
