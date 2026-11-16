"""Reads the room's inbox for meeting invites and replies Accepted / Declined."""

import datetime as dt
import email
import email.policy
import email.utils
import imaplib
import logging
import smtplib
import ssl
from email.message import EmailMessage

import icalendar

log = logging.getLogger("meetingbox.mail")


def calendar_parts(msg):
    """Return (list of icalendar.Calendar, plain/html body text) for an email."""
    cals, body = [], []
    for part in msg.walk():
        ctype = part.get_content_type()
        filename = (part.get_filename() or "").lower()
        if ctype in ("text/calendar", "application/ics") or filename.endswith(".ics"):
            raw = part.get_payload(decode=True)
            if not raw:
                continue
            try:
                cals.append(icalendar.Calendar.from_ical(raw))
            except Exception as exc:
                log.warning("Could not parse calendar attachment: %s", exc)
        elif ctype in ("text/plain", "text/html") and not part.get_filename():
            try:
                body.append(part.get_content())
            except Exception:
                pass
    # Outlook often sends the same invite inline and as an attachment.
    unique, seen = [], set()
    for c in cals:
        sig = c.to_ical()
        if sig not in seen:
            seen.add(sig)
            unique.append(c)
    return unique, "\n".join(body)


def organizer_address(event):
    org = event.get("ORGANIZER")
    if org is None:
        return None
    addr = str(org)
    return addr.split(":", 1)[1] if ":" in addr else addr


def sender_allowed(address, allowed_domains):
    if not allowed_domains:
        return True
    if not address or "@" not in address:
        return False
    domain = address.rsplit("@", 1)[1].lower()
    return any(domain == d.lower().lstrip("@") or domain.endswith("." + d.lower().lstrip("@")) for d in allowed_domains)


def build_reply(event, room_address, room_name, partstat):
    """An iTIP REPLY email telling the organizer the room accepted or declined."""
    cal = icalendar.Calendar()
    cal.add("PRODID", "-//meeting-box//EN")
    cal.add("VERSION", "2.0")
    cal.add("METHOD", "REPLY")
    ev = icalendar.Event()
    for prop in ("UID", "SEQUENCE", "RECURRENCE-ID", "DTSTART", "DTEND", "SUMMARY", "ORGANIZER"):
        if event.get(prop) is not None:
            ev[prop] = event[prop]
    ev.add("DTSTAMP", dt.datetime.now(dt.timezone.utc))
    attendee = icalendar.vCalAddress(f"mailto:{room_address}")
    attendee.params["PARTSTAT"] = partstat
    attendee.params["CN"] = room_name
    ev.add("ATTENDEE", attendee, encode=0)
    cal.add_component(ev)

    verb = "Accepted" if partstat == "ACCEPTED" else "Declined"
    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((room_name, room_address))
    msg["To"] = organizer_address(event)
    msg["Subject"] = f"{verb}: {event.get('SUMMARY', 'Meeting')}"
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid()
    text = f"{room_name} has {verb.lower()} this meeting."
    if partstat != "ACCEPTED":
        text += " The room is already booked at that time."
    msg.set_content(text)
    msg.add_alternative(cal.to_ical().decode(), subtype="calendar", params={"method": "REPLY"})
    return msg


class Mailbox:
    def __init__(self, cfg, room_name):
        self.cfg = cfg
        self.room_name = room_name
        self.address = cfg["address"]

    def _imap(self):
        conn = imaplib.IMAP4_SSL(self.cfg["imap_host"], self.cfg.get("imap_port", 993), timeout=30)
        conn.login(self.cfg.get("username") or self.address, self.cfg["password"])
        return conn

    def fetch_new(self, state):
        """Yield raw messages that arrived since the last check.

        ``state`` is a dict persisted between runs (uidvalidity / last_uid).
        """
        conn = self._imap()
        try:
            typ, data = conn.select(self.cfg.get("folder", "INBOX"), readonly=True)
            if typ != "OK":
                raise RuntimeError(f"Cannot open mail folder: {data}")
            validity = conn.response("UIDVALIDITY")[1][0]
            validity = validity.decode() if isinstance(validity, bytes) else str(validity)
            if state.get("uidvalidity") != validity:
                state.clear()
                state["uidvalidity"] = validity
            if state.get("last_uid"):
                criteria = f"UID {int(state['last_uid']) + 1}:*"
            else:
                since = (dt.date.today() - dt.timedelta(days=self.cfg.get("first_run_days", 30))).strftime("%d-%b-%Y")
                criteria = f"SINCE {since}"
            typ, data = conn.uid("SEARCH", None, criteria)
            uids = [int(u) for u in data[0].split()] if data and data[0] else []
            for uid in sorted(uids):
                if state.get("last_uid") and uid <= int(state["last_uid"]):
                    continue  # "N:*" always returns the newest message
                typ, msg_data = conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
                raw = next((p[1] for p in msg_data if isinstance(p, tuple)), None)
                if raw:
                    yield email.message_from_bytes(raw, policy=email.policy.default)
                state["last_uid"] = uid
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    def _smtp(self):
        host, port = self.cfg["smtp_host"], self.cfg.get("smtp_port", 465)
        ctx = ssl.create_default_context()
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
        else:
            s = smtplib.SMTP(host, port, timeout=30)
            s.starttls(context=ctx)
        s.login(self.cfg.get("username") or self.address, self.cfg["password"])
        return s

    def check_smtp(self):
        with self._smtp():
            pass

    def send(self, msg):
        with self._smtp() as s:
            s.send_message(msg)
