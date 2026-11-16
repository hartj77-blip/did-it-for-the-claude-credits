"""The background loop: read mail, accept invites, refresh feeds, auto-join."""

import copy
import datetime as dt
import email.utils
import logging
import os
import threading
import time
import urllib.request

import icalendar

from . import launcher
from .mailbox import Mailbox, build_reply, calendar_parts, organizer_address, sender_allowed
from .store import Store

log = logging.getLogger("meetingbox")

DEFAULTS = {
    "room_name": "Meeting Room",
    "port": 8765,
    "poll_seconds": 60,
    "mailbox": {"enabled": False},
    "auto_accept": True,
    "accept_from_domains": [],
    "decline_conflicts": True,
    "calendar_feeds": [],
    "auto_join": False,
    "join_early_seconds": 60,
    "launch": {"zoom": "app", "teams": "app", "meet": "browser", "webex": "browser", "browser_command": None},
}


def load_config(raw):
    cfg = copy.deepcopy(DEFAULTS)
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(cfg.get(key), dict):
            cfg[key].update(value)
        else:
            cfg[key] = value
    mb = cfg["mailbox"]
    if mb.get("enabled") and not mb.get("password"):
        mb["password"] = os.environ.get(mb.get("password_env", "MEETINGBOX_PASSWORD"), "")
        if not mb["password"]:
            raise SystemExit(
                "The room mailbox password is missing. Set the MEETINGBOX_PASSWORD environment "
                "variable (or mailbox.password in config.json)."
            )
    return cfg


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _overlaps(a, b):
    return a["start"] < b["end"] and b["start"] < a["end"]


class Service:
    def __init__(self, cfg, data_dir):
        self.cfg = cfg
        os.makedirs(data_dir, exist_ok=True)
        self.store = Store(os.path.join(data_dir, "meetings.json"))
        self.mailbox = Mailbox(cfg["mailbox"], cfg["room_name"]) if cfg["mailbox"].get("enabled") else None
        self.status = {"last_sync": None, "errors": [], "activity": []}
        self.joined = set()
        self.stop = threading.Event()

    # ---- invites ---------------------------------------------------------

    def _note(self, text):
        log.info(text)
        self.status["activity"] = ([{"time": _now().isoformat(), "text": text}] + self.status["activity"])[:20]

    def find_conflict(self, cal):
        """First already-booked meeting that clashes with this invite, if any."""
        incoming = Store(None)
        uids = incoming.apply_request(cal)
        start, end = _now(), _now() + dt.timedelta(days=180)
        new = [o for o in incoming.occurrences(start, end) if not o["all_day"]]
        if not new:
            return None
        existing = [
            o for o in self.store.occurrences(start, end)
            if o["uid"] not in uids and not o["all_day"]
        ]
        for n in new:
            for e in existing:
                if _overlaps(n, e):
                    return e
        return None

    def handle_message(self, msg):
        cals, body = calendar_parts(msg)
        for cal in cals:
            method = str(cal.get("METHOD", "REQUEST")).upper()
            events = list(cal.walk("VEVENT"))
            if not events:
                continue
            title = str(events[0].get("SUMMARY", "(no title)"))
            organizer = organizer_address(events[0]) or email_from(msg)

            if not sender_allowed(organizer, self.cfg["accept_from_domains"]):
                self._note(f"Ignored invite from {organizer} (not an allowed domain): {title}")
                continue

            if method == "CANCEL":
                self.store.apply_cancel(cal)
                self._note(f"Cancelled: {title}")
                continue
            if method not in ("REQUEST", "PUBLISH"):
                continue  # REPLY / COUNTER etc. are not for us

            conflict = self.find_conflict(cal) if self.cfg["decline_conflicts"] else None
            wants_reply = (
                method == "REQUEST"
                and self.cfg["auto_accept"]
                and self.mailbox is not None
                and organizer
                and organizer.lower() != self.mailbox.address.lower()
            )
            if conflict:
                self._note(f"Declined (clashes with “{conflict['title']}”): {title}")
                if wants_reply:
                    self._reply(events[0], "DECLINED")
                continue

            self.store.apply_request(cal, extra_text=body)
            self._note(f"Accepted: {title}" if wants_reply else f"Added: {title}")
            if wants_reply:
                self._reply(events[0], "ACCEPTED")
        self.store.save()

    def _reply(self, event, partstat):
        try:
            self.mailbox.send(build_reply(event, self.mailbox.address, self.cfg["room_name"], partstat))
        except Exception as exc:
            self._error(f"Could not send reply to organizer: {exc}")

    def _error(self, text):
        log.error(text)
        self.status["errors"] = ([{"time": _now().isoformat(), "text": text}] + self.status["errors"])[:10]

    # ---- syncing ---------------------------------------------------------

    def sync(self):
        before = len(self.status["errors"]) and self.status["errors"][0]
        self._sync()
        first = self.status["errors"][0] if self.status["errors"] else None
        self.status["current_error"] = first["text"] if first is not None and first is not before else None
        self.status["last_sync"] = _now().isoformat()

    def _sync(self):
        if self.mailbox:
            try:
                state = self.store.meta.setdefault("imap", {})
                for msg in self.mailbox.fetch_new(state):
                    self.handle_message(msg)
                    self.store.save()  # remembers last_uid even for non-invites
            except Exception as exc:
                self._error(f"Mailbox check failed: {exc}")
        for url in self.cfg["calendar_feeds"]:
            try:
                fetch = "https://" + url[len("webcal://"):] if url.startswith("webcal://") else url
                with urllib.request.urlopen(fetch, timeout=30) as resp:
                    cal = icalendar.Calendar.from_ical(resp.read())
                self.store.replace_feed(url, cal)
                self.store.save()
            except Exception as exc:
                self._error(f"Calendar feed failed ({url[:40]}…): {exc}")

    # ---- schedule & joining ---------------------------------------------

    def schedule(self, days=1):
        now = _now()
        local_midnight = dt.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        start = min(local_midnight, now - dt.timedelta(hours=1))
        return self.store.occurrences(start, local_midnight + dt.timedelta(days=days))

    def join_url(self, url):
        return launcher.launch(url, self.cfg["launch"], self.cfg["room_name"])

    def join_meeting(self, key):
        for occ in self.schedule(days=2):
            if occ["key"] == key and occ["url"]:
                self.joined.add(key)
                self._note(f"Joining: {occ['title']}")
                return self.join_url(occ["url"])
        raise KeyError("No joinable meeting with that id")

    def auto_join_tick(self):
        if not self.cfg["auto_join"]:
            return
        now = _now()
        early = dt.timedelta(seconds=self.cfg["join_early_seconds"])
        due = [
            o for o in self.schedule()
            if o["url"] and not o["all_day"] and o["key"] not in self.joined
            and dt.datetime.fromisoformat(o["start"]) - early <= now < dt.datetime.fromisoformat(o["end"])
        ]
        if due:
            self.join_meeting(due[-1]["key"])  # the one that started most recently
            self.joined.update(o["key"] for o in due)

    def run_forever(self):
        next_sync = 0
        while not self.stop.is_set():
            if time.monotonic() >= next_sync:
                self.sync()
                next_sync = time.monotonic() + self.cfg["poll_seconds"]
            try:
                self.auto_join_tick()
            except Exception as exc:
                self._error(f"Auto-join failed: {exc}")
            self.stop.wait(10)


def email_from(msg):
    return email.utils.parseaddr(msg.get("From", ""))[1] or None
