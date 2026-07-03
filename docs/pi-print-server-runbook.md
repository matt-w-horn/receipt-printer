# Direct-to-Metal Print Server Runbook

**System:** Raspberry Pi Zero W + Epson TM-T20III
**Role:** Secure, headless print server for the `receipt-printer` Apps Script job
(daily generative art).
**Owner:** Matt Horn

This is the receiving end of the pipeline. The Apps Script side (in `src/`) builds
ESC/POS byte payloads and POSTs them to this server; this box authenticates the
request and writes the raw bytes straight to the printer's character device. See
the top-level [README](../README.md) for the Apps Script side and
[`escpos-protocol.md`](escpos-protocol.md) for the byte protocol.

> **Secrets are redacted here on purpose.** Placeholders like `<NGROK_USER>` /
> `<NGROK_PASS>` / `<NGROK_DOMAIN>` stand in for real values, which live in the
> password manager and in Apps Script **Script Properties** — never in this repo.
> Don't paste real credentials or hostnames into this file.

---

## 1. Architecture Overview

**Hardware**

- **Compute:** Raspberry Pi Zero W (headless).
- **Printer:** Epson TM-T20III over USB (character device `/dev/usb/lp0`).
- **Power:** Separate power supplies for the Pi and the printer.

**Software stack**

- **OS:** Raspberry Pi OS Lite (Bullseye/Bookworm).
- **Server:** Python 3 (`http.server`) writing raw bytes to USB.
- **Tunnel:** ngrok (static domain + basic auth).
- **Process management:** systemd (`printer.service`).
- **Client:** Google Apps Script (`dist/main.gs`, built from `src/`, trigger-based).

```
Apps Script trigger → sendToPi() → ngrok (static domain, basic auth)
   → Pi Zero W: Python http.server on :8080 → /dev/usb/lp0 → Epson TM-T20III
```

---

## 2. Credentials & Secrets

Real values live in the password manager; the Apps Script side reads them from
Script Properties. This table is a map of _where each secret lives_, not the
secrets themselves.

| Service           | Location                      | Key / field                          |
| ----------------- | ----------------------------- | ------------------------------------ |
| **SSH access**    | Pi local network              | user `pi` / password                 |
| **ngrok auth**    | `start_print_system.sh` on Pi | `<NGROK_USER>` / `<NGROK_PASS>`      |
| **Google Script** | Project Settings → Properties | `NGROK_USER`, `NGROK_PASS`, `PI_URL` |

The ngrok basic-auth pair on the Pi (`start_print_system.sh`) must match
`NGROK_USER` / `NGROK_PASS` in Script Properties exactly. The static ngrok
domain is `<NGROK_DOMAIN>`.

---

## 3. File Paths & Configuration

### A. Python server — `/home/pi/printer_project/printer_server.py`

- Listens on port `8080`, sits behind ngrok's basic auth, pipes raw request
  bytes to `/dev/usb/lp0`.
- **Restart logic:** self-terminates every 3600 seconds (1 hour) to force a
  clean systemd refresh.

### B. Startup script — `/home/pi/printer_project/start_print_system.sh`

- Cleans up old processes, waits for Wi-Fi, launches Python, then launches ngrok.
- **Critical command** (credentials redacted):

  ```bash
  nohup ngrok http \
    --domain=<NGROK_DOMAIN> \
    --basic-auth="<NGROK_USER>:<NGROK_PASS>" \
    127.0.0.1:8080 > /home/pi/printer_project/ngrok.log 2>&1 &
  ```

### C. systemd service — `/etc/systemd/system/printer.service`

- Runs the startup script at boot and restarts it on crash.
- **Key settings:** `Restart=always`, `RestartSec=30`.

### D. Scheduled maintenance — `sudo crontab -e`

- **Schedule:** every Monday at 04:00.
- **Command:** `/sbin/shutdown -r now` (clears RAM and resets the USB stack).

---

## 4. Maintenance Commands

**SSH access:**

```bash
ssh pi@printserver.local
```

**Restart the printer service (fixes 99% of issues):**

```bash
sudo systemctl restart printer
```

**Check status & logs:**

```bash
# Service status (green dot = good)
sudo systemctl status printer

# Python logs (real-time)
tail -f /home/pi/printer_project/server.log

# ngrok logs (URL / connection errors)
cat /home/pi/printer_project/ngrok.log
```

**Check hardware connection:**

```bash
# Is the printer physically seen? (look for "Seiko Epson Corp")
lsusb

# Does the system see the character device?
ls -l /dev/usb/lp0
```

---

## 5. Troubleshooting Guide

### Google Script says "Ngrok Error 502"

- **Meaning:** ngrok is online, but Python is dead.
- **Fix:** `sudo systemctl restart printer`
- **Root cause:** the Python script may have crashed on a bad character or a USB
  disconnect.

### Google Script says "Ngrok Error 401"

- **Meaning:** wrong password.
- **Fix:** check **Script Properties** in Apps Script — `NGROK_USER` and
  `NGROK_PASS` must match exactly what's in `start_print_system.sh` on the Pi.

### Printer is silent, but the script says "Success"

- **Meaning:** the Pi received the data, but the printer ignored it.
- **Fix:**
  1. Check whether the paper is loaded **upside down** (scratch test).
  2. Check for flashing error/paper lights on the Epson.
  3. Power-cycle the printer (physical OFF/ON switch).

### "Unexpected error… newBlob"

- **Meaning:** a special character (emoji, smart quote) was sent to a byte
  encoder that couldn't represent it.
- **Status:** guarded in the current code — all printed text goes through
  `encodeCP437` (`src/escpos.ts`), which normalizes smart punctuation, drops
  control characters, and substitutes `?` for anything CP437 can't print. If
  this error recurs, some new code path is bypassing `encodeCP437`.

---

## 6. Disaster Recovery (Rebuild from Scratch)

If the SD card dies, restore in this order:

1. **Flash OS:** install Raspberry Pi OS Lite.
2. **Network:** configure Wi-Fi and enable SSH (`touch ssh` in the boot
   partition).
3. **Dependencies:**

   ```bash
   sudo apt update
   sudo apt remove cups -y
   sudo usermod -a -G lp pi
   ```

4. **ngrok:** download the ARM build, install, then
   `ngrok config add-authtoken <TOKEN>`.
5. **Code:** `mkdir printer_project`, copy in `printer_server.py` and
   `start_print_system.sh`.
6. **Service:** create `/etc/systemd/system/printer.service`, then `enable` and
   `start` it.
7. **Security:** install UFW, set up unattended-upgrades.

---

## 7. End-to-End Test (curl)

Run from a laptop to verify connectivity all the way to paper. Replace the
credentials with the real ngrok basic-auth values from the password manager.

```bash
printf "\x1B\x40SYSTEM ONLINE\x0A\x0A\x0A\x1D\x56\x42\x00" \
  | curl -v -u "<NGROK_USER>:<NGROK_PASS>" \
      -X POST --data-binary @- \
      https://<NGROK_DOMAIN>
```

A short "SYSTEM ONLINE" receipt should print and cut.
