// In-memory Drive for testing the folder-moving LOGIC without touching Google.
//
// Why this exists: every folder bug that bit us on 2026-07-22/23 lived in the
// code that talks to Drive (video-merge's mirrorMove, the folder resolvers) —
// and none of it had a test, because the whole surface was `await
// someDriveApiCall()`. The pure helpers were unit-tested; the orchestration
// that CALLS them was not, so the bugs (empty-skeleton move, EP-split by
// exact-name matching) shipped and were found by the crew.
//
// FakeDrive models the tree faithfully enough to replay those bugs as
// regression tests: folders + files with parents, move = reparent, trash =
// tombstone, "empty" = no live children (matching isFolderEmpty's real
// semantics: a folder holding only subfolders is NOT empty).
//
// It exposes methods with the SAME signatures as the google-drive.ts functions
// mirrorMove imports, so a test can mock.module('./google-drive') with an
// instance and run the real algorithm against it.

export interface FakeFolder { id: string; name: string; parent: string | null; trashed: boolean; createdTime: string }
export interface FakeFile { id: string; name: string; parent: string | null; size: string | null; trashed: boolean }

export class FakeDrive {
  folders = new Map<string, FakeFolder>()
  files = new Map<string, FakeFile>()
  private seq = 0
  private clock = 0

  /** Create a folder; returns its id. Root is created with parent=null. */
  mkFolder(name: string, parent: string | null): string {
    const id = `fld_${++this.seq}`
    // deterministic, monotonic createdTime so oldest-match logic is testable
    this.clock += 1000
    this.folders.set(id, { id, name, parent, trashed: false, createdTime: new Date(this.clock).toISOString() })
    return id
  }

  mkFile(name: string, parent: string, size: number | null = 1): string {
    const id = `fil_${++this.seq}`
    this.files.set(id, { id, name, parent, size: size == null ? null : String(size), trashed: false })
    return id
  }

  private liveFolderChildren(parentId: string): FakeFolder[] {
    return Array.from(this.folders.values()).filter(f => f.parent === parentId && !f.trashed)
      .sort((a, b) => a.createdTime.localeCompare(b.createdTime))
  }
  private liveFileChildren(parentId: string): FakeFile[] {
    return Array.from(this.files.values()).filter(f => f.parent === parentId && !f.trashed)
  }

  // ── the google-drive.ts surface mirrorMove imports ────────────────────────

  listFilesInFolder = async (parentId: string) =>
    this.liveFileChildren(parentId).map(f => ({ id: f.id, name: f.name, size: f.size }))

  listChildFolders = async (parentId: string) =>
    this.liveFolderChildren(parentId).map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime }))

  findChildFolder = async (parentId: string, name: string) =>
    this.liveFolderChildren(parentId).find(f => f.name === name)?.id ?? null

  // A folder is empty when it has NO live children of any kind — matching
  // isFolderEmpty (subfolders count, so an EP folder holding CAM-A is NOT empty).
  isFolderEmpty = async (folderId: string) =>
    this.liveFolderChildren(folderId).length === 0 && this.liveFileChildren(folderId).length === 0

  trashDriveItem = async (id: string) => {
    const fld = this.folders.get(id); if (fld) { fld.trashed = true; return }
    const fil = this.files.get(id); if (fil) fil.trashed = true
  }

  // moveFileToFolder moves a FILE **or a FOLDER** (Drive treats folders as
  // files; mirrorMove's fast path relocates whole folders through it).
  moveFileToFolder = async (id: string, target: string, _removeParent: string) => {
    const fld = this.folders.get(id); if (fld) { fld.parent = target; return }
    const fil = this.files.get(id); if (fil) { fil.parent = target; return }
    throw new Error(`move: unknown id ${id}`)
  }

  ensureFolderPath = async (rootId: string, segments: string[]) => {
    let parent = rootId
    for (const seg of segments) {
      const existing = this.liveFolderChildren(parent).find(f => f.name === seg)
      parent = existing ? existing.id : this.mkFolder(seg, parent)
    }
    return parent
  }

  isFolderAlive = async (id: string) => this.folders.has(id) && !this.folders.get(id)!.trashed
  hasDriveCredentials = () => true

  // ── test assertions helpers ───────────────────────────────────────────────

  /** Live child folder names of a parent (for asserting the resulting tree). */
  childFolderNames(parentId: string): string[] {
    return this.liveFolderChildren(parentId).map(f => f.name)
  }
  /** Live file names anywhere under a subtree (recursive). */
  filesUnder(rootId: string): string[] {
    const out: string[] = []
    const walk = (id: string) => {
      for (const f of this.liveFileChildren(id)) out.push(f.name)
      for (const c of this.liveFolderChildren(id)) walk(c.id)
    }
    walk(rootId)
    return out.sort()
  }
}
