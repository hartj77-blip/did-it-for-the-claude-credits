import datetime as dt
import email
import email.policy
import os
import sys
import tempfile
import unittest
from email.message import EmailMessage

import icalendar

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from meetingbox import launcher  # noqa: E402
from meetingbox.links import find_links, teams_app_url, zoom_app_url  # noqa: E402
from meetingbox.mailbox import build_reply, calendar_parts, sender_allowed  # noqa: E402
from meetingbox.service import Service, load_config  # noqa: E402

ROOM = "room@example.com"
TOMORROW = (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")
NEXT_WEEK = (dt.date.today() + dt.timedelta(days=7)).strftime("%Y%m%d")

TEAMS_LINK = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d"

# Outlook-style invite: Windows time zone name, Teams link in an X- property.
OUTLOOK_TEAMS = f"""BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN=Pat Lee:mailto:pat@contoso.com
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{ROOM}
DESCRIPTION;LANGUAGE=en-US:Microsoft Teams meeting\\nJoin: <{TEAMS_LINK}>
UID:040000008200E00074C5B7101A82E008
SUMMARY;LANGUAGE=en-US:Quarterly review
DTSTART;TZID=Eastern Standard Time:{TOMORROW}T100000
DTEND;TZID=Eastern Standard Time:{TOMORROW}T110000
SEQUENCE:0
LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting
X-MICROSOFT-SKYPETEAMSMEETINGURL:{TEAMS_LINK}
END:VEVENT
END:VCALENDAR
"""

# Google Calendar invite: weekly, Meet link only in X-GOOGLE-CONFERENCE.
GOOGLE_MEET_WEEKLY = f"""BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
METHOD:REQUEST
BEGIN:VEVENT
DTSTART;TZID=America/Chicago:{TOMORROW}T140000
DTEND;TZID=America/Chicago:{TOMORROW}T143000
RRULE:FREQ=WEEKLY;COUNT=4
DTSTAMP:20261101T000000Z
ORGANIZER;CN=sam@gmail.com:mailto:sam@gmail.com
UID:weekly123@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{ROOM}
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
DESCRIPTION:Weekly sync
SEQUENCE:0
SUMMARY:Weekly sync
END:VEVENT
END:VCALENDAR
"""

# Google Calendar invite where the organizer put a Zoom link in the location
# (Google still attaches a Meet link; Zoom is what they meant).
ZOOM_IN_LOCATION = f"""BEGIN:VCALENDAR
VERSION:2.0
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:{NEXT_WEEK}T150000Z
DTEND:{NEXT_WEEK}T160000Z
ORGANIZER:mailto:alex@partner.org
UID:zoom1@google.com
LOCATION:https://us02web.zoom.us/j/85512345678?pwd=AbCd123.1
X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg
SUMMARY:Partner call
END:VEVENT
END:VCALENDAR
"""


def invite_email(ics, sender="pat@contoso.com"):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ROOM
    msg["Subject"] = "Invitation"
    msg.set_content("You have been invited.")
    msg.add_attachment(ics.encode(), maintype="text", subtype="calendar", filename="invite.ics")
    return email.message_from_bytes(msg.as_bytes(), policy=email.policy.default)


def with_method(ics, method, **replace):
    out = ics.replace("METHOD:REQUEST", f"METHOD:{method}")
    for old, new in replace.items():
        out = out.replace(old, new)
    return out


class FakeMailbox:
    address = ROOM

    def __init__(self):
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)


def make_service(**overrides):
    cfg = load_config({"room_name": "Board Room", **overrides})
    svc = Service(cfg, tempfile.mkdtemp())
    svc.mailbox = FakeMailbox()
    return svc


def upcoming(svc, days=30):
    now = dt.datetime.now(dt.timezone.utc)
    return svc.store.occurrences(now, now + dt.timedelta(days=days))


