#!/usr/bin/env python3
"""Local Octopus Energy dashboard server. Python 3.9+, standard library only.

Serves ./static and proxies the Octopus REST API so your API key stays on this
machine (it is stored in config.json and never sent to the browser).

    python3 server.py            # http://127.0.0.1:8765
    python3 server.py 9000       # custom port
    python3 server.py --lan      # also reachable from other devices on your home network
"""
import base64
import ipaddress
import json
import math
import mimetypes
import os
import random
import re
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

try:
    from zoneinfo import ZoneInfo
    LONDON = ZoneInfo("Europe/London")
except Exception:  # pragma: no cover - demo data falls back to UTC
    LONDON = timezone.utc

API = "https://api.octopus.energy/v1"
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CONFIG_FILE = ROOT / "config.json"
CACHE_FILE = ROOT / "cache.json"
PROPERTY_FILE = ROOT / "property.json"  # geocoded address and building outlines, so each is looked up once
CACHE_TTL = 30 * 60  # seconds
LOCK = threading.Lock()
LAN = False  # set by --lan: listen on the local network instead of only this computer


def _ip(addr):
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
        return ip.ipv4_mapped or ip if ip.version == 6 else ip
    except ValueError:
        return None


def is_loopback(addr):
    ip = _ip(addr)
    return bool(ip and ip.is_loopback)


def is_private(addr):
    ip = _ip(addr)
    return bool(ip and (ip.is_private or ip.is_loopback))


def lan_addresses():
    ips = set()
    try:  # no packet is sent; this just asks the OS which address it would use
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- config ----

def load_config():
    cfg = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
        except ValueError:
            cfg = {}
    cfg["apiKey"] = os.environ.get("OCTOPUS_API_KEY") or cfg.get("apiKey")
    cfg["account"] = os.environ.get("OCTOPUS_ACCOUNT") or cfg.get("account")
    return cfg


def save_config(cfg):
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)


# ------------------------------------------------------------ octopus api ----

def api_get(url, key=None):
    req = Request(url, headers={"Accept": "application/json",
                                "User-Agent": "octopus-solar-dashboard/1.0"})
    if key:
        token = base64.b64encode((key + ":").encode()).decode()
        req.add_header("Authorization", "Basic " + token)
    try:
        with urlopen(req, timeout=30) as r:
            return json.load(r)
    except HTTPError as e:
        if e.code in (401, 403):
            raise ApiError(401, "Octopus rejected the API key (check the key and account number).")
        if e.code == 404:
            raise ApiError(404, "Not found on Octopus: " + url.split("?")[0].replace(API, ""))
        raise ApiError(502, "Octopus API error %s" % e.code)
    except URLError as e:
        raise ApiError(502, "Could not reach Octopus: %s" % e.reason)


def paginate(url, key=None):
    out = []
    while url:
        page = api_get(url, key)
        out.extend(page.get("results", []))
        url = page.get("next")
    return out


def parse_dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ms(d):
    return int(d.timestamp() * 1000)


def discover(account, key):
    acct = api_get("%s/accounts/%s/" % (API, account), key)
    points = []
    for prop in acct.get("properties", []):
        if prop.get("moved_out_at"):
            continue
        points.extend(prop.get("electricity_meter_points", []))
    imports = [p for p in points if not p.get("is_export")] or points
    if not imports:
        raise ApiError(404, "No electricity meter point found on this account.")
    mp = imports[0]
    meters = [m for m in mp.get("meters", []) if m.get("serial_number")]
    if not meters:
        raise ApiError(404, "No electricity meter serial number found on this account.")
    return {
        "mpan": mp["mpan"],
        "serial": meters[-1]["serial_number"],
        "agreements": mp.get("agreements", []),
    }


