"""Find Teams / Zoom / Google Meet / Webex join links in invite text."""

import re
from urllib.parse import parse_qs, urlparse

_TAIL = r"[^\s<>\"'\]\)]*"

PATTERNS = [
    ("teams", re.compile(r"https://teams\.microsoft\.com/l/meetup-join/" + _TAIL, re.I)),
    ("teams", re.compile(r"https://teams\.microsoft\.com/meet/" + _TAIL, re.I)),
    ("teams", re.compile(r"https://teams\.live\.com/meet/" + _TAIL, re.I)),
    ("zoom", re.compile(r"https://(?:[\w-]+\.)*zoom(?:gov)?\.(?:us|com)/(?:j|w|my|s)/" + _TAIL, re.I)),
    ("meet", re.compile(r"https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?" + _TAIL + ")?", re.I)),
    ("webex", re.compile(r"https://[\w-]+\.webex\.com/(?:meet|join|[\w-]+/j\.php)" + _TAIL, re.I)),
]

PLATFORM_NAMES = {"teams": "Microsoft Teams", "zoom": "Zoom", "meet": "Google Meet", "webex": "Webex"}


def _clean(url):
    # Trailing punctuation picked up from prose, and HTML-escaped ampersands.
    url = url.replace("&amp;", "&")
    return url.rstrip(".,;:!>")


def find_links(*texts):
    """Return [(platform, url), ...] in the order they appear, de-duplicated.

    Texts are searched in the order given, so pass the most authoritative
    field (e.g. LOCATION) first.
    """
    found, seen = [], set()
    for text in texts:
        if not text:
            continue
        text = str(text)
        hits = []
        for platform, pattern in PATTERNS:
            for m in pattern.finditer(text):
                hits.append((m.start(), platform, _clean(m.group(0))))
        for _, platform, url in sorted(hits):
            key = url.lower()
            if key not in seen:
                seen.add(key)
                found.append((platform, url))
    return found


def detect_platform(url):
    links = find_links(url)
    return links[0][0] if links else None


def zoom_app_url(url, display_name=None):
    """Turn https://zoom.us/j/123?pwd=x into a zoommtg:// link the desktop app opens directly."""
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] not in ("j", "w", "s"):
        return None
    confno = re.sub(r"\D", "", parts[1])
    if not confno:
        return None
    query = parse_qs(parsed.query)
    out = f"zoommtg://{parsed.hostname}/join?action=join&confno={confno}"
    if query.get("pwd"):
        out += "&pwd=" + query["pwd"][0]
    if display_name:
        from urllib.parse import quote
        out += "&uname=" + quote(display_name)
    return out


def teams_app_url(url):
    """https://teams.microsoft.com/... -> msteams:/... (opens the Teams desktop app)."""
    if url.lower().startswith("https://teams.microsoft.com/"):
        return "msteams:/" + url[len("https://teams.microsoft.com/"):]
    return None
