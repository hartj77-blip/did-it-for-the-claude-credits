"""Keeps the room's meetings: invites it accepted plus any calendar feeds.

Each meeting series is stored as a small iCalendar document (its time zones,
the main event and any one-off changes), keyed by UID. Recurring meetings are
expanded into individual occurrences when the schedule is read.
"""

import datetime as dt
import json
import os
import threading

import icalendar
import recurring_ical_events

from .links import find_links

LINK_PROPS_FIRST = ["LOCATION", "X-MICROSOFT-SKYPETEAMSMEETINGURL", "X-MICROSOFT-ONLINEMEETINGCONFLINK", "URL"]
LINK_PROPS_LAST = ["DESCRIPTION", "X-ALT-DESC", "X-GOOGLE-CONFERENCE"]


def event_links(event, extra_text=""):
    texts = [event.get(p) for p in LINK_PROPS_FIRST + LINK_PROPS_LAST]
    for conf in event.get("CONFERENCE", []) if isinstance(event.get("CONFERENCE"), list) else [event.get("CONFERENCE")]:
        texts.append(conf)
    texts.append(extra_text)
    return find_links(*texts)


def _rid_key(component):
    rid = component.get("RECURRENCE-ID")
    return rid.to_ical().decode() if rid is not None else None


def _as_utc(value):
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.astimezone()  # floating time = local time of the room
        return value.astimezone(dt.timezone.utc)
    # All-day event: start of that day, local time.
    return dt.datetime.combine(value, dt.time()).astimezone().astimezone(dt.timezone.utc)


def _build_calendar(timezones, events):
    cal = icalendar.Calendar()
    cal.add("PRODID", "-//meeting-box//EN")
    cal.add("VERSION", "2.0")
    for tz in timezones:
        cal.add_component(tz)
    for ev in events:
        cal.add_component(ev)
    return cal


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.series = {}  # uid -> {"ics": str, "links": [...], "source": "invite"|feed-url}
        self.meta = {}
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self.series = data.get("series", {})
            self.meta = data.get("meta", {})

    def save(self):
        with self.lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"series": self.series, "meta": self.meta}, f, indent=1)
            os.replace(tmp, self.path)

    # ---- invites ---------------------------------------------------------

    def apply_request(self, cal, extra_text=""):
        """Add or update the events in an invite. Returns the UIDs touched."""
        timezones = list(cal.walk("VTIMEZONE"))
        touched = []
        with self.lock:
            for ev in cal.walk("VEVENT"):
                uid = str(ev.get("UID"))
                links = [list(l) for l in event_links(ev, extra_text)]
                entry = self.series.get(uid)
                if ev.get("RECURRENCE-ID") is None or entry is None:
                    # Whole meeting (or first sight of it): replace what we had,
                    # keeping one-off changes only if this is a later update.
                    keep = []
                    if entry is not None and ev.get("RECURRENCE-ID") is None:
                        old = icalendar.Calendar.from_ical(entry["ics"])
                        keep = [e for e in old.walk("VEVENT") if e.get("RECURRENCE-ID") is not None]
                    events = [ev] + keep
                    tzs = timezones
                else:
                    old = icalendar.Calendar.from_ical(entry["ics"])
                    rid = _rid_key(ev)
                    events = [e for e in old.walk("VEVENT") if _rid_key(e) != rid] + [ev]
                    tzids = {str(t.get("TZID")) for t in timezones}
                    tzs = timezones + [t for t in old.walk("VTIMEZONE") if str(t.get("TZID")) not in tzids]
                    links = links or entry.get("links", [])
                prev_links = entry.get("links", []) if entry else []
                self.series[uid] = {
                    "ics": _build_calendar(tzs, events).to_ical().decode(),
                    "links": links or prev_links,
                    "source": "invite",
                }
                touched.append(uid)
        return touched

    def apply_cancel(self, cal):
        with self.lock:
            for ev in cal.walk("VEVENT"):
                uid = str(ev.get("UID"))
                entry = self.series.get(uid)
                if entry is None:
                    continue
                if ev.get("RECURRENCE-ID") is None:
                    del self.series[uid]
                    continue
                # One occurrence cancelled: store it as a cancelled override.
                old = icalendar.Calendar.from_ical(entry["ics"])
                rid = _rid_key(ev)
                events = [e for e in old.walk("VEVENT") if _rid_key(e) != rid]
                ev["STATUS"] = "CANCELLED"
                events.append(ev)
                entry["ics"] = _build_calendar(list(old.walk("VTIMEZONE")), events).to_ical().decode()

    # ---- calendar feeds --------------------------------------------------

    def replace_feed(self, source, cal):
        timezones = list(cal.walk("VTIMEZONE"))
        grouped = {}
        for ev in cal.walk("VEVENT"):
            grouped.setdefault(str(ev.get("UID")), []).append(ev)
        with self.lock:
            for uid in [u for u, e in self.series.items() if e["source"] == source]:
                del self.series[uid]
            for uid, events in grouped.items():
                if uid in self.series:  # already known from an invite email
                    continue
                links = []
                for ev in events:
                    links = links or [list(l) for l in event_links(ev)]
                self.series[uid] = {
                    "ics": _build_calendar(timezones, events).to_ical().decode(),
                    "links": links,
                    "source": source,
                }

    # ---- reading the schedule -------------------------------------------

    def occurrences(self, start, end, only_uids=None):
        """All meetings overlapping [start, end), sorted by start time."""
        out = []
        with self.lock:
            items = list(self.series.items())
        for uid, entry in items:
            if only_uids is not None and uid not in only_uids:
                continue
            cal = icalendar.Calendar.from_ical(entry["ics"])
            try:
                events = recurring_ical_events.of(cal).between(start, end)
            except Exception:  # a malformed invite shouldn't take down the room
                continue
            for ev in events:
                if str(ev.get("STATUS", "")).upper() == "CANCELLED":
                    continue
                s = _as_utc(ev.decoded("DTSTART"))
                if ev.get("DTEND") is not None:
                    e = _as_utc(ev.decoded("DTEND"))
                elif ev.get("DURATION") is not None:
                    e = s + ev.decoded("DURATION")
                else:
                    e = s + dt.timedelta(hours=1)
                links = [list(l) for l in event_links(ev)] or entry.get("links", [])
                out.append({
                    "key": f"{uid}|{s.isoformat()}",
                    "uid": uid,
                    "title": str(ev.get("SUMMARY", "(no title)")),
                    "organizer": str(ev.get("ORGANIZER", "")).replace("mailto:", "").replace("MAILTO:", ""),
                    "start": s.isoformat(),
                    "end": e.isoformat(),
                    "all_day": not isinstance(ev.decoded("DTSTART"), dt.datetime),
                    "platform": links[0][0] if links else None,
                    "url": links[0][1] if links else None,
                    "links": links,
                    "source": entry["source"],
                })
        out.sort(key=lambda o: o["start"])
        return out
