// Times and devices in words. DESIGN.md §5: relative when recent ("Today 07:43", "Yesterday"), dates otherwise.
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff >= 0 && diff < 60) return "Just now";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** formatTime for the middle of a sentence ("Last active today 07:43"). */
export const formatTimeInline = (iso: string | null | undefined, now = new Date()) =>
  formatTime(iso, now).replace(/^(Just now|Today|Yesterday|Never)/, (m) => m.toLowerCase());

/** Full timestamp for a tooltip/title. */
export const fullTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

/** "Firefox on macOS" from a user agent; good enough for a sessions list. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /okhttp|Dalvik/i.test(ua) ? "Android app"
    : /curl|node|undici|python|Go-http/i.test(ua) ? "Script"
    : null;
  const os =
    /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}

export const isMobileUa = (ua: string | null | undefined) => !!ua && /Android|iPhone|iPad|Mobile/.test(ua);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
