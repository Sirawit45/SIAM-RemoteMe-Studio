import asyncio
import json
import mimetypes
import os
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Dict, Any, List, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.config import BASE_DIR, BUNDLE_DIR, config
from backend.screen_engine import screen_engine
from backend.input_controller import input_controller
from backend.file_manager import file_manager
from backend.system_info import get_system_telemetry, get_clipboard_text, set_clipboard_text
from backend.webrtc_signaling import session_manager
from backend.wan_manager import wan_manager

app = FastAPI(
    title="RemoteMe - Ultra Smooth Cross-Platform Remote Desktop & File Transfer",
    version="2.0.0",
)

# Enable CORS so a client on Machine A can connect directly to Host Machine B over LAN/VPN
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "Content-Disposition"],
)


# --- Pydantic Models ---
class PinVerifyRequest(BaseModel):
    pin: str


class ConfigUpdateRequest(BaseModel):
    device_name: Optional[str] = None
    require_pin: Optional[bool] = None
    pin_code: Optional[str] = None
    allow_input_control: Optional[bool] = None
    allow_file_delete: Optional[bool] = None
    default_fps: Optional[int] = None
    default_quality: Optional[int] = None
    default_scale: Optional[float] = None
    default_upload_dir: Optional[str] = None


class ClipboardRequest(BaseModel):
    text: str


class MkdirRequest(BaseModel):
    parent_path: str
    folder_name: str


class RenameRequest(BaseModel):
    old_path: str
    new_name: str


class DeleteRequest(BaseModel):
    paths: List[str]


class CopyMoveRequest(BaseModel):
    action: str  # "copy" or "move"
    sources: List[str]
    destination_dir: str


class UploadInitRequest(BaseModel):
    filename: str
    total_size: int
    target_dir: Optional[str] = None
    transfer_id: Optional[str] = None


class UploadCancelRequest(BaseModel):
    transfer_id: str


# --- System & Auth Endpoints ---
@app.middleware("http")
async def disable_browser_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


@app.on_event("startup")
async def on_startup():
    # Automatically launch Global Internet Tunnel (Cloudflare Edge HTTPS/WSS) on startup
    wan_manager.start_tunnel(port=config.port, provider="cloudflare")


def _is_local_host_request(request: Request) -> bool:
    """Return True ONLY if the request originates directly from this local machine (not via Cloud Tunnel or LAN)."""
    if request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for"):
        return False
    client_ip = request.client.host if request.client else ""
    return client_ip in ("127.0.0.1", "::1", "localhost")


def _is_authorized_request(request: Request) -> bool:
    """Return True if local host console, or if PIN lock is disabled, or if a valid session token is provided."""
    if _is_local_host_request(request) or not config.require_pin:
        return True
    token = request.headers.get("X-RemoteMe-Token") or request.query_params.get("token")
    return session_manager.is_token_valid(token)


@app.get("/api/system/info")
async def api_system_info(request: Request):
    is_local = _is_local_host_request(request)
    if not _is_authorized_request(request):
        raise HTTPException(
            status_code=401,
            detail="กรุณายืนยันรหัส PIN หรือรอเครื่องปลายทางกดยอมรับการเชื่อมต่อก่อน",
        )
    sessions = session_manager.get_active_sessions()
    telemetry = get_system_telemetry(active_clients_count=len(sessions))
    wan_state = wan_manager.get_state()
    telemetry["wan"] = wan_state
    if wan_state.get("public_url"):
        telemetry["addresses"].insert(0, {
            "interface": "Global Cloud Edge",
            "ip": "Internet WAN",
            "type": "ออนไลน์ทั่วโลก (Global Internet)",
            "url": wan_state["public_url"],
        })
    telemetry["sessions"] = sessions
    telemetry["pending_requests"] = session_manager.get_pending_requests() if is_local else []
    # Only show the secret PIN on the host PC's own local screen; mask it for external viewers!
    telemetry["pin_code"] = config.pin_code if is_local else "******"
    return telemetry


class WanStartRequest(BaseModel):
    provider: Optional[str] = "cloudflare"


@app.post("/api/wan/start")
async def api_wan_start(req: WanStartRequest):
    wan_manager.start_tunnel(port=config.port, provider=req.provider or "cloudflare")
    return {"status": "starting", "wan": wan_manager.get_state()}


