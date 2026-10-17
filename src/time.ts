export type EtStamp = {
  iso: string;
  date: string;
  day: string;
  year: string;
  month: string;
  heading: string;
  versionTs: string;
};

export function etStamp(input?: string | Date, timeZone = "UTC"): EtStamp {
  const date = input instanceof Date ? input : input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid instant");
  }
  const zone = timeZone.trim() || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const zoneName = get("timeZoneName") || zone;
  const iso = date.toISOString();
  return {
    iso,
    date: `${year}-${month}-${day}`,
    day,
    year,
    month,
    heading: `${hour}:${minute} ${zoneName}`,
    versionTs: iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
  };
}

export function versionStamp(date = new Date()): string {
  const base = date.toISOString().replace(/[-:]/g, "").replace(".", "");
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${base}${suffix}`;
}

export function within24h(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return Math.abs(left - right) <= 24 * 60 * 60 * 1000;
}

export function isoDaysAgo(iso: string, days: number): boolean {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return true;
  return Date.now() - then <= days * 24 * 60 * 60 * 1000;
}
