# Security Specification — RenLite v2 (Phase 1)

## Data Invariants
1. **Hotels (`/hotels/{hotelId}`)**: Hotel documents can only be created or updated by the owning hotel administrator (`hotelId == request.auth.uid`) or a verified admin. Guests may read a specific hotel document (`get`) only when signed in and cannot list all hotels. `locations` is bounded to 500 entries and `emergencyPhone` to 50 chars.
2. **Sessions (`/hotels/{hotelId}/sessions/{sessionId}`)**: Every session must reference an existing parent hotel (`/hotels/{hotelId}`), bind `guestUid` immutably to `request.auth.uid` on creation, start in `active` status, and use server timestamps (`request.time`). Guests can only read/update their own sessions (`guestUid == request.auth.uid`), cannot modify `completed` sessions, cannot assign `staff_controlled` or `completed`, and cannot override an active `staff_controlled` session back to `active`.
3. **Messages (`/hotels/{hotelId}/sessions/{sessionId}/messages/{messageId}`)**: Messages must reference an existing parent hotel and session, use server timestamps (`request.time`), enforce valid `sender` values (`guest`, `ai`, `staff`, `system`), enforce `guestUid == request.auth.uid` for guest-authored messages, and limit text length to 5000 characters. Core message fields (`sender`, `text`, `timestamp`, `guestUid`, `staffUid`) are immutable; translation metadata (`staffText`, `originalLanguage`, `translatedToLanguage`) may only be attached when absent.
4. **Requests (`/hotels/{hotelId}/requests/{requestId}`)**: Service requests must reference an existing session owned by the creating user (or hotel owner), start in `pending` or `escalated` status, enforce server timestamps (`createdAt == request.time`, `lastUpdated == request.time`), and preserve `sessionId` and `createdAt` immutably. Guests may backfill `roomNumber`, increment pending `quantity`, or mark a `completed` request as `reopened`; hotel owners/admins manage fulfillment transitions.

## Dirty Dozen Adversarial Payloads
1. Unauthenticated read/write to `/hotels/hotel1`.
2. Oversized document ID (`> 128` chars or invalid characters) on `/hotels/{hotelId}`.
3. Shadow field injection (`{ ..., isVerified: true }`) on `/hotels/{hotelId}` creation.
4. Spoofed `guestUid` on session creation (`guestUid != request.auth.uid`).
5. Orphaned session creation referencing a non-existent `/hotels/missing-hotel`.
6. Client-forged timestamp (`lastUpdatedAt != request.time`) on session, message, or request write.
7. Cross-guest session read/update where `existing().guestUid != request.auth.uid`.
8. Unverified email admin spoof (`email_verified == false`).
9. Guest attempting to set `status: 'staff_controlled'` or `status: 'completed'` on session update, or overwrite `staff_controlled`.
10. Oversized message text (`> 5000` chars) or oversized `locations` array (`> 500`).
11. Guest attempting to mark their own service request `completed` or tamper with another guest's request.
12. Unbounded `list` query on `/hotels` or cross-tenant `list` on `/hotels/{otherHotel}/requests`.