@app.post("/api/wan/stop")
async def api_wan_stop():
    wan_manager.stop_tunnel()
    return {"status": "stopped", "wan": wan_manager.get_state()}


@app.get("/api/wan/resolve")
async def api_wan_resolve(device_id: str = Query(...)):
    record = await asyncio.to_thread(wan_manager.resolve_remote_device_id, device_id)
    if not record or not record.get("public_url"):
        raise HTTPException(
            status_code=404,
            detail="ไม่พบเครื่องปลายทางออนไลน์ด้วยรหัส ID นี้ (กรุณาตรวจสอบว่าเครื่องปลายทางเปิด Global Internet แล้ว)",
        )
    return record


class ApprovalRespondRequest(BaseModel):
    request_id: str
    approved: bool


@app.post("/api/auth/request")
async def api_request_access(request: Request):
    client_ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for")
        or (request.client.host if request.client else "unknown")
    )
    user_agent = request.headers.get("user-agent", "Remote Device")
    req_data = session_manager.create_connection_request(client_ip, user_agent)
    return {
        "request_id": req_data["request_id"],
        "status": req_data["status"],
        "device_name": config.device_name,
        "device_id": config.device_id,
    }


@app.get("/api/auth/request-status")
async def api_request_status(request_id: str = Query(...)):
    req = session_manager.get_request_status(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="ไม่พบคำขอเชื่อมต่อนี้ หรือหมดเวลาแล้ว")
    return {
        "request_id": req["request_id"],
        "status": req["status"],
        "token": req.get("token"),
        "device_name": config.device_name,
        "device_id": config.device_id,
    }


@app.post("/api/auth/respond")
async def api_respond_access(req: ApprovalRespondRequest):
    resolved = session_manager.resolve_connection_request(req.request_id, req.approved)
    if not resolved:
        raise HTTPException(status_code=404, detail="ไม่พบคำขอเชื่อมต่อนี้")
    return {"status": "ok", "request": resolved}


@app.post("/api/auth/verify")
async def api_verify_pin(req: PinVerifyRequest):
    if not config.require_pin or req.pin.strip() == config.pin_code:
        token = session_manager.approve_all_pending_by_pin()
        return {
            "authenticated": True,
            "token": token,
            "device_name": config.device_name,
            "device_id": config.device_id,
        }
    raise HTTPException(status_code=401, detail="รหัส PIN ไม่ถูกต้อง")


@app.post("/api/auth/logout")
async def api_logout(request: Request):
    token = request.headers.get("X-RemoteMe-Token")
    session_manager.revoke_token(token)
    return {"status": "ok"}