def ev_configured(account, key, tariffs):
    """Does this account have an EV or EV charger set up? Octopus lists connected smart-charge devices in its GraphQL API;
    Intelligent Octopus Go, which needs a connected car or charger, is a second sign. Returns (bool, why)."""
    if any(("INTELLI" in t or "-IOG-" in t) for t in tariffs):
        return True, "an Intelligent Octopus tariff"
    gql = API + "/graphql/"
    try:
        def post(body, token=None):
            h = {"Content-Type": "application/json", **({"Authorization": token} if token else {})}
            return ext_json(gql, json.dumps(body).encode(), timeout=15, headers=h)
        tok = post({"query": "mutation($k:String!){obtainKrakenToken(input:{APIKey:$k}){token}}", "variables": {"k": key}})
        token = tok["data"]["obtainKrakenToken"]["token"]
        res = post({"query": "query($a:String!){devices(accountNumber:$a){deviceType}}", "variables": {"a": account}}, token)
        kinds = {d.get("deviceType") for d in (res.get("data") or {}).get("devices") or []}
        if kinds & {"ELECTRIC_VEHICLES", "CHARGE_POINTS"}:
            return True, "a connected EV or charger"
    except (ApiError, KeyError, TypeError):
        pass  # unknown: treated as no EV, so nothing is wrongly split out of your usage
    return False, ""


def price_history(info, now):
    """12-month average peak / off-peak unit rates and standing charge, for the last four years, stitched across
    the products on the account (the most recently launched product wins at any date)."""
    prods = {}
    for ag in info["agreements"]:
        m = re.match(r"^E-(?:1R|2R)-(.+)-[A-Z]$", ag["tariff_code"])
        if m:
            prods[m.group(1)] = ag["tariff_code"]
    start = now - timedelta(days=4 * 365 + 40)
    q = urlencode({"period_from": iso(start), "page_size": 1500})
    series = {}
    for prod, code in prods.items():
        base = "%s/products/%s/electricity-tariffs/%s" % (API, prod, code)

        def get(kind):
            try:
                return [(ms(parse_dt(r["valid_from"])), ms(parse_dt(r["valid_to"])) if r.get("valid_to") else 1 << 62, r["value_inc_vat"])
                        for r in paginate("%s/%s/?%s" % (base, kind, q))]
            except ApiError:
                return []
        std = get("standard-unit-rates")
        day, night = ([], []) if std else (get("day-unit-rates"), get("night-unit-rates"))
        stand = get("standing-charges")
        launch = min([r[0] for r in std + day + night + stand] or [1 << 62])
        series[prod] = {"peak": std or day, "off": std or night, "stand": stand, "launch": launch}

    def value(kind, t):
        for prod in sorted(series, key=lambda p: -series[p]["launch"]):
            if series[prod]["launch"] > t:
                continue
            for a, b, v in series[prod][kind]:
                if a <= t < b:
                    return v
        return None

    samples = []
    t = start
    while t < now:
        noon, night = ms(t.replace(hour=13, minute=0)), ms(t.replace(hour=2, minute=0))
        samples.append((t, value("peak", noon), value("off", night), value("stand", noon)))
        t += timedelta(days=10)
    out = []
    for k in range(4):
        end = now - timedelta(days=365 * k)
        w = [x for x in samples if end - timedelta(days=365) <= x[0] < end]
        pick = lambda i: [x[i] for x in w if x[i] is not None]
        p, o, st = pick(1), pick(2), pick(3)
        if len(p) < 20 or len(o) < 20:
            break
        out.append({"end": end.strftime("%Y-%m"), "peak": sum(p) / len(p), "off": sum(o) / len(o),
                    "standing": sum(st) / len(st) if st else None})
    return out


