/**
 * SIAM RemoteMe Studio - Core Application Controller
 * Displays ONLY:
 *   1. This Machine's ID & Refreshable Password
 *   2. Destination Machine's ID & Password inputs to connect
 * Never mirrors its own screen.
 */
const App = {
    currentTab: 'dashboard',
    targetOrigin: window.location.origin,
    localSystemInfo: null,
    systemInfo: null,
    isDark: false,
    localPollTimer: null,
    remotePollTimer: null,
    approvalPollTimer: null,
    activeRequestId: null,
    activeHostModalReqId: null,
    authToken: null,
    isRemoteConnected: false,
    isDisconnected: true,

    isLocalHostBrowser() {
        const h = window.location.hostname;
        return h === 'localhost' || h === '127.0.0.1';
    },

    isLocalHostConsole() {
        return this.isLocalHostBrowser() && !this.isRemoteConnected;
    },

    init() {
        lucide.createIcons();

        // Always start on the clean 2-Card Home Screen every time the program is opened!
        this.authToken = null;
        this.isRemoteConnected = false;
        this.isDisconnected = true;
        sessionStorage.removeItem('remoteme_auth_token');

        this.loadSavedPartnerId();

        if (this.isLocalHostBrowser()) {
            // Poll local PC backend ONLY to show This PC's ID, Password, and incoming approval requests
            this.fetchLocalHostInfo();
            this.localPollTimer = setInterval(() => this.fetchLocalHostInfo(), 2000);
        } else {
            // On mobile / external browser: generate & display this client device's own ID & refreshable Password
            this.initClientDeviceCredentials();
        }

        FileTransfer.init();
        RemoteViewer.init();
        this.showHomeScreen();
    },

    initClientDeviceCredentials() {
        let clientId = localStorage.getItem('remoteme_client_self_id');
        if (!clientId) {
            const p1 = String(Math.floor(100 + Math.random() * 900));
            const p2 = String(Math.floor(100 + Math.random() * 900));
            const p3 = String(Math.floor(100 + Math.random() * 900));
            clientId = `${p1}-${p2}-${p3}`;
            localStorage.setItem('remoteme_client_self_id', clientId);
        }
        let clientPin = localStorage.getItem('remoteme_client_self_pin');
        if (!clientPin) {
            clientPin = String(Math.floor(100000 + Math.random() * 900000));
            localStorage.setItem('remoteme_client_self_pin', clientPin);
        }
        this.localSystemInfo = {
            device_id: clientId,
            pin_code: clientPin,
        };
        this.setText('card-device-id', clientId.replace(/-/g, ' '));
        this.setText('card-pin-code', clientPin);
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
        const sep = path.includes('?') ? '&' : '?';
        const tokenParam = this.authToken ? `${sep}token=${encodeURIComponent(this.authToken)}` : '';
        return `${proto}//${u.host}${path}${tokenParam}`;
    },

    loadSavedPartnerId() {
        const params = new URLSearchParams(window.location.search);
        const queryId = params.get('id');
        const partnerInput = document.getElementById('partner-id-input');
        if (queryId && partnerInput) {
            partnerInput.value = queryId.replace(/-/g, ' ');
            localStorage.setItem('remoteme_saved_device_id', queryId);
            return;
        }
        const savedId = localStorage.getItem('remoteme_saved_device_id');
        if (savedId && partnerInput && !partnerInput.value) {
            partnerInput.value = savedId.replace(/-/g, ' ');
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
            this.toast('กรุณากรอกรหัส ID ของเครื่องปลายทาง 9 หลัก', 'warning');
            return null;
        }

        const digitsOnly = raw.replace(/[^0-9]/g, '');

        // Block self-connection (prevent mirroring own screen!)
        const myDigits = (this.localSystemInfo?.device_id || '').replace(/[^0-9]/g, '');
        if (digitsOnly && myDigits && digitsOnly === myDigits) {
            this.toast('ไม่สามารถควบคุมหน้าจอเครื่องตัวเองได้ กรุณาใส่รหัส ID ของเครื่องปลายทางเครื่องอื่น', 'warning');
            return null;
        }

        if (digitsOnly.length === 9 && !raw.includes('.') && !raw.includes(':')) {
            const formattedId = `${digitsOnly.slice(0,3)}-${digitsOnly.slice(3,6)}-${digitsOnly.slice(6)}`;
            localStorage.setItem('remoteme_saved_device_id', formattedId);
            this.toast(`กำลังค้นหาเครื่องปลายทาง ID: ${formattedId.replace(/-/g, ' ')}...`, 'info');
            const record = await this.resolveDeviceIdClientSide(digitsOnly);
            if (!record || !record.public_url) {
                this.toast('ไม่พบรหัสเครื่องนี้ออนไลน์อยู่ กรุณาตรวจสอบว่าเปิดโปรแกรมที่เครื่องปลายทางแล้ว', 'error');
                return null;
            }
            const resolvedUrl = record.public_url.replace(/\/+$/, '');
            // Also check if resolved tunnel URL belongs to this local host PC
            if (this.isLocalHostBrowser() && this.localSystemInfo?.wan?.public_url &&
                resolvedUrl === this.localSystemInfo.wan.public_url.replace(/\/+$/, '')) {
                this.toast('ไม่สามารถควบคุมหน้าจอเครื่องตัวเองได้ กรุณาใส่รหัส ID ของเครื่องปลายทางเครื่องอื่น', 'warning');
                return null;
            }
            return resolvedUrl;
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
        const finalUrl = formatted.replace(/\/+$/, '');
        if (this.isLocalHostBrowser() && (finalUrl.includes('localhost') || finalUrl.includes('127.0.0.1'))) {
            this.toast('ไม่สามารถควบคุมหน้าจอเครื่องตัวเองได้ กรุณาใส่รหัส ID ของเครื่องปลายทางเครื่องอื่น', 'warning');
            return null;
        }
        return finalUrl;
    },

    async connectWithIdAndPassword() {
        const rawId = document.getElementById('partner-id-input')?.value.trim();
        const pin = document.getElementById('partner-pin-input')?.value.trim();

        if (!rawId) {
            this.toast('กรุณาใส่รหัส ID ของเครื่องปลายทาง', 'warning');
            document.getElementById('partner-id-input')?.focus();
            return;
        }
        if (!pin) {
            this.toast('กรุณาใส่รหัสผ่าน (Password) ของเครื่องปลายทาง', 'warning');
            document.getElementById('partner-pin-input')?.focus();
            return;
        }

        const originUrl = await this.resolveInputToOrigin(rawId);
        if (!originUrl) return;

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
                this.toast(data.detail || 'รหัสผ่าน (Password) ไม่ถูกต้อง', 'error');
                return;
            }
            const pinInput = document.getElementById('partner-pin-input');
            if (pinInput) pinInput.value = '';
            this.toast('เชื่อมต่อสำเร็จ! กำลังเปิดหน้าจอเครื่องปลายทาง...', 'success');
            this.completeAuthorization(data.token);
        } catch (e) {
            this.toast('ไม่สามารถติดต่อเครื่องปลายทางได้ กรุณาตรวจสอบรหัส ID หรืออินเทอร์เน็ต', 'error');
        }
    },

    async requestHostApproval() {
        const rawId = document.getElementById('partner-id-input')?.value.trim();
        if (!rawId) {
            this.toast('กรุณาใส่รหัส ID ของเครื่องปลายทางก่อนส่งคำขอเชื่อมต่อ', 'warning');
            document.getElementById('partner-id-input')?.focus();
            return;
        }
        const originUrl = await this.resolveInputToOrigin(rawId);
        if (!originUrl) return;

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
            this.toast(`ส่งคำขอไปที่เครื่อง "${data.device_name || 'ปลายทาง'}" แล้ว กรุณากดยอมรับที่หน้าจอปลายทาง`, 'info');

            if (this.approvalPollTimer) clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = setInterval(() => this.checkApprovalStatus(), 1200);
        } catch (e) {
            this.toast('ไม่สามารถติดต่อเครื่องปลายทางได้ กรุณาตรวจสอบว่าเปิดโปรแกรมอยู่ที่เครื่องปลายทาง', 'error');
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

    completeAuthorization(token) {
        if (this.approvalPollTimer) {
            clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = null;
        }
        this.activeRequestId = null;
        document.getElementById('approval-waiting-box')?.classList.add('hidden');

        this.authToken = token;
        this.isRemoteConnected = true;
        this.isDisconnected = false;
        sessionStorage.setItem('remoteme_auth_token', token);

        // Show active remote session navigation bar
        const activeNav = document.getElementById('active-session-nav');
        if (activeNav) {
            activeNav.classList.remove('hidden');
            activeNav.classList.add('flex');
        }
        const mobileNav = document.getElementById('mobile-bottom-nav');
        if (mobileNav) {
            mobileNav.classList.remove('hidden');
            mobileNav.classList.add('flex');
        }

        if (this.remotePollTimer) clearInterval(this.remotePollTimer);
        this.remotePollTimer = setInterval(() => this.fetchRemoteTargetInfo(), 2500);
        this.fetchRemoteTargetInfo();

        FileTransfer.loadLocations();
        FileTransfer.loadDirectory('');
        this.switchTab('remote');
        RemoteViewer.reconnect();
    },

    showHomeScreen() {
        this.currentTab = 'dashboard';
        document.body.classList.remove('remote-tab-active', 'immersive-fullscreen');

        // Hide remote/files/transfers/settings tabs, show ONLY dashboard (the 2-Card Home Screen)
        ['remote', 'files', 'transfers', 'settings'].forEach(t => {
            document.getElementById(`tab-${t}`)?.classList.add('hidden');
        });
        document.getElementById('tab-dashboard')?.classList.remove('hidden');

        // Hide active session nav bars when on Home Screen
        const activeNav = document.getElementById('active-session-nav');
        if (activeNav) {
            activeNav.classList.add('hidden');
            activeNav.classList.remove('flex');
        }
        const mobileNav = document.getElementById('mobile-bottom-nav');
        if (mobileNav) {
            mobileNav.classList.add('hidden');
            mobileNav.classList.remove('flex');
        }

        const topHeader = document.getElementById('main-top-header');
        if (topHeader) {
            topHeader.classList.remove('hidden', 'lg:flex');
        }
        const titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.textContent = 'SIAM RemoteMe Studio';
        lucide.createIcons();
    },

    async enterDisconnectedState(skipServerLogout = false) {
        if (!skipServerLogout && this.authToken && this.targetOrigin) {
            try {
                await fetch(`${this.targetOrigin}/api/auth/logout`, {
                    method: 'POST',
                    headers: { 'X-RemoteMe-Token': this.authToken },
                });
            } catch (e) {}
        }

        this.isRemoteConnected = false;
        this.isDisconnected = true;
        this.systemInfo = null;
        this.authToken = null;
        sessionStorage.removeItem('remoteme_auth_token');

        if (this.remotePollTimer) {
            clearInterval(this.remotePollTimer);
            this.remotePollTimer = null;
        }
        if (this.approvalPollTimer) {
            clearInterval(this.approvalPollTimer);
            this.approvalPollTimer = null;
        }
        document.getElementById('approval-waiting-box')?.classList.add('hidden');

        const pinInput = document.getElementById('partner-pin-input');
        if (pinInput) pinInput.value = '';

        if (typeof FileTransfer !== 'undefined' && FileTransfer.clearAllData) {
            FileTransfer.clearAllData();
        }

        this.showHomeScreen();
    },

    openMobileDrawer() {},
    closeMobileDrawer() {},

    switchTab(tabName) {
        if (!this.isRemoteConnected && tabName !== 'dashboard') {
            this.toast('กรุณาใส่ ID และ Password เพื่อเชื่อมต่อเครื่องปลายทางก่อน', 'warning');
            return;
        }
        this.currentTab = tabName;
        document.body.classList.toggle('remote-tab-active', tabName === 'remote');

        const tabs = ['dashboard', 'remote', 'files', 'transfers', 'settings'];
        tabs.forEach(t => {
            const sec = document.getElementById(`tab-${t}`);
            if (sec) sec.classList.toggle('hidden', t !== tabName);
        });

        // Highlight active top button
        const btnRemote = document.getElementById('top-btn-remote');
        const btnFiles = document.getElementById('top-btn-files');
        if (btnRemote && btnFiles) {
            if (tabName === 'remote') {
                btnRemote.className = 'px-3 py-1.5 rounded-xl bg-rose-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition';
                btnFiles.className = 'px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition';
            } else if (tabName === 'files') {
                btnFiles.className = 'px-3 py-1.5 rounded-xl bg-rose-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition';
                btnRemote.className = 'px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition';
            }
        }

        document.querySelectorAll('.mobile-nav-btn').forEach(el => {
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

    async fetchLocalHostInfo() {
        if (!this.isLocalHostBrowser()) return;
        try {
            const res = await fetch(`${window.location.origin}/api/system/info`);
            if (!res.ok) return;
            const data = await res.json();
            this.localSystemInfo = data;

            const formattedId = (data.device_id || '').replace(/-/g, ' ');
            this.setText('card-device-id', formattedId);
            this.setText('card-pin-code', data.pin_code || '------');

            const dot = document.getElementById('host-status-dot');
            const txt = document.getElementById('host-status-text');
            if (dot) dot.className = 'w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0';
            const sessionCount = (data.sessions || []).length;
            if (txt) {
                txt.textContent = sessionCount > 0
                    ? `มีผู้ควบคุมเชื่อมต่ออยู่ (${sessionCount} เครื่อง)`
                    : 'พร้อมรับการเชื่อมต่อ';
            }

            // Show incoming connection approval modal if someone requests access to this PC
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
        } catch (e) {}
    },

    async fetchRemoteTargetInfo() {
        if (!this.isRemoteConnected) return;
        try {
            const res = await fetch(this.getApiUrl('/api/system/info'));
            if (res.status === 401) {
                RemoteViewer.disconnectSession();
                return;
            }
            if (!res.ok) throw new Error('Host unreachable');
            const data = await res.json();
            this.systemInfo = data;
            if (Array.isArray(data.monitors)) {
                RemoteViewer.updateMonitorList(data.monitors);
            }
        } catch (err) {}
    },

    async respondIncomingRequest(approved) {
        if (!this.activeHostModalReqId) return;
        const reqId = this.activeHostModalReqId;
        this.activeHostModalReqId = null;
        const approvalModal = document.getElementById('host-approval-modal');
        approvalModal?.classList.add('hidden');
        approvalModal?.classList.remove('flex');

        try {
            await fetch(`${window.location.origin}/api/auth/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: reqId, approved }),
            });
            this.toast(approved ? 'อนุมัติให้อุปกรณ์เข้าเชื่อมต่อแล้ว' : 'ปฏิเสธคำขอเชื่อมต่อแล้ว', approved ? 'success' : 'warning');
            this.fetchLocalHostInfo();
        } catch (e) {}
    },

    async regeneratePin() {
        if (!this.isLocalHostBrowser()) {
            const newPin = String(Math.floor(100000 + Math.random() * 900000));
            localStorage.setItem('remoteme_client_self_pin', newPin);
            if (this.localSystemInfo) this.localSystemInfo.pin_code = newPin;
            this.setText('card-pin-code', newPin);
            this.toast(`รีเฟรชรหัสผ่านใหม่เรียบร้อย: ${newPin}`, 'success');
            return;
        }
        try {
            const res = await fetch(`${window.location.origin}/api/config/regenerate-pin`, { method: 'POST' });
            const data = await res.json();
            if (data.pin_code) {
                if (this.localSystemInfo) this.localSystemInfo.pin_code = data.pin_code;
                this.setText('card-pin-code', data.pin_code);
                this.toast(`รีเฟรชรหัสผ่านใหม่เรียบร้อย: ${data.pin_code}`, 'success');
            }
        } catch (e) {
            this.toast('ไม่สามารถรีเฟรชรหัสผ่านใหม่ได้', 'error');
        }
    },

    async disconnectAllSessions() {
        if (this.isLocalHostBrowser()) {
            try {
                await fetch(`${window.location.origin}/api/sessions/disconnect-all`, { method: 'POST' });
                await this.regeneratePin();
                this.toast('ตัดการเชื่อมต่อผู้ควบคุมทั้งหมดและรีเฟรชรหัสผ่านใหม่แล้ว', 'success');
                this.fetchLocalHostInfo();
            } catch (e) {}
        }
        if (this.isRemoteConnected) {
            RemoteViewer.disconnectSession();
        }
    },

    toggleTheme() {
        this.isDark = !this.isDark;
        document.body.classList.toggle('dark-theme', this.isDark);
        document.documentElement.classList.toggle('dark', this.isDark);
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