@app.post("/api/config/update")
async def api_update_config(req: ConfigUpdateRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    config.update(updates)
    return {"status": "ok", "config": config.to_dict()}


@app.post("/api/config/regenerate-pin")
async def api_regenerate_pin():
    new_pin = config.regenerate_pin()
    await session_manager.disconnect_all_sessions()
    return {"status": "ok", "pin_code": new_pin}


@app.post("/api/sessions/disconnect-all")
async def api_disconnect_all_sessions():
    disconnected = await session_manager.disconnect_all_sessions()
    return {"status": "ok", "disconnected": disconnected}


@app.get("/api/clipboard")
async def api_get_clipboard():
    return {"text": get_clipboard_text()}


@app.post("/api/clipboard")
async def api_set_clipboard(req: ClipboardRequest):
    ok = set_clipboard_text(req.text)
    return {"status": "ok" if ok else "error"}


@app.get("/api/screenshot")
async def api_screenshot(monitor: int = 1):
    png_bytes = await asyncio.to_thread(screen_engine.capture_png_screenshot, monitor)
    filename = f"RemoteMe_Screen_{int(time.time())}.png"
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- File Explorer & High-Speed Resumable Transfer Endpoints ---
@app.get("/api/files/locations")
async def api_file_locations(request: Request):
    if not _is_authorized_request(request):
        raise HTTPException(status_code=401, detail="กรุณาเชื่อมต่อและยืนยันตัวตนก่อนดูไฟล์")
    return {"locations": file_manager.get_quick_locations()}


@app.get("/api/files/list")
async def api_file_list(request: Request, path: Optional[str] = Query(default=None)):
    if not _is_authorized_request(request):
        raise HTTPException(status_code=401, detail="กรุณาเชื่อมต่อและยืนยันตัวตนก่อนดูไฟล์")
    try:
        return file_manager.list_directory(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/mkdir")
async def api_file_mkdir(req: MkdirRequest):
    try:
        return file_manager.create_folder(req.parent_path, req.folder_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/rename")
async def api_file_rename(req: RenameRequest):
    try:
        return file_manager.rename_item(req.old_path, req.new_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/delete")
async def api_file_delete(req: DeleteRequest):
    try:
        return file_manager.delete_items(req.paths)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/copy-move")
async def api_file_copy_move(req: CopyMoveRequest):
    try:
        return await asyncio.to_thread(file_manager.copy_or_move, req.action, req.sources, req.destination_dir)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/upload/init")
async def api_upload_init(req: UploadInitRequest):
    try:
        return file_manager.init_upload(req.filename, req.total_size, req.target_dir, req.transfer_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/upload/chunk")
async def api_upload_chunk(request: Request):
    transfer_id = request.headers.get("X-Transfer-Id")
    offset_str = request.headers.get("X-Chunk-Offset", "0")
    if not transfer_id:
        raise HTTPException(status_code=400, detail="Missing X-Transfer-Id header")
    try:
        offset = int(offset_str)
        body = await request.body()
        res = await asyncio.to_thread(file_manager.write_upload_chunk, transfer_id, offset, body)
        return res
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/files/upload/cancel")
async def api_upload_cancel(req: UploadCancelRequest):
    return file_manager.cancel_upload(req.transfer_id)


@app.get("/api/files/download")
async def api_file_download(request: Request, path: str = Query(...)):
    """
    Supports full HTTP Range requests (206 Partial Content) for Pause/Resume & High-Speed Chunked Downloads.
    If path is a directory, automatically zips and streams it.
    """
    target = Path(path).resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail="ไม่พบไฟล์ที่ต้องการดาวน์โหลด")

    if target.is_dir():
        zip_buf = await asyncio.to_thread(file_manager.create_zip_from_paths, [str(target)])
        zip_bytes = zip_buf.getvalue()
        encoded_name = urllib.parse.quote(f"{target.name}.zip")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
                "Content-Length": str(len(zip_bytes)),
            },
        )

    file_size = target.stat().st_size
    encoded_name = urllib.parse.quote(target.name)
    mime_type, _ = mimetypes.guess_type(str(target))
    mime_type = mime_type or "application/octet-stream"

    range_header = request.headers.get("Range")
    if range_header and range_header.startswith("bytes="):
        try:
            range_val = range_header.replace("bytes=", "").split(",")[0].strip()
            start_str, end_str = range_val.split("-")
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))
            chunk_len = (end - start) + 1

            def iter_range():
                with open(target, "rb") as f:
                    f.seek(start)
                    remaining = chunk_len
                    while remaining > 0:
                        data = f.read(min(256 * 1024, remaining))
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            return StreamingResponse(
                iter_range(),
                status_code=206,
                media_type=mime_type,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(chunk_len),
                    "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
                },
            )
        except Exception:
            pass

    return FileResponse(
        path=str(target),
        media_type=mime_type,
        filename=target.name,
        headers={"Accept-Ranges": "bytes"},
    )


@app.get("/api/files/preview")
async def api_file_preview(path: str = Query(...)):
    target = Path(path).resolve()
    if not target.exists() or target.is_dir():
        raise HTTPException(status_code=404, detail="ไม่พบไฟล์")

    ext = target.suffix.lower()
    if ext in {".txt", ".md", ".py", ".js", ".ts", ".json", ".html", ".css", ".csv", ".log", ".bat", ".sh", ".ps1", ".yaml", ".yml", ".ini", ".xml"}:
        try:
            content = target.read_text(encoding="utf-8", errors="replace")[:100_000]
            return {"type": "text", "name": target.name, "content": content}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    mime_type, _ = mimetypes.guess_type(str(target))
    return FileResponse(path=str(target), media_type=mime_type or "application/octet-stream")


