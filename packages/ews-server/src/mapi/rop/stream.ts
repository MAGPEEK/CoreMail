/**
 * Stream-ROP-Handler — Phase v4.2.0 (Lesen) + v4.3.0 (Schreiben)
 *
 * STUB — Implementation kommt in v4.2.0+.
 *
 * Geplante Handlers:
 *   v4.2.0 (lesen):
 *     - RopOpenStream      (MS-OXCPRPT §2.2.13.1) — öffnet Stream über Property
 *     - RopReadStream      (MS-OXCPRPT §2.2.14.1) — liest Chunk
 *     - RopGetStreamSize   (MS-OXCPRPT §2.2.15.1)
 *     - RopSeekStream      (MS-OXCPRPT §2.2.17.1)
 *
 *   v4.3.0 (schreiben):
 *     - RopWriteStream     (MS-OXCPRPT §2.2.16.1)
 *     - RopCommitStream    (MS-OXCPRPT §2.2.18.1)
 *     - RopSetStreamSize   (MS-OXCPRPT §2.2.19.1)
 *     - RopWriteAndCommitStream
 *
 * Stream-Object-Lifecycle:
 *   1. Outlook ruft RopOpenStream(messageHandle, PR_BODY_W, RW-Flags)
 *      → Server lädt body aus DB/MinIO in handleTable[handle] = { kind: 'stream',
 *        buffer, offset: 0 }
 *   2. Outlook ruft mehrfach RopReadStream(handle, byteCount)
 *      → Server liest chunk aus buffer ab offset, advanced offset
 *   3. Outlook ruft RopRelease(handle)
 *      → Server entfernt Stream-Object
 *
 * Performance: Outlook liest typischerweise in 4096-Byte-Chunks. Bei großen
 * Bodies (HTML-Mails > 1 MB) sind das viele Round-Trips. Streamen aus
 * MinIO direkt wäre optimal, aber für v4.2.0 reicht "alles in den Buffer
 * vorladen".
 */
export {};