class LinkTests(unittest.TestCase):
    def test_finds_each_platform(self):
        text = (
            "Zoom: https://zoom.us/j/123456789?pwd=abc. "
            "Meet: meet.google.com/abc-defg-hij or https://meet.google.com/abc-defg-hij "
            f"Teams: <{TEAMS_LINK}> Webex: https://acme.webex.com/meet/jdoe"
        )
        platforms = [p for p, _ in find_links(text)]
        self.assertEqual(platforms, ["zoom", "meet", "teams", "webex"])
        self.assertEqual(find_links(text)[0][1], "https://zoom.us/j/123456789?pwd=abc")

    def test_new_style_teams_link(self):
        self.assertEqual(find_links("https://teams.microsoft.com/meet/2223334445?p=xyz")[0][0], "teams")

    def test_app_urls(self):
        self.assertEqual(
            zoom_app_url("https://us02web.zoom.us/j/85512345678?pwd=AbCd123.1", "Board Room"),
            "zoommtg://us02web.zoom.us/join?action=join&confno=85512345678&pwd=AbCd123.1&uname=Board%20Room",
        )
        self.assertTrue(teams_app_url(TEAMS_LINK).startswith("msteams:/l/meetup-join/"))

    def test_launch_plan(self):
        cfg = load_config({})["launch"]
        self.assertEqual(launcher.plan("https://meet.google.com/abc-defg-hij", cfg, "R")[0], "browser")
        self.assertEqual(launcher.plan("https://zoom.us/j/1?pwd=2", cfg, "R")[0], "app")
        with self.assertRaises(ValueError):
            launcher.plan("https://evil.example.com/", cfg, "R")


