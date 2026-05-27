/**
 * Recurrence Pattern Binary Encoder (v5.2.0)
 *
 * MS-OXOCAL §2.2.1.44 — PidLidAppointmentRecur encoded als binary blob.
 *
 * Struktur:
 *   uint16  RecurFrequency      (Daily/Weekly/Monthly/Yearly)
 *   uint16  PatternType         (0=Day, 1=Week, 2=Month, 3=MonthNth, ...)
 *   uint16  CalendarType        (0=Default Gregorian)
 *   uint32  FirstDateTime       (Minutes seit 0001-01-01)
 *   uint32  Period              (z.B. 2 für „every 2 weeks")
 *   uint32  SlidingFlag         (0)
 *   <PatternTypeSpecific>       (variable je nach PatternType)
 *   uint32  EndType             (0x2021=Date, 0x2022=Count, 0x2023=Never)
 *   uint32  OccurrenceCount
 *   uint32  FirstDow            (0=Sunday)
 *   uint32  DeletedInstanceCount
 *   uint32  DeletedInstanceDates[]
 *   uint32  ModifiedInstanceCount
 *   uint32  ModifiedInstanceDates[]
 *   uint32  StartDate           (Minutes seit 0001-01-01)
 *   uint32  EndDate             (oder 0x5AE980DF für „Never")
 *   <ExceptionInfo>             (zero exceptions in v5.2.0)
 *
 * Wir parsen iCal RRULE-Strings (z.B. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")
 * und konvertieren sie zu diesem Binary-Format. Outlook akzeptiert das und
 * zeigt das Recurrence-Pattern korrekt im Termin-Dialog.
 */

const RECUR_FREQ_DAILY   = 0x200A;
const RECUR_FREQ_WEEKLY  = 0x200B;
const RECUR_FREQ_MONTHLY = 0x200C;
const RECUR_FREQ_YEARLY  = 0x200D;

const PATTERN_TYPE_DAY        = 0x0000;
const PATTERN_TYPE_WEEK       = 0x0001;
const PATTERN_TYPE_MONTH      = 0x0002;
const PATTERN_TYPE_MONTH_NTH  = 0x0003;

const END_TYPE_DATE      = 0x00002021;
const END_TYPE_COUNT     = 0x00002022;
const END_TYPE_NEVER     = 0x00002023;

const NEVER_END_DATE_MINUTES = 0x5AE980DF;  // ~31 Dec 4500

/**
 * Konvertiert ein Date in „Minuten seit 0001-01-01 00:00:00 UTC".
 */
function dateToRecurMinutes(d: Date): number {
  const ref = Date.UTC(1, 0, 1);   // Year 1, Jan 1
  // JavaScript Date kann das nicht direkt darstellen (year 0001 ist OK)
  // Wir setzen ref explizit auf -62167219200000 (1 AD).
  const refMs = -62167219200000;
  return Math.floor((d.getTime() - refMs) / 60000);
}

const DAY_BITS = {
  SU: 0x01, MO: 0x02, TU: 0x04, WE: 0x08, TH: 0x10, FR: 0x20, SA: 0x40,
};

/**
 * Parst einen iCal-RRULE-String (RFC 5545) und konvertiert ihn in das
 * PidLidAppointmentRecur Binary-Format.
 *
 * Beispiele:
 *   "FREQ=DAILY"
 *   "FREQ=WEEKLY;INTERVAL=2"
 *   "FREQ=WEEKLY;BYDAY=MO,WE,FR"
 *   "FREQ=MONTHLY;BYMONTHDAY=15"
 *   "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24"
 *   "FREQ=DAILY;COUNT=10"
 *   "FREQ=WEEKLY;UNTIL=20261231T235959Z"
 */
