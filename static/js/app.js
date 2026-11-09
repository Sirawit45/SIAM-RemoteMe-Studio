/**
 * RemoteMe Studio - Core Application Controller
 */
const App = {
    currentTab: 'dashboard',
    targetOrigin: window.location.origin,
    systemInfo: null,
    isDark: false,
    pollTimer: null,
    approvalPollTimer: null,
    activeRequestId: null,
    activeHostModalReqId: null,
    authToken: sessionStorage.getItem('remoteme_auth_token') || null,
    isDisconnected: false,

    isLocalHostConsole() {
        const h = window.location.hostname;
        return (h === 'localhost' || h === '127.0.0.1') && this.targetOrigin === window.location.origin;
    },

    init() {
        lucide.createIcons();
        this.loadSavedHost();

        // If on remote device (phone / external PC) and disconnected or not yet authorized, start on Lock Screen!
        if (sessionStorage.getItem('remoteme_disconnected') === '1' || (!this.isLocalHostConsole() && !this.authToken)) {
            FileTransfer.init();
            RemoteViewer.init();
            this.enterDisconnectedState(true);
            return;
        }

        this.fetchSystemInfo();
        this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);

        // Initialize sub-modules
        FileTransfer.init();
        RemoteViewer.init();
    },

    getApiUrl(path) {
        const base = `${this.targetOrigin}${path}`;
        if (!this.authToken) return base;
        const sep = path.includes('?') ? '&' : '?';
        return `${base}${sep}token=${encodeURIComponent(this.authToken)}`;
    },

    getWsUrl(path) {
        const u = new URL(this.targetOrigin);
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${u.host}${path}`;
    },

    loadSavedHost() {
        const params = new URLSearchParams(window.location.search);
        const queryId = params.get('id');
        if (queryId) {
            const input = document.getElementById('remote-host-input');
            if (input) input.value = queryId;
            const lockInput = document.getElementById('reconnect-host-input');
            if (lockInput) lockInput.value = queryId;
            localStorage.setItem('remoteme_saved_device_id', queryId);
        }

        const savedId = localStorage.getItem('remoteme_saved_device_id');
        if (savedId) {
            const input = document.getElementById('remote-host-input');
            if (input && !input.value) input.value = savedId;
            const lockInput = document.getElementById('reconnect-host-input');
            if (lockInput && !lockInput.value) lockInput.value = savedId;
        }

        const saved = sessionStorage.getItem('remoteme_target_origin');
        if (saved && saved !== window.location.origin) {
            this.targetOrigin = saved;
            document.getElementById('btn-reset-localhost')?.classList.remove('hidden');
        }
    },

    async resolveDeviceIdClientSide(digitsOnly) {
        const msgBuffer = new TextEncoder().encode(`siam_remoteme_v2_${digitsOnly}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const digest = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        const topic = `siam_rm_${digitsOnly}_${digest}`;

        const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=24h`);
        if (!res.ok) return null;
        const text = await res.text();
        const lines = text.trim().split('\n').reverse();
        for (const line of lines) {
            try {
                const evt = JSON.parse(line);
                if (evt.event === 'message' && evt.message) {
                    const data = JSON.parse(evt.message);
                    if (data.public_url) return data;
                }
            } catch (e) {}
        }
        return null;
    },

    async resolveInputToOrigin(rawInput) {
        const raw = (rawInput || '').trim();
        if (!raw) {
            if (!window.location.hostname.endsWith('github.io')) {
                return this.targetOrigin || window.location.origin;
            }
            return null;
        }

        const digitsOnly = raw.replace(/[^0-9]/g, '');
        if (digitsOnly.length === 9 && !raw.includes('.') && !raw.includes(':')) {
            const formattedId = `${digitsOnly.slice(0,3)}-${digitsOnly.slice(3,6)}-${digitsOnly.slice(6)}`;
            localStorage.setItem('remoteme_saved_device_id', formattedId);
            this.toast(`กำลังค้นหาเครื่องรหัส ${formattedId}...`, 'info');
            const record = await this.resolveDeviceIdClientSide(digitsOnly);
            if (!record || !record.public_url) {
                this.toast('ไม่พบรหัสเครื่องนี้ออนไลน์อยู่ กรุณาตรวจสอบว่าเปิดโปรแกรมที่เครื่องปลายทางแล้ว', 'error');
                return null;
            }
            return record.public_url.replace(/\/+$/, '');
        }

        let formatted = raw;
        if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
            if (formatted.includes('.trycloudflare.com') || formatted.includes('.lhr.life') || formatted.includes('.ngrok')) {
                formatted = 'https://' + formatted;
            } else {
                formatted = 'http://' + formatted;
            }
        }
        if (formatted.startsWith('http://') && !formatted.includes(':', 6) && !formatted.includes('.trycloudflare.com')) {
            formatted += ':8765';
        }
        return formatted.replace(/\/+$/, '');
    },

    async connectToTargetHost() {
        const raw = document.getElementById('remote-host-input')?.value.trim() ||
                    document.getElementById('reconnect-host-input')?.value.trim();
        const lockInput = document.getElementById('reconnect-host-input');
        if (raw && lockInput) lockInput.value = raw;

        const originUrl = await this.resolveInputToOrigin(raw);
        if (!originUrl) return;

        this.targetOrigin = originUrl;
        sessionStorage.setItem('remoteme_target_origin', this.targetOrigin);

        // Always require fresh approval or PIN when connecting to a target host!
        this.enterDisconnectedState(true);
        await this.requestHostApproval();
    },

    async requestHostApproval() {
        const raw = document.getElementById('reconnect-host-input')?.value.trim() ||
                    document.getElementById('remote-host-input')?.value.trim();
        const originUrl = await this.resolveInputToOrigin(raw);
        if (!originUrl) {
            this.toast('กรุณาใส่รหัสเครื่อง 9 หลัก (เช่น 916-479-992) ก่อนส่งคำขอเชื่อมต่อ', 'warning');
            return;
        }
        this.targetOrigin = originUrl;
        sessionStorage.setItem('remoteme_target_origin', this.targetOrigin);

        try {
            const res = await fetch(`${this.targetOrigin}/api/auth/request`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.request_id) {
                throw new Error(data.detail || 'ไม่สามารถส่งคำขอเชื่อมต่อได้');
            }

            this.activeRequestId = data.request_id;
            document.getElementById('approval-waiting-box')?.classList.remove('hidden');
            this.toast(`ส่งคำขอไปที่เครื่อง "${data.device_name || 'ปลายทาง'}" แล้ว กรุณากดยอมรับที่หน้าจอคอม หรือกรอกรหัส PIN`, 'info');

            if (this.approvalPollTimer) clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = setInterval(() => this.checkApprovalStatus(), 1200);
        } catch (e) {
            this.toast('ไม่สามารถติดต่อเครื่องปลายทางได้ กรุณาตรวจสอบว่าเปิดโปรแกรมอยู่ที่คอมพิวเตอร์', 'error');
        }
    },

    async checkApprovalStatus() {
        if (!this.activeRequestId) return;
        try {
            const res = await fetch(`${this.targetOrigin}/api/auth/request-status?request_id=${encodeURIComponent(this.activeRequestId)}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.status === 'approved' && data.token) {
                if (this.approvalPollTimer) {
                    clearInterval(this.approvalPollTimer);
                    this.approvalPollTimer = null;
                }
                this.activeRequestId = null;
                document.getElementById('approval-waiting-box')?.classList.add('hidden');
                this.toast('เครื่องปลายทางกดยอมรับการเชื่อมต่อแล้ว!', 'success');
                this.completeAuthorization(data.token);
            } else if (data.status === 'rejected') {
                if (this.approvalPollTimer) {
                    clearInterval(this.approvalPollTimer);
                    this.approvalPollTimer = null;
                }
                this.activeRequestId = null;
                document.getElementById('approval-waiting-box')?.classList.add('hidden');
                this.toast('เครื่องปลายทางปฏิเสธคำขอเชื่อมต่อ', 'error');
            }
        } catch (e) {}
    },

    async reconnectWithPin() {
        const pin = document.getElementById('reconnect-pin-input')?.value.trim();
        if (!pin) {
            this.toast('กรุณากรอกรหัส PIN 6 หลัก', 'warning');
            return;
        }
        const raw = document.getElementById('reconnect-host-input')?.value.trim() ||
                    document.getElementById('remote-host-input')?.value.trim();
        const originUrl = await this.resolveInputToOrigin(raw);
        if (!originUrl) {
            this.toast('กรุณาใส่รหัสเครื่อง 9 หลักก่อนยืนยันรหัส PIN', 'warning');
            return;
        }
        this.targetOrigin = originUrl;
        sessionStorage.setItem('remoteme_target_origin', this.targetOrigin);

        try {
            const res = await fetch(`${this.targetOrigin}/api/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin }),
            });
            const data = await res.json();
            if (!res.ok || !data.authenticated) {
                this.toast(data.detail || 'รหัส PIN 6 หลักไม่ถูกต้อง', 'error');
                return;
            }
            const pinInput = document.getElementById('reconnect-pin-input');
            if (pinInput) pinInput.value = '';
            this.toast('ยืนยันรหัส PIN สำเร็จ เชื่อมต่อเครื่องปลายทางแล้ว!', 'success');
            this.completeAuthorization(data.token);
        } catch (e) {
            this.toast('ไม่สามารถตรวจสอบรหัส PIN กับเครื่องปลายทางได้', 'error');
        }
    },

    completeAuthorization(token) {
        if (this.approvalPollTimer) {
            clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = null;
        }
        this.activeRequestId = null;
        document.getElementById('approval-waiting-box')?.classList.add('hidden');

        this.authToken = token;
        sessionStorage.setItem('remoteme_auth_token', token);
        this.exitDisconnectedState();

        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);
        }
        this.fetchSystemInfo();
        FileTransfer.loadLocations();
        FileTransfer.loadDirectory('');
        RemoteViewer.reconnect();
    },

    resetToLocalHost() {
        this.targetOrigin = window.location.origin;
        sessionStorage.removeItem('remoteme_target_origin');
        const input = document.getElementById('remote-host-input');
        if (input) input.value = '';
        document.getElementById('btn-reset-localhost')?.classList.add('hidden');
        this.exitDisconnectedState();
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);
        }
        this.toast('สลับกลับมาเชื่อมต่อเครื่องปัจจุบันแล้ว', 'success');
        this.fetchSystemInfo();
        FileTransfer.loadLocations();
        FileTransfer.loadDirectory('');
        RemoteViewer.reconnect();
    },

    exitDisconnectedState() {
        this.isDisconnected = false;
        sessionStorage.removeItem('remoteme_disconnected');

        const lockScreen = document.getElementById('global-disconnected-screen');
        if (lockScreen) {
            lockScreen.classList.add('hidden');
            lockScreen.classList.remove('flex');
        }
        document.getElementById('mobile-bottom-nav')?.classList.remove('hidden');
        document.getElementById('btn-header-disconnect')?.classList.remove('hidden');
        this.switchTab(this.currentTab || 'dashboard');
    },

    async enterDisconnectedState(skipServerLogout = false) {
        if (!skipServerLogout && this.authToken) {
            try {
                await fetch(`${this.targetOrigin}/api/auth/logout`, {
                    method: 'POST',
                    headers: { 'X-RemoteMe-Token': this.authToken },
                });
            } catch (e) {}
        }

        this.isDisconnected = true;
        this.systemInfo = null;
        this.authToken = null;
        sessionStorage.removeItem('remoteme_auth_token');
        sessionStorage.setItem('remoteme_disconnected', '1');

        // Also clear any previously saved PIN in localStorage so reconnect ALWAYS requires new PIN or Host Popup Approval!
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('remoteme_saved_pin_')) {
                localStorage.removeItem(k);
            }
        });

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.approvalPollTimer) {
            clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = null;
        }
        document.getElementById('approval-waiting-box')?.classList.add('hidden');

        // Hide ALL 5 tabs and mobile bottom nav so nothing (CPU, IP, Files, Controls) can be viewed
        ['dashboard', 'remote', 'files', 'transfers', 'settings'].forEach(t => {
            document.getElementById(`tab-${t}`)?.classList.add('hidden');
        });
        document.getElementById('mobile-bottom-nav')?.classList.add('hidden');
        document.getElementById('btn-header-disconnect')?.classList.add('hidden');
        this.closeMobileDrawer();

        // Show Global Disconnected Lock Screen
        const lockScreen = document.getElementById('global-disconnected-screen');
        if (lockScreen) {
            lockScreen.classList.remove('hidden');
            lockScreen.classList.add('flex');
        }
        const savedId = localStorage.getItem('remoteme_saved_device_id') || '';
        const lockInput = document.getElementById('reconnect-host-input');
        if (lockInput && !lockInput.value) lockInput.value = savedId;
        const pinInput = document.getElementById('reconnect-pin-input');
        if (pinInput) pinInput.value = '';

        // Clear all File Explorer data immediately
        if (typeof FileTransfer !== 'undefined' && FileTransfer.clearAllData) {
            FileTransfer.clearAllData();
        }

        // Clear all host machine details from UI
        const dot = document.getElementById('host-status-dot');
        const txt = document.getElementById('host-status-text');
        if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        if (txt) txt.textContent = 'ตัดการเชื่อมต่อแล้ว (Disconnected)';

        this.setText('header-device-name', 'ไม่ได้เชื่อมต่อ');
        this.setText('sidebar-device-id', '--- --- ---');
        this.setText('card-device-id', '--- --- ---');
        this.setText('card-os-info', 'ตัดการเชื่อมต่อจากเครื่องปลายทางแล้ว');
        this.setText('card-pin-code', '------');
        this.setText('sidebar-sys-load', '0% / 0%');
        this.setText('meter-cpu-text', '0%');
        this.setText('meter-ram-text', '0 / 0 GB (0%)');
        this.setText('dash-active-sessions', '00');
        this.setText('dash-stream-fps', '0 FPS');
        this.setText('dash-stream-ping', 'Offline');

        const cpuBar = document.getElementById('meter-cpu-bar');
        if (cpuBar) cpuBar.style.width = '0%';
        const ramBar = document.getElementById('meter-ram-bar');
        if (ramBar) ramBar.style.width = '0%';

        const wanUrlEl = document.getElementById('wan-public-url');
        const wanDotEl = document.getElementById('wan-status-dot');
        if (wanUrlEl) wanUrlEl.textContent = 'ตัดการเชื่อมต่อแล้ว';
        if (wanDotEl) wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';

        const urlList = document.getElementById('network-url-list');
        if (urlList) urlList.innerHTML = '';
        lucide.createIcons();
    },

    openMobileDrawer() {
        document.getElementById('app-sidebar')?.classList.remove('-translate-x-full');
        document.getElementById('mobile-drawer-backdrop')?.classList.remove('hidden');
    },

    closeMobileDrawer() {
        document.getElementById('app-sidebar')?.classList.add('-translate-x-full');
        document.getElementById('mobile-drawer-backdrop')?.classList.add('hidden');
    },

    switchTab(tabName) {
        if (this.isDisconnected) {
            this.closeMobileDrawer();
            this.toast('กรุณายืนยันการเชื่อมต่อใหม่ก่อนเข้าใช้งาน', 'warning');
            return;
        }
        this.currentTab = tabName;
        this.closeMobileDrawer();

        const tabs = ['dashboard', 'remote', 'files', 'transfers', 'settings'];
        tabs.forEach(t => {
            const sec = document.getElementById(`tab-${t}`);
            if (sec) sec.classList.toggle('hidden', t !== tabName);
        });

        document.querySelectorAll('.nav-item, .mobile-nav-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === tabName);
        });

        const topHeader = document.getElementById('main-top-header');
        if (topHeader) {
            if (tabName === 'remote') {
                topHeader.classList.add('hidden', 'lg:flex');
            } else {
                topHeader.classList.remove('hidden', 'lg:flex');
            }
        }

        const titles = {
            dashboard: 'ศูนย์ควบคุมรีโมทและการเชื่อมต่อ',
            remote: 'รีโมทหน้าจอสด (60 FPS)',
            files: 'จัดการและโอนย้ายไฟล์',
            transfers: 'รายการโอนย้ายไฟล์',
            settings: 'ตั้งค่าระบบ & ความปลอดภัย',
        };
        const titleEl = document.getElementById('page-title');
        if (titleEl && titles[tabName]) titleEl.textContent = titles[tabName];

        if (tabName === 'remote') {
            RemoteViewer.ensureConnected();
            setTimeout(() => document.getElementById('remote-canvas')?.focus(), 100);
        } else if (tabName === 'files') {
            if (!FileTransfer.currentPath) {
                FileTransfer.loadLocations();
                FileTransfer.loadDirectory('');
            }
        }
    },

    async fetchSystemInfo() {
        if (this.isDisconnected) return;
        try {
            const res = await fetch(this.getApiUrl('/api/system/info'));
            if (res.status === 401) {
                // Unauthorized -> immediately lock screen!
                RemoteViewer.disconnectSession();
                return;
            }
            if (!res.ok) throw new Error('Host unreachable');
            if (this.isDisconnected) return;
            const data = await res.json();
            this.systemInfo = data;
            this.renderSystemInfo(data);
        } catch (err) {
            const dot = document.getElementById('host-status-dot');
            const txt = document.getElementById('host-status-text');
            if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
            if (txt) txt.textContent = 'ขาดการเชื่อมต่อ (Offline)';
        }
    },

    renderSystemInfo(data) {
        const dot = document.getElementById('host-status-dot');
        const txt = document.getElementById('host-status-text');
        if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
        if (txt) txt.textContent = 'พร้อมเชื่อมต่อ (Online)';

        // Check if there are pending incoming connection requests on the Host PC
        const pending = data.pending_requests || [];
        const approvalModal = document.getElementById('host-approval-modal');
        if (pending.length > 0) {
            const req = pending[0];
            this.activeHostModalReqId = req.request_id;
            this.setText('approval-device-info', `อุปกรณ์: ${req.device_label} • IP: ${req.client_ip}`);
            approvalModal?.classList.remove('hidden');
            approvalModal?.classList.add('flex');
        } else if (this.activeHostModalReqId) {
            this.activeHostModalReqId = null;
            approvalModal?.classList.add('hidden');
            approvalModal?.classList.remove('flex');
        }

        const formattedId = (data.device_id || '').replace(/-/g, ' ');
        this.setText('sidebar-device-id', formattedId);
        this.setText('card-device-id', formattedId);
        this.setText('header-device-name', `${data.device_name}`);
        this.setText('card-os-info', 'พร้อมรับการเชื่อมต่อด้วยรหัส 9 หลัก');
        this.setText('card-pin-code', data.pin_code || '------');

        const activeCount = Math.max(1, (data.sessions || []).length);
        this.setText('dash-active-sessions', String(activeCount).padStart(2, '0'));

        const reqPinToggle = document.getElementById('toggle-require-pin');
        if (reqPinToggle && document.activeElement !== reqPinToggle) {
            reqPinToggle.checked = !!data.config?.require_pin;
        }

        const wan = data.wan || {};
        const wanDotEl = document.getElementById('wan-status-dot');
        if (wanDotEl) {
            if (wan.status === 'online' && wan.public_url) {
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
            } else if (wan.status === 'starting' || wan.status === 'downloading') {
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
            } else {
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
            }
        }

        const setDevName = document.getElementById('set-device-name');
        if (setDevName && document.activeElement !== setDevName && !setDevName.dataset.loaded) {
            setDevName.value = data.device_name || '';
            setDevName.dataset.loaded = '1';
            document.getElementById('set-pin-code').value = data.pin_code || '';
            document.getElementById('set-upload-dir').value = data.config?.default_upload_dir || '';
            document.getElementById('set-require-pin').checked = !!data.config?.require_pin;
            document.getElementById('set-allow-input').checked = !!data.config?.allow_input_control;
            document.getElementById('set-allow-delete').checked = !!data.config?.allow_file_delete;
        }

        if (Array.isArray(data.monitors)) {
            RemoteViewer.updateMonitorList(data.monitors);
        }
    },

    async respondIncomingRequest(approved) {
        if (!this.activeHostModalReqId) return;
        const reqId = this.activeHostModalReqId;
        this.activeHostModalReqId = null;
        const approvalModal = document.getElementById('host-approval-modal');
        approvalModal?.classList.add('hidden');
        approvalModal?.classList.remove('flex');

        try {
            await fetch(this.getApiUrl('/api/auth/respond'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: reqId, approved }),
            });
            this.toast(approved ? 'อนุมัติให้อุปกรณ์เข้าเชื่อมต่อแล้ว' : 'ปฏิเสธคำขอเชื่อมต่อแล้ว', approved ? 'success' : 'warning');
            this.fetchSystemInfo();
        } catch (e) {}
    },

    async regeneratePin() {
        try {
            const res = await fetch(this.getApiUrl('/api/config/regenerate-pin'), { method: 'POST' });
            const data = await res.json();
            if (data.pin_code) {
                this.setText('card-pin-code', data.pin_code);
                const pinInput = document.getElementById('set-pin-code');
                if (pinInput) pinInput.value = data.pin_code;
                this.toast(`สร้างรหัส PIN ใหม่เรียบร้อย: ${data.pin_code} (ตัดการเชื่อมต่อเดิมทั้งหมดแล้ว)`, 'success');
            }
        } catch (e) {
            this.toast('ไม่สามารถสร้างรหัส PIN ใหม่ได้', 'error');
        }
    },

    async disconnectAllSessions() {
        try {
            await fetch(this.getApiUrl('/api/sessions/disconnect-all'), { method: 'POST' });
        } catch (e) {}
        if (!this.isLocalHostConsole()) {
            RemoteViewer.disconnectSession();
        } else {
            this.toast('เตะอุปกรณ์ที่เชื่อมต่อเข้ามาทั้งหมดออกเรียบร้อยแล้ว', 'success');
            this.fetchSystemInfo();
        }
    },

    async toggleRequirePin(checked) {
        try {
            await fetch(this.getApiUrl('/api/config/update'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ require_pin: checked }),
            });
            const setPin = document.getElementById('set-require-pin');
            if (setPin) setPin.checked = checked;
            this.toast(checked ? 'เปิดระบบล็อกรหัส PIN แล้ว' : 'ปิดการถามรหัส PIN (เชื่อมต่อด่วน)', 'info');
        } catch (e) {
            this.toast('บันทึกการตั้งค่าไม่สำเร็จ', 'error');
        }
    },

    async saveSettings() {
        const payload = {
            device_name: document.getElementById('set-device-name')?.value.trim(),
            pin_code: document.getElementById('set-pin-code')?.value.trim(),
            default_upload_dir: document.getElementById('set-upload-dir')?.value.trim(),
            require_pin: document.getElementById('set-require-pin')?.checked,
            allow_input_control: document.getElementById('set-allow-input')?.checked,
            allow_file_delete: document.getElementById('set-allow-delete')?.checked,
        };
        try {
            const res = await fetch(this.getApiUrl('/api/config/update'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (res.ok) {
                this.toast('บันทึกการตั้งค่าระบบและความปลอดภัยเรียบร้อยแล้ว', 'success');
                this.fetchSystemInfo();
            }
        } catch (e) {
            this.toast('เกิดข้อผิดพลาดในการบันทึกตั้งค่า', 'error');
        }
    },

    toggleTheme() {
        this.isDark = !this.isDark;
        document.body.classList.toggle('dark-theme', this.isDark);
        document.documentElement.classList.toggle('dark', this.isDark);
    },

    copyWanUrl() {
        const url = this.systemInfo?.wan?.public_url;
        if (url) {
            this.copyText(url);
        } else {
            this.toast('กำลังสร้างลิงก์ออนไลน์ระดับโลก กรุณารอสักครู่...', 'warning');
        }
    },

    async restartWanTunnel(provider = 'cloudflare') {
        try {
            this.toast('กำลังเปิดอุโมงค์เชื่อมต่อข้ามอินเทอร์เน็ตระดับโลกใหม่...', 'info');
            await fetch(this.getApiUrl('/api/wan/stop'), { method: 'POST' });
            await fetch(this.getApiUrl('/api/wan/start'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
            });
            setTimeout(() => this.fetchSystemInfo(), 1500);
        } catch (e) {
            this.toast('ไม่สามารถรีเฟรชอุโมงค์ออนไลน์ได้', 'error');
        }
    },

    async stopWanTunnel() {
        try {
            await fetch(this.getApiUrl('/api/wan/stop'), { method: 'POST' });
            await fetch(this.getApiUrl('/api/sessions/disconnect-all'), { method: 'POST' });
            this.toast('ปิดลิงก์ออนไลน์และตัดการเชื่อมต่อจากภายนอกทั้งหมดแล้ว', 'success');
            this.fetchSystemInfo();
        } catch (e) {
            this.toast('ไม่สามารถปิดอุโมงค์ออนไลน์ได้', 'error');
        }
    },

    openQrModal() {
        const devId = this.systemInfo?.device_id || '';
        const portalUrl = `https://sirawit45.github.io/SIAM-RemoteMe-Studio/?id=${encodeURIComponent(devId)}`;
        const qrImg = document.getElementById('qr-code-img');
        if (qrImg) {
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(portalUrl)}`;
        }
        this.setText('qr-device-id', devId.replace(/-/g, ' '));
        this.setText('qr-pin-code', this.systemInfo?.pin_code || '------');

        const modal = document.getElementById('qr-modal');
        modal?.classList.remove('hidden');
        modal?.classList.add('flex');
    },

    closeQrModal() {
        const modal = document.getElementById('qr-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    },

    copyText(text) {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            this.toast(`คัดลอก "${text}" ลงคลิปบอร์ดแล้ว`, 'success');
        });
    },

    setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    },

    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const colors = {
            success: 'bg-emerald-600 text-white border-emerald-500',
            error: 'bg-rose-600 text-white border-rose-500',
            warning: 'bg-amber-500 text-white border-amber-400',
            info: 'bg-slate-900 text-white border-slate-700',
        };
        const el = document.createElement('div');
        el.className = `px-4 py-3 rounded-xl border shadow-xl text-xs font-medium flex items-center gap-2 transition-all duration-300 pointer-events-auto ${colors[type] || colors.info}`;
        el.innerHTML = `<span>${message}</span>`;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(8px)';
            setTimeout(() => el.remove(), 300);
        }, 3200);
    }
};

window.addEventListener('DOMContentLoaded', () => App.init());
