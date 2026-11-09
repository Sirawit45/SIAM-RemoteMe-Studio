import os
import sys
import time
import secrets
import threading
from typing import Dict, Any, List, Set, Optional
from fastapi import WebSocket


class SessionManager:
    """
    Manages connected Remote Viewer sessions, Host Approval Popups, Session Auth Tokens, and WebRTC P2P signaling.
    """

    def __init__(self):
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.webrtc_peers: Dict[str, WebSocket] = {}
        self.authorized_tokens: Set[str] = set()
        self.pending_requests: Dict[str, Dict[str, Any]] = {}

    def issue_token(self) -> str:
        token = secrets.token_hex(16)
        self.authorized_tokens.add(token)
        return token

    def is_token_valid(self, token: Optional[str]) -> bool:
        if not token:
            return False
        return token in self.authorized_tokens

    def revoke_token(self, token: Optional[str]):
        if token:
            self.authorized_tokens.discard(token)

    def create_connection_request(self, client_ip: str, user_agent: str) -> Dict[str, Any]:
        # Parse friendly device name from User-Agent
        ua = user_agent or "Remote Device"
        if "iPhone" in ua:
            device_label = "iPhone (iOS)"
        elif "iPad" in ua:
            device_label = "iPad (iPadOS)"
        elif "Android" in ua:
            device_label = "โทรศัพท์ Android"
        elif "Macintosh" in ua:
            device_label = "คอมพิวเตอร์ Mac"
        elif "Windows" in ua:
            device_label = "คอมพิวเตอร์ Windows"
        else:
            device_label = "อุปกรณ์รีโมทภายนอก"

        req_id = f"req_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
        req_data = {
            "request_id": req_id,
            "device_label": device_label,
            "client_ip": client_ip,
            "created_at": int(time.time() * 1000),
            "status": "pending",  # "pending" | "approved" | "rejected"
            "token": None,
        }
        self.pending_requests[req_id] = req_data
        return req_data

    def resolve_connection_request(self, req_id: str, approved: bool) -> Optional[Dict[str, Any]]:
        req = self.pending_requests.get(req_id)
        if not req:
            return None
        if req["status"] != "pending":
            return req

        if approved:
            token = self.issue_token()
            req["status"] = "approved"
            req["token"] = token
        else:
            req["status"] = "rejected"
            req["token"] = None

        return req

    def approve_all_pending_by_pin(self) -> str:
        token = self.issue_token()
        for req_id, req in list(self.pending_requests.items()):
            if req["status"] == "pending":
                req["status"] = "approved"
                req["token"] = token
        return token

    def get_pending_requests(self) -> List[Dict[str, Any]]:
        now = int(time.time() * 1000)
        # Clean up requests older than 90 seconds
        for rid, r in list(self.pending_requests.items()):
            if now - r["created_at"] > 90_000:
                self.pending_requests.pop(rid, None)
        return [r for r in self.pending_requests.values() if r["status"] == "pending"]

    def get_request_status(self, req_id: str) -> Optional[Dict[str, Any]]:
        return self.pending_requests.get(req_id)

    def register_session(self, session_id: str, client_ip: str, user_agent: str, mode: str = "binary_stream"):
        self.sessions[session_id] = {
            "session_id": session_id,
            "client_ip": client_ip,
            "user_agent": user_agent,
            "mode": mode,
            "connected_at": int(time.time() * 1000),
            "fps": 0,
            "latency_ms": 0,
            "monitor_id": 1,
        }

    def update_session_metrics(self, session_id: str, fps: float = None, latency_ms: float = None, monitor_id: int = None):
        if session_id in self.sessions:
            if fps is not None:
                self.sessions[session_id]["fps"] = round(fps, 1)
            if latency_ms is not None:
                self.sessions[session_id]["latency_ms"] = round(latency_ms, 1)
            if monitor_id is not None:
                self.sessions[session_id]["monitor_id"] = monitor_id

    def remove_session(self, session_id: str):
        self.sessions.pop(session_id, None)
        self.webrtc_peers.pop(session_id, None)

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        return list(self.sessions.values())

    async def disconnect_all_sessions(self) -> int:
        count = 0
        for pid, ws in list(self.webrtc_peers.items()):
            try:
                await ws.send_json({"type": "force_disconnect", "reason": "ตัดการเชื่อมต่อแล้ว กรุณายืนยันตัวตนใหม่เมื่อต้องการเชื่อมต่ออีกครั้ง"})
                await ws.close(code=1000)
                count += 1
            except Exception:
                pass
        self.sessions.clear()
        self.webrtc_peers.clear()
        self.authorized_tokens.clear()
        self.pending_requests.clear()
        return count

    async def register_webrtc_peer(self, peer_id: str, ws: WebSocket):
        self.webrtc_peers[peer_id] = ws

    async def relay_webrtc_signal(self, sender_id: str, message: Dict[str, Any]):
        target_id = message.get("target")
        payload = {**message, "sender": sender_id}
        if target_id and target_id in self.webrtc_peers:
            try:
                await self.webrtc_peers[target_id].send_json(payload)
            except Exception:
                pass
        else:
            for pid, ws in list(self.webrtc_peers.items()):
                if pid != sender_id:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        self.webrtc_peers.pop(pid, None)


session_manager = SessionManager()
