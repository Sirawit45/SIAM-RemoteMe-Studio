/**
 * RemoteMe Studio - Core Application Controller
 */
const App = {
    currentTab: 'dashboard',
    targetOrigin: window.location.origin,
    systemInfo: null,
    isDark: false,
    pollTimer: null,

    init() {
        lucide.createIcons();
        if (sessionStorage.getItem('remoteme_disconnected') === '1') {
            FileTransfer.init();
            RemoteViewer.init();
            this.enterDisconnectedState();
            return;
        }
        this.loadSavedHost();
        this.fetchSystemInfo();
        this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);

        // Initialize sub-modules
        FileTransfer.init();
        RemoteViewer.init();
    },

    getApiUrl(path) {
        return `${this.targetOrigin}${path}`;
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
            localStorage.setItem('remoteme_saved_device_id', queryId);
            setTimeout(() => this.connectToTargetHost(), 200);
            return;
        }

        // If opened on the permanent GitHub Pages Mobile App Portal, auto-connect to last saved Device ID
        if (window.location.hostname.endsWith('github.io')) {
            const savedId = localStorage.getItem('remoteme_saved_device_id');
            if (savedId) {
                const input = document.getElementById('remote-host-input');
                if (input) input.value = savedId;
                setTimeout(() => this.connectToTargetHost(), 200);
                return;
            }
        }

        const saved = sessionStorage.getItem('remoteme_target_origin');
        if (saved && saved !== window.location.origin) {
            this.targetOrigin = saved;
            const input = document.getElementById('remote-host-input');
            if (input) input.value = saved.replace(/^https?:\/\//, '');
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

    async connectToTargetHost() {
        const raw = document.getElementById('remote-host-input')?.value.trim();
        if (!raw) {
            this.toast('กรุณาใส่รหัสเครื่อง 9 หลัก (เช่น 123 456 789) หรือลิงก์/IP เครื่องปลายทาง', 'warning');
            return;
        }

        // Check if input is a 9-digit Device ID
        const digitsOnly = raw.replace(/[^0-9]/g, '');
        if (digitsOnly.length === 9 && !raw.includes('.') && !raw.includes(':')) {
            const formattedId = `${digitsOnly.slice(0,3)}-${digitsOnly.slice(3,6)}-${digitsOnly.slice(6)}`;
            localStorage.setItem('remoteme_saved_device_id', formattedId);
            this.toast(`กำลังค้นหาเครื่องรหัส ${formattedId} บนเครือข่ายอินเทอร์เน็ตทั่วโลก...`, 'info');
            try {
                const record = await this.resolveDeviceIdClientSide(digitsOnly);
                if (!record || !record.public_url) {
                    this.toast('ไม่พบรหัสเครื่องนี้ออนไลน์อยู่ กรุณาตรวจสอบว่าเปิดโปรแกรมที่เครื่องปลายทางแล้ว', 'error');
                    return;
                }
                this.applyTargetOrigin(record.public_url, record.device_name);
                return;
            } catch (e) {
                this.toast('ไม่สามารถค้นหารหัสเครื่องผ่านอินเทอร์เน็ตได้', 'error');
                return;
            }
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
        this.applyTargetOrigin(formatted.replace(/\/+$/, ''));
    },

    applyTargetOrigin(originUrl, label = '') {
        this.exitDisconnectedState();
        this.targetOrigin = originUrl;
        sessionStorage.setItem('remoteme_target_origin', this.targetOrigin);
        document.getElementById('btn-reset-localhost')?.classList.remove('hidden');

        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);
        }

        this.toast(`กำลังเชื่อมต่อเครื่องปลายทาง ${label ? `(${label})` : ''}: ${this.targetOrigin}`, 'success');
        this.fetchSystemInfo();
        FileTransfer.loadLocations();
        FileTransfer.loadDirectory('');
        RemoteViewer.reconnect();
    },

    resetToLocalHost() {
        this.exitDisconnectedState();
        this.targetOrigin = window.location.origin;
        sessionStorage.removeItem('remoteme_target_origin');
        const input = document.getElementById('remote-host-input');
        if (input) input.value = '';
        document.getElementById('btn-reset-localhost')?.classList.add('hidden');
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);
        }
        this.toast('สลับกลับมาเชื่อมต่อเครื่องปัจจุบันแล้ว', 'success');
        this.fetchSystemInfo();
        FileTransfer.loadLocations();
        FileTransfer.loadDirectory('');
        RemoteViewer.reconnect();
    },

    reconnectFromLockScreen() {
        const lockInput = document.getElementById('reconnect-host-input')?.value.trim();
        const headerInput = document.getElementById('remote-host-input');
        if (lockInput && headerInput) {
            headerInput.value = lockInput;
        }
        this.exitDisconnectedState();
        if (headerInput && headerInput.value.trim()) {
            this.connectToTargetHost();
        } else {
            if (!this.pollTimer) {
                this.pollTimer = setInterval(() => this.fetchSystemInfo(), 2500);
            }
            this.fetchSystemInfo();
            FileTransfer.loadLocations();
            FileTransfer.loadDirectory('');
            RemoteViewer.reconnect();
        }
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

    enterDisconnectedState() {
        this.isDisconnected = true;
        this.systemInfo = null;
        sessionStorage.setItem('remoteme_disconnected', '1');
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        sessionStorage.removeItem('remoteme_target_origin');

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
        if (wanUrlEl) wanUrlEl.textContent = 'ตัดการเชื่อมต่อแล้ว — กรุณาใส่รหัส 9 หลักด้านบนแล้วกด "เชื่อมต่อ"';
        if (wanDotEl) wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';

        const urlList = document.getElementById('network-url-list');
        if (urlList) {
            urlList.innerHTML = '';
        }
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
            this.toast('ตัดการเชื่อมต่อแล้ว กรุณากดเชื่อมต่อใหม่ก่อนเข้าใช้งาน', 'warning');
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

        // On mobile screens, hide the top header when in Remote Desktop tab to maximize screen area
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

        const formattedId = (data.device_id || '').replace(/-/g, ' ');
        this.setText('sidebar-device-id', formattedId);
        this.setText('card-device-id', formattedId);
        this.setText('header-device-name', `${data.device_name} (${data.os_name})`);
        this.setText('card-os-info', `${data.os_name} (${data.os_arch}) • ${data.cpu_cores} Cores`);
        this.setText('card-pin-code', data.pin_code || '------');

        this.setText('sidebar-sys-load', `${data.cpu_percent}% / ${data.ram_percent}%`);
        this.setText('meter-cpu-text', `${data.cpu_percent}%`);
        this.setText('meter-ram-text', `${data.ram_used_gb} / ${data.ram_total_gb} GB (${data.ram_percent}%)`);

        const cpuBar = document.getElementById('meter-cpu-bar');
        if (cpuBar) cpuBar.style.width = `${Math.max(4, data.cpu_percent)}%`;
        const ramBar = document.getElementById('meter-ram-bar');
        if (ramBar) ramBar.style.width = `${Math.max(4, data.ram_percent)}%`;

        const activeCount = Math.max(1, (data.sessions || []).length);
        this.setText('dash-active-sessions', String(activeCount).padStart(2, '0'));

        const reqPinToggle = document.getElementById('toggle-require-pin');
        if (reqPinToggle && document.activeElement !== reqPinToggle) {
            reqPinToggle.checked = !!data.config?.require_pin;
        }

        // Render Global Internet (WAN) Tunnel state
        const wan = data.wan || {};
        const wanUrlEl = document.getElementById('wan-public-url');
        const wanDotEl = document.getElementById('wan-status-dot');
        if (wanUrlEl && wanDotEl) {
            if (wan.status === 'online' && wan.public_url) {
                wanUrlEl.textContent = wan.public_url;
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
            } else if (wan.status === 'starting' || wan.status === 'downloading') {
                wanUrlEl.textContent = 'กำลังเชื่อมต่ออุโมงค์คลาวด์ระดับโลก (ใช้เวลาประมาณ 3-6 วินาที)...';
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
            } else {
                wanUrlEl.textContent = wan.error_msg || 'คลิกปุ่ม "รีเฟรชลิงก์โลก" เพื่อเปิดใช้งานลิงก์ควบคุมข้ามอินเทอร์เน็ต';
                wanDotEl.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
            }
        }

        // Populate Network Access URLs
        const urlList = document.getElementById('network-url-list');
        if (urlList && Array.isArray(data.addresses)) {
            urlList.innerHTML = data.addresses.map(addr => `
                <div onclick="App.copyText('${addr.url}')" class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 hover:bg-rose-50/60 dark:hover:bg-slate-800 border border-slate-200/70 dark:border-slate-700 cursor-pointer transition group">
                    <div class="flex items-center gap-2.5">
                        <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${addr.url.startsWith('https://') ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'}">${addr.type}</span>
                        <span class="font-mono-num text-xs font-semibold text-slate-700 dark:text-slate-200">${addr.url}</span>
                    </div>
                    <span class="text-[11px] text-rose-600 opacity-80 group-hover:opacity-100 flex items-center gap-1 font-medium">
                        คัดลอกลิงก์
                    </span>
                </div>
            `).join('');
        }

        // Sync settings form if not focused
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

        // Update Monitors dropdown in Remote Viewer
        if (Array.isArray(data.monitors)) {
            RemoteViewer.updateMonitorList(data.monitors);
        }
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
        RemoteViewer.disconnectSession();
        this.toast('ตัดการเชื่อมต่ออุปกรณ์ทั้งหมดและล้างข้อมูลเซสชันแล้ว', 'success');
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
        const url = this.systemInfo?.wan?.public_url || (this.systemInfo?.addresses?.[0]?.url) || window.location.origin;
        const qrImg = document.getElementById('qr-code-img');
        if (qrImg) {
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;
        }
        this.setText('qr-device-id', (this.systemInfo?.device_id || '').replace(/-/g, ' '));
        this.setText('qr-pin-code', this.systemInfo?.pin_code || '------');
        this.setText('qr-url-text', url);

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
