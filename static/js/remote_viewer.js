/**
 * RemoteMe Studio - 60 FPS Low-Latency Binary Canvas & Input Engine
 */
const RemoteViewer = {
    ws: null,
    canvas: null,
    ctx: null,
    inputEnabled: true,
    currentMonitor: 1,
    currentPreset: 'smooth',
    isConnected: false,
    frameCounter: 0,
    bytesCounter: 0,
    currentFps: 0,
    currentRtt: 1,
    lastStatTime: performance.now(),
    lastMouseMoveTime: 0,
    knownMonitorsHash: '',
    pingInterval: null,
    touchMode: 'trackpad', // 'trackpad' (relative drag like laptop touchpad) or 'direct' (tap-to-point)
    virtualCursorX: 0.5,
    virtualCursorY: 0.5,
    touchStartX: 0,
    touchStartY: 0,
    touchStartTime: 0,
    touchMoved: false,
    zoomLevels: [1, 1.8, 2.8],
    zoomIdx: 0,
    isDecoding: false,
    pendingBuffer: null,
    lastFrameBitmap: null,
    lastLocalInputTime: 0,
    rafPending: false,

    init() {
        this.canvas = document.getElementById('remote-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
            this.bindInputEvents();
        }
        this.connect();

        // Update FPS & Bandwidth HUD every second
        setInterval(() => {
            const now = performance.now();
            const dt = (now - this.lastStatTime) / 1000;
            if (dt > 0) {
                this.currentFps = Math.round(this.frameCounter / dt);
                const kbps = Math.round((this.bytesCounter / 1024) / dt);
                this.frameCounter = 0;
                this.bytesCounter = 0;
                this.lastStatTime = now;

                App.setText('hud-fps', `${this.currentFps} FPS`);
                App.setText('nav-fps-badge', `${this.currentFps || 60} FPS`);
                App.setText('dash-stream-fps', `${this.currentFps || 60} FPS`);
                App.setText('hud-kbps', kbps > 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${kbps} KB/s`);
            }
        }, 1000);
    },

    ensureConnected() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connect();
        } else {
            this.sendJson({ type: 'config', streaming: true });
        }
    },

    reconnect() {
        this.manualDisconnect = false;
        document.getElementById('remote-disconnected-overlay')?.classList.add('hidden');
        document.getElementById('remote-disconnected-overlay')?.classList.remove('flex');
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        this.connect();
    },

    disconnectSession() {
        this.manualDisconnect = true;
        this.isConnected = false;
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.gpuActive) {
            this.stopGpuWebRtcCapture();
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        const overlay = document.getElementById('remote-disconnected-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.classList.add('flex');
        }
        App.enterDisconnectedState();
        App.toast('หยุดการเชื่อมต่อและล้างข้อมูลเครื่องปลายทางแล้ว', 'info');
    },

    resumeSession() {
        App.enterDisconnectedState(true);
        App.requestHostApproval();
    },

    connect() {
        if (this.manualDisconnect || App.isDisconnected) return;
        if (!App.isLocalHostConsole() && !App.authToken) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        const wsUrl = App.getWsUrl('/ws/remote');
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        ws.onopen = () => {
            this.isConnected = true;
            const overlay = document.getElementById('remote-disconnected-overlay');
            if (overlay) {
                overlay.classList.add('hidden');
                overlay.classList.remove('flex');
            }
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.sendJson({ type: 'ping', ts: Date.now() });
                }
            }, 2000);
        };

        ws.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                this.handleJsonMessage(JSON.parse(event.data));
            } else if (event.data instanceof ArrayBuffer) {
                await this.handleBinaryFrame(event.data);
            }
        };

        ws.onclose = () => {
            this.isConnected = false;
            if (!this.manualDisconnect && !App.isDisconnected) {
                setTimeout(() => {
                    if (!this.isConnected && !this.manualDisconnect && !App.isDisconnected) this.connect();
                }, 2500);
            }
        };
    },

    handleJsonMessage(msg) {
        if (msg.type === 'hello') {
            this.currentDeviceId = msg.device_id || 'default';
            if (Array.isArray(msg.monitors)) {
                this.updateMonitorList(msg.monitors);
            }
            if (msg.require_pin && !msg.authenticated) {
                if (App.authToken) {
                    this.sendJson({ type: 'auth', token: App.authToken });
                    return;
                }
                const localPin = (App.systemInfo?.pin_code && App.systemInfo.pin_code !== '******') ? App.systemInfo.pin_code : null;
                if (localPin) {
                    this.sendJson({ type: 'auth', pin: localPin });
                    return;
                }
                // Require authorization on the Lock Screen (Host Popup Approval OR 6-Digit PIN)
                this.disconnectSession();
            }
        } else if (msg.type === 'auth_result') {
            if (msg.authenticated) {
                if (msg.token) {
                    App.authToken = msg.token;
                    sessionStorage.setItem('remoteme_auth_token', msg.token);
                }
            } else {
                App.toast(msg.error || 'กรุณายืนยันตัวตนใหม่', 'error');
                this.disconnectSession();
            }
        } else if (msg.type === 'force_disconnect') {
            this.disconnectSession();
            App.toast(msg.reason || 'การเชื่อมต่อถูกตัดโดยเจ้าของเครื่อง', 'warning');
        } else if (msg.type === 'pong') {
            const rtt = Math.max(1, Date.now() - (msg.client_ts || Date.now()));
            this.currentRtt = rtt;
            App.setText('hud-rtt', `Ping: ${rtt} ms`);
            App.setText('sidebar-ping', `~${rtt} ms`);
            App.setText('dash-stream-ping', `~${rtt} ms`);
        }
    },

    async handleBinaryFrame(buffer) {
        if (buffer.byteLength <= 20) return;

        // If GPU is currently decoding a frame, keep only the newest buffer (drop intermediate stale frame!)
        if (this.isDecoding) {
            this.pendingBuffer = buffer;
            return;
        }

        this.isDecoding = true;
        try {
            let currentBuf = buffer;
            while (currentBuf) {
                await this._decodeAndRenderBuffer(currentBuf);
                currentBuf = this.pendingBuffer;
                this.pendingBuffer = null;
            }
        } finally {
            this.isDecoding = false;
        }
    },

    async _decodeAndRenderBuffer(buffer) {
        const view = new DataView(buffer, 0, 20);
        const m0 = view.getUint8(0);
        const m1 = view.getUint8(1);
        if (m0 !== 82 || m1 !== 77) return; // 'RM'

        const fmtId = view.getUint8(3);
        const width = view.getUint16(4, false);
        const height = view.getUint16(6, false);
        const normCx = view.getUint16(8, false);
        const normCy = view.getUint16(10, false);

        this.bytesCounter += buffer.byteLength;
        this.frameCounter++;

        // Send ACK immediately before GPU decode so next network frame starts traveling in parallel!
        this.sendJson({
            type: 'ack',
            fps: this.currentFps,
            rtt: this.currentRtt,
        });

        const imgBytes = new Uint8Array(buffer, 20);
        const mime = fmtId === 2 ? 'image/webp' : 'image/jpeg';
        const blob = new Blob([imgBytes], { type: mime });

        try {
            const bitmap = await createImageBitmap(blob);
            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.canvas.width = width;
                this.canvas.height = height;
                App.setText('hud-res', `${width}x${height}`);
            }

            if (this.lastFrameBitmap) {
                try { this.lastFrameBitmap.close(); } catch (e) {}
            }
            this.lastFrameBitmap = bitmap;

            this.ctx.drawImage(bitmap, 0, 0);

            // Use 0ms local predicted cursor while user is actively moving finger/mouse (<450ms)
            const isLocalActive = (performance.now() - this.lastLocalInputTime) < 450;
            const cx = (isLocalActive ? this.virtualCursorX : (normCx / 10000)) * width;
            const cy = (isLocalActive ? this.virtualCursorY : (normCy / 10000)) * height;
            if (!isLocalActive) {
                this.virtualCursorX = normCx / 10000;
                this.virtualCursorY = normCy / 10000;
            }
            this.drawRemoteCursor(cx, cy);
        } catch (e) {
            // Ignore dropped decode frame
        }
    },

    renderLocalCursorInstant() {
        if (this.rafPending || !this.lastFrameBitmap || !this.ctx) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
            this.rafPending = false;
            if (!this.lastFrameBitmap) return;
            const w = this.canvas.width;
            const h = this.canvas.height;
            this.ctx.drawImage(this.lastFrameBitmap, 0, 0);
            this.drawRemoteCursor(this.virtualCursorX * w, this.virtualCursorY * h);
        });
    },

    drawRemoteCursor(x, y) {
        const ctx = this.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 12, y + 12);
        ctx.lineTo(x + 5, y + 13);
        ctx.lineTo(x, y + 18);
        ctx.closePath();
        ctx.fillStyle = '#e11d48';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
        ctx.restore();
    },

    sendJson(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    },

    updateMonitorList(monitors) {
        const hash = JSON.stringify(monitors);
        if (hash === this.knownMonitorsHash) return;
        this.knownMonitorsHash = hash;

        const sel = document.getElementById('remote-monitor-select');
        if (!sel) return;
        sel.innerHTML = monitors.map(m =>
            `<option value="${m.id}" ${m.id === this.currentMonitor ? 'selected' : ''}>${m.label}</option>`
        ).join('');
    },

    changeMonitor(monId) {
        this.currentMonitor = parseInt(monId, 10);
        this.sendJson({ type: 'config', monitor_id: this.currentMonitor });
        App.toast(`สลับไปแสดงผลหน้าจอที่ ${this.currentMonitor}`, 'info');
    },

    applyPreset(preset) {
        this.currentPreset = preset;
        ['smooth', 'uhd', 'eco'].forEach(p => {
            const btn = document.getElementById(`preset-${p}`);
            if (btn) {
                btn.className = p === preset
                    ? 'px-2.5 py-1 rounded-md bg-rose-600 text-white font-medium transition'
                    : 'px-2.5 py-1 rounded-md text-slate-300 hover:text-white transition';
            }
        });

        if (preset === 'smooth') {
            this.sendJson({ type: 'config', fps: 60, quality: 72, scale: 1.0, format: 'jpeg' });
            App.toast('โหมดลื่นไหลพิเศษ (60 FPS Low-Latency)', 'success');
        } else if (preset === 'uhd') {
            this.sendJson({ type: 'config', fps: 45, quality: 92, scale: 1.0, format: 'jpeg' });
            App.toast('โหมดคมชัดสูงสุด (Ultra HD 4:4:4 ตัวอักษรคมกริบ)', 'success');
        } else if (preset === 'eco') {
            this.sendJson({ type: 'config', fps: 30, quality: 55, scale: 0.75, format: 'jpeg' });
            App.toast('โหมดประหยัดอินเทอร์เน็ต (เหมาะสำหรับมือถือ/เน็ตช้า)', 'info');
        }
    },

    toggleInputControl() {
        this.inputEnabled = !this.inputEnabled;
        const btn = document.getElementById('btn-toggle-control');
        if (btn) {
            if (this.inputEnabled) {
                btn.className = 'px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-xs font-medium flex items-center gap-1.5 transition';
                btn.innerHTML = `<i data-lucide="mouse-pointer-click" class="w-3.5 h-3.5"></i><span>ควบคุมเมาส์/คีย์บอร์ด: เปิด</span>`;
            } else {
                btn.className = 'px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition';
                btn.innerHTML = `<i data-lucide="eye" class="w-3.5 h-3.5"></i><span>ดูอย่างเดียว (View-Only)</span>`;
            }
            lucide.createIcons();
        }
    },

    async toggleGpuScreenShare() {
        if (this.gpuStream) {
            this.gpuStream.getTracks().forEach(t => t.stop());
            this.gpuStream = null;
            if (this.gpuTimer) clearInterval(this.gpuTimer);
            const btn = document.getElementById('btn-gpu-capture');
            if (btn) {
                btn.innerHTML = `<i data-lucide="zap" class="w-3.5 h-3.5 text-amber-400"></i><span>เปิดโหมด GPU 60FPS</span>`;
                lucide.createIcons();
            }
            App.toast('ปิดโหมด GPU Screen Share แล้ว', 'info');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
                audio: false,
            });
            this.gpuStream = stream;
            const video = document.createElement('video');
            video.srcObject = stream;
            video.muted = true;
            await video.play();

            const offCanvas = document.createElement('canvas');
            const offCtx = offCanvas.getContext('2d', { alpha: false });

            const btn = document.getElementById('btn-gpu-capture');
            if (btn) {
                btn.innerHTML = `<i data-lucide="zap" class="w-3.5 h-3.5 text-emerald-400"></i><span>GPU 60FPS: กำลังทำงาน</span>`;
                lucide.createIcons();
            }
            App.toast('เริ่มสตรีมหน้าจอด้วยชิปการ์ดจอ (GPU 60FPS) สำเร็จ!', 'success');

            stream.getVideoTracks()[0].addEventListener('ended', () => {
                if (this.gpuStream) this.toggleGpuScreenShare();
            });

            this.gpuTimer = setInterval(() => {
                if (!this.gpuStream || !video.videoWidth) return;
                const w = video.videoWidth;
                const h = video.videoHeight;
                if (offCanvas.width !== w || offCanvas.height !== h) {
                    offCanvas.width = w;
                    offCanvas.height = h;
                }
                offCtx.drawImage(video, 0, 0, w, h);
                offCanvas.toBlob(async (blob) => {
                    if (!blob || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                    const arr = new Uint8Array(await blob.arrayBuffer());
                    const packet = new Uint8Array(4 + arr.length);
                    packet[0] = (w >> 8) & 0xFF;
                    packet[1] = w & 0xFF;
                    packet[2] = (h >> 8) & 0xFF;
                    packet[3] = h & 0xFF;
                    packet.set(arr, 4);
                    this.ws.send(packet.buffer);
                }, 'image/jpeg', 0.8);
            }, 25);
        } catch (err) {
            App.toast('ยกเลิกการเลือกหน้าจอ GPU', 'info');
        }
    },

    getNormalizedCoords(evt) {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
        const x = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (evt.clientY - rect.top) / rect.height));
        return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
    },

    bindInputEvents() {
        const c = this.canvas;

        c.addEventListener('mousemove', (e) => {
            if (!this.inputEnabled) return;
            const { x, y } = this.getNormalizedCoords(e);
            this.virtualCursorX = x;
            this.virtualCursorY = y;
            this.lastLocalInputTime = performance.now();
            this.renderLocalCursorInstant();

            const now = performance.now();
            if (now - this.lastMouseMoveTime < 12) return;
            this.lastMouseMoveTime = now;
            this.sendJson({ type: 'mousemove', x, y });
        });

        c.addEventListener('mousedown', (e) => {
            c.focus();
            if (!this.inputEnabled) return;
            e.preventDefault();
            const btnMap = { 0: 'left', 1: 'middle', 2: 'right' };
            const { x, y } = this.getNormalizedCoords(e);
            this.sendJson({ type: 'mousedown', button: btnMap[e.button] || 'left', x, y });
        });

        c.addEventListener('mouseup', (e) => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            const btnMap = { 0: 'left', 1: 'middle', 2: 'right' };
            const { x, y } = this.getNormalizedCoords(e);
            this.sendJson({ type: 'mouseup', button: btnMap[e.button] || 'left', x, y });
        });

        c.addEventListener('dblclick', (e) => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            const { x, y } = this.getNormalizedCoords(e);
            this.sendJson({ type: 'dblclick', button: 'left', x, y });
        });

        c.addEventListener('contextmenu', (e) => e.preventDefault());

        c.addEventListener('wheel', (e) => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            this.sendJson({ type: 'wheel', dx: e.deltaX, dy: e.deltaY });
        }, { passive: false });

        c.addEventListener('keydown', (e) => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            this.sendJson({ type: 'keydown', key: e.key, code: e.code });
        });

        c.addEventListener('keyup', (e) => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            this.sendJson({ type: 'keyup', key: e.key, code: e.code });
        });

        // Mobile / Tablet Touch support (Supports both Trackpad relative drag & Direct tap mode!)
        c.addEventListener('touchstart', (e) => {
            if (!this.inputEnabled || e.touches.length === 0) return;
            const t = e.touches[0];
            this.touchStartX = t.clientX;
            this.touchStartY = t.clientY;
            this.touchStartTime = performance.now();
            this.touchMoved = false;

            if (this.touchMode === 'direct') {
                const { x, y } = this.getNormalizedCoords(t);
                this.virtualCursorX = x;
                this.virtualCursorY = y;
                this.lastLocalInputTime = performance.now();
                this.renderLocalCursorInstant();
                this.sendJson({ type: 'mousemove', x, y });
            }
        }, { passive: true });

        c.addEventListener('touchmove', (e) => {
            if (!this.inputEnabled || e.touches.length === 0) return;
            const t = e.touches[0];
            const dx = t.clientX - this.touchStartX;
            const dy = t.clientY - this.touchStartY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                this.touchMoved = true;
            }

            if (this.touchMode === 'trackpad') {
                // Relative trackpad movement scaled cleanly to screen width/height
                const sensitivity = 1.45 / Math.max(280, window.innerWidth);
                this.virtualCursorX = Math.max(0, Math.min(1, this.virtualCursorX + dx * sensitivity));
                this.virtualCursorY = Math.max(0, Math.min(1, this.virtualCursorY + dy * sensitivity));
                this.touchStartX = t.clientX;
                this.touchStartY = t.clientY;
            } else {
                const { x, y } = this.getNormalizedCoords(t);
                this.virtualCursorX = x;
                this.virtualCursorY = y;
            }

            // 0ms Instant Local Cursor Redraw at 120Hz/60Hz!
            this.lastLocalInputTime = performance.now();
            this.renderLocalCursorInstant();

            const now = performance.now();
            if (now - this.lastMouseMoveTime < 12) return;
            this.lastMouseMoveTime = now;

            this.sendJson({
                type: 'mousemove',
                x: Number(this.virtualCursorX.toFixed(4)),
                y: Number(this.virtualCursorY.toFixed(4)),
            });
        }, { passive: true });

        c.addEventListener('touchend', (e) => {
            if (!this.inputEnabled) return;
            const elapsed = performance.now() - this.touchStartTime;
            // Quick tap without dragging -> Click at current cursor position!
            if (!this.touchMoved && elapsed < 260) {
                this.sendJson({
                    type: 'click',
                    button: 'left',
                    x: Number(this.virtualCursorX.toFixed(4)),
                    y: Number(this.virtualCursorY.toFixed(4)),
                });
            }
        }, { passive: true });
    },

    toggleTouchMode() {
        this.touchMode = this.touchMode === 'trackpad' ? 'direct' : 'trackpad';
        const btn = document.getElementById('btn-touch-mode');
        const label = document.getElementById('touch-mode-label');
        if (this.touchMode === 'trackpad') {
            if (btn) btn.className = 'px-2.5 py-2 rounded-xl bg-rose-600 text-white text-[11px] font-bold flex items-center gap-1 shrink-0 shadow';
            if (label) label.textContent = 'โหมดทัชแพด';
            App.toast('โหมดทัชแพด: ลากนิ้วเลื่อนเมาส์เหมือนโน้ตบุ๊ก แตะ 1 ครั้งเพื่อคลิก', 'info');
        } else {
            if (btn) btn.className = 'px-2.5 py-2 rounded-xl bg-indigo-600 text-white text-[11px] font-bold flex items-center gap-1 shrink-0 shadow';
            if (label) label.textContent = 'โหมดแตะจุด';
            App.toast('โหมดแตะตรงจุด: แตะตรงไหนบนจอคอม คลิกตรงนั้นทันที', 'info');
        }
    },

    triggerMobileMouseClick(action = 'click', button = 'left') {
        this.sendJson({
            type: action,
            button: button,
            x: Number(this.virtualCursorX.toFixed(4)),
            y: Number(this.virtualCursorY.toFixed(4)),
        });
    },

    cycleZoom() {
        this.zoomIdx = (this.zoomIdx + 1) % this.zoomLevels.length;
        const z = this.zoomLevels[this.zoomIdx];
        if (this.canvas) {
            this.canvas.style.transform = z === 1 ? 'none' : `scale(${z})`;
            this.canvas.style.transformOrigin = 'top left';
        }
        App.setText('zoom-level-text', `ซูม ${z}x`);
        App.toast(z === 1 ? 'ปรับขนาดภาพพอดีหน้าจอ (1x)' : `ขยายหน้าจอ ${z} เท่า (เลื่อนดูได้)`, 'info');
    },

    sendKey(keyName) {
        this.sendJson({ type: 'keypress', key: keyName, code: keyName });
    },

    sendHotkey(combo) {
        this.sendJson({ type: 'hotkey', combo });
        App.toast(`ส่งคำสั่งคีย์ลัด: ${combo}`, 'info');
    },

    downloadScreenshot() {
        const url = App.getApiUrl(`/api/screenshot?monitor=${this.currentMonitor}`);
        window.open(url, '_blank');
        App.toast('กำลังบันทึกภาพหน้าจอความละเอียดสูง (PNG)...', 'success');
    },

    toggleFullscreen() {
        const stage = document.getElementById('remote-stage-container');
        if (!document.fullscreenElement) {
            stage?.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    },

    // --- Thai Text & Clipboard Modal ---
    openTextClipboardModal() {
        const modal = document.getElementById('clipboard-modal');
        modal?.classList.remove('hidden');
        modal?.classList.add('flex');
        document.getElementById('remote-text-input')?.focus();
    },

    closeTextClipboardModal() {
        const modal = document.getElementById('clipboard-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    },

    async pullHostClipboard() {
        try {
            const res = await fetch(App.getApiUrl('/api/clipboard'));
            const data = await res.json();
            const input = document.getElementById('remote-text-input');
            if (input) input.value = data.text || '';
            App.toast('ดึงข้อความจากคลิปบอร์ดเครื่องปลายทางแล้ว', 'success');
        } catch (e) {
            App.toast('ไม่สามารถดึงคลิปบอร์ดได้', 'error');
        }
    },

    async pushHostClipboard() {
        const text = document.getElementById('remote-text-input')?.value || '';
        try {
            await fetch(App.getApiUrl('/api/clipboard'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            App.toast('ส่งข้อความเข้าคลิปบอร์ดเครื่องปลายทางแล้ว (กด Ctrl+V เพื่อวางได้เลย)', 'success');
        } catch (e) {
            App.toast('ส่งคลิปบอร์ดไม่สำเร็จ', 'error');
        }
    },

    sendDirectText() {
        const input = document.getElementById('remote-text-input');
        const text = input?.value || '';
        if (!text) return;
        this.sendJson({ type: 'text', text });
        App.toast('พิมพ์ข้อความลงหน้าจอปลายทางเรียบร้อยแล้ว', 'success');
        input.value = '';
        this.closeTextClipboardModal();
    },

    // --- Drag & Drop File Upload directly onto Remote Screen ---
    onDragOver(e) {
        e.preventDefault();
        const overlay = document.getElementById('remote-drop-overlay');
        overlay?.classList.remove('hidden');
        overlay?.classList.add('flex');
    },

    onDragLeave(e) {
        e.preventDefault();
        const overlay = document.getElementById('remote-drop-overlay');
        overlay?.classList.add('hidden');
        overlay?.classList.remove('flex');
    },

    onDropFiles(e) {
        e.preventDefault();
        this.onDragLeave(e);
        if (e.dataTransfer?.files?.length) {
            FileTransfer.handleSelectedFiles(e.dataTransfer.files);
        }
    }
};