def fetch_octopus(cfg, days):
    key, account = cfg["apiKey"], cfg["account"]
    info = discover(account, key)
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)

    url = "%s/electricity-meter-points/%s/meters/%s/consumption/?%s" % (
        API, info["mpan"], info["serial"],
        urlencode({"period_from": iso(start), "period_to": iso(now),
                   "page_size": 25000, "order_by": "period"}))
    rows = paginate(url, key)
    # Octopus does not always return pages in time order; sort and drop duplicate slots.
    consumption = sorted({ms(parse_dt(r["interval_start"])): r["consumption"] for r in rows}.items())
    consumption = [[t, v] for t, v in consumption]
    if not consumption:
        raise ApiError(404, "No half-hourly consumption returned. Check that smart-meter "
                            "half-hourly data is enabled in your Octopus account.")

    rates, day, night, standing, tariffs, warnings = [], [], [], [], [], []
    for ag in info["agreements"]:
        a_from = parse_dt(ag["valid_from"])
        a_to = parse_dt(ag["valid_to"]) if ag.get("valid_to") else None
        if a_from >= now or (a_to and a_to <= start):
            continue
        code = ag["tariff_code"]
        tariffs.append(code)
        m = re.match(r"^E-(?:1R|2R)-(.+)-[A-Z]$", code)
        if not m:
            warnings.append("Could not parse tariff code " + code)
            continue
        base = "%s/products/%s/electricity-tariffs/%s" % (API, m.group(1), code)
        q = urlencode({"period_from": iso(max(a_from, start)),
                       "period_to": iso(min(a_to, now) if a_to else now),
                       "page_size": 1500})
        lo, hi = ms(a_from), (ms(a_to) if a_to else None)

        def grab(kind, dest):
            """Fetch rate records, clipped to this agreement so tariffs never overlap."""
            got = 0
            try:
                for r in paginate("%s/%s/?%s" % (base, kind, q)):
                    f = max(ms(parse_dt(r["valid_from"])), lo)
                    t = ms(parse_dt(r["valid_to"])) if r.get("valid_to") else None
                    if hi is not None and (t is None or t > hi):
                        t = hi
                    if t is None or t > f:
                        dest.append([f, t, r["value_inc_vat"]])
                        got += 1
            except ApiError as e:
                warnings.append("%s unavailable for %s (%s)" % (kind, code, e.message))
            return got

        grab("standing-charges", standing)
        # Normal tariffs publish a time-of-day schedule here; Intelligent Octopus Go
        # "four rate EV" products leave it empty and publish flat day / night rates instead.
        if not grab("standard-unit-rates", rates):
            grab("day-unit-rates", day)
            grab("night-unit-rates", night)
    for lst in (rates, day, night, standing):
        lst.sort(key=lambda r: r[0])
    try:
        history = price_history(info, now)
    except Exception as e:  # history is a nice-to-have; never block the dashboard on it
        history = []
        warnings.append("Rate history unavailable (%s)" % e)
    ev, ev_why = ev_configured(account, key, tariffs)
    return {
        "meta": {"demo": False, "account": account, "mpan": info["mpan"], "ev": ev, "evWhy": ev_why,
                 "tariffs": tariffs, "warnings": warnings,
                 "fetchedAt": ms(now)},
        "consumption": consumption, "rates": rates, "day": day, "night": night,
        "standing": standing, "history": history,
    }


# ------------------------------------------------------- address and roof ----
# The address comes from your Octopus account. To put it on a map it is sent to OpenStreetMap's Nominatim (falling
# back to postcodes.io, which only sees the postcode), and building outlines are fetched from OpenStreetMap's Overpass
# API for the area around the point. Nothing else leaves this computer, and every answer is cached in property.json.
NOMINATIM = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REV = "https://nominatim.openstreetmap.org/reverse"
POSTCODES = "https://api.postcodes.io/postcodes/"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
POSTCODE_RE = re.compile(r"^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$")
DEMO_PLACE = {"lat": 51.76003, "lon": -1.20993, "label": "Demo location (a semi-detached house in Headington, Oxford): search for your own postcode",
              "source": "demo"}
GEO_MEM = {}


def ext_json(url, data=None, timeout=25, headers=None):
    """GET (or POST data to) a JSON API."""
    req = Request(url, data=data, headers={"Accept": "application/json",
                                           "User-Agent": "octopus-solar-dashboard/1.0 (personal local tool)", **(headers or {})})
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except HTTPError as e:
        raise ApiError(502, "Lookup failed (%s)" % e.code)
    except (URLError, OSError, ValueError) as e:
        raise ApiError(502, "Lookup failed: %s" % getattr(e, "reason", e))


def geo_cache(key, fn):
    """Answers are remembered in memory and in property.json."""
    with LOCK:
        if not GEO_MEM and PROPERTY_FILE.exists():
            try:
                GEO_MEM.update(json.loads(PROPERTY_FILE.read_text()))
            except ValueError:
                pass
        if key in GEO_MEM:
            return GEO_MEM[key]
    value = fn()
    with LOCK:
        GEO_MEM[key] = value
        if len(GEO_MEM) > 200:
            GEO_MEM.pop(next(iter(GEO_MEM)))
        PROPERTY_FILE.write_text(json.dumps(GEO_MEM))
    return value


def tidy_postcode(pc):
    pc = re.sub(r"\s+", "", (pc or "").upper())
    return pc[:-3] + " " + pc[-3:] if len(pc) > 3 else pc


