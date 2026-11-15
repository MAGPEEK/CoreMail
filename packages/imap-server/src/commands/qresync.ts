/**
 * QRESYNC (RFC 7162 §3.2): SELECT/EXAMINE (QRESYNC (…)) and the expunge history
 * behind VANISHED (EARLIER).
 *
 * Deletion history. Expunged messages stay in the folder as soft-deleted rows
 * (tombstones: deletedAt set, modSeq = modSeq of the expunge, see
 * @coremail/storage message-store). Moves to another folder and hard deletes
 * (empty trash, retention) leave no tombstone in the source folder, and
 * tombstones themselves are removed after the recovery window. So the server
 * can never prove which UIDs disappeared after a given modSeq. The safe rule
 * used here (RFC 7162 §3.2.5.1/§3.2.6 allow reporting UIDs the client does not
 * know or that vanished earlier):
 *
 *   VANISHED (EARLIER) = candidate UIDs − live UIDs of the folder
 *                        − UIDs whose tombstone proves they vanished at or before
 *                          the client's modSeq (only when the candidates are not
 *                          the client's own known-uids list)
 *
 * candidates = the known-uids of SELECT (QRESYNC), else 1:(UIDNEXT-1); the UID
 * set of UID FETCH … (CHANGEDSINCE … VANISHED). Everything is computed on
 * ranges, output is chunked into several VANISHED responses.
 */
import { prisma } from '@coremail/storage';
import { ImapParseError, tokenize, type Token } from '../server/tokenizer.js';
import { type UidRange, clampRanges, chunkRanges, parseUidRanges, subtractUids } from '../session/uid-set.js';
import { type ImapSession, sendUntagged } from '../session/state.js';

export interface QresyncParams {
  uidValidity: number;
  modSeq: bigint;
  /** Known UIDs of the client (sequence set), null when not given. */
  knownUids: string | null;
}

export interface SelectParams {
  condstore: boolean;
  qresync: QresyncParams | null;
}

const NZ = /^[1-9]\d{0,9}$/;
const MODSEQ = /^\d{1,19}$/;
const SET = /^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/;

const atom = (t: Token | undefined): string | null => (t?.type === 'atom' ? t.value : null);

/**
 * Parses the SELECT/EXAMINE parameter list (RFC 4466 §2.1):
 *   (CONDSTORE) / (QRESYNC (uidvalidity modseq [known-uids [(seq-set uid-set)]]))
 * Throws ImapParseError on anything else.
 */
export function parseSelectParams(text: string): SelectParams {
  let tokens: Token[];
  try {
    tokens = tokenize([text]);
  } catch {
    throw new ImapParseError('Invalid SELECT parameters');
  }
  const list = tokens[0];
  if (tokens.length !== 1 || list?.type !== 'list') throw new ImapParseError('Invalid SELECT parameters');
  const out: SelectParams = { condstore: false, qresync: null };
  const items = list.items;
  for (let i = 0; i < items.length; i++) {
    const name = atom(items[i])?.toUpperCase();
    if (name === 'CONDSTORE') { out.condstore = true; continue; }
    if (name !== 'QRESYNC' || out.qresync) throw new ImapParseError('Unknown SELECT parameter');
    const args = items[++i];
    if (args?.type !== 'list') throw new ImapParseError('QRESYNC expects a parameter list');
    const [v, m, known, match, ...rest] = args.items;
    const uidValidity = atom(v);
    const modSeq = atom(m);
    if (!uidValidity || !NZ.test(uidValidity) || !modSeq || !MODSEQ.test(modSeq) || rest.length > 0) {
      throw new ImapParseError('QRESYNC expects (uidvalidity modseq [known-uids [seq-match]])');
    }
    let knownUids: string | null = null;
    if (known !== undefined) {
      knownUids = atom(known);
      if (knownUids === null || !SET.test(knownUids)) throw new ImapParseError('Invalid QRESYNC known-uids');
    }
    if (match !== undefined) {
      // The sequence match data only helps servers without history; it is validated, not used.
      const seqs = match.type === 'list' ? atom(match.items[0]) : null;
      const uids = match.type === 'list' ? atom(match.items[1]) : null;
      if (match.type !== 'list' || match.items.length !== 2 || !seqs || !uids || !SET.test(seqs) || !SET.test(uids)) {
        throw new ImapParseError('Invalid QRESYNC sequence match data');
      }
    }
    out.qresync = { uidValidity: Number(uidValidity), modSeq: BigInt(modSeq), knownUids };
  }
  return out;
}

/**
 * UIDs among `candidates` that are not live in the folder (see module doc).
 * `knownBefore`: tombstones with modSeq ≤ this value are known to the client
 * already and are left out; null keeps them.
 */
export async function vanishedUids(folderId: string, candidates: UidRange[], knownBefore: bigint | null): Promise<UidRange[]> {
  if (candidates.length === 0) return [];
  const lo = candidates[0]![0];
  const hi = candidates[candidates.length - 1]![1];
  const rows = await prisma.message.findMany({
    where: { folderId, uid: { gte: lo, lte: hi } },
    select: { uid: true, deletedAt: true, modSeq: true },
  });
  const exclude = new Set<number>();
  for (const r of rows) {
    if (r.deletedAt === null) exclude.add(r.uid);
    else if (knownBefore !== null && r.modSeq <= knownBefore) exclude.add(r.uid);
  }
  // A UID may have a live row and a tombstone only in legacy data; live wins.
  return subtractUids(candidates, [...exclude].sort((a, b) => a - b));
}

/** Sends VANISHED (EARLIER) responses for the ranges (nothing when empty). */
export function sendVanishedEarlier(session: ImapSession, ranges: UidRange[]): void {
  for (const set of chunkRanges(ranges)) sendUntagged(session, `VANISHED (EARLIER) ${set}`);
}

/** Candidate ranges of SELECT (QRESYNC): the known UIDs, or every UID below UIDNEXT. */
export function selectCandidates(params: QresyncParams, uidNext: number): UidRange[] {
  const top = Math.max(0, uidNext - 1);
  if (top === 0) return [];
  const ranges = params.knownUids === null ? [[1, top] as UidRange] : parseUidRanges(params.knownUids, top) ?? [];
  return clampRanges(ranges, 1, top);
}
