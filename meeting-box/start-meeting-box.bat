@echo off
rem Starts the meeting box service and opens the touchscreen page full screen.
rem Put a shortcut to this file in shell:startup so it runs when the PC signs in.
cd /d "%~dp0"
start "Meeting Box" /min pythonw -m meetingbox --config config.json
timeout /t 3 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --app=http://127.0.0.1:8765 --user-data-dir="%LOCALAPPDATA%\MeetingBoxKiosk" --no-first-run
