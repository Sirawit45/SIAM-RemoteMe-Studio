import platform
import socket
import time
from typing import Dict, List, Any

import psutil
import pyperclip

from backend.config import config
from backend.screen_engine import screen_engine


def get_network_addresses(port: int = 8765) -> List[Dict[str, str]]:
    """Discover all accessible LAN / Wi-Fi / Tailscale / VPN IPv4 addresses."""
    addresses = []
    seen_ips = set()

    try:
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
        for iface_name, addr_list in addrs.items():
            if iface_name in stats and not stats[iface_name].isup:
                continue
            for addr in addr_list:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip.startswith("127.") or ip.startswith("169.254.") or ip in seen_ips:
                        continue
                    seen_ips.add(ip)
                    net_type = "LAN / Wi-Fi"
                    lower_name = iface_name.lower()
                    if "tailscale" in lower_name or ip.startswith("100."):
                        net_type = "Tailscale / Mesh VPN"
                    elif "zerotier" in lower_name or "wireguard" in lower_name or "tun" in lower_name:
                        net_type = "VPN Network"
                    addresses.append({
                        "interface": iface_name,
                        "ip": ip,
                        "type": net_type,
                        "url": f"http://{ip}:{port}",
                    })
    except Exception:
        pass

    # Fallback socket probe if empty
    if not addresses:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127."):
                addresses.append({
                    "interface": "Primary Network",
                    "ip": ip,
                    "type": "LAN / Wi-Fi",
                    "url": f"http://{ip}:{port}",
                })
        except Exception:
            pass

    addresses.append({
        "interface": "Localhost (เครื่องนี้)",
        "ip": "127.0.0.1",
        "type": "Local",
        "url": f"http://localhost:{port}",
    })
    return addresses


def get_system_telemetry(active_clients_count: int = 0) -> Dict[str, Any]:
    cpu_pct = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    net_io = psutil.net_io_counters()
    boot_time = psutil.boot_time()
    uptime_sec = int(time.time() - boot_time)

    battery_info = None
    try:
        bat = psutil.sensors_battery()
        if bat:
            battery_info = {
                "percent": round(bat.percent, 1),
                "plugged": bat.power_plugged,
            }
    except Exception:
        pass

    return {
        "device_id": config.device_id,
        "device_name": config.device_name,
        "os_name": f"{platform.system()} {platform.release()}",
        "os_arch": platform.machine(),
        "python_version": platform.python_version(),
        "cpu_percent": round(cpu_pct, 1),
        "cpu_cores": psutil.cpu_count(logical=True),
        "ram_percent": round(mem.percent, 1),
        "ram_used_gb": round(mem.used / (1024 ** 3), 2),
        "ram_total_gb": round(mem.total / (1024 ** 3), 2),
        "net_sent_mb": round(net_io.bytes_sent / (1024 ** 2), 2),
        "net_recv_mb": round(net_io.bytes_recv / (1024 ** 2), 2),
        "uptime_seconds": uptime_sec,
        "battery": battery_info,
        "monitors": screen_engine.get_monitors(),
        "addresses": get_network_addresses(config.port),
        "active_clients": active_clients_count,
        "capture_stats": screen_engine.stats,
        "config": {
            "require_pin": config.require_pin,
            "allow_input_control": config.allow_input_control,
            "allow_file_delete": config.allow_file_delete,
            "default_fps": config.default_fps,
            "default_quality": config.default_quality,
            "default_scale": config.default_scale,
            "default_upload_dir": config.default_upload_dir,
        },
    }


def get_clipboard_text() -> str:
    try:
        return pyperclip.paste() or ""
    except Exception:
        return ""


def set_clipboard_text(text: str) -> bool:
    try:
        pyperclip.copy(text)
        return True
    except Exception:
        return False
