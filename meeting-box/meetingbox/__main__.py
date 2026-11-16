"""Run the meeting box:  python -m meetingbox [--config config.json] [check]"""

import argparse
import datetime as dt
import json
import logging
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import launcher
from .service import Service, load_config

HERE = os.path.dirname(os.path.abspath(__file__))


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                with open(os.path.join(HERE, "kiosk.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if self.path == "/api/state":
                return self._send(200, {
                    "room_name": service.cfg["room_name"],
                    "address": service.mailbox.address if service.mailbox else None,
                    "auto_join": service.cfg["auto_join"],
                    "meetings": service.schedule(days=2),
                    "status": service.status,
                })
            self._send(404, {"error": "not found"})

        def do_POST(self):
            # The custom header forces a CORS preflight, so other web pages open in
            # the kiosk browser cannot make this box launch things.
            if self.headers.get("X-Meeting-Box") != "1":
                return self._send(403, {"error": "forbidden"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/api/join":
                    how, _ = service.join_meeting(body["key"])
                elif self.path == "/api/join-url":
                    how, _ = service.join_url(body["url"].strip())
                    service._note("Joined a pasted link")
                elif self.path == "/api/sync":
                    threading.Thread(target=service.sync, daemon=True).start()
                    how = None
                else:
                    return self._send(404, {"error": "not found"})
                self._send(200, {"ok": True, "how": how})
            except (KeyError, ValueError) as exc:
                self._send(400, {"error": str(exc).strip("'")})
            except Exception as exc:
                self._send(500, {"error": f"Could not open the meeting: {exc}"})

    return Handler


def main():
    ap = argparse.ArgumentParser(prog="meetingbox")
    ap.add_argument("command", nargs="?", default="run", choices=["run", "check"])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--data", default=None, help="folder for saved meetings (default: next to config)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    with open(args.config, encoding="utf-8") as f:
        cfg = load_config(json.load(f))
    data_dir = args.data or os.path.join(os.path.dirname(os.path.abspath(args.config)), "data")

    if args.command == "check":
        # Dry run: read everything but send no replies and save nothing.
        cfg["auto_accept"] = False
        service = Service(cfg, tempfile.mkdtemp(prefix="meetingbox-check-"))
        if service.mailbox:
            service.mailbox._imap().logout()
            print(f"✓ Signed in to the mailbox for {service.mailbox.address} (IMAP)")
            service.mailbox.check_smtp()
            print("✓ Can send replies (SMTP)")
        service.sync()
        for err in service.status["errors"]:
            print("✗", err["text"])
        meetings = service.schedule(days=7)
        print(f"\nNext 7 days: {len(meetings)} meeting(s)")
        for m in meetings:
            how = launcher.plan(m["url"], cfg["launch"], cfg["room_name"])[0] if m["url"] else "-"
            when = dt.datetime.fromisoformat(m["start"]).astimezone().strftime("%a %d %b %H:%M")
            print(f"  {when}  {m['platform'] or 'no link':6}  via {how:7}  {m['title']}")
        return

    service = Service(cfg, data_dir)
    server = ThreadingHTTPServer(("127.0.0.1", cfg["port"]), make_handler(service))
    threading.Thread(target=service.run_forever, daemon=True).start()
    logging.info("Meeting box for %s running at http://127.0.0.1:%s", cfg["room_name"], cfg["port"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        service.stop.set()


if __name__ == "__main__":
    main()
