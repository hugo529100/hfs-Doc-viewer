'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

exports.version = 7.2;
exports.apiRequired = 8.87;
exports.repo = "Hug3O/Doc-viewer";
exports.description = "Text editor with fullscreen dialog, saved versions, unified timeline, VSCode theme. Metadata lives next to the file in cache/docviewer/, keyed by filename (no hashes).";

exports.frontend_js = ['editor.js', 'theme.js', 'main.js'];
exports.frontend_css = ['style.css'];

const DEFAULT_EDITABLE_EXTS = [
    '.txt', '.log', '.nfo', '.readme', '.rtf', '.md', '.markdown', '.tex',
    '.json', '.xml', '.csv', '.tsv', '.yml', '.yaml', '.ini', '.cfg', '.conf',
    '.config', '.properties', '.env', '.toml', '.lock', '.srt', '.vtt', '.ass',
    '.ssa', '.sub', '.template', '.spec', '.webapp', '.arg', '.gitignore',
    '.gitattributes', '.editorconfig', '.dockerignore', '.gradle', '.makefile',
    '.mk', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.ts',
    '.jsx', '.tsx', '.py', '.rb', '.php', '.pl', '.lua', '.sh', '.bash', '.zsh',
    '.fish', '.bat', '.cmd', '.ps1', '.c', '.h', '.cpp', '.hpp', '.cc', '.hxx',
    '.java', '.kt', '.swift', '.go', '.rs', '.sql', '.graphql', '.gql',
    '.gcode',
];

exports.config = {
    editableExts: {
        frontend: true,
        type: 'string',
        label: 'Editable file extensions',
        defaultValue: DEFAULT_EDITABLE_EXTS.join(', '),
        helperText: 'Comma-separated list (e.g. ".txt, .md"). Leave empty to disable all. html/htm/xhtml are excluded by default to let the browser open them natively.',
    },
    limitMB: { frontend: true, type: 'number', label: 'Limit MB', defaultValue: 2, min: 0 },
    encoding: {
        frontend: true, type: 'select', label: 'Default Encoding', defaultValue: 'utf-8',
        options: [
            { value: 'utf-8', label: 'UTF-8' },
            { value: 'big5', label: 'Big5 (ANSI)' },
            { value: 'gbk', label: 'GBK (ANSI)' },
            { value: 'latin1', label: 'Latin-1 (ANSI)' },
        ],
    },

    // ===== 總開關：關閉後以下所有選項都隱藏，且不產生任何 cache 文件 =====
    autoBackup: {
        frontend: true,
        type: 'boolean',
        label: 'Enable cache (versions, drafts, backups)',
        defaultValue: true,
        helperText: 'Master switch. When OFF: no cache folder is created, no versions, no drafts, no physical backups, no action log. The editor becomes a plain read/edit/save tool.',
    },

    // ===== 以下選項只在 autoBackup 開啟時顯示 =====
    versionHistoryLimit: {
        showIf: x => x.autoBackup !== false,
        frontend: true, type: 'number', label: 'Version History Limit (unlocked)',
        defaultValue: 10, min: 1, max: 200,
        helperText: 'Maximum number of unlocked versions kept per file. Locked/starred versions are never rotated out.',
    },
    draftSnapshotLimit: {
        showIf: x => x.autoBackup !== false,
        frontend: true, type: 'number', label: 'Draft Snapshot Limit',
        defaultValue: 10, min: 1, max: 100,
    },
    draftSnapshotInterval: {
        showIf: x => x.autoBackup !== false,
        frontend: true, type: 'number', label: 'Draft Snapshot Interval (minutes)',
        defaultValue: 5, min: 1, max: 120,
    },
    actionLogLimit: {
        showIf: x => x.autoBackup !== false,
        frontend: true, type: 'number', label: 'Action Log Limit',
        defaultValue: 200, min: 10, max: 2000,
    },
    draftTTLDays: {
        showIf: x => x.autoBackup !== false,
        frontend: true, type: 'number', label: 'Draft TTL (days)',
        defaultValue: 7, min: 1, max: 365,
    },
};

