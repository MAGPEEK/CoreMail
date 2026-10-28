/**
 * Contacts ROP mapping — phase v4.7.0
 *
 * STUB — implementation arrives in v4.7.0.
 *
 * Contacts in Outlook = messages with MessageClass `IPM.Contact` in a
 * folder with PR_CONTAINER_CLASS_W="IPF.Contact". Plus the GAL (Global Address
 * List) via the NSPI protocol (`/mapi/nspi/`).
 *
 * v4.7.0 implementation:
 *
 * 1. NSPI (Global Address List)
 *    Via the packages/ews-server/src/mapi/handler.ts NSPI router:
 *      - NspiBind         → open session (✅ already in v4.0.0)
 *      - NspiUnbind       → close session (✅ already in v4.0.0)
 *      - NspiGetSpecialTable → address-book list (hierarchy: only the GAL as
 *        the single address book)
 *      - NspiQueryRows    → table of all users from Prisma `user`
 *      - NspiGetProps     → properties of a user entry
 *      - NspiResolveNames → name → SMTP lookup
 *      - NspiGetMatches   → search query with restriction
 *      - NspiDnToMinId    → LegacyDN → MinId
 *
 *    Binary format: even more complex than emsmdb. MS-OXNSPI §2.2 specifies it.
 *
 * 2. IPM.Contact messages (personal contacts)
 *    Property mapping `Contact` (Prisma) → MAPI:
 *      - displayName  → PR_DISPLAY_NAME_W
 *      - email        → PR_EMAIL_ADDRESS_W (all e-mail addresses via
 *                       named properties PidLidEmail1EmailAddress etc.)
 *      - email2       → PidLidEmail2EmailAddress
 *      - phone        → PR_BUSINESS_TELEPHONE_NUMBER_W
 *      - mobile       → PR_MOBILE_TELEPHONE_NUMBER_W
 *      - company      → PR_COMPANY_NAME_W
 *      - department   → PR_DEPARTMENT_NAME_W
 *      - jobTitle     → PR_TITLE_W
 *      - notes        → PR_BODY_W
 *      - vcardData    → opaque (for round-trip compatibility)
 *
 * 3. CardDAV bridge (bidirectional)
 *    Since our CardDAV server (caldav-server) already works against the same contact
 *    storage, changes from Outlook are automatically visible in OWA + Apple
 *    Contacts (same storage). No extra bridging code needed.
 */
export {};
