import datetime as dt
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "public"
DATA = BASE / "data"
DATA_FILE = DATA / "schedule.json"
XLSX_FILE = BASE.parent / "2026 FIBA 3x3 TV Package.xlsx"

TZ = dt.timezone(dt.timedelta(hours=8))
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

EVENTS = ("Challenger", "WT", "WS", "CUP")
OPERATIONS = ("開始錄影", "直播")
TOOLS = ("obs-1", "obs-2", "vMix")


def now_iso():
    return dt.datetime.now(TZ).isoformat(timespec="seconds")


def _to_date(value):
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    text = str(value).strip()
    for fmt in ("%d %b %Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unknown date value: {value!r}")


def _to_time(value):
    if isinstance(value, dt.time):
        return f"{value.hour:02d}:{value.minute:02d}"
    text = str(value).strip()
    parts = text.split(":")[:2]
    if len(parts) == 2:
        try:
            return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
        except ValueError:
            pass
    return text


def normalize_tool(value):
    if value is None:
        return None
    key = str(value).strip().lower().replace("_", "-").replace(" ", "")
    aliases = {"vmix": "vMix", "obs1": "obs-1", "obs2": "obs-2"}
    return aliases.get(key, str(value).strip())


def local_dt(date_str, time_str):
    d = dt.date.fromisoformat(date_str)
    h, m = (int(x) for x in time_str.split(":"))
    return dt.datetime(d.year, d.month, d.day, h, m, tzinfo=TZ)


def make_item(letter, date_str, time_str, event, region, operation, description,
              end_time, end_date, relation, tool, source):
    end_datetime = None
    if end_time and end_date:
        end_datetime = local_dt(end_date, end_time).isoformat()
    return {
        "id": f"{source}-{letter}",
        "letter": letter,
        "date": date_str,
        "time": time_str,
        "datetime": local_dt(date_str, time_str).isoformat(),
        "event": event or "",
        "region": region or "",
        "operation": operation or "",
        "description": description or "",
        "end_time": end_time,
        "end_date": end_date,
        "end_datetime": end_datetime,
        "relation": relation,
        "tool": tool,
        "source": source,
    }


def import_xlsx(path):
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    items = []
    current_date = None
    in_section = False
    empty_streak = 0

    for row in ws.iter_rows(values_only=True):
        letter = row[0] if len(row) > 0 else None
        col_b = row[1] if len(row) > 1 else None

        if letter is None and col_b is None:
            if in_section:
                empty_streak += 1
                if empty_streak >= 3:
                    in_section = False
                    current_date = None
            continue

        empty_streak = 0
        text_b = str(col_b).strip() if col_b is not None else ""

        if letter is None:
            if text_b == "開始時間(UTC+8)":
                in_section = True
                continue
            if text_b:
                try:
                    current_date = _to_date(col_b)
                    in_section = False
                    continue
                except ValueError:
                    continue

        if not in_section or current_date is None:
            continue

        time_str = _to_time(col_b)
        event = str(row[2]).strip() if len(row) > 2 and row[2] is not None else ""
        region = str(row[3]).strip() if len(row) > 3 and row[3] is not None else ""
        operation = str(row[4]).strip() if len(row) > 4 and row[4] is not None else ""
        description = str(row[5]).strip() if len(row) > 5 and row[5] is not None else ""
        end_raw = row[6] if len(row) > 6 else None
        relation = str(row[7]).strip() if len(row) > 7 and row[7] is not None else None
        tool = normalize_tool(row[8] if len(row) > 8 else None)

        end_time = _to_time(end_raw) if end_raw is not None else None
        end_date = None
        if end_time:
            end_date = (current_date + dt.timedelta(days=1)).isoformat() \
                if end_time <= time_str else current_date.isoformat()

        items.append(make_item(
            letter=str(letter).strip(), date_str=current_date.isoformat(),
            time_str=time_str, event=event, region=region, operation=operation,
            description=description, end_time=end_time, end_date=end_date,
            relation=relation, tool=tool, source="seed",
        ))

    return sorted(items, key=lambda i: i["datetime"])


def next_letter(used):
    used = set(used)
    i = 0
    while True:
        if i < 26:
            candidate = chr(ord("a") + i)
        else:
            candidate = "a" + chr(ord("a") + (i - 26))
        if candidate not in used:
            return candidate
        i += 1


def validate_payload(payload, require_operation=True):
    date_str = str(payload.get("date") or "").strip()
    time_str = str(payload.get("time") or "").strip()
    end_time = str(payload.get("end_time") or "").strip()
    event = str(payload.get("event") or "").strip()
    region = str(payload.get("region") or "").strip()
    operation = str(payload.get("operation") or "").strip()
    description = str(payload.get("description") or "").strip()
    tool = normalize_tool(payload.get("tool"))

    if not DATE_RE.match(date_str):
        return "日期格式必須是 YYYY-MM-DD", None
    if not TIME_RE.match(time_str):
        return "開始時間格式必須是 HH:MM", None
    if end_time and not TIME_RE.match(end_time):
        return "結束時間格式必須是 HH:MM", None
    if end_time and end_time == time_str:
        return "結束時間不能與開始時間相同", None
    if event not in EVENTS:
        return "賽事必須是 Challenger / WT / WS / CUP", None
    if require_operation and operation not in OPERATIONS:
        return "操作必須是 開始錄影 / 直播", None
    if not region:
        return "請輸入地區", None
    if tool not in TOOLS:
        return "使用工具必須是 obs-1 / obs-2 / vMix", None
    try:
        start_date = dt.date.fromisoformat(date_str)
    except ValueError:
        return "日期格式不正確", None

    return None, {
        "date": date_str,
        "time": time_str,
        "end_time": end_time or None,
        "event": event,
        "region": region,
        "operation": operation,
        "description": description,
        "tool": tool,
        "start_date": start_date,
    }