def geocode(text):
    """Place a postcode or an address on the map: {lat, lon, label, source}."""
    text = " ".join((text or "").split())
    if not text or len(text) > 200:
        raise ApiError(400, "Enter a postcode or an address.")
    pc = tidy_postcode(text)

    def run():
        if POSTCODE_RE.match(pc):
            try:
                r = ext_json(POSTCODES + quote(pc.replace(" ", "")))["result"]
                return {"lat": r["latitude"], "lon": r["longitude"], "label": pc, "source": "postcode"}
            except (ApiError, KeyError, TypeError):
                pass
        hits = ext_json(NOMINATIM + "?" + urlencode({"q": text, "format": "jsonv2", "limit": 1, "countrycodes": "gb"}))
        if not hits:
            raise ApiError(404, "Could not find that place. Try the postcode.")
        h = hits[0]
        return {"lat": float(h["lat"]), "lon": float(h["lon"]), "label": h.get("display_name", text), "source": "address"}
    return geo_cache("geo:" + text.upper(), run)


def account_address(cfg):
    acct = api_get("%s/accounts/%s/" % (API, cfg["account"]), cfg["apiKey"])
    props = acct.get("properties", [])
    props = [p for p in props if not p.get("moved_out_at")] or props
    if not props:
        raise ApiError(404, "No property found on this account.")
    p = props[0]
    lines = [p.get(k) for k in ("address_line_1", "address_line_2", "address_line_3", "town", "county")]
    return {"lines": [x for x in lines if x], "postcode": tidy_postcode(p.get("postcode"))}


def property_info(cfg):
    """The account's address and where it is. If the address cannot be placed, fall back to the postcode."""
    addr = account_address(cfg)
    place = None
    try:
        place = geocode(", ".join(addr["lines"] + [addr["postcode"]]))
    except ApiError:
        pass
    if (not place or place["source"] != "address") and POSTCODE_RE.match(addr["postcode"] or ""):
        try:
            place = geocode(addr["postcode"])
        except ApiError:
            pass
    if not place:
        raise ApiError(404, "Could not place your address on the map. Search for your postcode instead.")
    return {"address": ", ".join(addr["lines"] + [addr["postcode"]]), "postcode": addr["postcode"], **place}


def building_at(lat, lon):
    """The single building at a point, from Nominatim. A slower-to-scale but more reliable fallback for Overpass."""
    def run():
        d = ext_json(NOMINATIM_REV + "?" + urlencode({"lat": "%.6f" % lat, "lon": "%.6f" % lon, "zoom": 18, "format": "jsonv2",
                                                      "polygon_geojson": 1, "addressdetails": 0}))
        g = d.get("geojson") or {}
        if d.get("category") != "building" or g.get("type") != "Polygon":
            return []
        pts = [[y, x] for x, y in g["coordinates"][0]]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        return [{"id": int(d.get("osm_id") or 0), "poly": pts, "tags": {}}] if len(pts) >= 3 else []
    return geo_cache("bat:%.5f:%.5f" % (lat, lon), run)


BUILDING_TAGS = ("building", "building:levels", "height", "roof:shape", "roof:orientation", "roof:direction", "roof:angle",
                 "roof:levels", "addr:housenumber")


def buildings_osm_api(lat, lon, radius):
    """Every building way in a small box, from the OpenStreetMap map API: fast and reliable, and it includes buildings with no address."""
    dl, dn = radius / 111320.0, radius / (111320.0 * math.cos(math.radians(lat)))
    data = ext_json("https://api.openstreetmap.org/api/0.6/map.json?bbox=%.6f,%.6f,%.6f,%.6f" % (lon - dn, lat - dl, lon + dn, lat + dl))
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in data.get("elements", []) if e["type"] == "node"}
    out = []
    for e in data.get("elements", []):
        if e["type"] != "way" or "building" not in e.get("tags", {}):
            continue
        ids = e.get("nodes", [])
        if len(ids) > 1 and ids[0] == ids[-1]:
            ids = ids[:-1]
        pts = [list(nodes[i]) for i in ids if i in nodes]
        if len(pts) >= 3:
            out.append({"id": e["id"], "poly": pts, "tags": {k: v for k, v in e["tags"].items() if k in BUILDING_TAGS}})
    out.sort(key=lambda b: min(abs(p[0] - lat) + abs(p[1] - lon) for p in b["poly"]))
    return out[:80]