# --- Real-Time Ultra-Smooth Remote Desktop WebSocket ---
@app.websocket("/ws/remote")
async def ws_remote_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = f"sess_{int(time.time() * 1000)}_{os.urandom(2).hex()}"
    client_ip = websocket.client.host if websocket.client else "unknown"
    user_agent = websocket.headers.get("user-agent", "RemoteMe Viewer")

    is_mobile = any(k in user_agent for k in ("Mobile", "iPhone", "Android", "iPad"))
    is_local_host = (
        not websocket.headers.get("cf-connecting-ip")
        and not websocket.headers.get("x-forwarded-for")
        and client_ip in ("127.0.0.1", "::1", "localhost")
    )

    # Stream state per viewer connection (local host console is pre-authenticated so it doesn't block reading the PIN)
    state = {
        "authenticated": True if is_local_host else (not config.require_pin),
        "streaming": True,
        "monitor_id": 1,
        "fps": 60,
        "quality": 60 if is_mobile else config.default_quality,
        "scale": 0.65 if is_mobile else config.default_scale,
        "format": "jpeg",
        "in_flight": 0,
        "last_ack_time": time.perf_counter(),
        "client_fps": 0.0,
        "client_rtt": 0.0,
    }
    ack_event = asyncio.Event()
    ack_event.set()

    session_manager.register_session(session_id, client_ip, user_agent)
    await session_manager.register_webrtc_peer(session_id, websocket)

    # Send initial handshake with monitors and host info
    await websocket.send_json({
        "type": "hello",
        "session_id": session_id,
        "device_id": config.device_id,
        "device_name": config.device_name,
        "require_pin": config.require_pin,
        "authenticated": state["authenticated"],
        "monitors": screen_engine.get_monitors(),
        "stream_config": {
            "monitor_id": state["monitor_id"],
            "fps": state["fps"],
            "quality": state["quality"],
            "scale": state["scale"],
            "format": state["format"],
        },
    })

    stop_event = asyncio.Event()

    async def receive_loop():
        try:
            while not stop_event.is_set():
                ws_msg = await websocket.receive()
                if ws_msg.get("type") == "websocket.disconnect":
                    stop_event.set()
                    break

                # If client pushes binary GPU-captured frame [4B width/height header + JPEG bytes]
                if "bytes" in ws_msg and ws_msg["bytes"]:
                    bdata = ws_msg["bytes"]
                    if len(bdata) > 4:
                        w = (bdata[0] << 8) | bdata[1]
                        h = (bdata[2] << 8) | bdata[3]
                        screen_engine.push_gpu_frame(bdata[4:], w, h)
                    continue

                raw = ws_msg.get("text")
                if not raw:
                    continue
                msg = json.loads(raw)
                mtype = msg.get("type")

                if mtype == "auth":
                    provided_token = msg.get("token")
                    provided_pin = (msg.get("pin") or "").strip()
                    if (
                        not config.require_pin
                        or session_manager.is_token_valid(provided_token)
                        or (provided_pin and provided_pin == config.pin_code)
                    ):
                        state["authenticated"] = True
                        token = provided_token if session_manager.is_token_valid(provided_token) else session_manager.approve_all_pending_by_pin()
                        await websocket.send_json({"type": "auth_result", "authenticated": True, "token": token})
                    else:
                        await websocket.send_json({"type": "auth_result", "authenticated": False, "error": "รหัส PIN ไม่ถูกต้อง"})
                    continue

                if not state["authenticated"]:
                    continue

                if mtype == "ack":
                    state["in_flight"] = 0
                    state["last_ack_time"] = time.perf_counter()
                    ack_event.set()
                    if "fps" in msg or "rtt" in msg:
                        session_manager.update_session_metrics(
                            session_id,
                            fps=msg.get("fps"),
                            latency_ms=msg.get("rtt"),
                        )

                elif mtype == "ping":
                    await websocket.send_json({
                        "type": "pong",
                        "client_ts": msg.get("ts"),
                        "server_ts": int(time.time() * 1000),
                    })

                elif mtype == "config":
                    if "monitor_id" in msg:
                        state["monitor_id"] = int(msg["monitor_id"])
                        session_manager.update_session_metrics(session_id, monitor_id=state["monitor_id"])
                    if "fps" in msg:
                        state["fps"] = max(5, min(60, int(msg["fps"])))
                    if "quality" in msg:
                        state["quality"] = max(20, min(95, int(msg["quality"])))
                    if "scale" in msg:
                        state["scale"] = max(0.25, min(1.0, float(msg["scale"])))
                    if "format" in msg:
                        state["format"] = msg["format"]
                    if "streaming" in msg:
                        state["streaming"] = bool(msg["streaming"])
                    ack_event.set()

                elif mtype == "mousemove":
                    msg["monitor"] = state["monitor_id"]
                    input_controller.handle_packet(msg)
                    ack_event.set()

                elif mtype in ("mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup", "keypress", "text", "hotkey"):
                    msg["monitor"] = state["monitor_id"]
                    await asyncio.to_thread(input_controller.handle_packet, msg)
                    ack_event.set()

                elif mtype in ("webrtc_offer", "webrtc_answer", "webrtc_ice", "webrtc_ready"):
                    await session_manager.relay_webrtc_signal(session_id, msg)

        except WebSocketDisconnect:
            stop_event.set()
        except Exception:
            stop_event.set()

    async def stream_loop():
        prev_sig = None
        last_sent_time = 0.0
        try:
            while not stop_event.is_set():
                if not state["authenticated"] or not state["streaming"]:
                    await asyncio.sleep(0.04)
                    continue

                # Strict Zero-Queue Lockstep: wait until the previous frame is acknowledged (or 90ms max recovery)
                if state["in_flight"] >= 1:
                    try:
                        await asyncio.wait_for(ack_event.wait(), timeout=0.09)
                    except asyncio.TimeoutError:
                        state["in_flight"] = 0

                ack_event.clear()
                t_start = time.perf_counter()

                # Force full keyframe at least every 0.8s even if static
                check_sig = prev_sig if (t_start - last_sent_time) < 0.8 else None

                frame_bytes, meta, new_sig = await asyncio.to_thread(
                    screen_engine.capture_binary_frame,
                    state["monitor_id"],
                    state["quality"],
                    state["scale"],
                    state["format"],
                    check_sig,
                )

                if frame_bytes is None and meta.get("unchanged"):
                    # Screen pixels haven't changed -> don't clog the network pipe!
                    await asyncio.sleep(0.008)
                    continue

                prev_sig = new_sig
                last_sent_time = time.perf_counter()
                state["in_flight"] = 1
                await websocket.send_bytes(frame_bytes)

                target_interval = 1.0 / max(10, state["fps"])
                elapsed = time.perf_counter() - t_start
                if elapsed < target_interval:
                    await asyncio.sleep(target_interval - elapsed)

        except WebSocketDisconnect:
            stop_event.set()
        except Exception:
            stop_event.set()

    recv_task = asyncio.create_task(receive_loop())
    send_task = asyncio.create_task(stream_loop())

    await stop_event.wait()
    recv_task.cancel()
    send_task.cancel()
    session_manager.remove_session(session_id)


