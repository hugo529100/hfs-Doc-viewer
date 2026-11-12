'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

exports.version = 6.8;
exports.apiRequired = 8.87;
exports.repo = "Hug3O/Doc-viewer";
exports.description = "Text editor with fullscreen dialog, saved versions, unified timeline, VSCode theme.";

exports.frontend_js = ['editor.js', 'theme.js', 'main.js'];
exports.frontend_css = ['style.css'];

exports.config = {
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
    autoBackup: { frontend: true, type: 'boolean', label: 'Auto Backup on Save', defaultValue: true },
    versionHistoryLimit: {
        frontend: true, type: 'number', label: 'Version History Limit (unlocked)',
        defaultValue: 10, min: 1, max: 200,
        helperText: 'Maximum number of unlocked versions kept per file. Locked/starred versions are never rotated out.',
    },
    draftSnapshotLimit: {
        frontend: true, type: 'number', label: 'Draft Snapshot Limit',
        defaultValue: 10, min: 1, max: 100,
    },
    draftSnapshotInterval: {
        frontend: true, type: 'number', label: 'Draft Snapshot Interval (minutes)',
        defaultValue: 5, min: 1, max: 120,
    },
    actionLogLimit: {
        frontend: true, type: 'number', label: 'Action Log Limit',
        defaultValue: 200, min: 10, max: 2000,
    },
    draftTTLDays: {
        frontend: true, type: 'number', label: 'Draft TTL (days)',
        defaultValue: 7, min: 1, max: 365,
    },
};

exports.changelog = [
    { version: 6.8, message: "Add saveEncoded API for ANSI (GBK/Big5/Latin-1) saving via iconv-lite; encoding selectable in editor toolbar." },
    { version: 6.7, message: "Debug logging gated behind config; theme-aware scrollbars; wrap toggle fix." },
];