def buildings_overpass(lat, lon, radius):
    q = '[out:json][timeout:20];way["building"](around:%d,%.6f,%.6f);out geom tags;' % (radius, lat, lon)
    body = urlencode({"data": q}).encode()
    last = None
    for url in OVERPASS:
        try:
            data = ext_json(url, body, timeout=12)
            break
        except ApiError as e:
            last = e
    else:
        raise last
    out = []
    for el in data.get("elements", []):
        pts = [[g["lat"], g["lon"]] for g in el.get("geometry", [])]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        if len(pts) >= 3:
            out.append({"id": el["id"], "poly": pts, "tags": {k: v for k, v in el.get("tags", {}).items() if k in BUILDING_TAGS}})
    return out[:80]


def buildings(lat, lon, radius=70):
    """Building outlines around a point, from OpenStreetMap, with any roof tags people have added."""
    def run():
        try:
            return buildings_osm_api(lat, lon, radius)
        except ApiError:
            return buildings_overpass(lat, lon, radius)
    return geo_cache("bld2:%.4f:%.4f:%d" % (lat, lon, radius), run)


# -------------------------------------------------------------- demo data ----

def demo_data(days):
    """Plausible half-hourly data for a UK home with an EV on Intelligent Octopus Go."""
    rnd = random.Random(42)
    end_local = datetime.now(LONDON).replace(hour=0, minute=0, second=0, microsecond=0)
    t = (end_local - timedelta(days=days)).astimezone(timezone.utc)
    end = end_local.astimezone(timezone.utc)
    ev_left = 0.0
    out = []
    while t < end:
        lt = t.astimezone(LONDON)
        h = lt.hour + lt.minute / 60.0
        weekend = lt.weekday() >= 5
        season = 1 + 0.35 * math.cos(2 * math.pi * (lt.timetuple().tm_yday - 15) / 365.0)
        load = (0.11
                + 0.22 * math.exp(-((h - 7.8) / 1.0) ** 2)
                + (0.12 if weekend else 0.05) * math.exp(-((h - 13) / 2.5) ** 2)
                + 0.42 * math.exp(-((h - 19) / 1.8) ** 2))
        load *= season * rnd.lognormvariate(0, 0.22)
        if rnd.random() < 0.05:
            load += rnd.uniform(0.3, 0.7)
        if h == 23.5 and ev_left <= 0 and rnd.random() < 0.28:
            ev_left = rnd.choice([8, 12, 16, 20, 26, 32])
        if ev_left > 0 and (h >= 23.5 or h < 5.5):
            chunk = min(3.55, ev_left)
            ev_left -= chunk
            load += chunk
        out.append([ms(t), round(load, 3)])
        t += timedelta(minutes=30)
    return {"meta": {"demo": True, "account": "DEMO", "ev": True, "tariffs": [], "warnings": [],
                     "fetchedAt": ms(datetime.now(timezone.utc))},
            "consumption": out, "rates": [], "day": [[out[0][0], None, 30.5]], "night": [[out[0][0], None, 7.0]],
            "standing": [[out[0][0], None, 46.0]], "history": []}


# ------------------------------------------------------------------ cache ----

def get_data(cfg, days, demo, refresh):
    if demo:
        return demo_data(days)
    cache_key = "v4:%s:%d" % (cfg["account"], days)
    with LOCK:
        if not refresh and CACHE_FILE.exists():
            try:
                c = json.loads(CACHE_FILE.read_text())
                if c.get("key") == cache_key and time.time() - c["at"] < CACHE_TTL:
                    return c["data"]
            except (ValueError, KeyError):
                pass
        data = fetch_octopus(cfg, days)
        CACHE_FILE.write_text(json.dumps({"key": cache_key, "at": time.time(), "data": data}))
        return data


# ------------------------------------------------------------------- http ----