# Mount Static Frontend
STATIC_DIR = BUNDLE_DIR / "static"
if not STATIC_DIR.exists():
    STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


def _enable_prevent_sleep():
    """Prevent Windows from going to sleep and dropping internet connection while RemoteMe is running."""
    if sys.platform == "win32":
        try:
            import ctypes
            ES_CONTINUOUS = 0x80000000
            ES_SYSTEM_REQUIRED = 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        except Exception:
            pass


def _open_desktop_app_window(port: int):
    """Automatically launch Desktop App UI window when run as Portable .exe."""
    import shutil
    import subprocess
    import threading
    import webbrowser

    def _launch():
        time.sleep(1.5)
        url = f"http://localhost:{port}"
        for browser_cmd in ("msedge", "chrome"):
            exe = shutil.which(browser_cmd)
            if exe:
                try:
                    subprocess.Popen([exe, f"--app={url}", "--window-size=1360,840"])
                    return
                except Exception:
                    pass
        webbrowser.open(url)

    threading.Thread(target=_launch, daemon=True).start()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    _enable_prevent_sleep()
    port = int(os.environ.get("REMOTEME_PORT", config.port))
    print("=" * 68)
    print(f" [SIAM RemoteMe Studio v2.0 - Portable Edition]")
    print(f" Device Name : {config.device_name}")
    print(f" Device ID   : {config.device_id}  |  PIN: {config.pin_code}")
    print(f" Local URL   : http://localhost:{port}")
    print("=" * 68)

    if getattr(sys, "frozen", False) and "--headless" not in sys.argv:
        _open_desktop_app_window(port)

    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning", ws_max_size=16 * 1024 * 1024)