class InviteTests(unittest.TestCase):
    def test_outlook_teams_invite_is_accepted(self):
        svc = make_service()
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        [m] = upcoming(svc)
        self.assertEqual(m["platform"], "teams")
        self.assertEqual(m["url"], TEAMS_LINK)
        # 10:00 Eastern in November is 15:00 UTC.
        self.assertTrue(m["start"].endswith("15:00:00+00:00"), m["start"])

        [reply] = svc.mailbox.sent
        self.assertEqual(reply["To"], "pat@contoso.com")
        self.assertTrue(reply["Subject"].startswith("Accepted:"))
        cal_part = next(p for p in reply.walk() if p.get_content_type() == "text/calendar")
        self.assertEqual(cal_part.get_param("method"), "REPLY")
        cal = icalendar.Calendar.from_ical(cal_part.get_payload(decode=True))
        ev = next(iter(cal.walk("VEVENT")))
        self.assertEqual(str(ev["UID"]), "040000008200E00074C5B7101A82E008")
        self.assertEqual(ev["ATTENDEE"].params["PARTSTAT"], "ACCEPTED")

    def test_weekly_meet_series_and_single_cancel(self):
        svc = make_service()
        svc.handle_message(invite_email(GOOGLE_MEET_WEEKLY, "sam@gmail.com"))
        series = upcoming(svc)
        self.assertEqual(len(series), 4)
        self.assertTrue(all(m["platform"] == "meet" for m in series))

        # Organizer cancels just the second week.
        second = dt.datetime.fromisoformat(series[1]["start"]).strftime("%Y%m%dT%H%M%SZ")
        cancel = with_method(GOOGLE_MEET_WEEKLY, "CANCEL").replace(
            "RRULE:FREQ=WEEKLY;COUNT=4", f"RECURRENCE-ID:{second}")
        svc.handle_message(invite_email(cancel, "sam@gmail.com"))
        remaining = upcoming(svc)
        self.assertEqual(len(remaining), 3)
        self.assertNotIn(series[1]["start"], [m["start"] for m in remaining])

        # Then the whole series.
        svc.handle_message(invite_email(with_method(GOOGLE_MEET_WEEKLY, "CANCEL"), "sam@gmail.com"))
        self.assertEqual(upcoming(svc), [])

    def test_zoom_in_location_beats_attached_meet(self):
        svc = make_service()
        svc.handle_message(invite_email(ZOOM_IN_LOCATION, "alex@partner.org"))
        [m] = upcoming(svc)
        self.assertEqual(m["platform"], "zoom")
        self.assertEqual([p for p, _ in m["links"]], ["zoom", "meet"])

    def test_updated_time_replaces_old_one(self):
        svc = make_service()
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        moved = OUTLOOK_TEAMS.replace("T100000", "T130000").replace("T110000", "T140000").replace("SEQUENCE:0", "SEQUENCE:1")
        svc.handle_message(invite_email(moved))
        [m] = upcoming(svc)
        self.assertTrue(m["start"].endswith("18:00:00+00:00"))

    def test_clash_is_declined(self):
        svc = make_service()
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        clash = OUTLOOK_TEAMS.replace("UID:040000008200E00074C5B7101A82E008", "UID:other").replace(
            "T100000", "T103000").replace("SUMMARY;LANGUAGE=en-US:Quarterly review", "SUMMARY:Overlap")
        svc.handle_message(invite_email(clash))
        self.assertEqual([m["title"] for m in upcoming(svc)], ["Quarterly review"])
        self.assertTrue(svc.mailbox.sent[-1]["Subject"].startswith("Declined:"))

    def test_clash_allowed_when_configured(self):
        svc = make_service(decline_conflicts=False)
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        clash = OUTLOOK_TEAMS.replace("UID:040000008200E00074C5B7101A82E008", "UID:other")
        svc.handle_message(invite_email(clash))
        self.assertEqual(len(upcoming(svc)), 2)

    def test_domain_allow_list(self):
        svc = make_service(accept_from_domains=["contoso.com"])
        svc.handle_message(invite_email(ZOOM_IN_LOCATION, "alex@partner.org"))
        self.assertEqual(upcoming(svc), [])
        self.assertEqual(svc.mailbox.sent, [])
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        self.assertEqual(len(upcoming(svc)), 1)
        self.assertTrue(sender_allowed("a@eu.contoso.com", ["contoso.com"]))
        self.assertFalse(sender_allowed("a@notcontoso.com", ["contoso.com"]))

    def test_no_reply_to_own_invites_or_when_disabled(self):
        svc = make_service(auto_accept=False)
        svc.handle_message(invite_email(OUTLOOK_TEAMS))
        self.assertEqual(len(upcoming(svc)), 1)
        self.assertEqual(svc.mailbox.sent, [])

    def test_meetings_survive_restart(self):
        svc = make_service()
        svc.handle_message(invite_email(GOOGLE_MEET_WEEKLY, "sam@gmail.com"))
        again = Service(svc.cfg, os.path.dirname(svc.store.path))
        self.assertEqual(len(upcoming(again)), 4)

    def test_duplicate_inline_and_attached_calendar(self):
        msg = EmailMessage()
        msg["From"] = "pat@contoso.com"
        msg.set_content("hi")
        msg.add_alternative(OUTLOOK_TEAMS.encode(), maintype="text", subtype="calendar", params={"method": "REQUEST"})
        msg.add_attachment(OUTLOOK_TEAMS.encode(), maintype="application", subtype="ics", filename="invite.ics")
        cals, _ = calendar_parts(email.message_from_bytes(msg.as_bytes(), policy=email.policy.default))
        self.assertEqual(len(cals), 1)

    def test_reply_for_one_occurrence_keeps_recurrence_id(self):
        cal = icalendar.Calendar.from_ical(GOOGLE_MEET_WEEKLY)
        ev = next(iter(cal.walk("VEVENT")))
        ev.add("RECURRENCE-ID", dt.datetime(2026, 12, 1, 20, tzinfo=dt.timezone.utc))
        msg = build_reply(ev, ROOM, "Board Room", "ACCEPTED")
        self.assertIn(b"RECURRENCE-ID", msg.as_bytes())


if __name__ == "__main__":
    unittest.main()
