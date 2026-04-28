// THE STANDARD physical rooms (TSD building) — synced from Google Workspace resource calendars
export interface Location {
  id: string
  name: string          // display label, e.g. "Studio 1"
  fullName: string      // "Studio 1 (TSD)" or "Meeting Room 2 (TSD, 4/F)"
  building?: string
  floor?: string
  capacity?: number
  group: 'STUDIO' | 'A' | 'B' | 'EXTERNAL'
}

export const LOCATIONS: Location[] = [
  // ── Studio
  { id: 'tsd-studio-1',  name: 'Studio 1',         fullName: 'Studio 1 (TSD)',                    building: 'TSD', floor: '',     capacity: 20, group: 'STUDIO' },
  { id: 'tsd-studio-2',  name: 'Studio 2',         fullName: 'Studio 2 (TSD, 1/F)',               building: 'TSD', floor: '1/F',  capacity: 20, group: 'STUDIO' },

  // ── A series rooms (TSD building)
  { id: 'tsd-a-hall-1f', name: 'Hall (1/F)',       fullName: 'A · Hall (TSD, 1/F)',               building: 'TSD', floor: '1/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-lounge-2f', name: 'Lounge (2/F)',   fullName: 'A · Lounge (TSD, 2/F)',             building: 'TSD', floor: '2/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-mr1-5f',  name: 'Meeting Room 1 (5/F)', fullName: 'A · Meeting Room 1 (TSD, 5/F)', building: 'TSD', floor: '5/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-mr2-4f',  name: 'Meeting Room 2 (4/F)', fullName: 'A · Meeting Room 2 (TSD, 4/F)', building: 'TSD', floor: '4/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-mr3-3f',  name: 'Meeting Room 3 (3/F)', fullName: 'A · Meeting Room 3 (TSD, 3/F)', building: 'TSD', floor: '3/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-pod1-5f', name: 'Pod 1 (5/F)',      fullName: 'A · Pod 1 (TSD, 5/F)',              building: 'TSD', floor: '5/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-pod2-5f', name: 'Pod 2 (5/F)',      fullName: 'A · Pod 2 (TSD, 5/F)',              building: 'TSD', floor: '5/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-pod3-5f', name: 'Pod 3 (5/F)',      fullName: 'A · Pod 3 (TSD, 5/F)',              building: 'TSD', floor: '5/F',  capacity: 6,  group: 'A' },
  { id: 'tsd-a-war-4f',  name: 'War Room (4/F)',   fullName: 'A · War Room (TSD, 4/F)',           building: 'TSD', floor: '4/F',  capacity: 10, group: 'A' },

  // ── B series rooms (TSD building, 5/F)
  { id: 'tsd-b-1-5f',    name: 'B-1 (5/F)',        fullName: 'B · 1 (TSD, 5/F)',                  building: 'TSD', floor: '5/F',  capacity: 6,  group: 'B' },
  { id: 'tsd-b-2-5f',    name: 'B-2 (5/F)',        fullName: 'B · 2 (TSD, 5/F)',                  building: 'TSD', floor: '5/F',  capacity: 6,  group: 'B' },
  { id: 'tsd-b-3-5f',    name: 'B-3 (5/F)',        fullName: 'B · 3 (TSD, 5/F)',                  building: 'TSD', floor: '5/F',  capacity: 6,  group: 'B' },
  { id: 'tsd-b-hall-5f', name: 'B-Hall (5/F)',     fullName: 'B · Hall (TSD, 5/F)',               building: 'TSD', floor: '5/F',  capacity: 10, group: 'B' },

  // ── External
  { id: 'external-on-location', name: 'On Location (specify)',   fullName: 'On Location',  group: 'EXTERNAL' },
  { id: 'external-remote',      name: 'Remote / Online',         fullName: 'Remote / Online', group: 'EXTERNAL' },
  { id: 'external-event',       name: 'External Event Venue',    fullName: 'External Event', group: 'EXTERNAL' },
  { id: 'external-other',       name: 'Other (specify)',         fullName: 'Other', group: 'EXTERNAL' },
]

export const LOCATION_GROUPS: { key: 'STUDIO' | 'A' | 'B' | 'EXTERNAL'; label: string }[] = [
  { key: 'STUDIO',   label: 'Studio (TSD)' },
  { key: 'A',        label: 'A · Meeting Rooms / Pods (TSD)' },
  { key: 'B',        label: 'B · Rooms (TSD, 5/F)' },
  { key: 'EXTERNAL', label: 'External / Other' },
]

export function findLocation(idOrName: string | null | undefined): Location | undefined {
  if (!idOrName) return undefined
  return LOCATIONS.find(l => l.id === idOrName || l.name === idOrName || l.fullName === idOrName)
}

export function locationNeedsManualText(id: string): boolean {
  // External venues that need a manual specification field
  return id === 'external-on-location' || id === 'external-event' || id === 'external-other'
}
