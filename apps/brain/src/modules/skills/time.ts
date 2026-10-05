/** Wall-clock parts of `date` in `timezone`. */
function parts(date: Date, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
}

/**
 * "2026-10-05T18:30" as wall time in `timezone` → the real instant. Models give local
 * times without offsets; the person's timezone decides what they mean.
 */
export function zonedToUtc(local: string, timezone: string): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  // The zone's offset at that moment; twice, in case the first guess crossed a DST change.
  let guess = wall - (parts(new Date(wall), timezone) - wall);
  guess = wall - (parts(new Date(guess), timezone) - guess);
  return new Date(guess);
}

/** "18:30 on Sunday 5 October" in the person's timezone, for her to say. */
export function spoken(date: Date, timezone: string, now = new Date()): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (day(date) === day(now)) return `${time} today`;
  if (day(date) === day(new Date(now.getTime() + 86_400_000))) return `${time} tomorrow`;
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return `${time} on ${when}`;
}

/** 330 → "5 minutes 30 seconds". */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    [h && unit(h, "hour"), m && unit(m, "minute"), sec && unit(sec, "second")]
      .filter(Boolean)
      .join(" ") || "0 seconds"
  );
}
