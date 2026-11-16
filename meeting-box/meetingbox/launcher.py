"""Opens a meeting link in the right app (Zoom / Teams desktop) or the browser."""

import logging
import os
import subprocess
import sys
import webbrowser

from .links import detect_platform, teams_app_url, zoom_app_url

log = logging.getLogger("meetingbox.launch")


def _open_uri(uri):
    """Hand a URI to the OS so its registered app (zoommtg:, msteams:) opens it."""
    if sys.platform.startswith("win"):
        os.startfile(uri)  # noqa: S606 - URI comes from a recognised meeting link
    elif sys.platform == "darwin":
        subprocess.Popen(["open", uri])
    else:
        subprocess.Popen(["xdg-open", uri])


def _open_browser(url, browser_command):
    if browser_command:
        cmd = [part.replace("{url}", url) for part in browser_command]
        if not any("{url}" in part for part in browser_command):
            cmd.append(url)
        subprocess.Popen(cmd)
    else:
        webbrowser.open(url, new=1)


def plan(url, launch_cfg, room_name):
    """Work out what will be opened, without opening it. Returns (how, target)."""
    platform = detect_platform(url)
    if platform is None:
        raise ValueError("Not a Teams, Zoom, Google Meet or Webex link")
    mode = launch_cfg.get(platform, "browser")
    if platform == "zoom" and mode == "app":
        app = zoom_app_url(url, room_name)
        if app:
            return "app", app
    if platform == "teams" and mode == "app":
        app = teams_app_url(url)
        if app:
            return "app", app
    return "browser", url


def launch(url, launch_cfg, room_name):
    how, target = plan(url, launch_cfg, room_name)
    log.info("Joining via %s: %s", how, target)
    if how == "app":
        _open_uri(target)
    else:
        _open_browser(target, launch_cfg.get("browser_command"))
    return how, target
