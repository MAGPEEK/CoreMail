/**
 * Contacts-ROP-Mapping — Phase v4.7.0
 *
 * STUB — Implementation kommt in v4.7.0.
 *
 * Kontakte in Outlook = Messages mit MessageClass `IPM.Contact` in einem
 * Folder mit PR_CONTAINER_CLASS_W="IPF.Contact". Plus die GAL (Global Address
 * List) über das NSPI-Protokoll (`/mapi/nspi/`).
 *
 * v4.7.0 Implementation:
 *
 * 1. NSPI (Global Address List)
 *    Über packages/ews-server/src/mapi/handler.ts NSPI-Router:
 *      - NspiBind         → Session öffnen (✅ schon in v4.0.0)
 *      - NspiUnbind       → Session schließen (✅ schon in v4.0.0)
 *      - NspiGetSpecialTable → Adressbuch-Liste (Hierarchy: nur GAL als
 *        einziges Adressbuch)
 *      - NspiQueryRows    → Tabelle aller User aus Prisma `user`
 *      - NspiGetProps     → Properties eines User-Eintrags
 *      - NspiResolveNames → Name → SMTP-Lookup
 *      - NspiGetMatches   → Suchanfrage mit Restriction
 *      - NspiDnToMinId    → LegacyDN → MinId
 *
 *    Binary Format: noch komplexer als emsmdb. MS-OXNSPI §2.2 spezifiziert es.
 *
 * 2. IPM.Contact-Messages (persönliche Kontakte)
 *    Property-Mapping `Contact` (Prisma) → MAPI:
 *      - displayName  → PR_DISPLAY_NAME_W
 *      - email        → PR_EMAIL_ADDRESS_W (alle email-Adressen über
 *                       named-properties PidLidEmail1EmailAddress etc.)
 *      - email2       → PidLidEmail2EmailAddress
 *      - phone        → PR_BUSINESS_TELEPHONE_NUMBER_W
 *      - mobile       → PR_MOBILE_TELEPHONE_NUMBER_W
 *      - company      → PR_COMPANY_NAME_W
 *      - department   → PR_DEPARTMENT_NAME_W
 *      - jobTitle     → PR_TITLE_W
 *      - notes        → PR_BODY_W
 *      - vcardData    → opaque (für Round-Trip-Kompat)
 *
 * 3. CardDAV-Bridge (bidirektional)
 *    Da unser CardDAV-Server (caldav-server) bereits gegen denselben Contact-
 *    Storage arbeitet, sind Änderungen aus Outlook automatisch in OWA + Apple
 *    Kontakte sichtbar (gleicher Storage). Kein extra Bridging-Code nötig.
 */
export {};
