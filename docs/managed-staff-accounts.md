# Managed staff accounts — implementation contract

Product promise: sign up, add hotel, invite team, generate QR codes. Existing guest and owner flows must remain unchanged.

## UX
- Owner signs in using verified email; existing email invitations remain available.
- Admin creates manager/associate with display name, hotel-scoped case-insensitive username, department, optional contact email. Hotel code is an opaque unique property alias, not a password. Remember hotel code only on the device.
- Generate a unique cryptographically random temporary credential, show once, copy for private delivery; never use a universal password. Prefer a one-time activation link; email delivery is optional and must not send a reusable password. Expire activation after 72 hours; rate limit attempts and regeneration. No public email requirement for managed staff.
- Staff logs in with hotel code and username. First login requires setting a permanent password (minimum 15 characters for password-only accounts; allow at least 64, spaces and paste). No operational access until activation is completed server-side. Admin can reset, deactivate, and change manager/associate role; cannot recover passwords. Existing owner role cannot be changed through staff management.

## Architecture and boundaries
- Keep Firebase Authentication as credential authority. Do not store plaintext passwords, roll our own password hashing, or mark a fictitious email as verified. Evaluate a dedicated managed-account identity namespace using Firebase Auth email/password with internal non-deliverable identifier and a distinct server-controlled identity marker; prove namespace cannot be registered by public signup or claimed by an attacker. If that cannot be guaranteed in the shared project, isolate managed identities in a separate Identity Platform tenant and test token/rules compatibility before implementation.
- Backend-only username reservation keyed by hotel ID and normalized username; random internal account UID; transactionally enforce uniqueness and hotel code mapping. Public resolution must not expose contact emails or allow account enumeration; use generic errors and abuse protection.
- Managed account state (pending, active, resetting, disabled) must be authoritative in Firestore with client writes denied. For access, require correct identity marker, active membership, correct hotel, and completed activation/reset. Owner and verified email-invite paths retain their separate existing checks.
- First login/activation must validate the temporary credential, update the Firebase password via trusted server, invalidate the activation secret and old sessions, and only then grant access; failure must remain closed. Do not rely on a UI redirect or client-writable flag. Design retry-safe provisioning across Auth and Firestore; cleanup orphaned accounts without enabling them. Never activate merely because client reports a password change. Reset must suspend access before changing credential, invalidate old sessions including Firestore access via server-managed state and token auth_time checks, and restore only after fresh successful activation. Test races, retries and stale tokens.
- Current backend's Authentication Reader role is insufficient for creating/resetting users. Review exact permissions and shared-project blast radius before adding user-write permissions; use isolated tenant/project or separate constrained provisioning identity if feasible. No project-wide Firebase Admin grant. Keep existing database condition, secret reference, and public guest ingress unchanged.
- Audit account creation/reset/deactivation by actor, hotel, target, timestamp; never log passwords, activation secrets, bearer tokens or full credentials. Return secret once, no caching; transport HTTPS.
- Do not deploy until revised Firestore rules and API authorization agree and emulator tests plus tagged staging revision tests pass. Current PR #3 validation does not cover this feature.

## Acceptance tests
1. Two hotels can use same username; duplicates within one hotel (including case changes) are denied.
2. Anonymous/associate/manager cannot create/reset accounts; admin cannot modify another hotel or owner.
3. Pending/expired/disabled accounts cannot read conversations, requests, configuration or call privileged endpoints, including direct SDK/API access.
4. Activation is single-use and correct-hotel bound; wrong temporary secret, replay, concurrent activation and retry after partial failure fail safely.
5. Permanent password login works without real email; old temporary password and pre-reset sessions cannot access data.
6. Reset/deactivation denies existing session and cross-hotel access; reactivation requires explicit admin action.
7. Owner signup, verified invitation, sandbox, guest QR, translation and request routing regressions pass.
8. Confirm real runtime IAM, no credential logging, and no public signup namespace takeover.
9. Verify rollout/rollback with isolated test property; resolve existing GitHub credential alert before commercial use.

## Delivery
Stage A: contract and threat model (this document).
Stage B: identity namespace proof and authorization/emulator tests.
Stage C: provisioning/activation/reset backend.
Stage D: staff login and Team Management UI.
Stage E: tagged revision QA and coordinated rules release.
