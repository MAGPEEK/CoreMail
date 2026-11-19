/**
 * Prisma filter for directory listings (GAL, autocomplete, ActiveSync GAL,
 * JMAP principals, folder-permission grantees): leaves out users / Shared
 * Mailboxes hidden from the address list. Mailboxes without a policy row are
 * listed. Pure module (no imports), re-exported by mail-flow.ts.
 */
export const GAL_VISIBLE_WHERE = Object.freeze({ NOT: { mailFlowPolicy: { is: { hiddenFromGal: true } } } });
