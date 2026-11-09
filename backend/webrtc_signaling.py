import time
from typing import Dict, Any, List
from fastapi import WebSocket


class SessionManager:
    """
    Manages connected Remote Viewer sessions and WebRTC P2P signaling.
    """

    def __init__(self):
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.webrtc_peers: Dict[str, WebSocket] = {}

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
            # Broadcast to all other WebRTC peers (e.g. host <-> viewer)
            for pid, ws in list(self.webrtc_peers.items()):
                if pid != sender_id:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        self.webrtc_peers.pop(pid, None)


session_manager = SessionManager()