exports.changelog = [
    { version: 7.2, message: "autoBackup is now the master switch: when OFF, no cache folder is created at all (no versions/drafts/actions/physical backups). Related options are hidden. Orphan sweep is now built-in (no longer configurable)." },
    { version: 7.1, message: "Metadata directories are now keyed by filename (not MD5). Orphan cleanup and manual inspection are trivial: the directory name IS the filename." },
    { version: 7.0, message: "Metadata lives next to the file in cache/docviewer/, not in storage/. Lazy cleanup on file open. Version content is plain UTF-8 text, no more base64." },
    { version: 6.9, message: "Editable extensions are now configurable (html/htm/xhtml excluded by default to preserve native browser preview)." },
    { version: 6.8, message: "Add saveEncoded API for ANSI (GBK/Big5/Latin-1) saving via iconv-lite." },
];

function parseEditableExts(rawValue) {
    if (rawValue == null) return DEFAULT_EDITABLE_EXTS.slice();
    if (Array.isArray(rawValue)) {
        return rawValue
            .map(x => String(x).trim().toLowerCase())
            .filter(Boolean)
            .map(x => x.startsWith('.') ? x : '.' + x);
    }
    if (typeof rawValue !== 'string') return DEFAULT_EDITABLE_EXTS.slice();
    const trimmed = rawValue.trim();
    if (!trimmed) return [];
    return trimmed
        .split(/[\s,;]+/)
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
        .map(x => x.startsWith('.') ? x : '.' + x);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function safeDirName(fileName) {
    if (!fileName) return '_';
    let name = String(fileName);
    const lastDot = name.lastIndexOf('.');
    let base = lastDot > 0 ? name.substring(0, lastDot) : name;
    let ext = lastDot > 0 ? name.substring(lastDot) : '';
    const invalid = /[\x00-\x1F\x7F/\\:*?"<>|]/g;
    base = base.replace(invalid, '_');
    ext = ext.replace(invalid, '_');
    if (WIN_RESERVED.test(base)) base = '_' + base;
    if (!base) base = '_';
    let result = base + ext;
    if (result.length > 180) {
        const hash = crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
        result = result.slice(0, 160) + '~' + hash + ext;
    }
    return result;
}

exports.init = async api => {
    const path = api.require('path');
    const fs = api.require('fs');
    const fsp = api.require('fs/promises');
    const crypto = api.require('crypto');

    let iconv = null;
    try { iconv = api.require('iconv-lite'); }
    catch (e) { try { iconv = require('iconv-lite'); } catch (e2) { iconv = null; } }

    function encodeWithEncoding(str, enc) {
        const e = String(enc || 'utf-8').toLowerCase();
        if (e === 'utf-8' || e === 'utf8') return Buffer.from(str, 'utf8');
        if (iconv && iconv.encodingExists && iconv.encodingExists(e)) {
            try { return iconv.encode(str, e); } catch (err) {}
        }
        if (e === 'latin1' || e === 'iso-8859-1' || e === 'windows-1252') {
            const buf = Buffer.alloc(str.length);
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                buf[i] = code < 256 ? code : 63;
            }
            return buf;
        }
        return null;
    }

    function getEditableExts() {
        return parseEditableExts(api.getConfig('editableExts'));
    }
    function isDocFile(filePath) {
        if (!filePath) return false;
        const dotIdx = filePath.lastIndexOf('.');
        if (dotIdx < 0) return false;
        const ext = filePath.substring(dotIdx).toLowerCase();
        return getEditableExts().includes(ext);
    }

    // ===== 總開關：所有 cache 相關操作入口都先檢查 =====
    function isCacheEnabled() {
        return api.getConfig('autoBackup') !== false;
    }

    const API_BASE = '/~/api/doc-viewer/';

    const STORAGE_MAP_FILE = path.join(api.storageDir, 'pathmap.json');
    await fsp.mkdir(api.storageDir, { recursive: true }).catch(() => {});

    // ============================================================
    // pathMap 持久化
    // ============================================================
    const pathMap = new Map();

    async function loadPathMap() {
        try {
            const raw = await fsp.readFile(STORAGE_MAP_FILE, 'utf8');
            const obj = JSON.parse(raw);
            for (const [k, v] of Object.entries(obj)) pathMap.set(k, v);
        } catch {}
    }
    async function savePathMap() {
        try {
            const obj = {};
            for (const [k, v] of pathMap) obj[k] = v;
            await fsp.writeFile(STORAGE_MAP_FILE, JSON.stringify(obj, null, 2), 'utf8');
        } catch {}
    }
    await loadPathMap();

    function recordPathMap(urlDir, realDir) {
        if (!urlDir || !realDir) return;
        const decoded = safeDecode(urlDir);
        const realWithSep = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
        if (pathMap.get(decoded) !== realWithSep) {
            pathMap.set(decoded, realWithSep);
            savePathMap().catch(() => {});
        }
    }

    function safeDecode(s) {
        if (!s) return '';
        try { return decodeURIComponent(s); }
        catch (e) { return s; }
    }
    function contentHash(buf) {
        return crypto.createHash('md5').update(buf).digest('hex');
    }
    function timeString(d = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // ============================================================
    // 從 URI 解析物理路徑
    // ============================================================
    function realPathFromUri(uri) {
        if (!uri) return null;
        const decoded = safeDecode(uri.split('?')[0].split('#')[0]);
        const lastSlash = decoded.lastIndexOf('/');
        if (lastSlash < 0) return null;
        const urlDir = decoded.substring(0, lastSlash + 1);
        const fileName = decoded.substring(lastSlash + 1);
        let bestMatch = null, bestLen = 0;
        for (const [urlPrefix, diskDir] of pathMap) {
            if (urlDir.startsWith(urlPrefix) && urlPrefix.length > bestLen) {
                const rel = urlDir.substring(urlPrefix.length);
                bestMatch = path.join(diskDir, rel ? rel.split('/').join(path.sep) : '', fileName);
                bestLen = urlPrefix.length;
            }
        }
        return bestMatch;
    }

    // 只在 cache 開啟時才創建 cacheRoot
    async function resolveCacheRootByUri(uri) {
        if (!isCacheEnabled()) return null;
        const realPath = realPathFromUri(uri);
        if (!realPath) return null;
        const realDir = path.dirname(realPath);
        if (!fs.existsSync(realDir)) return null;
        const cacheRoot = path.join(realDir, 'cache', 'docviewer');
        try {
            await fsp.mkdir(cacheRoot, { recursive: true });
        } catch {
            return null;
        }
        return cacheRoot;
    }

    function fileNameFromUri(uri) {
        if (!uri) return '';
        const decoded = safeDecode(uri.split('?')[0].split('#')[0]);
        const lastSlash = decoded.lastIndexOf('/');
        return lastSlash < 0 ? decoded : decoded.substring(lastSlash + 1);
    }

    function safeKey(uri) {
        return safeDirName(fileNameFromUri(uri));
    }

    function versionsDir(cacheRoot, uri) {
        return path.join(cacheRoot, 'versions', safeKey(uri));
    }
    function draftsDir(cacheRoot, uri) {
        return path.join(cacheRoot, 'drafts', safeKey(uri));
    }
    function actionsFile(cacheRoot, uri) {
        return path.join(cacheRoot, 'actions', safeKey(uri) + '.json');
    }

    // ============================================================
    // 物理備份（cache/docbak）
    // ============================================================
    async function copyFileRetry(src, dst) {
        try {
            await fsp.copyFile(src, dst);
        } catch (e) {
            if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
            await new Promise(r => setTimeout(r, 3000));
            await fsp.copyFile(src, dst);
        }
    }
    async function backupFilePhysical(realPath) {
        if (!isCacheEnabled()) return;
        try {
            if (!fs.existsSync(realPath)) return;
            const realDir = path.dirname(realPath);
            const cacheDir = path.join(realDir, 'cache', 'docbak');
            await fsp.mkdir(cacheDir, { recursive: true });
            const base = path.basename(realPath, path.extname(realPath));
            const safe = base.replace(/[^\w.-]+/g, '_').slice(0, 100);
            const ext = path.extname(realPath) || '.txt';
            const dst = path.join(cacheDir, `${safe}_backup_${timeString()}${ext}`);
            await copyFileRetry(realPath, dst);
        } catch (e) {}
    }

    // ============================================================
    // 版本歷史
    // ============================================================
    async function loadVersionIndex(cacheRoot, uri) {
        const dir = versionsDir(cacheRoot, uri);
        try {
            const raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
            const idx = JSON.parse(raw);
            idx.uri = uri;
            idx.versions = idx.versions || [];
            return idx;
        } catch {
            return { uri, versions: [] };
        }
    }
    async function saveVersionIndex(cacheRoot, uri, idx) {
        const dir = versionsDir(cacheRoot, uri);
        await fsp.mkdir(dir, { recursive: true }).catch(() => {});
        await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
    }

    async function recordVersionFromContent(uri, content) {
        if (!isCacheEnabled()) return { ok: false, reason: 'cache disabled' };
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) return { ok: false, reason: 'no cache root; open the file through the browser first' };

        const buf = Buffer.from(content, 'utf8');
        const ch = contentHash(buf);
        const idx = await loadVersionIndex(cacheRoot, uri);

        const last = idx.versions[idx.versions.length - 1];
        if (last && last.contentHash === ch) {
            return { ok: true, skipped: true };
        }

        const id = String(Date.now()) + '_' + crypto.randomBytes(3).toString('hex');
        const dir = versionsDir(cacheRoot, uri);
        await fsp.mkdir(dir, { recursive: true }).catch(() => {});

        await fsp.writeFile(path.join(dir, id + '.txt'), content, 'utf8');

        idx.versions.push({
            id,
            contentHash: ch,
            timestamp: Date.now(),
            size: buf.length,
            label: null,
            starred: false,
            locked: false,
        });

        const limit = Math.max(1, api.getConfig('versionHistoryLimit') || 10);
        const unlocked = idx.versions.filter(v => !v.locked && !v.starred);
        if (unlocked.length > limit) {
            const toRemove = unlocked.slice(0, unlocked.length - limit);
            const removeIds = new Set(toRemove.map(v => v.id));
            for (const v of toRemove) {
                try { await fsp.unlink(path.join(dir, v.id + '.txt')); } catch {}
            }
            idx.versions = idx.versions.filter(v => !removeIds.has(v.id));
        }

        await saveVersionIndex(cacheRoot, uri, idx);
        await appendAction(cacheRoot, uri, { type: 'save', size: buf.length, versionId: id });
        return { ok: true, id };
    }

    async function getVersionContent(uri, id) {
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) throw new Error('no cache root');
        const dir = versionsDir(cacheRoot, uri);
        return await fsp.readFile(path.join(dir, id + '.txt'), 'utf8');
    }

    // ============================================================
    // 草稿
    // ============================================================
    async function saveDraft(uri, content) {
        if (!isCacheEnabled()) return;
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) return;
        try {
            const dir = draftsDir(cacheRoot, uri);
            await fsp.mkdir(dir, { recursive: true }).catch(() => {});
            const ch = contentHash(Buffer.from(content, 'utf8'));
            const now = Date.now();

            await fsp.writeFile(path.join(dir, 'current.txt'), content, 'utf8');
            await fsp.writeFile(path.join(dir, 'current.meta.json'), JSON.stringify({
                uri, contentHash: ch, timestamp: now, size: Buffer.byteLength(content, 'utf8'),
            }), 'utf8');

            const intervalMs = Math.max(1, api.getConfig('draftSnapshotInterval') || 5) * 60 * 1000;
            const snaps = await listDraftSnapshots(cacheRoot, uri);
            const lastSnap = snaps[snaps.length - 1];
            if (!lastSnap || now - lastSnap.timestamp >= intervalMs) {
                if (!lastSnap || lastSnap.contentHash !== ch) {
                    const sid = String(now) + '_' + crypto.randomBytes(3).toString('hex');
                    await fsp.writeFile(path.join(dir, 'snap_' + sid + '.txt'), content, 'utf8');
                    await fsp.writeFile(path.join(dir, 'snap_' + sid + '.meta.json'), JSON.stringify({
                        uri, id: sid, contentHash: ch, timestamp: now, size: Buffer.byteLength(content, 'utf8'),
                    }), 'utf8');
                    await rotateDraftSnapshots(cacheRoot, uri);
                }
            }
        } catch (e) {}
    }

    async function listDraftSnapshots(cacheRoot, uri) {
        try {
            const dir = draftsDir(cacheRoot, uri);
            const files = await fsp.readdir(dir);
            const snaps = [];
            for (const f of files.filter(x => x.startsWith('snap_') && x.endsWith('.meta.json'))) {
                try {
                    const meta = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
                    snaps.push({
                        id: meta.id, timestamp: meta.timestamp,
                        size: meta.size || 0, contentHash: meta.contentHash,
                    });
                } catch {}
            }
            return snaps.sort((a, b) => a.timestamp - b.timestamp);
        } catch { return []; }
    }

    async function rotateDraftSnapshots(cacheRoot, uri) {
        const limit = Math.max(1, api.getConfig('draftSnapshotLimit') || 10);
        const snaps = await listDraftSnapshots(cacheRoot, uri);
        if (snaps.length > limit) {
            const dir = draftsDir(cacheRoot, uri);
            for (const s of snaps.slice(0, snaps.length - limit)) {
                try { await fsp.unlink(path.join(dir, 'snap_' + s.id + '.txt')); } catch {}
                try { await fsp.unlink(path.join(dir, 'snap_' + s.id + '.meta.json')); } catch {}
            }
        }
    }

    async function loadDraft(uri) {
        if (!isCacheEnabled()) return null;
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) return null;
        try {
            const dir = draftsDir(cacheRoot, uri);
            const metaRaw = await fsp.readFile(path.join(dir, 'current.meta.json'), 'utf8');
            const meta = JSON.parse(metaRaw);
            const ttl = Math.max(1, api.getConfig('draftTTLDays') || 7) * 24 * 60 * 60 * 1000;
            if (Date.now() - meta.timestamp > ttl) {
                await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
                return null;
            }
            const content = await fsp.readFile(path.join(dir, 'current.txt'), 'utf8');
            return { uri, content, contentHash: meta.contentHash, timestamp: meta.timestamp };
        } catch { return null; }
    }

    async function clearDraft(uri) {
        if (!isCacheEnabled()) return;
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) return;
        try {
            await fsp.rm(draftsDir(cacheRoot, uri), { recursive: true, force: true });
        } catch {}
    }

    async function getDraftSnapshot(uri, id) {
        const cacheRoot = await resolveCacheRootByUri(uri);
        if (!cacheRoot) throw new Error('no cache root');
        const dir = draftsDir(cacheRoot, uri);
        const meta = JSON.parse(await fsp.readFile(path.join(dir, 'snap_' + id + '.meta.json'), 'utf8'));
        const content = await fsp.readFile(path.join(dir, 'snap_' + id + '.txt'), 'utf8');
        return { ...meta, content };
    }

    // ============================================================
    // 操作日誌
    // ============================================================
    async function appendAction(cacheRoot, uri, action) {
        if (!isCacheEnabled()) return;
        try {
            const file = actionsFile(cacheRoot, uri);
            let logData = { uri, actions: [] };
            try { logData = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
            logData.uri = uri;
            logData.actions = logData.actions || [];
            logData.actions.push({ ts: Date.now(), ...action });
            const limit = Math.max(10, api.getConfig('actionLogLimit') || 200);
            if (logData.actions.length > limit) logData.actions = logData.actions.slice(-limit);
            await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
            await fsp.writeFile(file, JSON.stringify(logData, null, 2), 'utf8');
        } catch (e) {}
    }
    async function listActions(cacheRoot, uri) {
        try {
            const logData = JSON.parse(await fsp.readFile(actionsFile(cacheRoot, uri), 'utf8'));
            return logData.actions || [];
        } catch { return []; }
    }

    // ============================================================
    // Lazy 清理（內置功能，無配置開關）
    // ============================================================
    async function lazyCleanupForUri(uri) {
        if (!isCacheEnabled()) return;
        try {
            const realPath = realPathFromUri(uri);
            if (!realPath) return;
            const cacheRoot = await resolveCacheRootByUri(uri);
            if (!cacheRoot) return;

            // 1. 物理檔案不存在 → 刪除整個 cache/docviewer 下的條目
            if (!fs.existsSync(realPath)) {
                await fsp.rm(versionsDir(cacheRoot, uri), { recursive: true, force: true }).catch(() => {});
                await fsp.rm(draftsDir(cacheRoot, uri), { recursive: true, force: true }).catch(() => {});
                await fsp.rm(actionsFile(cacheRoot, uri), { force: true }).catch(() => {});
                return;
            }

            // 2. rotate 版本
            const idx = await loadVersionIndex(cacheRoot, uri);
            const limit = Math.max(1, api.getConfig('versionHistoryLimit') || 10);
            const unlocked = idx.versions.filter(v => !v.locked && !v.starred);
            if (unlocked.length > limit) {
                const toRemove = unlocked.slice(0, unlocked.length - limit);
                const removeIds = new Set(toRemove.map(v => v.id));
                const dir = versionsDir(cacheRoot, uri);
                for (const v of toRemove) {
                    try { await fsp.unlink(path.join(dir, v.id + '.txt')); } catch {}
                }
                idx.versions = idx.versions.filter(v => !removeIds.has(v.id));
                await saveVersionIndex(cacheRoot, uri, idx);
            }

            // 3. 清理過期草稿
            const d = await loadDraft(uri);
            if (!d) {
                await fsp.rm(draftsDir(cacheRoot, uri), { recursive: true, force: true }).catch(() => {});
            }

            // 4. action log 過大則裁剪
            const af = actionsFile(cacheRoot, uri);
            try {
                const stat = await fsp.stat(af);
                if (stat.size > 1024 * 1024) {
                    const logData = JSON.parse(await fsp.readFile(af, 'utf8'));
                    logData.actions = (logData.actions || []).slice(-200);
                    await fsp.writeFile(af, JSON.stringify(logData, null, 2), 'utf8');
                }
            } catch {}

        } catch (e) {}
    }

    // ============================================================
    // 全局孤兒清理（僅供 API / 手動調用，不暴露前端按鈕）
    // ============================================================
    let cleaningInProgress = false;
    async function cleanOrphanedCache() {
        if (!isCacheEnabled()) return { skipped: true, reason: 'cache disabled' };
        if (cleaningInProgress) return { busy: true };
        cleaningInProgress = true;
        const result = { scanned: 0, removed: 0, errors: 0 };

        try {
            const seenRoots = new Set();
            for (const [urlPrefix, diskDir] of pathMap) {
                const cacheRoot = path.join(diskDir, 'cache', 'docviewer');
                if (seenRoots.has(cacheRoot)) continue;
                seenRoots.add(cacheRoot);
                if (!fs.existsSync(cacheRoot)) continue;

                for (const sub of ['versions', 'drafts']) {
                    try {
                        const subDir = path.join(cacheRoot, sub);
                        if (!fs.existsSync(subDir)) continue;
                        const entries = await fsp.readdir(subDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isDirectory()) continue;
                            result.scanned++;
                            const possibleNames = reverseSafeDirName(entry.name);
                            const found = possibleNames.some(n => fs.existsSync(path.join(diskDir, n)));
                            if (!found) {
                                try {
                                    await fsp.rm(path.join(subDir, entry.name), { recursive: true, force: true });
                                    result.removed++;
                                } catch { result.errors++; }
                            }
                        }
                    } catch { result.errors++; }
                }

                try {
                    const aDir = path.join(cacheRoot, 'actions');
                    if (fs.existsSync(aDir)) {
                        const entries = await fsp.readdir(aDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                            result.scanned++;
                            const key = entry.name.replace(/\.json$/, '');
                            const possibleNames = reverseSafeDirName(key);
                            const found = possibleNames.some(n => fs.existsSync(path.join(diskDir, n)));
                            if (!found) {
                                try {
                                    await fsp.unlink(path.join(aDir, entry.name));
                                    result.removed++;
                                } catch { result.errors++; }
                            }
                        }
                    }
                } catch { result.errors++; }
            }
        } catch (e) {
            result.errors++;
        } finally {
            cleaningInProgress = false;
        }
        return result;
    }

    function reverseSafeDirName(dirName) {
        const out = new Set();
        out.add(dirName);
        return [...out];
    }

    // ============================================================
    // API
    // ============================================================
    async function handleApi(ctx, method, params) {
        // 總開關關閉時，所有 cache 寫入類 API 直接返回「未啟用」
        const cacheReadOnly = !isCacheEnabled();

        if (method === 'recordVersion') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: false, reason: 'cache disabled' }; return; }
            const { uri, content } = params;
            if (!uri || typeof content !== 'string') { ctx.status = 400; ctx.body = { ok: false }; return; }
            try {
                const r = await recordVersionFromContent(uri, content);
                const realPath = realPathFromUri(uri);
                if (realPath) backupFilePhysical(realPath).catch(() => {});
                ctx.status = 200; ctx.body = r;
            } catch (e) {
                ctx.status = 500; ctx.body = { ok: false, error: String(e) };
            }
            return;
        }

        if (method === 'saveEncoded') {
            const { uri, content, encoding } = params;
            if (!uri || typeof content !== 'string') { ctx.status = 400; ctx.body = { ok: false, reason: 'bad params' }; return; }
            try {
                const realPath = realPathFromUri(uri);
                if (!realPath) {
                    ctx.status = 404;
                    ctx.body = { ok: false, reason: 'no real path mapping for uri; please open the file through the browser first' };
                    return;
                }
                const buf = encodeWithEncoding(content, encoding);
                if (!buf) {
                    ctx.status = 400;
                    ctx.body = { ok: false, reason: 'unsupported encoding: ' + encoding };
                    return;
                }
                await fsp.writeFile(realPath, buf);
                if (!cacheReadOnly) {
                    recordVersionFromContent(uri, content).catch(() => {});
                    backupFilePhysical(realPath).catch(() => {});
                }
                ctx.status = 200;
                ctx.body = { ok: true, bytes: buf.length, encoding };
            } catch (e) {
                ctx.status = 500;
                ctx.body = { ok: false, error: String(e && e.message || e) };
            }
            return;
        }

        if (method === 'listTimeline') {
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: true, items: [] }; return; }
            const cacheRoot = await resolveCacheRootByUri(uri);
            if (!cacheRoot) { ctx.status = 200; ctx.body = { ok: true, items: [] }; return; }
            const items = [];
            const snaps = await listDraftSnapshots(cacheRoot, uri);
            for (const s of snaps) items.push({ kind: 'draft', id: s.id, ts: s.timestamp, size: s.size });
            const actions = await listActions(cacheRoot, uri);
            for (const a of actions) {
                if (a.type === 'save') continue;
                items.push({ kind: 'action', type: a.type, ts: a.ts, versionId: a.versionId, label: a.label, starred: a.starred, locked: a.locked });
            }
            items.sort((a, b) => b.ts - a.ts);
            ctx.status = 200;
            ctx.body = { ok: true, items };
            return;
        }

        if (method === 'listVersions') {
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: true, versions: [] }; return; }
            const cacheRoot = await resolveCacheRootByUri(uri);
            if (!cacheRoot) { ctx.status = 200; ctx.body = { ok: true, versions: [] }; return; }
            const idx = await loadVersionIndex(cacheRoot, uri);
            ctx.status = 200;
            ctx.body = { ok: true, versions: idx.versions };
            return;
        }
        if (method === 'getVersion') {
            const { uri, id } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            if (cacheReadOnly) { ctx.status = 404; ctx.body = { ok: false }; return; }
            try {
                const content = await getVersionContent(uri, id);
                ctx.status = 200;
                ctx.body = { ok: true, content };
            } catch { ctx.status = 404; ctx.body = { ok: false }; }
            return;
        }
        if (method === 'updateVersionMeta') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: false, reason: 'cache disabled' }; return; }
            const { uri, id, label, starred, locked } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            const cacheRoot = await resolveCacheRootByUri(uri);
            if (!cacheRoot) { ctx.status = 404; ctx.body = { ok: false }; return; }
            const idx = await loadVersionIndex(cacheRoot, uri);
            const v = idx.versions.find(x => x.id === id);
            if (!v) { ctx.status = 404; ctx.body = { ok: false }; return; }
            if (label !== undefined) v.label = label;
            if (starred !== undefined) v.starred = !!starred;
            if (locked !== undefined) v.locked = !!locked;
            await saveVersionIndex(cacheRoot, uri, idx);
            await appendAction(cacheRoot, uri, { type: 'meta', versionId: id, label: v.label, starred: v.starred, locked: v.locked });
            ctx.status = 200;
            ctx.body = { ok: true, version: v };
            return;
        }
        if (method === 'deleteVersion') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: false, reason: 'cache disabled' }; return; }
            const { uri, id } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            const cacheRoot = await resolveCacheRootByUri(uri);
            if (!cacheRoot) { ctx.status = 404; ctx.body = { ok: false }; return; }
            const idx = await loadVersionIndex(cacheRoot, uri);
            const v = idx.versions.find(x => x.id === id);
            if (!v) { ctx.status = 404; ctx.body = { ok: false }; return; }
            if (v.locked) { ctx.status = 403; ctx.body = { ok: false, reason: 'locked' }; return; }
            try { await fsp.unlink(path.join(versionsDir(cacheRoot, uri), id + '.txt')); } catch {}
            idx.versions = idx.versions.filter(x => x.id !== id);
            await saveVersionIndex(cacheRoot, uri, idx);
            ctx.status = 200;
            ctx.body = { ok: true };
            return;
        }
        if (method === 'saveDraft') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: false, reason: 'cache disabled' }; return; }
            const { uri, content } = params;
            if (!uri || typeof content !== 'string') { ctx.status = 400; ctx.body = { ok: false }; return; }
            await saveDraft(uri, content);
            ctx.status = 200;
            ctx.body = { ok: true };
            return;
        }
        if (method === 'getDraft') {
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: true, draft: null }; return; }
            const d = await loadDraft(uri);
            ctx.status = 200;
            ctx.body = { ok: true, draft: d };
            return;
        }
        if (method === 'clearDraft') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: false, reason: 'cache disabled' }; return; }
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            await clearDraft(uri);
            ctx.status = 200;
            ctx.body = { ok: true };
            return;
        }
        if (method === 'getDraftSnapshot') {
            const { uri, id } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            if (cacheReadOnly) { ctx.status = 404; ctx.body = { ok: false }; return; }
            try {
                const d = await getDraftSnapshot(uri, id);
                ctx.status = 200;
                ctx.body = { ok: true, content: d.content, timestamp: d.timestamp };
            } catch { ctx.status = 404; ctx.body = { ok: false }; }
            return;
        }

        if (method === 'cleanOrphaned') {
            try {
                const result = await cleanOrphanedCache();
                ctx.status = 200;
                ctx.body = { ok: true, ...result };
            } catch (e) {
                ctx.status = 500;
                ctx.body = { ok: false, error: String(e) };
            }
            return;
        }

        if (method === 'lazyCleanup') {
            if (cacheReadOnly) { ctx.status = 200; ctx.body = { ok: true, skipped: true }; return; }
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            await lazyCleanupForUri(uri);
            ctx.status = 200;
            ctx.body = { ok: true };
            return;
        }

        ctx.status = 404;
        ctx.body = { ok: false, reason: 'unknown method: ' + method };
    }

    function extractParams(ctx) {
        const out = {};
        try { Object.assign(out, ctx.query || {}); } catch {}
        try {
            const b = ctx.request?.body;
            if (b && typeof b === 'object') Object.assign(out, b);
        } catch {}
        try {
            const sp = ctx.state?.params;
            if (sp && typeof sp === 'object') Object.assign(out, sp);
        } catch {}
        return out;
    }

    return {
        middleware: async ctx => {
            const p = ctx.path;

            if (p.startsWith(API_BASE)) {
                const apiMethod = p.substring(API_BASE.length).split('?')[0];
                const params = extractParams(ctx);
                try {
                    await handleApi(ctx, apiMethod, params);
                } catch (e) {
                    ctx.status = 500;
                    ctx.body = { ok: false, error: String(e && e.message || e) };
                }
                return;
            }

            try {
                if (ctx.state && ctx.state.fileSource && isDocFile(ctx.state.fileSource)) {
                    ctx.set('X-Doc-Viewer', '1');
                }
            } catch (e) {}

            return async () => {
                try {
                    if (ctx.method === 'GET') {
                        let realPath = null;
                        if (ctx.state && ctx.state.vfsNode && ctx.state.vfsNode.source) {
                            realPath = ctx.state.vfsNode.source;
                        } else if (ctx.state && ctx.state.fileSource) {
                            realPath = ctx.state.fileSource;
                        }
                        if (realPath) {
                            const urlPath = ctx.path || '';
                            const urlDir = urlPath.substring(0, urlPath.lastIndexOf('/') + 1);
                            recordPathMap(urlDir, path.dirname(realPath));
                        }
                    }
                } catch (e) {}
            };
        },
    };
};