def save_items(items):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


def load_items():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    items = []
    if XLSX_FILE.exists():
        items = import_xlsx(XLSX_FILE)
    save_items(items)
    return items


class Handler(BaseHTTPRequestHandler):
    server_version = "FIBA3x3Schedule/1.0"

    def log_message(self, fmt, *args):
        print(f"[server] {fmt % args}")

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        relative = unquote(path).lstrip("/")
        target = (PUBLIC / relative).resolve()
        if not str(target).startswith(str(PUBLIC.resolve())):
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(target.suffix.lower(), "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/schedule":
            self._send_json({"items": load_items(), "now": now_iso()})
            return
        if parsed.path == "/api/now":
            self._send_json({"now": now_iso()})
            return
        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/schedule":
            self._send_json({"error": "not found"}, 404)
            return

        payload = self._read_json()
        if not isinstance(payload, dict):
            self._send_json({"error": "invalid JSON body"}, 400)
            return

        err, vals = validate_payload(payload, require_operation=True)
        if err:
            self._send_json({"error": err}, 400)
            return
        if not vals["end_time"]:
            self._send_json({"error": "結束時間格式必須是 HH:MM"}, 400)
            return

        date_str = vals["date"]
        time_str = vals["time"]
        end_time = vals["end_time"]
        event = vals["event"]
        region = vals["region"]
        operation = vals["operation"]
        description = vals["description"]
        tool = vals["tool"]
        start_date = vals["start_date"]

        end_date = start_date + dt.timedelta(days=1) if end_time <= time_str else start_date
        start_op, end_op = ("開始錄影", "停止錄影") if operation == "開始錄影" else ("Live", "End Live")

        items = load_items()
        used = [item["letter"] for item in items]
        start_letter = next_letter(used)
        used.append(start_letter)
        end_letter = next_letter(used)

        start_item = make_item(
            start_letter, date_str, time_str, event, region, start_op,
            description, end_time, end_date.isoformat(), end_letter, tool, "form",
        )
        end_item = make_item(
            end_letter, end_date.isoformat(), end_time, event, region, end_op,
            description, None, None, None, tool, "form",
        )
        items.extend([start_item, end_item])
        items.sort(key=lambda i: i["datetime"])
        save_items(items)
        self._send_json({"items": [start_item, end_item]}, 201)

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/schedule":
            self._send_json({"error": "not found"}, 404)
            return
        query = parse_qs(parsed.query)
        item_id = (query.get("id") or [None])[0]
        if not item_id:
            self._send_json({"error": "missing id"}, 400)
            return

        payload = self._read_json()
        if not isinstance(payload, dict):
            self._send_json({"error": "invalid JSON body"}, 400)
            return

        err, vals = validate_payload(payload, require_operation=False)
        if err:
            self._send_json({"error": err}, 400)
            return

        items = load_items()
        item = next((x for x in items if x["id"] == item_id), None)
        if not item:
            self._send_json({"error": "item not found"}, 404)
            return

        start_like = bool(item.get("relation") or item.get("end_time"))
        if start_like and not vals["end_time"]:
            self._send_json({"error": "結束時間格式必須是 HH:MM"}, 400)
            return

        target = None
        if item.get("relation"):
            target = next(
                (x for x in items if x["letter"] == item["relation"]),
                None,
            )

        end_time = vals["end_time"] if start_like else item.get("end_time")
        end_date = None
        if end_time:
            end_date = (vals["start_date"] + dt.timedelta(days=1)).isoformat() \
                if end_time <= vals["time"] else vals["start_date"].isoformat()

        item.update({
            "date": vals["date"],
            "time": vals["time"],
            "datetime": local_dt(vals["date"], vals["time"]).isoformat(),
            "event": vals["event"],
            "region": vals["region"],
            "description": vals["description"],
            "end_time": end_time,
            "end_date": end_date,
            "end_datetime": local_dt(end_date, end_time).isoformat()
                if end_time and end_date else None,
            "tool": vals["tool"],
        })

        if start_like:
            if vals["operation"] == "直播":
                item["operation"] = "Live"
                if target:
                    target["operation"] = "End Live"
            elif vals["operation"] == "開始錄影":
                item["operation"] = "開始錄影"
                if target:
                    target["operation"] = "停止錄影"

        if target and end_time:
            target.update({
                "date": end_date,
                "time": end_time,
                "datetime": local_dt(end_date, end_time).isoformat(),
                "event": vals["event"],
                "region": vals["region"],
                "description": vals["description"],
                "tool": vals["tool"],
            })

        items.sort(key=lambda i: i["datetime"])
        save_items(items)
        self._send_json({"items": [item] + ([target] if target else [])})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/schedule":
            self._send_json({"error": "not found"}, 404)
            return
        query = parse_qs(parsed.query)
        item_id = (query.get("id") or [None])[0]
        if not item_id:
            self._send_json({"error": "missing id"}, 400)
            return
        items = load_items()
        remaining = [item for item in items if item["id"] != item_id]
        if len(remaining) == len(items):
            self._send_json({"error": "item not found"}, 404)
            return
        save_items(remaining)
        self._send_json({"ok": True})


def main():
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"FIBA 3x3 時間表已啟動: http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
