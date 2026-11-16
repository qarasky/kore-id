// Devices and counts in words. Times come from kore-ui's <Time> / formatRelativeTime.

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
