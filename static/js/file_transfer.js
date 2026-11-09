/**
 * RemoteMe Studio - Unrestricted File Explorer & Chunked Resumable Transfer Engine
 * Supports Pause / Resume / Cancel for both Uploads & Downloads with real-time MiB/s telemetry
 */
const FileTransfer = {
    currentPath: '',
    parentPath: null,
    allItems: [],
    filteredItems: [],
    clipboardItems: [],
    clipboardAction: null, // 'copy' or 'move'
    transfers: [],         // Array of transfer task objects
    activeFilter: 'all',
    inspectedTransferId: null,
    CHUNK_SIZE: 1024 * 1024, // 1 MiB per chunk for smooth pause/resume & high throughput

    init() {
        if (!App.isDisconnected) {
            this.loadLocations();
            this.loadDirectory('');
        }
        this.renderTransferViews();

        // Update transfer speed & modal UI every 250ms
        setInterval(() => this.updateTransferMetricsUI(), 250);
    },

    clearAllData() {
        this.currentPath = '';
        this.parentPath = null;
        this.allItems = [];
        this.filteredItems = [];
        this.clipboardItems = [];
        const quickEl = document.getElementById('file-quick-locations');
        if (quickEl) quickEl.innerHTML = '';
        const driveEl = document.getElementById('file-drive-locations');
        if (driveEl) driveEl.innerHTML = '';
        const pathInput = document.getElementById('explorer-path-input');
        if (pathInput) pathInput.value = '';
        const rowsEl = document.getElementById('explorer-file-rows');
        if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-xs text-slate-400">ตัดการเชื่อมต่อแล้ว ไม่สามารถดูไฟล์ได้</td></tr>`;
    },

    formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let val = bytes;
        while (val >= 1024 && i < units.length - 1) {
            val /= 1024;
            i++;
        }
        return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    },

    formatDate(ms) {
        if (!ms) return '-';
        const d = new Date(ms);
        return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' +
               d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    },

    getCategoryIcon(cat) {
        const map = {
            folder: { icon: 'folder', color: 'text-amber-500 fill-amber-500/20' },
            image: { icon: 'image', color: 'text-pink-500' },
            video: { icon: 'film', color: 'text-purple-500' },
            audio: { icon: 'music', color: 'text-cyan-500' },
            archive: { icon: 'file-archive', color: 'text-orange-500' },
            document: { icon: 'file-text', color: 'text-blue-500' },
            code: { icon: 'file-code', color: 'text-emerald-500' },
            executable: { icon: 'cpu', color: 'text-rose-500' },
            file: { icon: 'file', color: 'text-slate-400' },
        };
        return map[cat] || map.file;
    },

    async loadLocations() {
        if (App.isDisconnected) return;
        try {
            const res = await fetch(App.getApiUrl('/api/files/locations'));
            const data = await res.json();
            const locs = data.locations || [];

            const quickEl = document.getElementById('file-quick-locations');
            const driveEl = document.getElementById('file-drive-locations');

            const shortcuts = locs.filter(l => l.type === 'shortcut');
            const drives = locs.filter(l => l.type === 'drive');

            if (quickEl) {
                quickEl.innerHTML = shortcuts.map(item => `
                    <button onclick="FileTransfer.loadDirectory(${JSON.stringify(item.path).replace(/"/g, '&quot;')})"
                        class="w-full px-3 py-2 rounded-xl hover:bg-rose-50 dark:hover:bg-slate-800 flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition text-left">
                        <i data-lucide="${item.icon || 'folder'}" class="w-4 h-4 text-rose-500 shrink-0"></i>
                        <span class="truncate">${item.name}</span>
                    </button>
                `).join('');
            }

            if (driveEl) {
                driveEl.innerHTML = drives.map(d => `
                    <div onclick="FileTransfer.loadDirectory(${JSON.stringify(d.path).replace(/"/g, '&quot;')})"
                        class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 hover:bg-rose-50/50 dark:hover:bg-slate-800 border border-slate-200/60 dark:border-slate-700 cursor-pointer transition">
                        <div class="flex items-center justify-between text-xs font-bold mb-1">
                            <span class="flex items-center gap-1.5">
                                <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-indigo-500"></i>
                                <span>${d.name}</span>
                            </span>
                            <span class="text-[10px] font-mono-num text-slate-400">${d.used_percent}%</span>
                        </div>
                        <div class="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div class="h-full bg-indigo-500 rounded-full" style="width: ${d.used_percent}%"></div>
                        </div>
                        <div class="text-[10px] text-slate-400 mt-1">ว่าง ${d.free_formatted} จาก ${d.total_formatted}</div>
                    </div>
                `).join('');
            }
            lucide.createIcons();
        } catch (e) {}
    },

    async loadDirectory(pathStr = '') {
        if (App.isDisconnected) return;
        try {
            const q = pathStr ? `?path=${encodeURIComponent(pathStr)}` : '';
            const res = await fetch(App.getApiUrl(`/api/files/list${q}`));
            if (!res.ok) {
                const err = await res.json();
                App.toast(err.detail || 'ไม่สามารถเปิดโฟลเดอร์นี้ได้', 'error');
                return;
            }
            const data = await res.json();
            this.currentPath = data.current_path;
            this.parentPath = data.parent_path;
            this.allItems = data.items || [];
            this.filteredItems = [...this.allItems];

            const pathInput = document.getElementById('explorer-path-input');
            if (pathInput) pathInput.value = this.currentPath;
            const searchInput = document.getElementById('explorer-search-input');
            if (searchInput) searchInput.value = '';

            this.renderFileList();
        } catch (e) {
            App.toast('เกิดข้อผิดพลาดในการโหลดรายการไฟล์', 'error');
        }
    },

    refreshCurrentDir() {
        this.loadDirectory(this.currentPath);
    },

    navigateUp() {
        if (this.parentPath) {
            this.loadDirectory(this.parentPath);
        }
    },

    filterFiles(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
            this.filteredItems = [...this.allItems];
        } else {
            this.filteredItems = this.allItems.filter(item => item.name.toLowerCase().includes(q));
        }
        this.renderFileList();
    },

    renderFileList() {
        const container = document.getElementById('explorer-file-list');
        if (!container) return;

        App.setText('explorer-item-count', `${this.filteredItems.length} รายการในโฟลเดอร์นี้`);

        if (this.filteredItems.length === 0) {
            container.innerHTML = `
                <div class="py-16 text-center text-slate-400">
                    <i data-lucide="folder-open" class="w-12 h-12 mx-auto mb-2 opacity-40"></i>
                    <p class="text-sm font-medium">ไม่มีไฟล์หรือโฟลเดอร์ในตำแหน่งนี้</p>
                    <p class="text-xs mt-1">ลากไฟล์จากเครื่องของคุณมาวางที่นี่เพื่ออัปโหลดได้ทันที</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        container.innerHTML = this.filteredItems.map((item) => {
            const { icon, color } = this.getCategoryIcon(item.category);
            const escapedPath = JSON.stringify(item.path).replace(/"/g, '&quot;');
            const escapedName = JSON.stringify(item.name).replace(/"/g, '&quot;');

            const clickAction = item.is_dir
                ? `FileTransfer.loadDirectory(${escapedPath})`
                : `FileTransfer.previewItem(${escapedPath}, ${escapedName}, '${item.category}')`;

            return `
                <div class="file-row grid grid-cols-12 items-center px-3.5 lg:px-5 py-2.5 text-xs group">
                    <div onclick="${clickAction}" class="col-span-7 sm:col-span-6 flex items-center gap-2.5 cursor-pointer pr-2 overflow-hidden">
                        <i data-lucide="${icon}" class="w-4 h-4 shrink-0 ${color}"></i>
                        <div class="min-w-0">
                            <div class="font-medium truncate group-hover:text-rose-600 transition">${item.name}</div>
                            <div class="sm:hidden text-[10px] text-slate-400 font-mono-num">${item.size_formatted}</div>
                        </div>
                    </div>
                    <div class="col-span-2 text-right font-mono-num text-slate-500 hidden sm:block">${item.size_formatted}</div>
                    <div class="col-span-2 text-right text-[11px] text-slate-400 hidden sm:block">${this.formatDate(item.modified)}</div>
                    <div class="col-span-5 sm:col-span-2 flex items-center justify-end gap-1">
                        <button onclick="FileTransfer.startChunkedDownload(${escapedPath}, ${escapedName}, ${item.size}, ${item.is_dir})"
                            class="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 text-rose-600 transition"
                            title="${item.is_dir ? 'ดาวน์โหลดโฟลเดอร์เป็น .zip' : 'ดาวน์โหลดไฟล์ความเร็วสูง'}">
                            <i data-lucide="download" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="FileTransfer.markClipboard('copy', ${escapedPath}, ${escapedName})"
                            class="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition"
                            title="คัดลอก (Copy)">
                            <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="FileTransfer.markClipboard('move', ${escapedPath}, ${escapedName})"
                            class="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition"
                            title="ย้าย (Cut/Move)">
                            <i data-lucide="scissors" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="FileTransfer.promptRename(${escapedPath}, ${escapedName})"
                            class="hidden sm:inline-flex p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 transition"
                            title="เปลี่ยนชื่อ (Rename)">
                            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
                        </button>
                        <button onclick="FileTransfer.deleteItem(${escapedPath}, ${escapedName})"
                            class="p-1.5 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-950 text-slate-400 hover:text-rose-600 transition"
                            title="ลบ (Delete)">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        lucide.createIcons();
    },

    // --- File System Operations (Create Folder, Rename, Copy/Move, Delete, Preview) ---
    async promptNewFolder() {
        const name = prompt('ตั้งชื่อโฟลเดอร์ใหม่:');
        if (!name || !name.trim()) return;
        try {
            const res = await fetch(App.getApiUrl('/api/files/mkdir'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_path: this.currentPath, folder_name: name.trim() }),
            });
            if (res.ok) {
                App.toast(`สร้างโฟลเดอร์ "${name.trim()}" เรียบร้อยแล้ว`, 'success');
                this.refreshCurrentDir();
            }
        } catch (e) {
            App.toast('ไม่สามารถสร้างโฟลเดอร์ได้', 'error');
        }
    },

    async promptRename(oldPath, oldName) {
        const newName = prompt(`เปลี่ยนชื่อ "${oldName}" เป็น:`, oldName);
        if (!newName || !newName.trim() || newName.trim() === oldName) return;
        try {
            const res = await fetch(App.getApiUrl('/api/files/rename'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_path: oldPath, new_name: newName.trim() }),
            });
            if (res.ok) {
                App.toast(`เปลี่ยนชื่อเป็น "${newName.trim()}" สำเร็จ`, 'success');
                this.refreshCurrentDir();
            }
        } catch (e) {
            App.toast('เปลี่ยนชื่อไม่สำเร็จ', 'error');
        }
    },

    async deleteItem(pathStr, name) {
        if (!confirm(`คุณต้องการลบ "${name}" ใช่หรือไม่?`)) return;
        try {
            const res = await fetch(App.getApiUrl('/api/files/delete'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: [pathStr] }),
            });
            if (res.ok) {
                App.toast(`ลบ "${name}" เรียบร้อยแล้ว`, 'info');
                this.refreshCurrentDir();
            } else {
                const err = await res.json();
                App.toast(err.detail || 'ลบไฟล์ไม่สำเร็จ', 'error');
            }
        } catch (e) {
            App.toast('เกิดข้อผิดพลาดในการลบไฟล์', 'error');
        }
    },

    markClipboard(action, pathStr, name) {
        this.clipboardAction = action;
        this.clipboardItems = [pathStr];
        const btn = document.getElementById('btn-paste-files');
        const label = document.getElementById('paste-btn-label');
        if (btn && label) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            label.textContent = `${action === 'move' ? 'ย้าย' : 'วาง'} "${name}" ที่นี่`;
        }
        App.toast(`เลือก${action === 'move' ? 'ตัด (ย้าย)' : 'คัดลอก'} "${name}" แล้ว เปิดโฟลเดอร์ปลายทางแล้วกดปุ่มสีส้มเพื่อวางได้เลย`, 'info');
    },

    async pasteItemsHere() {
        if (!this.clipboardItems.length || !this.clipboardAction) return;
        try {
            const res = await fetch(App.getApiUrl('/api/files/copy-move'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: this.clipboardAction,
                    sources: this.clipboardItems,
                    destination_dir: this.currentPath,
                }),
            });
            if (res.ok) {
                App.toast('ดำเนินการคัดลอก/ย้ายไฟล์สำเร็จแล้ว', 'success');
                this.clipboardItems = [];
                this.clipboardAction = null;
                document.getElementById('btn-paste-files')?.classList.add('hidden');
                this.refreshCurrentDir();
            }
        } catch (e) {
            App.toast('วางไฟล์ไม่สำเร็จ', 'error');
        }
    },

    async previewItem(pathStr, name, category) {
        const modal = document.getElementById('file-preview-modal');
        const title = document.getElementById('preview-modal-title');
        const body = document.getElementById('preview-modal-body');
        if (!modal || !body) return;

        title.textContent = name;
        const rawUrl = App.getApiUrl(`/api/files/preview?path=${encodeURIComponent(pathStr)}`);

        if (category === 'image') {
            body.innerHTML = `<img src="${rawUrl}" class="max-h-[70vh] max-w-full rounded-xl shadow-lg object-contain" />`;
        } else if (category === 'video') {
            body.innerHTML = `<video src="${App.getApiUrl(`/api/files/download?path=${encodeURIComponent(pathStr)}`)}" controls autoplay class="max-h-[70vh] max-w-full rounded-xl"></video>`;
        } else if (category === 'audio') {
            body.innerHTML = `<audio src="${App.getApiUrl(`/api/files/download?path=${encodeURIComponent(pathStr)}`)}" controls autoplay class="w-full max-w-md"></audio>`;
        } else {
            try {
                const res = await fetch(rawUrl);
                const contentType = res.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await res.json();
                    if (data.type === 'text') {
                        const escaped = data.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        body.innerHTML = `<pre class="w-full h-[65vh] p-4 rounded-xl bg-slate-950 text-slate-100 font-mono-num text-xs overflow-auto select-text">${escaped}</pre>`;
                    }
                } else {
                    // Direct download for binary files
                    this.startChunkedDownload(pathStr, name, 0, false);
                    return;
                }
            } catch (e) {
                this.startChunkedDownload(pathStr, name, 0, false);
                return;
            }
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    },

    closePreviewModal() {
        const modal = document.getElementById('file-preview-modal');
        const body = document.getElementById('preview-modal-body');
        if (body) body.innerHTML = '';
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    },

    // --- Drag & Drop and File Input Upload Triggers ---
    triggerUploadDialog() {
        const input = document.getElementById('global-file-input');
        if (input) {
            input.value = '';
            input.click();
        }
    },

    onDragOver(e) {
        e.preventDefault();
        document.getElementById('explorer-drop-zone')?.classList.add('drop-zone-active');
    },

    onDragLeave(e) {
        e.preventDefault();
        document.getElementById('explorer-drop-zone')?.classList.remove('drop-zone-active');
    },

    onDrop(e) {
        e.preventDefault();
        this.onDragLeave(e);
        if (e.dataTransfer?.files?.length) {
            this.handleSelectedFiles(e.dataTransfer.files);
        }
    },

    handleSelectedFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        files.forEach(file => this.startChunkedUpload(file));
        App.toast(`เริ่มอัปโหลด ${files.length} ไฟล์ด้วยระบบ Chunked High-Speed`, 'success');
    },

    // =========================================================================
    // RESUMABLE CHUNKED UPLOAD & DOWNLOAD ENGINE (PAUSE / RESUME / SPEED MiB/s)
    // =========================================================================
    async startChunkedUpload(file) {
        const targetDir = this.currentPath || '';
        const initRes = await fetch(App.getApiUrl('/api/files/upload/init'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: file.name,
                total_size: file.size,
                target_dir: targetDir,
            }),
        });
        if (!initRes.ok) {
            App.toast(`ไม่สามารถเริ่มอัปโหลด ${file.name} ได้`, 'error');
            return;
        }
        const session = await initRes.json();

        const task = {
            id: session.transfer_id,
            direction: 'upload',
            filename: file.name,
            fileObj: file,
            totalBytes: file.size,
            transferredBytes: session.received_bytes || 0,
            speedBps: 0,
            status: 'active', // 'active' | 'paused' | 'completed' | 'cancelled' | 'error'
            targetPath: session.final_path,
            startedAt: performance.now(),
            lastTickTime: performance.now(),
            lastTickBytes: 0,
        };

        this.transfers.unshift(task);
        this.renderTransferViews();
        this.openDetailModal(task.id);
        this.runUploadLoop(task);
    },

    async runUploadLoop(task) {
        while (task.status === 'active' && task.transferredBytes < task.totalBytes) {
            const start = task.transferredBytes;
            const end = Math.min(task.totalBytes, start + this.CHUNK_SIZE);
            const blobChunk = task.fileObj.slice(start, end);
            const t0 = performance.now();

            try {
                const res = await fetch(App.getApiUrl('/api/files/upload/chunk'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Transfer-Id': task.id,
                        'X-Chunk-Offset': String(start),
                    },
                    body: blobChunk,
                });
                if (!res.ok) throw new Error('Chunk upload failed');
                const data = await res.json();

                const dtSec = Math.max(0.005, (performance.now() - t0) / 1000);
                const chunkLen = end - start;
                task.speedBps = chunkLen / dtSec;
                task.transferredBytes = data.received_bytes;

                if (data.status === 'completed' || task.transferredBytes >= task.totalBytes) {
                    task.status = 'completed';
                    task.speedBps = 0;
                    App.toast(`อัปโหลดไฟล์ "${task.filename}" เสร็จสมบูรณ์!`, 'success');
                    this.refreshCurrentDir();
                    break;
                }
            } catch (e) {
                if (task.status === 'active') {
                    task.status = 'paused';
                    task.speedBps = 0;
                    App.toast(`การอัปโหลด "${task.filename}" หยุดชั่วคราว กดรันต่อได้ทันที`, 'warning');
                }
                break;
            }
        }
        this.renderTransferViews();
    },

    async startChunkedDownload(pathStr, filename, totalSize, isDir) {
        // If directory or very small file (<2MB), trigger direct browser download or chunked range fetch
        if (isDir) {
            App.toast(`กำลังบีบอัดโฟลเดอร์ "${filename}.zip" และดาวน์โหลด...`, 'info');
            window.open(App.getApiUrl(`/api/files/download?path=${encodeURIComponent(pathStr)}`), '_blank');
            return;
        }

        const tid = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const task = {
            id: tid,
            direction: 'download',
            filename: filename,
            remotePath: pathStr,
            totalBytes: Math.max(1, totalSize),
            transferredBytes: 0,
            chunks: [],
            speedBps: 0,
            status: 'active',
            startedAt: performance.now(),
        };

        this.transfers.unshift(task);
        this.renderTransferViews();
        this.openDetailModal(task.id);
        this.runDownloadLoop(task);
    },

    async runDownloadLoop(task) {
        const url = App.getApiUrl(`/api/files/download?path=${encodeURIComponent(task.remotePath)}`);
        while (task.status === 'active' && task.transferredBytes < task.totalBytes) {
            const start = task.transferredBytes;
            const end = Math.min(task.totalBytes - 1, start + this.CHUNK_SIZE - 1);
            const t0 = performance.now();

            try {
                const res = await fetch(url, {
                    headers: { 'Range': `bytes=${start}-${end}` },
                });
                if (!res.ok && res.status !== 206) throw new Error('Download range error');
                const buf = await res.arrayBuffer();
                task.chunks.push(new Uint8Array(buf));

                const dtSec = Math.max(0.005, (performance.now() - t0) / 1000);
                task.speedBps = buf.byteLength / dtSec;
                task.transferredBytes += buf.byteLength;

                if (task.transferredBytes >= task.totalBytes || buf.byteLength === 0) {
                    task.status = 'completed';
                    task.speedBps = 0;

                    // Assemble Blob and trigger browser save
                    const finalBlob = new Blob(task.chunks);
                    task.chunks = []; // free memory
                    const blobUrl = URL.createObjectURL(finalBlob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = task.filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

                    App.toast(`ดาวน์โหลด "${task.filename}" เสร็จสมบูรณ์!`, 'success');
                    break;
                }
            } catch (e) {
                if (task.status === 'active') {
                    task.status = 'paused';
                    task.speedBps = 0;
                    App.toast(`พักการดาวน์โหลด "${task.filename}" ชั่วคราว`, 'warning');
                }
                break;
            }
        }
        this.renderTransferViews();
    },

    togglePauseResume(transferId, evt) {
        if (evt) evt.stopPropagation();
        const task = this.transfers.find(t => t.id === transferId);
        if (!task) return;

        if (task.status === 'active') {
            task.status = 'paused';
            task.speedBps = 0;
            App.toast(`หยุดชั่วคราว (Paused): ${task.filename}`, 'info');
        } else if (task.status === 'paused') {
            task.status = 'active';
            App.toast(`กำลังทำต่อ (Resuming): ${task.filename}`, 'success');
            if (task.direction === 'upload') {
                this.runUploadLoop(task);
            } else {
                this.runDownloadLoop(task);
            }
        }
        this.renderTransferViews();
        this.updateDetailModalUI();
    },

    async cancelTransfer(transferId, evt) {
        if (evt) evt.stopPropagation();
        const idx = this.transfers.findIndex(t => t.id === transferId);
        if (idx === -1) return;
        const task = this.transfers[idx];
        task.status = 'cancelled';
        task.speedBps = 0;
        task.chunks = [];

        if (task.direction === 'upload') {
            try {
                await fetch(App.getApiUrl('/api/files/upload/cancel'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transfer_id: task.id }),
                });
            } catch (e) {}
        }

        this.transfers.splice(idx, 1);
        if (this.inspectedTransferId === transferId) {
            this.closeDetailModal();
        }
        this.renderTransferViews();
        App.toast(`ยกเลิกการโอนย้าย "${task.filename}" แล้ว`, 'info');
    },

    clearCompletedTransfers() {
        this.transfers = this.transfers.filter(t => t.status === 'active' || t.status === 'paused');
        this.renderTransferViews();
    },

    setFilter(f) {
        this.activeFilter = f;
        ['all', 'active', 'completed'].forEach(k => {
            const btn = document.getElementById(`tm-filter-${k}`);
            if (btn) {
                btn.className = k === f
                    ? 'px-3 py-1.5 rounded-lg bg-rose-600 text-white'
                    : 'px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500';
            }
        });
        this.renderTransferViews();
    },

    updateTransferMetricsUI() {
        const activeTasks = this.transfers.filter(t => t.status === 'active');
        const completedTasks = this.transfers.filter(t => t.status === 'completed');
        const totalSpeedBps = activeTasks.reduce((acc, t) => acc + (t.speedBps || 0), 0);
        const speedMib = (totalSpeedBps / (1024 * 1024)).toFixed(1);

        App.setText('dash-transfer-speed', `${speedMib} MiB/s`);
        App.setText('dash-completed-transfers', `สำเร็จ ${completedTasks.length} รายการ`);
        App.setText('tm-active-count', String(activeTasks.length).padStart(2, '0'));
        App.setText('tm-total-speed', `${speedMib} MiB/s`);
        App.setText('tm-completed-count', String(completedTasks.length).padStart(2, '0'));

        const badge = document.getElementById('nav-transfer-badge');
        if (badge) {
            if (activeTasks.length > 0) {
                badge.textContent = String(activeTasks.length);
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        if (activeTasks.length > 0) {
            this.renderTransferViews();
        }
        if (this.inspectedTransferId) {
            this.updateDetailModalUI();
        }
    },

    renderTransferRowHTML(task) {
        const pct = task.totalBytes > 0 ? Math.min(100, (task.transferredBytes / task.totalBytes) * 100) : 0;
        const speedMib = (task.speedBps / (1024 * 1024)).toFixed(1);
        const isUp = task.direction === 'upload';

        let statusBadge = '';
        if (task.status === 'completed') {
            statusBadge = `<span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-600 font-semibold text-[11px]">เสร็จสมบูรณ์</span>`;
        } else if (task.status === 'paused') {
            statusBadge = `<span class="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-600 font-semibold text-[11px]">หยุดชั่วคราว</span>`;
        } else {
            statusBadge = `<span class="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-600 font-mono-num font-semibold text-[11px]">${speedMib} MiB/s</span>`;
        }

        return `
            <div onclick="FileTransfer.openDetailModal('${task.id}')"
                class="p-3.5 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 hover:border-rose-400 cursor-pointer transition flex items-center justify-between gap-4">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                    <div class="w-10 h-10 rounded-xl ${isUp ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/50' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50'} flex items-center justify-center shrink-0">
                        <i data-lucide="${isUp ? 'upload-cloud' : 'download-cloud'}" class="w-5 h-5"></i>
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-xs font-bold truncate pr-2">${task.filename}</span>
                            <span class="text-[11px] font-mono-num text-slate-400 shrink-0">${this.formatBytes(task.transferredBytes)} / ${this.formatBytes(task.totalBytes)} (${pct.toFixed(1)}%)</span>
                        </div>
                        <div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div class="h-full ${task.status === 'completed' ? 'bg-emerald-500' : (task.status === 'paused' ? 'bg-amber-500' : 'bg-rose-600 progress-animated')} rounded-full transition-all duration-150" style="width: ${pct}%"></div>
                        </div>
                    </div>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                    ${statusBadge}
                    ${task.status !== 'completed' ? `
                        <button onclick="FileTransfer.togglePauseResume('${task.id}', event)"
                            class="px-3 py-1.5 rounded-xl text-xs font-bold ${task.status === 'paused' ? 'bg-emerald-600 text-white' : 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'} transition">
                            ${task.status === 'paused' ? 'รันต่อ' : 'หยุดพัก'}
                        </button>
                        <button onclick="FileTransfer.cancelTransfer('${task.id}', event)"
                            class="p-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-rose-100 text-slate-400 hover:text-rose-600 transition" title="ยกเลิก">
                            <i data-lucide="x" class="w-4 h-4"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    },

    renderTransferViews() {
        const dashPreview = document.getElementById('dash-transfer-preview');
        const tmList = document.getElementById('tm-transfer-list');

        let list = this.transfers;
        if (this.activeFilter === 'active') {
            list = list.filter(t => t.status === 'active' || t.status === 'paused');
        } else if (this.activeFilter === 'completed') {
            list = list.filter(t => t.status === 'completed');
        }

        const emptyHTML = `
            <div class="py-10 text-center text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
                <p class="text-xs font-medium">ยังไม่มีรายการโอนย้ายไฟล์ในขณะนี้</p>
                <p class="text-[11px] mt-0.5">คลิกปุ่ม "+ เลือกไฟล์ส่งด่วน" หรือลากไฟล์มาวางเพื่อเริ่มโอนย้ายความเร็วสูง</p>
            </div>
        `;

        if (dashPreview) {
            dashPreview.innerHTML = this.transfers.length
                ? this.transfers.slice(0, 4).map(t => this.renderTransferRowHTML(t)).join('')
                : emptyHTML;
        }
        if (tmList) {
            tmList.innerHTML = list.length
                ? list.map(t => this.renderTransferRowHTML(t)).join('')
                : emptyHTML;
        }
        lucide.createIcons();
    },

    // --- Detailed Transfer Inspector Modal (Screenshot Right-Side Window) ---
    openDetailModal(transferId) {
        this.inspectedTransferId = transferId;
        const modal = document.getElementById('transfer-detail-modal');
        modal?.classList.remove('hidden');
        modal?.classList.add('flex');
        this.updateDetailModalUI();
    },

    closeDetailModal() {
        this.inspectedTransferId = null;
        const modal = document.getElementById('transfer-detail-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    },

    updateDetailModalUI() {
        if (!this.inspectedTransferId) return;
        const task = this.transfers.find(t => t.id === this.inspectedTransferId);
        if (!task) return;

        const pct = task.totalBytes > 0 ? Math.min(100, (task.transferredBytes / task.totalBytes) * 100) : 0;
        const remBytes = Math.max(0, task.totalBytes - task.transferredBytes);
        const speedMib = (task.speedBps / (1024 * 1024)).toFixed(1);
        const etaSec = task.speedBps > 0 ? Math.ceil(remBytes / task.speedBps) : 0;

        App.setText('modal-tf-id', `ID: ${task.id}`);
        App.setText('modal-tf-filename', task.filename);
        App.setText('modal-tf-percent', `${pct.toFixed(1)}%`);
        App.setText('modal-tf-transferred', this.formatBytes(task.transferredBytes));
        App.setText('modal-tf-remaining', this.formatBytes(remBytes));
        App.setText('modal-tf-speed', `${speedMib} MiB/s`);
        App.setText('modal-tf-eta', task.status === 'completed' ? 'เสร็จสิ้น' : (etaSec > 0 ? `${etaSec} วินาที` : '-- วินาที'));

        const bar = document.getElementById('modal-tf-bar');
        if (bar) bar.style.width = `${pct}%`;

        const badge = document.getElementById('modal-tf-status-badge');
        if (badge) {
            if (task.status === 'completed') {
                badge.textContent = 'โอนย้ายเสร็จสมบูรณ์';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-600 text-white';
            } else if (task.status === 'paused') {
                badge.textContent = 'หยุดชั่วคราว (Paused)';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500 text-white';
            } else {
                badge.textContent = task.direction === 'upload' ? 'กำลังอัปโหลดความเร็วสูง' : 'กำลังดาวน์โหลดความเร็วสูง';
                badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-600 text-white';
            }
        }

        const btnToggle = document.getElementById('modal-btn-toggle');
        const btnCancel = document.getElementById('modal-btn-cancel');
        if (btnToggle && btnCancel) {
            btnCancel.onclick = (e) => this.cancelTransfer(task.id, e);
            if (task.status === 'completed') {
                btnToggle.textContent = 'ปิดหน้าต่าง';
                btnToggle.onclick = () => this.closeDetailModal();
            } else if (task.status === 'paused') {
                btnToggle.textContent = 'รันต่อทันที (Resume)';
                btnToggle.onclick = (e) => this.togglePauseResume(task.id, e);
            } else {
                btnToggle.textContent = 'หยุดชั่วคราว (Pause)';
                btnToggle.onclick = (e) => this.togglePauseResume(task.id, e);
            }
        }
    }
};
