/**
 * v1.171 — one Drive listing per folder per run (design §2.5).
 *
 * Today a single booking is listed by four different sweeps every hour, each
 * paying its own Drive quota for the same answer. DriveView memoises reads for
 * the lifetime of ONE pass and keeps itself honest when a phase writes.
 *
 * ══ THE HARD BOUNDARY ══
 * A cached listing may be used to READ and to PLAN. It may NEVER be the
 * evidence for a destructive action.
 *
 * The cache lives for a whole pass — minutes. Trashing a folder because a
 * several-minute-old listing said it was empty widens the window between
 * "looked empty" and "deleted" from a second to the length of the run. Crew
 * genuinely do upload into an older day's folder mid-pass (the same behaviour
 * that forces merge's −45d lookback), and that footage would go in the bin.
 *
 * So: `freshChildren`/`freshFiles` bypass the cache and are the only reads
 * allowed to precede a trash. `assertNotForDeletion` documents that at the
 * call site.
 */

export interface DriveFile { id: string; name: string; size?: number | string | null; mimeType?: string }
export interface DriveFolder { id: string; name: string }

export interface DriveIO {
  listChildFolders(folderId: string): Promise<DriveFolder[]>
  listFilesInFolder(folderId: string): Promise<DriveFile[]>
}

export interface DriveViewStats {
  folderListCalls: number
  fileListCalls: number
  folderListHits: number
  fileListHits: number
  freshReads: number
  evictions: number
}

export class DriveView {
  private folders = new Map<string, DriveFolder[]>()
  private files = new Map<string, DriveFile[]>()
  /**
   * Folders THIS pass created. They are known-empty because `ensure*` only ever
   * creates, and the per-booking lease keeps other writers out — which is what
   * lets the merge fast path consume one (trash the empty twin, move the whole
   * landing folder over) instead of falling back to a per-file copy. The v1
   * design marked these "never trash", which inverted the guard and would have
   * killed the fast path for every booking, every hour.
   *
   * Consuming one still requires a FRESH read first (§5 rule 4).
   */
  readonly createdThisRun = new Set<string>()
  readonly stats: DriveViewStats = {
    folderListCalls: 0, fileListCalls: 0,
    folderListHits: 0, fileListHits: 0, freshReads: 0, evictions: 0,
  }

  constructor(private io: DriveIO) {}

  async childFolders(folderId: string): Promise<DriveFolder[]> {
    const hit = this.folders.get(folderId)
    if (hit) { this.stats.folderListHits++; return hit }
    this.stats.folderListCalls++
    const rows = await this.io.listChildFolders(folderId)
    this.folders.set(folderId, rows)
    return rows
  }

  async filesIn(folderId: string): Promise<DriveFile[]> {
    const hit = this.files.get(folderId)
    if (hit) { this.stats.fileListHits++; return hit }
    this.stats.fileListCalls++
    const rows = await this.io.listFilesInFolder(folderId)
    this.files.set(folderId, rows)
    return rows
  }

  /** Uncached read. The ONLY kind that may precede a trash. */
  async freshFiles(folderId: string): Promise<DriveFile[]> {
    this.stats.freshReads++
    const rows = await this.io.listFilesInFolder(folderId)
    this.files.set(folderId, rows)   // the fresh answer is also the new truth
    return rows
  }

  async freshChildren(folderId: string): Promise<DriveFolder[]> {
    this.stats.freshReads++
    const rows = await this.io.listChildFolders(folderId)
    this.folders.set(folderId, rows)
    return rows
  }

  // ── keeping the view honest after a write ─────────────────────────────────

  noteCreatedFolder(parentId: string, folder: DriveFolder): void {
    this.createdThisRun.add(folder.id)
    const kids = this.folders.get(parentId)
    if (kids && !kids.some(k => k.id === folder.id)) kids.push(folder)
    // A folder we just created is empty — record that rather than making the
    // next reader pay for a listing to learn it.
    if (!this.files.has(folder.id)) this.files.set(folder.id, [])
  }

  noteMovedFolder(folderId: string, fromParent: string | null, toParent: string | null): void {
    if (fromParent) {
      const from = this.folders.get(fromParent)
      if (from) this.folders.set(fromParent, from.filter(f => f.id !== folderId))
    }
    // We know the id moved but not its name in the new listing — evict rather
    // than invent an entry.
    if (toParent) this.evict(toParent)
  }

  noteTrashed(folderId: string, parentId: string | null): void {
    this.folders.delete(folderId)
    this.files.delete(folderId)
    this.createdThisRun.delete(folderId)
    if (parentId) {
      const kids = this.folders.get(parentId)
      if (kids) this.folders.set(parentId, kids.filter(f => f.id !== folderId))
    }
  }

  noteFilesMoved(fromFolder: string, toFolder: string): void {
    this.evict(fromFolder)
    this.evict(toFolder)
  }

  /** Conservative: a write whose exact effect we cannot model drops the entry. */
  evict(folderId: string): void {
    if (this.folders.delete(folderId) || this.files.delete(folderId)) this.stats.evictions++
  }

  /**
   * Call this at any site that is about to trash something, passing the reason.
   * It throws if handed a cached list — the type system cannot express "this
   * array came from a fresh read", so the check is a deliberate speed bump that
   * makes the rule visible in the diff.
   */
  assertNotForDeletion(source: 'cached'): never
  assertNotForDeletion(source: 'fresh'): void
  assertNotForDeletion(source: 'cached' | 'fresh'): void {
    if (source === 'cached') {
      throw new Error('DriveView: a cached listing must never justify a trash — re-read with freshFiles/freshChildren first')
    }
  }
}