class Handler(BaseHTTPRequestHandler):
    server_version = "OctopusDash/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        """Only talk to this computer, or (with --lan) to devices on the home network. The Host check also
        blocks DNS-rebinding attacks from web pages."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        ok = host in ("127.0.0.1", "localhost", "::1")
        if LAN and not ok:
            ok = is_private(host) or host.endswith(".local")
        if ok and LAN and not is_private(self.client_address[0]):
            ok = False
        if not ok:
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        url = urlparse(self.path)
        if url.path == "/api/status":
            cfg = load_config()
            ok = bool(cfg.get("apiKey") and cfg.get("account"))
            here = is_loopback(self.client_address[0])
            return self._send(200, {"configured": ok, "account": cfg.get("account") if ok else None,
                                    "keyHint": cfg["apiKey"][-4:] if ok and here else None})
        if url.path in ("/api/property", "/api/geocode", "/api/buildings"):
            return self._place(url)
        if url.path == "/api/data":
            q = parse_qs(url.query)
            try:
                days = max(30, min(1095, int(q.get("days", ["365"])[0])))
            except ValueError:
                days = 365
            demo = q.get("demo", ["0"])[0] == "1"
            cfg = load_config()
            if not demo and not (cfg.get("apiKey") and cfg.get("account")):
                return self._send(401, {"error": "not_configured"})
            try:
                return self._send(200, get_data(cfg, days, demo, q.get("refresh", ["0"])[0] == "1"))
            except ApiError as e:
                return self._send(e.status, {"error": e.message})
        return self._static(url.path)

    def _place(self, url):
        q = parse_qs(url.query)
        try:
            if url.path == "/api/geocode":
                return self._send(200, geocode(q.get("q", [""])[0]))
            if url.path == "/api/buildings":
                lat, lon = float(q["lat"][0]), float(q["lon"][0])
                if not (49 <= lat <= 61 and -9 <= lon <= 2.5):
                    raise ApiError(400, "That is outside the UK.")
                if q.get("at", ["0"])[0] == "1":
                    return self._send(200, {"buildings": building_at(lat, lon)})
                radius = max(20, min(150, int(q.get("radius", ["70"])[0])))
                return self._send(200, {"buildings": buildings(lat, lon, radius)})
            if q.get("demo", ["0"])[0] == "1":
                return self._send(200, DEMO_PLACE)
            cfg = load_config()
            if not (cfg.get("apiKey") and cfg.get("account")):
                return self._send(401, {"error": "not_configured"})
            key = "prop:" + cfg["account"]
            if q.get("refresh", ["0"])[0] == "1":
                GEO_MEM.pop(key, None)
            return self._send(200, geo_cache(key, lambda: property_info(cfg)))
        except (KeyError, ValueError):
            return self._send(400, {"error": "Bad request"})
        except ApiError as e:
            return self._send(e.status, {"error": e.message})

    def do_POST(self):
        if not self._local_only():
            return
        path = urlparse(self.path).path
        if not is_loopback(self.client_address[0]):  # the key and account can only be changed from this computer
            return self._send(403, {"error": "Change the connection from the computer running the dashboard."})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "Invalid JSON"})
        if path == "/api/config":
            key = str(body.get("apiKey", "")).strip()
            account = str(body.get("account", "")).strip().upper()
            if not re.match(r"^sk_live_\w+$", key):
                return self._send(400, {"error": "API key should look like sk_live_..."})
            if not re.match(r"^A-[A-Z0-9]+$", account):
                return self._send(400, {"error": "Account number should look like A-1234ABCD"})
            try:
                discover(account, key)
            except ApiError as e:
                return self._send(e.status, {"error": e.message})
            save_config({"apiKey": key, "account": account})
            if CACHE_FILE.exists():
                CACHE_FILE.unlink()
            return self._send(200, {"ok": True})
        if path == "/api/disconnect":
            for f in (CONFIG_FILE, CACHE_FILE, PROPERTY_FILE):
                if f.exists():
                    f.unlink()
            GEO_MEM.clear()
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        self._send(200, f.read_bytes(), ctype)


def main():
    global LAN
    args = sys.argv[1:]
    LAN = "--lan" in args or os.environ.get("LAN") == "1"
    port = next((int(a) for a in args if a.isdigit()), 8765)
    httpd = ThreadingHTTPServer(("0.0.0.0" if LAN else "127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d" % port
    print("Octopus dashboard running at %s  (Ctrl+C to stop)" % url)
    if LAN:
        for ip in lan_addresses():
            print("On your network:  http://%s:%d   (viewing only; connect or disconnect from this computer)" % (ip, port))
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