exports.init = async api => {
    const path = api.require('path');
    const fs = api.require('fs');
    const fsp = api.require('fs/promises');
    const crypto = api.require('crypto');

    const log = () => {};

    // iconv-lite 可选加载（用于 ANSI / GBK / Big5 保存）
    let iconv = null;
    try {
        iconv = api.require('iconv-lite');
    } catch (e) {
        try { iconv = require('iconv-lite'); } catch (e2) { iconv = null; }
    }

    function encodeWithEncoding(str, enc) {
        const e = String(enc || 'utf-8').toLowerCase();
        if (e === 'utf-8' || e === 'utf8') return Buffer.from(str, 'utf8');
        if (iconv && iconv.encodingExists && iconv.encodingExists(e)) {
            try { return iconv.encode(str, e); } catch (err) {}
        }
        // 回退：latin1 逐字符截断到 0-255；其他编码无法保证，返回 null
        if (e === 'latin1' || e === 'iso-8859-1' || e === 'windows-1252') {
            const buf = Buffer.alloc(str.length);
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                buf[i] = code < 256 ? code : 63; // '?'
            }
            return buf;
        }
        return null;
    }

    const DOC_EXTS = [
        '.txt', '.log', '.nfo', '.readme', '.rtf', '.md', '.markdown', '.tex',
        '.json', '.xml', '.csv', '.tsv', '.yml', '.yaml', '.ini', '.cfg', '.conf',
        '.config', '.properties', '.env', '.toml', '.lock', '.srt', '.vtt', '.ass',
        '.ssa', '.sub', '.template', '.spec', '.webapp', '.arg', '.gitignore',
        '.gitattributes', '.editorconfig', '.dockerignore', '.gradle', '.makefile',
        '.mk', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.ts',
        '.jsx', '.tsx', '.py', '.rb', '.php', '.pl', '.lua', '.sh', '.bash', '.zsh',
        '.fish', '.bat', '.cmd', '.ps1', '.c', '.h', '.cpp', '.hpp', '.cc', '.hxx',
        '.java', '.kt', '.swift', '.go', '.rs', '.sql', '.graphql', '.gql',
        '.html', '.htm', '.xhtml',
    ];

    const API_BASE = '/~/api/doc-viewer/';

    const DRAFTS_DIR = path.join(api.storageDir, 'drafts');
    const VERSIONS_DIR = path.join(api.storageDir, 'versions');
    const ACTIONS_DIR = path.join(api.storageDir, 'actions');

    await fsp.mkdir(DRAFTS_DIR, { recursive: true }).catch(() => {});
    await fsp.mkdir(VERSIONS_DIR, { recursive: true }).catch(() => {});
    await fsp.mkdir(ACTIONS_DIR, { recursive: true }).catch(() => {});

    function isDocFile(filePath) {
        if (!filePath) return false;
        const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
        return DOC_EXTS.includes(ext);
    }
    function sanitizeName(name) {
        return String(name).replace(/[^\w.-]+/g, '_').slice(0, 100);
    }
    function timeString(d = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    function safeDecode(s) {
        if (!s) return '';
        try { return decodeURIComponent(s); }
        catch (e) { return s; }
    }
    function docHash(uri) {
        return crypto.createHash('md5').update(uri).digest('hex');
    }
    function contentHash(buf) {
        return crypto.createHash('md5').update(buf).digest('hex');
    }

    // ============================================================
    // 物理備份（cache/docbak）
    // ============================================================
    async function ensureCacheDir(realPath) {
        try {
            const realDir = path.dirname(realPath);
            if (!fs.existsSync(realDir)) return null;
            const cacheDir = path.join(realDir, 'cache', 'docbak');
            if (!fs.existsSync(cacheDir)) {
                await fsp.mkdir(cacheDir, { recursive: true });
            }
            return cacheDir;
        } catch (e) { return null; }
    }
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
        if (api.getConfig('autoBackup') === false) return;
        try {
            if (!fs.existsSync(realPath)) return;
            const cacheDir = await ensureCacheDir(realPath);
            if (!cacheDir) return;
            const base = path.basename(realPath, path.extname(realPath));
            const safe = sanitizeName(base);
            const hash = crypto.createHash('md5').update(realPath).digest('hex').slice(0, 8);
            const ext = path.extname(realPath) || '.txt';
            const dst = path.join(cacheDir, `${safe}_${hash}_backup_${timeString()}${ext}`);
            await copyFileRetry(realPath, dst);
        } catch (e) {}
    }

    // ============================================================
    // 版本歷史
    // ============================================================
    function versionDir(uri) { return path.join(VERSIONS_DIR, docHash(uri)); }
    function versionIndexPath(uri) { return path.join(versionDir(uri), 'index.json'); }

    async function loadVersionIndex(uri) {
        try {
            const raw = await fsp.readFile(versionIndexPath(uri), 'utf8');
            const idx = JSON.parse(raw);
            idx.uri = uri;
            idx.versions = idx.versions || [];
            return idx;
        } catch {
            return { uri, versions: [] };
        }
    }
    async function saveVersionIndex(uri, idx) {
        await fsp.mkdir(versionDir(uri), { recursive: true }).catch(() => {});
        await fsp.writeFile(versionIndexPath(uri), JSON.stringify(idx, null, 2), 'utf8');
    }

    async function recordVersionFromContent(uri, content) {
        const buf = Buffer.from(content, 'utf8');
        const ch = contentHash(buf);
        const idx = await loadVersionIndex(uri);

        const last = idx.versions[idx.versions.length - 1];
        if (last && last.contentHash === ch) {
            return { ok: true, skipped: true };
        }

        const id = String(Date.now()) + '_' + crypto.randomBytes(3).toString('hex');
        const verFile = path.join(versionDir(uri), id + '.json');
        await fsp.mkdir(versionDir(uri), { recursive: true }).catch(() => {});
        await fsp.writeFile(verFile, JSON.stringify({
            uri,
            contentBase64: buf.toString('base64'),
            timestamp: Date.now(),
            size: buf.length,
        }), 'utf8');

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
                try { await fsp.unlink(path.join(versionDir(uri), v.id + '.json')); } catch {}
            }
            idx.versions = idx.versions.filter(v => !removeIds.has(v.id));
        }

        await saveVersionIndex(uri, idx);
        await appendAction(uri, { type: 'save', size: buf.length, versionId: id });
        return { ok: true, id };
    }

    async function getVersionContent(uri, id) {
        const file = path.join(versionDir(uri), id + '.json');
        const raw = await fsp.readFile(file, 'utf8');
        const v = JSON.parse(raw);
        return Buffer.from(v.contentBase64, 'base64');
    }

    // ============================================================
    // 草稿（含快照）
    // ============================================================
    function draftDir(uri) { return path.join(DRAFTS_DIR, docHash(uri)); }
    function draftCurrentPath(uri) { return path.join(draftDir(uri), 'current.json'); }

    async function saveDraft(uri, content) {
        try {
            await fsp.mkdir(draftDir(uri), { recursive: true }).catch(() => {});
            const ch = crypto.createHash('md5').update(content).digest('hex');
            const data = { uri, content, contentHash: ch, timestamp: Date.now() };
            await fsp.writeFile(draftCurrentPath(uri), JSON.stringify(data), 'utf8');

            const intervalMs = Math.max(1, api.getConfig('draftSnapshotInterval') || 5) * 60 * 1000;
            const snaps = await listDraftSnapshots(uri);
            const lastSnap = snaps[snaps.length - 1];
            if (!lastSnap || Date.now() - lastSnap.timestamp >= intervalMs) {
                if (!lastSnap || lastSnap.contentHash !== ch) {
                    const sid = String(Date.now()) + '_' + crypto.randomBytes(3).toString('hex');
                    await fsp.writeFile(path.join(draftDir(uri), 'snap_' + sid + '.json'),
                        JSON.stringify({ ...data, id: sid }), 'utf8');
                    await rotateDraftSnapshots(uri);
                }
            }
        } catch (e) {}
    }

    async function listDraftSnapshots(uri) {
        try {
            const files = await fsp.readdir(draftDir(uri));
            const snaps = [];
            for (const f of files.filter(x => x.startsWith('snap_') && x.endsWith('.json'))) {
                try {
                    const d = JSON.parse(await fsp.readFile(path.join(draftDir(uri), f), 'utf8'));
                    snaps.push({ id: d.id, timestamp: d.timestamp, size: (d.content || '').length, contentHash: d.contentHash });
                } catch {}
            }
            return snaps.sort((a, b) => a.timestamp - b.timestamp);
        } catch { return []; }
    }

    async function rotateDraftSnapshots(uri) {
        const limit = Math.max(1, api.getConfig('draftSnapshotLimit') || 10);
        const snaps = await listDraftSnapshots(uri);
        if (snaps.length > limit) {
            for (const s of snaps.slice(0, snaps.length - limit)) {
                try { await fsp.unlink(path.join(draftDir(uri), 'snap_' + s.id + '.json')); } catch {}
            }
        }
    }

    async function loadDraft(uri) {
        try {
            const raw = await fsp.readFile(draftCurrentPath(uri), 'utf8');
            const d = JSON.parse(raw);
            const ttl = Math.max(1, api.getConfig('draftTTLDays') || 7) * 24 * 60 * 60 * 1000;
            if (Date.now() - d.timestamp > ttl) {
                await fsp.unlink(draftCurrentPath(uri)).catch(() => {});
                return null;
            }
            return d;
        } catch { return null; }
    }
    async function clearDraft(uri) {
        try {
            await fsp.rm(draftDir(uri), { recursive: true, force: true });
        } catch {}
    }
    async function getDraftSnapshot(uri, id) {
        const p = path.join(draftDir(uri), 'snap_' + id + '.json');
        return JSON.parse(await fsp.readFile(p, 'utf8'));
    }

    // ============================================================
    // 操作日誌（底層）
    // ============================================================
    function actionPath(uri) { return path.join(ACTIONS_DIR, docHash(uri) + '.json'); }

    async function appendAction(uri, action) {
        try {
            let logData = { uri, actions: [] };
            try { logData = JSON.parse(await fsp.readFile(actionPath(uri), 'utf8')); } catch {}
            logData.uri = uri;
            logData.actions = logData.actions || [];
            logData.actions.push({ ts: Date.now(), ...action });
            const limit = Math.max(10, api.getConfig('actionLogLimit') || 200);
            if (logData.actions.length > limit) logData.actions = logData.actions.slice(-limit);
            await fsp.writeFile(actionPath(uri), JSON.stringify(logData, null, 2), 'utf8');
        } catch (e) {}
    }
    async function listActions(uri) {
        try {
            const logData = JSON.parse(await fsp.readFile(actionPath(uri), 'utf8'));
            return logData.actions || [];
        } catch { return []; }
    }

    // ============================================================
    // pathMap（給物理備份 / saveEncoded 用）
    // ============================================================
    const pathMap = new Map();
    function recordPathMap(urlDir, realDir) {
        if (!urlDir || !realDir) return;
        const decoded = safeDecode(urlDir);
        const realWithSep = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
        if (pathMap.get(decoded) !== realWithSep) pathMap.set(decoded, realWithSep);
    }
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

    // ============================================================
    // API
    // ============================================================
    async function handleApi(ctx, method, params) {

        if (method === 'recordVersion') {
            const { uri, content } = params;
            if (!uri || typeof content !== 'string') {
                ctx.status = 400; ctx.body = { ok: false }; return;
            }
            try {
                const r = await recordVersionFromContent(uri, content);
                const realPath = realPathFromUri(uri);
                if (realPath) backupFilePhysical(realPath).catch(() => {});
                ctx.status = 200;
                ctx.body = r;
            } catch (e) {
                ctx.status = 500;
                ctx.body = { ok: false, error: String(e) };
            }
            return;
        }

        // 非 UTF-8 保存（ANSI / GBK / Big5 / Latin-1）
        if (method === 'saveEncoded') {
            const { uri, content, encoding } = params;
            if (!uri || typeof content !== 'string') {
                ctx.status = 400; ctx.body = { ok: false, reason: 'bad params' }; return;
            }
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
                // 保存后也记录一次版本（用 utf8 内容，便于历史预览）
                recordVersionFromContent(uri, content).catch(() => {});
                backupFilePhysical(realPath).catch(() => {});
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
            const items = [];

            const snaps = await listDraftSnapshots(uri);
            for (const s of snaps) {
                items.push({ kind: 'draft', id: s.id, ts: s.timestamp, size: s.size });
            }

            const actions = await listActions(uri);
            for (const a of actions) {
                if (a.type === 'save') continue;
                items.push({
                    kind: 'action',
                    type: a.type,
                    ts: a.ts,
                    versionId: a.versionId,
                    label: a.label,
                    starred: a.starred,
                    locked: a.locked,
                });
            }

            items.sort((a, b) => b.ts - a.ts);
            ctx.status = 200;
            ctx.body = { ok: true, items };
            return;
        }

        if (method === 'listVersions') {
            const uri = params.uri;
            if (!uri) { ctx.status = 400; ctx.body = { ok: false }; return; }
            const idx = await loadVersionIndex(uri);
            ctx.status = 200;
            ctx.body = { ok: true, versions: idx.versions };
            return;
        }
        if (method === 'getVersion') {
            const { uri, id } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            try {
                const buf = await getVersionContent(uri, id);
                ctx.status = 200;
                ctx.body = { ok: true, content: buf.toString('base64') };
            } catch { ctx.status = 404; ctx.body = { ok: false }; }
            return;
        }
        if (method === 'updateVersionMeta') {
            const { uri, id, label, starred, locked } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            const idx = await loadVersionIndex(uri);
            const v = idx.versions.find(x => x.id === id);
            if (!v) { ctx.status = 404; ctx.body = { ok: false }; return; }
            if (label !== undefined) v.label = label;
            if (starred !== undefined) v.starred = !!starred;
            if (locked !== undefined) v.locked = !!locked;
            await saveVersionIndex(uri, idx);
            await appendAction(uri, { type: 'meta', versionId: id, label: v.label, starred: v.starred, locked: v.locked });
            ctx.status = 200;
            ctx.body = { ok: true, version: v };
            return;
        }
        if (method === 'deleteVersion') {
            const { uri, id } = params;
            if (!uri || !id) { ctx.status = 400; ctx.body = { ok: false }; return; }
            const idx = await loadVersionIndex(uri);
            const v = idx.versions.find(x => x.id === id);
            if (!v) { ctx.status = 404; ctx.body = { ok: false }; return; }
            if (v.locked) { ctx.status = 403; ctx.body = { ok: false, reason: 'locked' }; return; }
            try { await fsp.unlink(path.join(versionDir(uri), id + '.json')); } catch {}
            idx.versions = idx.versions.filter(x => x.id !== id);
            await saveVersionIndex(uri, idx);
            ctx.status = 200;
            ctx.body = { ok: true };
            return;
        }
        if (method === 'saveDraft') {
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
            const d = await loadDraft(uri);
            ctx.status = 200;
            ctx.body = { ok: true, draft: d };
            return;
        }
        if (method === 'clearDraft') {
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
            try {
                const d = await getDraftSnapshot(uri, id);
                ctx.status = 200;
                ctx.body = { ok: true, content: d.content, timestamp: d.timestamp };
            } catch { ctx.status = 404; ctx.body = { ok: false }; }
            return;
        }

        ctx.status = 404;
        ctx.body = { ok: false, reason: 'unknown method: ' + method };
    }

    function extractParams(ctx) {
        const out = {};
        try {
            const q = ctx.query || {};
            Object.assign(out, q);
        } catch {}
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
            const method = ctx.method.toUpperCase();

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