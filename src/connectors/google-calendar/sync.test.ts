import { describe, expect, it } from 'vitest'
import { mapEvents } from './sync.js'
import type { GoogleEvent } from './fetch.js'

describe('mapEvents', () => {
    it('maps a normal timed event', () => {
        const events: GoogleEvent[] = [
            {
                id: 'abc123',
                status: 'confirmed',
                summary: 'Coffee with Jess',
                start: { dateTime: '2026-05-02T15:00:00-07:00' },
                end: { dateTime: '2026-05-02T16:00:00-07:00' },
            },
        ]
        const { mapped, skipped } = mapEvents(events)
        expect(skipped).toBe(0)
        expect(mapped).toEqual([
            {
                external_id: 'abc123',
                title: 'Coffee with Jess',
                start_at: '2026-05-02T15:00:00-07:00',
                end_at: '2026-05-02T16:00:00-07:00',
                attendees: [],
                location: null,
            },
        ])
    })

    it('captures location and non-self attendees', () => {
        const events: GoogleEvent[] = [
            {
                id: 'meet-1',
                status: 'confirmed',
                summary: 'Lease signing',
                start: { dateTime: '2026-05-04T18:00:00-07:00' },
                end: { dateTime: '2026-05-04T19:00:00-07:00' },
                location: '1234 Mission St, San Francisco',
                attendees: [
                    { email: 'me@example.com', self: true, displayName: 'Me' },
                    { email: 'jordan@example.com', displayName: 'Jordan Park' },
                    { email: 'broker@example.com' },
                ],
            },
        ]
        const { mapped } = mapEvents(events)
        expect(mapped[0]?.attendees).toEqual(['Jordan Park', 'broker@example.com'])
        expect(mapped[0]?.location).toBe('1234 Mission St, San Francisco')
    })

    it('returns empty attendees and null location when google omits them', () => {
        const events: GoogleEvent[] = [
            {
                id: 'solo',
                status: 'confirmed',
                summary: 'Heads-down work',
                start: { dateTime: '2026-05-02T09:00:00-07:00' },
                end: { dateTime: '2026-05-02T11:00:00-07:00' },
            },
        ]
        const { mapped } = mapEvents(events)
        expect(mapped[0]?.attendees).toEqual([])
        expect(mapped[0]?.location).toBeNull()
    })

    it('promotes all-day dates to UTC midnight', () => {
        const events: GoogleEvent[] = [
            {
                id: 'all-day-1',
                status: 'confirmed',
                summary: 'Dad birthday',
                start: { date: '2026-05-10' },
                end: { date: '2026-05-11' },
            },
        ]
        const { mapped } = mapEvents(events)
        expect(mapped[0]).toMatchObject({
            start_at: '2026-05-10T00:00:00Z',
            end_at: '2026-05-11T00:00:00Z',
            attendees: [],
            location: null,
        })
    })

    it('drops cancelled events', () => {
        const events: GoogleEvent[] = [
            {
                id: 'gone',
                status: 'cancelled',
                start: { dateTime: '2026-05-02T15:00:00-07:00' },
            },
        ]
        const { mapped, skipped } = mapEvents(events)
        expect(mapped).toHaveLength(0)
        expect(skipped).toBe(1)
    })

    it('drops events with no start', () => {
        const events: GoogleEvent[] = [
            { id: 'broken', status: 'confirmed', summary: 'no start' },
        ]
        const { mapped, skipped } = mapEvents(events)
        expect(mapped).toHaveLength(0)
        expect(skipped).toBe(1)
    })

    it('falls back to "(no title)" when summary is missing', () => {
        const events: GoogleEvent[] = [
            {
                id: 'untitled',
                status: 'confirmed',
                start: { dateTime: '2026-05-02T15:00:00-07:00' },
            },
        ]
        const { mapped } = mapEvents(events)
        expect(mapped[0]?.title).toBe('(no title)')
    })

    it('keeps end_at null when google omits it', () => {
        const events: GoogleEvent[] = [
            {
                id: 'point',
                status: 'confirmed',
                summary: 'Doorbell',
                start: { dateTime: '2026-05-02T15:00:00-07:00' },
            },
        ]
        const { mapped } = mapEvents(events)
        expect(mapped[0]?.end_at).toBeNull()
    })
})