export function encodeRecurrencePattern(
  rrule: string,
  dtStart: Date,
  dtEnd: Date,
): Buffer {
  const params: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) params[k.toUpperCase()] = v;
  }
  const freq = (params['FREQ'] ?? 'DAILY').toUpperCase();
  const interval = parseInt(params['INTERVAL'] ?? '1', 10);
  const byDay = (params['BYDAY'] ?? '').split(',').filter(Boolean);
  const byMonthDay = parseInt(params['BYMONTHDAY'] ?? '0', 10);
  const byMonth = parseInt(params['BYMONTH'] ?? '0', 10);
  const count = parseInt(params['COUNT'] ?? '0', 10);
  const until = params['UNTIL'] ? parseIcalUntil(params['UNTIL']) : null;

  let recurFreq = RECUR_FREQ_DAILY;
  let patternType = PATTERN_TYPE_DAY;
  let period = interval;
  let patternSpecific = Buffer.alloc(0);

  switch (freq) {
    case 'DAILY':
      recurFreq = RECUR_FREQ_DAILY;
      patternType = PATTERN_TYPE_DAY;
      period = interval * 1440;     // minutes per day
      break;
    case 'WEEKLY': {
      recurFreq = RECUR_FREQ_WEEKLY;
      patternType = PATTERN_TYPE_WEEK;
      // 4-Byte WeekDay-Bitmask
      let mask = 0;
      if (byDay.length === 0) {
        // Default: Wochentag aus dtStart
        const dow = dtStart.getUTCDay();
        const bits = [DAY_BITS.SU, DAY_BITS.MO, DAY_BITS.TU, DAY_BITS.WE, DAY_BITS.TH, DAY_BITS.FR, DAY_BITS.SA];
        mask = bits[dow] ?? DAY_BITS.MO;
      } else {
        for (const d of byDay) {
          const k = d.slice(-2).toUpperCase() as keyof typeof DAY_BITS;
          mask |= DAY_BITS[k] ?? 0;
        }
      }
      patternSpecific = Buffer.alloc(4);
      patternSpecific.writeUint32LE(mask, 0);
      break;
    }
    case 'MONTHLY':
      recurFreq = RECUR_FREQ_MONTHLY;
      patternType = PATTERN_TYPE_MONTH;
      patternSpecific = Buffer.alloc(4);
      patternSpecific.writeUint32LE(byMonthDay || dtStart.getUTCDate(), 0);
      break;
    case 'YEARLY':
      recurFreq = RECUR_FREQ_YEARLY;
      patternType = PATTERN_TYPE_MONTH;
      period = 12 * interval;
      patternSpecific = Buffer.alloc(4);
      patternSpecific.writeUint32LE(byMonthDay || dtStart.getUTCDate(), 0);
      void byMonth;
      break;
  }

  // EndType
  let endType: number = END_TYPE_NEVER;
  let occCount = 0;
  let endDateMinutes = NEVER_END_DATE_MINUTES;
  if (count > 0) {
    endType = END_TYPE_COUNT;
    occCount = count;
    endDateMinutes = dateToRecurMinutes(dtEnd);
  } else if (until) {
    endType = END_TYPE_DATE;
    occCount = 10;        // simplified
    endDateMinutes = dateToRecurMinutes(until);
  }

  // Header + Body assembly
  const w = new BinaryBuilder();
  // ReaderVersion (2) + WriterVersion (2)
  w.uint16(0x3004);
  w.uint16(0x3004);
  // RecurFrequency, PatternType, CalendarType
  w.uint16(recurFreq);
  w.uint16(patternType);
  w.uint16(0x0000);
  // FirstDateTime
  w.uint32(dateToRecurMinutes(dtStart));
  // Period
  w.uint32(period);
  // SlidingFlag
  w.uint32(0);
  // PatternTypeSpecific
  w.bytes(patternSpecific);
  // EndType
  w.uint32(endType);
  // OccurrenceCount
  w.uint32(occCount || 1);
  // FirstDow (0=Sunday)
  w.uint32(0);
  // DeletedInstanceCount + Dates
  w.uint32(0);
  // ModifiedInstanceCount + Dates
  w.uint32(0);
  // StartDate
  w.uint32(dateToRecurMinutes(dtStart));
  // EndDate
  w.uint32(endDateMinutes);
  // Reader/WriterVersion2
  w.uint32(0x3006);
  w.uint32(0x3008);
  // StartTimeOffset / EndTimeOffset (in minutes from midnight)
  const startMinOfDay = dtStart.getUTCHours() * 60 + dtStart.getUTCMinutes();
  const endMinOfDay = dtEnd.getUTCHours() * 60 + dtEnd.getUTCMinutes();
  w.uint32(startMinOfDay);
  w.uint32(endMinOfDay);
  // ExceptionCount
  w.uint16(0);
  // ReservedBlock1Size + Block + ReservedBlock2Size + Block
  w.uint32(0);
  w.uint32(0);
  return w.toBuffer();
}

function parseIcalUntil(s: string): Date | null {
  // Format: YYYYMMDDTHHMMSSZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
    parseInt(m[4] ?? '0', 10), parseInt(m[5] ?? '0', 10), parseInt(m[6] ?? '0', 10),
  ));
}

/**
 * Minimaler Binary-Builder. Wir nutzen ihn statt MapiWriter weil das hier
 * keine MAPI-Konvention ist (different endianness/alignment).
 */
class BinaryBuilder {
  private chunks: Buffer[] = [];
  uint16(v: number) {
    const b = Buffer.alloc(2);
    b.writeUint16LE(v & 0xFFFF, 0);
    this.chunks.push(b);
  }
  uint32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUint32LE(v >>> 0, 0);
    this.chunks.push(b);
  }
  bytes(b: Buffer) {
    this.chunks.push(Buffer.from(b));
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
