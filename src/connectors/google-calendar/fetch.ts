// Pulls expanded event instances from Google Calendar.
//
// singleEvents=true expands recurring rules into individual instances —
// matches the events table model (one row per scheduled block, not one
// row per recurrence rule). orderBy=startTime requires singleEvents=true
// per Google's API.

export interface GoogleEvent {
    id: string
    status: 'confirmed' | 'tentative' | 'cancelled'
    summary?: string
    start?: { dateTime?: string; date?: string; timeZone?: string }
    end?: { dateTime?: string; date?: string; timeZone?: string }
    updated?: string
    location?: string
    attendees?: GoogleAttendee[]
}

export interface GoogleAttendee {
    email?: string
    displayName?: string
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted'
    organizer?: boolean
    self?: boolean
}

export interface FetchEventsArgs {
    accessToken: string
    calendarId: string
    timeMin: string
    timeMax: string
}

const API_BASE = 'https://www.googleapis.com/calendar/v3'
const PAGE_SIZE = 250

export async function fetchCalendarEvents(args: FetchEventsArgs): Promise<GoogleEvent[]> {
    const events: GoogleEvent[] = []
    let pageToken: string | undefined

    do {
        const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(args.calendarId)}/events`)
        url.searchParams.set('singleEvents', 'true')
        url.searchParams.set('orderBy', 'startTime')
        url.searchParams.set('timeMin', args.timeMin)
        url.searchParams.set('timeMax', args.timeMax)
        url.searchParams.set('maxResults', String(PAGE_SIZE))
        if (pageToken) url.searchParams.set('pageToken', pageToken)

        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${args.accessToken}` },
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`google calendar ${res.status}: ${text}`)
        }
        const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string }
        if (json.items) events.push(...json.items)
        pageToken = json.nextPageToken
    } while (pageToken)

    return events
}
