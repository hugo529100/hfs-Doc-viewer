{
    'use strict';
    function escapeHtml(html) {
        return html
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const limit = (Number((HFS.getPluginConfig() || {})['limitMB']) || 2) * Math.pow(1024, 2);
    const r = HFS.React;
    const cfg = HFS.getPluginConfig() || {};
    const defaultEncoding = cfg.encoding || 'utf-8';

    const CACHE_ENABLED = cfg.autoBackup !== false;

    const API = '/~/api/doc-viewer/';

    const HL_AUTO_MAX = 100000;
    const HL_HARD_MAX = 400000;
    const VIEWPORT_BUFFER_LINES = 80;

    const AUTO_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

    const ENCODINGS = [
        { value: 'utf-8', label: 'UTF-8', hint: 'UTF-8 (Unicode)' },
        { value: 'big5', label: 'Big5', hint: 'Big5 (ANSI, Traditional Chinese)' },
        { value: 'gbk', label: 'GBK', hint: 'GBK (ANSI, Simplified Chinese)' },
        { value: 'latin1', label: 'Latin-1', hint: 'Latin-1 / Windows-1252 (ANSI, Western)' },
    ];

    // ============================================================
    // 硬編碼的「Doc-viewer 支持的全部格式」—— 用於右鍵菜單 Edit
    // 包含 html / htm / xhtml，因為右鍵點擊是顯式意圖
    // ============================================================
    const ALL_SUPPORTED_EXTS = [
        'txt', 'log', 'nfo', 'readme', 'rtf', 'md', 'markdown', 'tex',
        'json', 'xml', 'csv', 'tsv', 'yml', 'yaml', 'ini', 'cfg', 'conf',
        'config', 'properties', 'env', 'toml', 'lock', 'srt', 'vtt', 'ass',
        'ssa', 'sub', 'template', 'spec', 'webapp', 'arg', 'gitignore',
        'gitattributes', 'editorconfig', 'dockerignore', 'gradle', 'makefile',
        'mk', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts',
        'jsx', 'tsx', 'py', 'rb', 'php', 'pl', 'lua', 'sh', 'bash', 'zsh',
        'fish', 'bat', 'cmd', 'ps1', 'c', 'h', 'cpp', 'hpp', 'cc', 'hxx',
        'java', 'kt', 'swift', 'go', 'rs', 'sql', 'graphql', 'gql',
        'html', 'htm', 'xhtml',
        'gcode',
    ];

    // ============================================================
    // 從配置解析「圖標攔截允許的擴展名」—— 用於點擊圖標打開
    // 默認不含 html / htm / xhtml，管理員可手動加入
    // ============================================================
    const DEFAULT_EDITABLE_EXTS = [
        'txt', 'log', 'nfo', 'readme', 'rtf', 'md', 'markdown', 'tex',
        'json', 'xml', 'csv', 'tsv', 'yml', 'yaml', 'ini', 'cfg', 'conf',
        'config', 'properties', 'env', 'toml', 'lock', 'srt', 'vtt', 'ass',
        'ssa', 'sub', 'template', 'spec', 'webapp', 'arg', 'gitignore',
        'gitattributes', 'editorconfig', 'dockerignore', 'gradle', 'makefile',
        'mk', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts',
        'jsx', 'tsx', 'py', 'rb', 'php', 'pl', 'lua', 'sh', 'bash', 'zsh',
        'fish', 'bat', 'cmd', 'ps1', 'c', 'h', 'cpp', 'hpp', 'cc', 'hxx',
        'java', 'kt', 'swift', 'go', 'rs', 'sql', 'graphql', 'gql',
        'gcode',
    ];

    function parseEditableExts(rawValue) {
        if (rawValue == null) return DEFAULT_EDITABLE_EXTS.slice();
        if (Array.isArray(rawValue)) {
            return rawValue
                .map(x => String(x).trim().toLowerCase())
                .filter(Boolean)
                .map(x => x.startsWith('.') ? x.slice(1) : x);
        }
        if (typeof rawValue !== 'string') return DEFAULT_EDITABLE_EXTS.slice();
        const trimmed = rawValue.trim();
        if (!trimmed) return [];
        return trimmed
            .split(/[\s,;]+/)
            .map(x => x.trim().toLowerCase())
            .filter(Boolean)
            .map(x => x.startsWith('.') ? x.slice(1) : x);
    }

    function buildExtRe(exts) {
        if (!exts || exts.length === 0) return null;
        return new RegExp(
            '\\.(?:' + exts.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$',
            'i'
        );
    }

    // 用於右鍵菜單 Edit / 文件大小檢查（含 html/htm/xhtml）
    const ALL_EXT_RE = buildExtRe(ALL_SUPPORTED_EXTS);

    // 用於圖標攔截（不含 html/htm/xhtml，除非配置加了）
    const EDITABLE_EXTS = parseEditableExts(cfg.editableExts);
    const DOC_EXT_RE = buildExtRe(EDITABLE_EXTS);

    // isSupportedDocName：判斷是否為 Doc-viewer 支持的任一格式（含 html/htm/xhtml）
    // → 用於右鍵菜單、文件大小超限提示
    function isSupportedDocName(name) {
        if (typeof name !== 'string' || !ALL_EXT_RE) return false;
        return ALL_EXT_RE.test(name);
    }

    // isIconHijackable：判斷圖標是否應該被攔截
    // → 用於圖標點擊攔截
    function isIconHijackable(name) {
        if (typeof name !== 'string' || !DOC_EXT_RE) return false;
        return DOC_EXT_RE.test(name);
    }

    async function apiPost(method, body) {
        const res = await fetch(API + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function loadDraft(uri) {
        if (!CACHE_ENABLED) return null;
        try { const d = await apiPost('getDraft', { uri }); return d.draft || null; }
        catch { return null; }
    }
    async function saveDraft(uri, content) {
        if (!CACHE_ENABLED) return;
        try { await apiPost('saveDraft', { uri, content }); } catch {}
    }
    async function clearDraft(uri) {
        if (!CACHE_ENABLED) return;
        try { await apiPost('clearDraft', { uri }); } catch {}
    }

    function silentLazyCleanup(uri) {
        if (!uri) return;
        if (!CACHE_ENABLED) return;
        apiPost('lazyCleanup', { uri }).catch(() => {});
    }

    function formatBytes(n) {
        if (n == null || isNaN(n)) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function formatDate(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            const p = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        } catch { return ''; }
    }
    function decodeBytes(buf, enc) {
        try { return new TextDecoder(enc || 'utf-8').decode(buf); }
        catch { return new TextDecoder('utf-8').decode(buf); }
    }

    function countChars(str) {
        if (!str) return { chars: 0, lines: 0 };
        let chars = 0;
        for (const _ of str) chars++;
        let lines = 1;
        for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) lines++;
        return { chars, lines };
    }

    function findMatches(value, term) {
        const matches = [];
        if (!value || !term) return matches;
        const lowerValue = value.toLowerCase();
        const lowerTerm = term.toLowerCase();
        if (!lowerTerm) return matches;
        let idx = 0;
        while ((idx = lowerValue.indexOf(lowerTerm, idx)) !== -1) {
            matches.push({ start: idx, end: idx + term.length });
            idx += term.length;
        }
        return matches;
    }

    function wrapSearch(rawValue, matches, currentIdx) {
        if (!matches || matches.length === 0) return escapeHtml(rawValue);
        let out = '';
        let pos = 0;
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            if (m.start < pos) continue;
            out += escapeHtml(rawValue.slice(pos, m.start));
            const cls = i === currentIdx ? 'dv-search-hit dv-search-hit-current' : 'dv-search-hit';
            out += '<mark class="' + cls + '">' + escapeHtml(rawValue.slice(m.start, m.end)) + '</mark>';
            pos = m.end;
        }
        out += escapeHtml(rawValue.slice(pos));
        return out;
    }

    function buildViewportHighlight(fullText, startLine, endLine, highlighter) {
        if (!highlighter) return escapeHtml(fullText);
        const lines = fullText.split('\n');
        const total = lines.length;
        const s = Math.max(0, Math.min(startLine, total - 1));
        const e = Math.max(s, Math.min(endLine, total - 1));

        const visibleText = lines.slice(s, e + 1).join('\n');
        const visibleHtml = highlighter(visibleText);

        const before = '\n'.repeat(s);
        const after = '\n'.repeat(Math.max(0, total - 1 - e));
        return before + visibleHtml + after;
    }

    async function saveContent(uri, content, encoding) {
        const enc = (encoding || 'utf-8').toLowerCase();
        if (enc === 'utf-8') {
            return fetch(uri + (uri.includes('?') ? '&' : '?') + 'existing=overwrite', {
                method: 'PUT',
                body: content,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }
        const res = await fetch(API + 'saveEncoded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, content, encoding: enc }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res;
    }

    // ============================================================
    // 圖標攔截（只針對 cfg.editableExts）
    // ============================================================
    const IconHijack = {
        hijackedIcons: new WeakSet(),
        _observer: null,
        _hijackTimeoutId: null,
        _preactHijackerSetup: false,
        _origDiffed: null,
        _origCommit: null,
        _globalInterceptorSetup: false,
        _openDialog: null,

        findEntryByLink(linkEl) {
            try {
                const name = linkEl.textContent?.trim();
                if (!name) return null;
                const href = linkEl.getAttribute('href');
                if (!href) return null;
                return {
                    name,
                    uri: href,
                    ext: name.split('.').pop().toLowerCase(),
                    s: null,
                };
            } catch { return null; }
        },

        setupPreactHijacker() {
            if (this._preactHijackerSetup) return;
            const preact = window.preact || window.Preact;
            if (!preact || !preact.options) return;
            const options = preact.options;
            this._origDiffed = options.diffed;
            this._origCommit = options.__c;
            const self = this;
            let hijackTimer = null;
            options.diffed = function(vnode) {
                if (self.isFileListVNode(vnode)) {
                    clearTimeout(hijackTimer);
                    hijackTimer = setTimeout(() => { self._scheduleHijack(); }, 30);
                }
                if (self._origDiffed) self._origDiffed(vnode);
            };
            options.__c = function(vnode, commitQueue) {
                if (self.isFileListVNode(vnode)) {
                    clearTimeout(hijackTimer);
                    hijackTimer = setTimeout(() => { self._scheduleHijack(); }, 10);
                }
                if (self._origCommit) self._origCommit(vnode, commitQueue);
            };
            this._preactHijackerSetup = true;
        },

        isFileListVNode(vnode) {
            if (!vnode) return false;
            if (vnode.type === 'ul' || vnode.type === 'div') {
                const className = vnode.props?.className || '';
                if (typeof className === 'string' && /file|list|entries/.test(className)) return true;
            }
            if (vnode.__k && Array.isArray(vnode.__k)) {
                for (const child of vnode.__k) {
                    if (child && child.type === 'li') {
                        const cls = child.props?.className || '';
                        if (typeof cls === 'string' && cls.includes('file')) return true;
                    }
                }
            }
            return false;
        },

        _scheduleHijack() {
            if (this._hijackTimeoutId) clearTimeout(this._hijackTimeoutId);
            this._hijackTimeoutId = setTimeout(() => {
                this._hijackTimeoutId = null;
                this.hijackAllIcons();
            }, 20);
        },

        hasDocInCurrentList() {
            const fileItems = document.querySelectorAll('li.file');
            for (const li of fileItems) {
                const a = li.querySelector('a[href]');
                const name = a?.textContent?.trim();
                if (name && isIconHijackable(name)) return true;
            }
            return false;
        },

        hijackAllIcons() {
            if (!DOC_EXT_RE) return;
            if (!this.hasDocInCurrentList()) return;
            const fileItems = document.querySelectorAll('li.file:not([data-dv-icon-hijacked="true"])');
            for (const li of fileItems) {
                const a = li.querySelector('a[href]');
                const name = a?.textContent?.trim();
                if (!name || !isIconHijackable(name)) continue;
                const icon = li.querySelector('span.icon, [class*="media-icon"]');
                if (!icon) continue;
                li.dataset.dvIconHijacked = 'true';
                const entry = this.findEntryByLink(a);
                icon.style.cursor = 'pointer';
                icon.title = 'Edit with Doc-viewer';
                this.hijackElementClicks(icon, entry);
            }
        },

        hijackElementClicks(element, entry) {
            if (!element || this.hijackedIcons.has(element)) return;
            this.hijackedIcons.add(element);
            const handler = (e) => {
                e.stopImmediatePropagation();
                e.stopPropagation();
                e.preventDefault();
                this.openEntry(entry);
            };
            element.addEventListener('click', handler, true);
        },

        openEntry(entry) {
            if (!entry) return;
            if (typeof this._openDialog === 'function') {
                this._openDialog(entry);
            } else {
                const a = document.createElement('a');
                a.href = entry.uri;
                a.target = '_blank';
                a.click();
            }
        },

        setupGlobalClickInterceptor() {
            if (this._globalInterceptorSetup) return;
            this._globalInterceptorSetup = true;
            const self = this;
            document.addEventListener('click', function(e) {
                if (!DOC_EXT_RE) return;
                const target = e.target.closest('li.file');
                if (!target) return;
                if (target.dataset.dvIconHijacked === 'true') return;
                const a = target.querySelector('a[href]');
                if (!a) return;
                const name = a.textContent?.trim();
                if (!name || !isIconHijackable(name)) return;
                const icon = target.querySelector('span.icon, [class*="media-icon"]');
                if (!icon || !icon.contains(e.target)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                const entry = self.findEntryByLink(a);
                self.openEntry(entry);
                target.dataset.dvIconHijacked = 'true';
            }, true);
        },

        startObserver() {
            if (this._observer) return;
            const self = this;
            let debounce = null;
            this._observer = new MutationObserver((mutations) => {
                let shouldHijack = false;
                for (const m of mutations) {
                    if (m.type === 'childList' && m.addedNodes.length > 0) {
                        for (const node of m.addedNodes) {
                            if (node.nodeType === 1) {
                                if (node.querySelector && (
                                    node.querySelector('li.file') ||
                                    node.classList.contains('file') ||
                                    node.classList.contains('list-wrapper') ||
                                    node.querySelector('.icon')
                                )) { shouldHijack = true; break; }
                            }
                        }
                    }
                    if (shouldHijack) break;
                }
                if (shouldHijack) {
                    clearTimeout(debounce);
                    debounce = setTimeout(() => {
                        if (self.hasDocInCurrentList()) self.hijackAllIcons();
                    }, 100);
                }
            });
            this._observer.observe(document.body, { childList: true, subtree: true });
        },

        start() {
            if (!DOC_EXT_RE) return;
            [200, 500, 1000, 2000, 3000].forEach(d => setTimeout(() => this.hijackAllIcons(), d));
            this.startObserver();
            this.setupPreactHijacker();
            this.setupGlobalClickInterceptor();
        },
    };

    // ============================================================
    // HistoryDialog（不變）
    // ============================================================
    function HistoryDialog({ uri, encoding, onClose, onRestore }) {
        const [tab, setTab] = React.useState('versions');
        const [versions, setVersions] = React.useState([]);
        const [timeline, setTimeline] = React.useState([]);
        const [currentDraft, setCurrentDraft] = React.useState(null);
        const [loading, setLoading] = React.useState(true);
        const [preview, setPreview] = React.useState(null);

        async function refresh() {
            setLoading(true);
            try {
                if (tab === 'versions') {
                    const d = await apiPost('listVersions', { uri });
                    setVersions((d.versions || []).slice().sort((a, b) => b.timestamp - a.timestamp));
                } else {
                    const [d1, d2] = await Promise.all([
                        apiPost('listTimeline', { uri }),
                        apiPost('getDraft', { uri }),
                    ]);
                    setTimeline(d1.items || []);
                    setCurrentDraft(d2.draft || null);
                }
            } catch {}
            setLoading(false);
        }
        React.useEffect(() => { refresh(); }, [tab]);

        async function previewVersion(v) {
            try {
                const d = await apiPost('getVersion', { uri, id: v.id });
                setPreview({
                    title: 'Version' + (v.label ? ' · ' + v.label : '') + ' · ' + new Date(v.timestamp).toLocaleString(),
                    content: d.content || '',
                });
            } catch { HFS.toast('Failed to load version', 'error'); }
        }
        async function previewItem(it) {
            try {
                if (it.kind === 'draft') {
                    const d = await apiPost('getDraftSnapshot', { uri, id: it.id });
                    setPreview({
                        title: 'Draft Snapshot · ' + new Date(it.ts).toLocaleString(),
                        content: d.content || '',
                    });
                } else if (it.kind === 'action' && it.versionId) {
                    const d = await apiPost('getVersion', { uri, id: it.versionId });
                    setPreview({
                        title: 'Meta · ' + new Date(it.ts).toLocaleString(),
                        content: d.content || '',
                    });
                }
            } catch { HFS.toast('Failed to load', 'error'); }
        }
        async function previewCurrentDraft() {
            if (!currentDraft) return;
            setPreview({
                title: 'Current Draft · ' + new Date(currentDraft.timestamp).toLocaleString(),
                content: currentDraft.content,
            });
        }
        async function doRestore(content) {
            if (!await HFS.dialogLib.confirmDialog('Restore', 'Replace editor content with this version? Unsaved changes will be lost.')) return;
            onRestore(content);
            onClose();
        }
        async function toggleFlag(item) {
            try {
                const flagged = !(item.starred || item.locked);
                await apiPost('updateVersionMeta', { uri, id: item.id, starred: flagged, locked: flagged });
                await refresh();
            } catch { HFS.toast('Failed', 'error'); }
        }
        async function updateLabel(item, label) {
            try {
                await apiPost('updateVersionMeta', { uri, id: item.id, label: label || null });
                await refresh();
            } catch { HFS.toast('Failed', 'error'); }
        }
        async function deleteVersion(item) {
            if (item.locked) { HFS.toast('Marked-important version cannot be deleted', 'info'); return; }
            if (!await HFS.dialogLib.confirmDialog('Delete', 'Delete this version?')) return;
            try { await apiPost('deleteVersion', { uri, id: item.id }); await refresh(); }
            catch { HFS.toast('Failed', 'error'); }
        }

        const VersionRow = React.memo(function VersionRow(props) {
            const { v } = props;
            const [editing, setEditing] = React.useState(false);
            const [draftLabel, setDraftLabel] = React.useState(v.label || '');
            const inputRef = React.useRef(null);
            const flagged = !!(v.starred || v.locked);

            React.useEffect(() => {
                if (!editing) setDraftLabel(v.label || '');
            }, [v.label, editing]);

            React.useEffect(() => {
                if (editing && inputRef.current) {
                    inputRef.current.focus();
                    inputRef.current.select();
                }
            }, [editing]);

            async function commit() {
                const val = draftLabel.trim();
                setEditing(false);
                if ((v.label || '') !== val) {
                    await props.updateLabel(v, val);
                }
            }
            function cancel() {
                setEditing(false);
                setDraftLabel(v.label || '');
            }

            return React.createElement('div', { className: 'dv-history-row' },
                React.createElement('button', {
                    className: 'dv-history-flag' + (flagged ? ' flagged' : ''),
                    onClick: () => props.toggleFlag(v),
                    title: flagged ? 'Important (click to unmark)' : 'Mark as important (kept forever)'
                }, flagged ? '\uFE0E★' : '\uFE0E☆'),
                React.createElement('span', { className: 'dv-history-time' }, new Date(v.timestamp).toLocaleString()),
                editing ?
                    React.createElement('input', {
                        key: 'rename-input-' + v.id,
                        ref: inputRef,
                        className: 'dv-history-rename-input',
                        value: draftLabel,
                        onChange: e => setDraftLabel(e.target.value),
                        onKeyDown: e => {
                            if (e.key === 'Enter') { e.preventDefault(); commit(); }
                            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                        },
                        onBlur: () => { commit(); },
                    })
                    :
                    React.createElement('span', {
                        className: 'dv-history-label' + (v.label ? '' : ' no-label'),
                        onClick: () => setEditing(true),
                        title: 'Click to rename'
                    }, v.label || '(no label)'),
                editing ? React.createElement('button', {
                    key: 'rename-ok-' + v.id,
                    className: 'dv-history-btn',
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: () => commit()
                }, '✓') : null,
                React.createElement('span', { className: 'dv-history-size' }, formatBytes(v.size)),
                React.createElement('button', { className: 'dv-history-btn', onClick: () => props.previewVersion(v) }, 'Preview'),
                React.createElement('button', {
                    className: 'dv-history-btn',
                    onClick: async () => {
                        const d = await apiPost('getVersion', { uri, id: v.id });
                        props.doRestore(d.content || '');
                    }
                }, 'Restore'),
                React.createElement('button', {
                    className: 'dv-history-btn danger',
                    onClick: () => props.deleteVersion(v),
                    title: 'Delete'
                }, '×')
            );
        });

        const renderVersionRow = (v) => React.createElement(VersionRow, {
            key: 'v-' + v.id,
            v,
            toggleFlag, updateLabel,
            previewVersion, doRestore, deleteVersion,
        });

        const renderTimelineRow = (it) => {
            const timeStr = new Date(it.ts).toLocaleString();
            if (it.kind === 'action') {
                return React.createElement('div', { key: 'a-' + it.ts, className: 'dv-history-row' },
                    React.createElement('span', { className: 'dv-history-time' }, timeStr),
                    React.createElement('span', { className: 'dv-history-kind' },
                        it.type === 'meta' ? '\uFE0EⓂ Meta updated' : it.type),
                    it.versionId ? React.createElement('button', {
                        className: 'dv-history-btn', onClick: () => previewItem(it)
                    }, 'Preview') : null,
                    it.versionId ? React.createElement('button', {
                        className: 'dv-history-btn',
                        onClick: async () => {
                            const d = await apiPost('getVersion', { uri, id: it.versionId });
                            if (d.ok) doRestore(d.content || '');
                        }
                    }, 'Restore') : null
                );
            }
            return React.createElement('div', { key: 'd-' + it.id, className: 'dv-history-row' },
                React.createElement('span', { className: 'dv-history-time' }, timeStr),
                React.createElement('span', { className: 'dv-history-kind' }, '\uFE0E▤ Draft snapshot'),
                React.createElement('span', { className: 'dv-history-size' }, formatBytes(it.size)),
                React.createElement('button', { className: 'dv-history-btn', onClick: () => previewItem(it) }, 'Preview'),
                React.createElement('button', {
                    className: 'dv-history-btn', onClick: async () => {
                        const d = await apiPost('getDraftSnapshot', { uri, id: it.id });
                        doRestore(d.content || '');
                    }
                }, 'Restore')
            );
        };

        const renderCurrentDraftRow = () => {
            if (!currentDraft) {
                return React.createElement('div', { className: 'dv-history-current-draft-empty' }, 'No current draft');
            }
            return React.createElement('div', { key: 'current-draft', className: 'dv-history-row current-draft' },
                React.createElement('span', { className: 'dv-history-time' }, new Date(currentDraft.timestamp).toLocaleString()),
                React.createElement('span', { className: 'dv-history-kind', style: { fontWeight: 600 } }, '\uFE0E✎ Current Draft (unsaved)'),
                React.createElement('span', { className: 'dv-history-size' }, formatBytes((currentDraft.content || '').length)),
                React.createElement('button', { className: 'dv-history-btn', onClick: previewCurrentDraft }, 'Preview'),
                React.createElement('button', { className: 'dv-history-btn', onClick: () => { doRestore(currentDraft.content || ''); } }, 'Restore')
            );
        };

        const renderList = () => {
            if (loading) return React.createElement('div', { className: 'dv-history-empty' }, 'Loading…');
            if (tab === 'versions') {
                return versions.length === 0 ?
                    React.createElement('div', { className: 'dv-history-empty' }, 'No saved versions yet') :
                    versions.map(renderVersionRow);
            }
            const rows = [renderCurrentDraftRow()];
            if (timeline.length === 0) {
                if (currentDraft) return rows;
                return React.createElement('div', { className: 'dv-history-empty' }, 'No timeline entries yet');
            }
            for (const it of timeline) rows.push(renderTimelineRow(it));
            return rows;
        };

        return React.createElement('div', { className: 'dv-history-backdrop' },
            React.createElement('div', { className: 'dv-history-panel' },
                React.createElement('div', { className: 'dv-history-header' },
                    React.createElement('span', { className: 'dv-history-title' }, 'History · ' + uri),
                    React.createElement('button', {
                        className: 'dv-history-tab' + (tab === 'versions' ? ' active' : ''),
                        onClick: () => { setTab('versions'); setPreview(null); }
                    }, 'Versions'),
                    React.createElement('button', {
                        className: 'dv-history-tab' + (tab === 'timeline' ? ' active' : ''),
                        onClick: () => { setTab('timeline'); setPreview(null); }
                    }, 'Timeline'),
                    React.createElement('button', { className: 'dv-history-close', onClick: onClose }, '×')
                ),
                React.createElement('div', { className: 'dv-history-body' },
                    React.createElement('div', { className: 'dv-history-list' }, renderList()),
                    React.createElement('div', { className: 'dv-history-preview' },
                        React.createElement('div', { className: 'dv-history-preview-title' }, preview ? preview.title : 'Preview'),
                        React.createElement('pre', { className: 'dv-history-preview-content' }, preview ? preview.content : 'Select an item to preview')
                    )
                )
            )
        );
    }

    function UnsavedChangesDialog({ onSave, onDiscard, onCancel }) {
        return React.createElement('div', {
            className: 'dv-unsaved-backdrop',
            onClick: (e) => { if (e.target === e.currentTarget) onCancel(); }
        },
            React.createElement('div', { className: 'dv-unsaved-dialog', role: 'dialog', 'aria-modal': 'true' },
                React.createElement('div', { className: 'dv-unsaved-title' }, 'Unsaved changes'),
                React.createElement('div', { className: 'dv-unsaved-body' }, 'You have unsaved changes. What would you like to do?'),
                React.createElement('div', { className: 'dv-unsaved-actions' },
                    React.createElement('button', { className: 'dv-btn dv-btn-save', onClick: onSave }, 'Save'),
                    React.createElement('button', { className: 'dv-btn', onClick: onDiscard }, 'Discard'),
                    React.createElement('button', { className: 'dv-btn', onClick: onCancel }, 'Cancel')
                )
            )
        );
    }

    function openEditorDialog(ent) {
        let dialog;
        const dialogDescriptor = {
            title: 'Editing ' + (ent.name || ent.n || ''),
            Content() {
                const [value, change] = r.useState('');
                const [originalContent, setOriginalContent] = r.useState('');
                const [dirty, setDirty] = r.useState(false);
                const [loading, setLoading] = r.useState(true);
                const [wrapMode, setWrapMode] = r.useState(() => {
                    try { return localStorage.getItem('dv.wrapMode') === 'off' ? 'off' : 'soft'; } catch { return 'soft'; }
                });
                const [fontScale, setFontScale] = r.useState(() => {
                    try { const v = parseFloat(localStorage.getItem('dv.fontScale')); if (isFinite(v) && v >= 0.75 && v <= 2) return v; } catch {}
                    return 1;
                });
                const [encoding, setEncoding] = r.useState(() => {
                    try { return localStorage.getItem('dv.encoding') || defaultEncoding; } catch { return defaultEncoding; }
                });
                const [highlightOn, setHighlightOn] = r.useState(() => {
                    try { return localStorage.getItem('dv.highlight') === '1'; } catch { return false; }
                });
                const [undoStack, setUndoStack] = r.useState([]);
                const [redoStack, setRedoStack] = r.useState([]);
                const [historyOpen, setHistoryOpen] = r.useState(false);
                const [unsavedPrompt, setUnsavedPrompt] = r.useState(false);
                const [lastModified, setLastModified] = r.useState(null);
                const [searchOpen, setSearchOpen] = r.useState(false);
                const [searchTerm, setSearchTerm] = r.useState('');
                const [searchIndex, setSearchIndex] = r.useState(0);

                const [hlInput, setHlInput] = r.useState('');
                const [viewStart, setViewStart] = r.useState(0);
                const [viewEnd, setViewEnd] = r.useState(200);
                const scrollRef = r.useRef(null);
                const lineHeightRef = r.useRef(20);

                const searchInputRef = r.useRef(null);
                const draftTimer = r.useRef(null);
                const lastHistoryTime = r.useRef(0);
                const dirtyRef = r.useRef(false);
                const uri = ent.uri || ent.href || '';
                const reloadNonceRef = r.useRef(0);

                const prevValueRef = r.useRef('');
                const initializedRef = r.useRef(false);
                const undoStackRef = r.useRef([]);
                const redoStackRef = r.useRef([]);

                const closedRef = r.useRef(false);

                r.useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

                r.useEffect(() => {
                    const timer = setTimeout(() => setupFullscreenDialog(), 50);
                    return () => clearTimeout(timer);
                }, []);

                function resetHistoryBaseline(newValue) {
                    initializedRef.current = true;
                    prevValueRef.current = newValue;
                    undoStackRef.current = [];
                    redoStackRef.current = [];
                    lastHistoryTime.current = 0;
                    setUndoStack([]);
                    setRedoStack([]);
                }

                r.useEffect(() => {
                    let cancelled = false;
                    const nonce = ++reloadNonceRef.current;
                    setLoading(true);
                    // 打開時不觸發 lazyCleanup（避免創建 cache）
                    fetch(uri + (uri.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' })
                        .then(res => {
                            if (!res.ok) throw new Error('HTTP ' + res.status);
                            try {
                                const lm = res.headers.get('last-modified');
                                if (lm) setLastModified(lm);
                            } catch {}
                            return res.arrayBuffer();
                        })
                        .then(buf => {
                            if (cancelled || nonce !== reloadNonceRef.current) return;
                            const text = decodeBytes(buf, encoding);
                            change(text);
                            setHlInput(text);
                            setOriginalContent(text);
                            setLoading(false);
                            resetHistoryBaseline(text);
                            if (nonce === 1) {
                                loadDraft(uri).then(draft => {
                                    if (!draft || draft.content === text) return;
                                    if (confirm('Found unsaved draft (' + new Date(draft.timestamp).toLocaleString() + '). Restore?')) {
                                        change(draft.content);
                                        setHlInput(draft.content);
                                        setDirty(true);
                                        resetHistoryBaseline(draft.content);
                                    } else {
                                        clearDraft(uri);
                                    }
                                });
                            }
                        })
                        .catch(() => {
                            if (!cancelled && nonce === reloadNonceRef.current) {
                                change('');
                                setHlInput('');
                                setLoading(false);
                                resetHistoryBaseline('');
                            }
                        });
                    return () => { cancelled = true; };
                }, [uri, encoding]);

                // 定時 lazy cleanup：只在 dirty 時啟動
                r.useEffect(() => {
                    if (loading) return;
                    if (!uri) return;
                    if (!CACHE_ENABLED) return;
                    if (!dirty) return;
                    const id = setInterval(() => {
                        if (closedRef.current) return;
                        if (!dirtyRef.current) return;
                        silentLazyCleanup(uri);
                    }, AUTO_CLEANUP_INTERVAL_MS);
                    return () => clearInterval(id);
                }, [loading, uri, dirty]);

                // 關閉保底清理：只在 dirty 過時觸發
                r.useEffect(() => {
                    return () => {
                        closedRef.current = true;
                        if (CACHE_ENABLED && uri && dirtyRef.current) {
                            silentLazyCleanup(uri);
                        }
                    };
                }, [uri]);

                r.useEffect(() => {
                    if (loading) return;
                    setDirty(value !== originalContent);
                }, [value, originalContent, loading]);

                r.useEffect(() => {
                    if (loading) return;
                    const id = setTimeout(() => setHlInput(value), 120);
                    return () => clearTimeout(id);
                }, [value, loading]);

                r.useEffect(() => {
                    if (loading) return;
                    if (draftTimer.current) clearTimeout(draftTimer.current);
                    if (value !== originalContent) {
                        draftTimer.current = setTimeout(() => { saveDraft(uri, value); }, 3000);
                    }
                    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
                }, [value, originalContent, loading, uri]);

                r.useEffect(() => {
                    if (loading) return;
                    if (!initializedRef.current) {
                        initializedRef.current = true;
                        prevValueRef.current = value;
                        return;
                    }
                    const prev = prevValueRef.current;
                    if (value === prev) return;
                    const now = Date.now();
                    if (now - lastHistoryTime.current >= 500) {
                        lastHistoryTime.current = now;
                        undoStackRef.current = [...undoStackRef.current, prev].slice(-100);
                        redoStackRef.current = [];
                        setUndoStack(undoStackRef.current.slice());
                        setRedoStack([]);
                    }
                    prevValueRef.current = value;
                }, [value, loading]);

                const searchMatches = React.useMemo(() => findMatches(value, searchTerm), [value, searchTerm]);
                r.useEffect(() => {
                    if (searchIndex >= searchMatches.length) setSearchIndex(0);
                }, [searchMatches.length, searchIndex]);
                r.useEffect(() => {
                    if (searchOpen && searchInputRef.current) {
                        searchInputRef.current.focus();
                        searchInputRef.current.select();
                    }
                }, [searchOpen]);

                r.useEffect(() => {
                    const el = scrollRef.current;
                    if (!el) return;
                    let raf = 0;
                    function measure() {
                        raf = 0;
                        const lh = lineHeightRef.current || 20;
                        const st = el.scrollTop;
                        const h = el.clientHeight;
                        const start = Math.max(0, Math.floor(st / lh) - VIEWPORT_BUFFER_LINES);
                        const end = Math.ceil((st + h) / lh) + VIEWPORT_BUFFER_LINES;
                        setViewStart(start);
                        setViewEnd(end);
                    }
                    function onScroll() {
                        if (raf) return;
                        raf = requestAnimationFrame(measure);
                    }
                    el.addEventListener('scroll', onScroll, { passive: true });
                    measure();
                    return () => {
                        el.removeEventListener('scroll', onScroll);
                        if (raf) cancelAnimationFrame(raf);
                    };
                }, [loading, wrapMode]);

                r.useEffect(() => {
                    const el = scrollRef.current;
                    if (!el) return;
                    const ta = el.querySelector('.dv-editor-textarea');
                    if (ta) {
                        const cs = getComputedStyle(ta);
                        const lh = parseFloat(cs.lineHeight);
                        if (isFinite(lh) && lh > 0) lineHeightRef.current = lh;
                    }
                    const ev = new Event('scroll');
                    el.dispatchEvent(ev);
                }, [fontScale, loading]);

                r.useEffect(() => {
                    if (!searchOpen || searchMatches.length === 0) return;
                    const m = searchMatches[searchIndex];
                    if (!m) return;
                    const scrollEl = scrollRef.current;
                    const ta = scrollEl ? scrollEl.querySelector('.dv-editor-textarea') : null;
                    if (!scrollEl || !ta) return;
                    try {
                        const before = value.slice(0, m.start);
                        const lineIndex = (before.match(/\n/g) || []).length;
                        const cs = getComputedStyle(ta);
                        const lineHeight = parseFloat(cs.lineHeight) || 20;
                        const paddingTop = parseFloat(cs.paddingTop) || 0;
                        const targetTop = paddingTop + lineIndex * lineHeight;
                        const viewH = scrollEl.clientHeight;
                        const newScroll = Math.max(0, targetTop - viewH / 2 + lineHeight / 2);
                        if (Math.abs(scrollEl.scrollTop - newScroll) > 4) {
                            scrollEl.scrollTop = newScroll;
                        }
                        if (document.activeElement === ta) {
                            ta.setSelectionRange(m.start, m.end);
                        }
                    } catch (e) {}
                }, [searchIndex, searchMatches, searchOpen, value]);

                const ext = (ent.name || ent.n || '').split('.').pop().toLowerCase();
                const hlHardDisabled = value.length > HL_HARD_MAX;
                const hlActive = !searchOpen && highlightOn && !hlHardDisabled;
                const theme = React.useMemo(() => {
                    if (searchOpen) {
                        return () => wrapSearch(value, searchMatches, searchIndex);
                    }
                    if (!hlActive) {
                        return () => escapeHtml(hlInput);
                    }
                    const highlighter = (window.DocViewerThemes && window.DocViewerThemes.sniff)
                        ? window.DocViewerThemes.sniff(hlInput, ext)
                        : null;
                    if (!highlighter) return () => escapeHtml(hlInput);
                    return () => buildViewportHighlight(hlInput, viewStart, viewEnd, highlighter);
                }, [hlInput, value, searchOpen, searchMatches, searchIndex, hlActive, ext, viewStart, viewEnd]);

                const [charCount, setCharCount] = r.useState({ chars: 0, lines: 0 });
                r.useEffect(() => {
                    let cancelled = false;
                    const run = () => { if (!cancelled) setCharCount(countChars(value)); };
                    if (typeof requestIdleCallback === 'function') {
                        const id = requestIdleCallback(run);
                        return () => { cancelled = true; cancelIdleCallback(id); };
                    }
                    const id = setTimeout(run, 0);
                    return () => { cancelled = true; clearTimeout(id); };
                }, [value]);

                function doSave() {
                    if (loading || value === originalContent) return Promise.resolve(false);
                    const savedValue = value;
                    return saveContent(uri, savedValue, encoding)
                        .then(res => {
                            if (!res.ok) throw new Error('HTTP ' + res.status);
                            try {
                                const lm = res.headers.get('last-modified');
                                if (lm) setLastModified(lm);
                            } catch {}
                            return res;
                        })
                        .then(() => {
                            setOriginalContent(savedValue);
                            setDirty(false);
                            if (CACHE_ENABLED) {
                                clearDraft(uri);
                                apiPost('recordVersion', { uri, content: savedValue })
                                    .catch(e => console.warn('[doc-viewer] recordVersion failed', e));
                            }
                            if (HFS.reloadList) HFS.reloadList();
                            return true;
                        })
                        .catch(e => { alert('Save failed: ' + e.message); return false; });
                }
                function save() { doSave(); }

                function doCloseNow() {
                    if (dialog && dialog.close) dialog.close();
                    else {
                        const closer = document.querySelector('.dialog-backdrop.dv-dialog-fullscreen .dialog-closer');
                        if (closer) {
                            window.__dvTryClose = null;
                            closer.click();
                        }
                    }
                }
                function tryClose() {
                    if (!dirtyRef.current) { doCloseNow(); return; }
                    setUnsavedPrompt(true);
                }
                r.useEffect(() => {
                    window.__dvTryClose = tryClose;
                    return () => { if (window.__dvTryClose === tryClose) window.__dvTryClose = null; };
                });

                async function handlePromptSave() {
                    const ok = await doSave();
                    setUnsavedPrompt(false);
                    if (ok) doCloseNow();
                }
                function handlePromptDiscard() {
                    setUnsavedPrompt(false);
                    clearDraft(uri);
                    doCloseNow();
                }
                function handlePromptCancel() { setUnsavedPrompt(false); }

                const handleUndo = () => {
                    if (undoStackRef.current.length === 0) return;
                    const prev = undoStackRef.current[undoStackRef.current.length - 1];
                    redoStackRef.current = [...redoStackRef.current, value];
                    undoStackRef.current = undoStackRef.current.slice(0, -1);
                    prevValueRef.current = prev;
                    setUndoStack(undoStackRef.current.slice());
                    setRedoStack(redoStackRef.current.slice());
                    change(prev);
                };
                const handleRedo = () => {
                    if (redoStackRef.current.length === 0) return;
                    const next = redoStackRef.current[redoStackRef.current.length - 1];
                    undoStackRef.current = [...undoStackRef.current, value];
                    redoStackRef.current = redoStackRef.current.slice(0, -1);
                    prevValueRef.current = next;
                    setUndoStack(undoStackRef.current.slice());
                    setRedoStack(redoStackRef.current.slice());
                    change(next);
                };

                const toggleWrap = () => {
                    const next = wrapMode === 'off' ? 'soft' : 'off';
                    setWrapMode(next);
                    try { localStorage.setItem('dv.wrapMode', next); } catch {}
                };
                const zoomIn = () => {
                    const next = Math.min(2.0, +(fontScale + 0.1).toFixed(2));
                    setFontScale(next);
                    try { localStorage.setItem('dv.fontScale', String(next)); } catch {}
                };
                const zoomOut = () => {
                    const next = Math.max(0.75, +(fontScale - 0.1).toFixed(2));
                    setFontScale(next);
                    try { localStorage.setItem('dv.fontScale', String(next)); } catch {}
                };
                const changeEncoding = (enc) => {
                    setEncoding(enc);
                    try { localStorage.setItem('dv.encoding', enc); } catch {}
                };
                const toggleHighlight = () => {
                    const next = !highlightOn;
                    setHighlightOn(next);
                    try { localStorage.setItem('dv.highlight', next ? '1' : '0'); } catch {}
                };

                const toggleSearch = () => {
                    const next = !searchOpen;
                    setSearchOpen(next);
                    if (!next) { setSearchTerm(''); setSearchIndex(0); }
                };
                const searchNext = () => {
                    if (searchMatches.length === 0) return;
                    setSearchIndex(i => (i + 1) % searchMatches.length);
                };
                const searchPrev = () => {
                    if (searchMatches.length === 0) return;
                    setSearchIndex(i => (i - 1 + searchMatches.length) % searchMatches.length);
                };

                const onKeyDown = (e) => {
                    if (e.target && e.target.classList && e.target.classList.contains('dv-search-input')) return;
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
                    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
                        e.preventDefault(); handleRedo();
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                        e.preventDefault();
                        setSearchOpen(true);
                    }
                };

                const onSearchKeyDown = (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        if (e.shiftKey) searchPrev(); else searchNext();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setSearchOpen(false);
                        setSearchTerm('');
                        setSearchIndex(0);
                    }
                };

                const fontSize = Math.round(13 * fontScale);

                if (loading) {
                    return HFS.h('div', { className: 'dv-loading' }, 'Loading…');
                }

                const searchBar = searchOpen ? HFS.h('div', { key: 'searchbar', className: 'dv-searchbar' }, [
                    HFS.h('input', {
                        key: 'input',
                        ref: searchInputRef,
                        className: 'dv-search-input',
                        type: 'text',
                        placeholder: 'Search…',
                        value: searchTerm,
                        onChange: (e) => { setSearchTerm(e.target.value); setSearchIndex(0); },
                        onKeyDown: onSearchKeyDown,
                    }),
                    HFS.h('span', { key: 'count', className: 'dv-search-count' },
                        searchTerm
                            ? (searchMatches.length === 0 ? '0 / 0' : ((searchIndex + 1) + ' / ' + searchMatches.length))
                            : ''),
                    HFS.h('button', {
                        key: 'prev', type: 'button', title: 'Previous match (Shift+Enter)',
                        className: 'dv-btn dv-btn-icon',
                        onClick: searchPrev,
                        disabled: searchMatches.length === 0,
                    }, '▲'),
                    HFS.h('button', {
                        key: 'next', type: 'button', title: 'Next match (Enter)',
                        className: 'dv-btn dv-btn-icon',
                        onClick: searchNext,
                        disabled: searchMatches.length === 0,
                    }, '▼'),
                    HFS.h('button', {
                        key: 'close', type: 'button', title: 'Close search (Esc)',
                        className: 'dv-btn dv-btn-icon',
                        onClick: toggleSearch,
                    }, '×'),
                ]) : null;

                return HFS.h('div', { className: 'dv-workspace' }, [
                    HFS.h('span', { key: 'title-actions', className: 'dv-title-actions' }, [
                        CACHE_ENABLED && HFS.h('button', {
                            key: 'history', type: 'button', title: 'History (Versions / Timeline)',
                            className: 'dv-btn dv-btn-wide',
                            onClick: () => setHistoryOpen(true)
                        }, '⟲ History'),
                        HFS.h('button', {
                            key: 'undo', type: 'button', title: 'Undo (Ctrl+Z)',
                            className: 'dv-btn dv-btn-icon',
                            onClick: handleUndo,
                            disabled: undoStack.length === 0
                        }, '↶'),
                        HFS.h('button', {
                            key: 'redo', type: 'button', title: 'Redo (Ctrl+Y)',
                            className: 'dv-btn dv-btn-icon',
                            onClick: handleRedo,
                            disabled: redoStack.length === 0
                        }, '↷'),
                        lastModified && HFS.h('span', {
                            key: 'lm', className: 'dv-title-lastmod', title: 'Last modified'
                        }, '· ' + formatDate(lastModified)),
                    ].filter(Boolean)),
                    HFS.h('div', { key: 'toolbar', className: 'dv-toolbar' }, [
                        HFS.h('span', { key: 'dirty', className: 'dv-toolbar-dirty' + (dirty ? '' : ' hidden') }, '●'),
                        dirty && HFS.h('span', { key: 'ns', className: 'dv-toolbar-unsaved-label' }, 'not saved'),
                        HFS.h('span', {
                            key: 'chars', className: 'dv-toolbar-charcount',
                            title: charCount.lines + ' line' + (charCount.lines === 1 ? '' : 's')
                        }, charCount.chars.toLocaleString() + ' chars'),
                        HFS.h('span', { key: 'size', className: 'dv-toolbar-size' },
                            ent.s != null ? formatBytes(ent.s) : ''),
                        HFS.h('span', { key: 'right-group', className: 'dv-toolbar-right' }, [
                            HFS.h('button', {
                                key: 'search', type: 'button', title: 'Search (Ctrl+F)',
                                className: 'dv-btn dv-btn-icon' + (searchOpen ? ' active' : ''),
                                onClick: toggleSearch
                            }, '\uFE0EⓈ'),
                            HFS.h('button', {
                                key: 'hl', type: 'button',
                                title: hlHardDisabled
                                    ? 'Highlight disabled (file too large for syntax highlighting)'
                                    : (highlightOn ? 'Highlight: ON (click to disable)' : 'Highlight: OFF (click to enable)'),
                                className: 'dv-btn dv-btn-hl' + (highlightOn && !hlHardDisabled ? ' active' : ''),
                                onClick: toggleHighlight,
                                disabled: hlHardDisabled,
                            }, highlightOn && !hlHardDisabled ? '\uFE0EⒽ' : '\uFE0EⒽ'),
                            HFS.h('button', {
                                key: 'wrap', type: 'button',
                                title: wrapMode === 'off' ? 'Wrap: OFF' : 'Wrap: ON',
                                className: 'dv-btn dv-btn-wrap' + (wrapMode === 'soft' ? ' active' : ''),
                                onClick: toggleWrap
                            }, wrapMode === 'off' ? '\uFE0EⓌ' : '\uFE0EⓌ'),
                            HFS.h('button', {
                                key: 'fm', type: 'button', title: 'Decrease font size',
                                className: 'dv-btn dv-btn-zoom', onClick: zoomOut
                            }, 'A−'),
                            HFS.h('button', {
                                key: 'fp', type: 'button', title: 'Increase font size',
                                className: 'dv-btn dv-btn-zoom', onClick: zoomIn
                            }, 'A+'),
                            HFS.h('select', {
                                key: 'enc',
                                className: 'dv-encoding-select',
                                title: (ENCODINGS.find(o => o.value === encoding) || {}).hint || 'Encoding',
                                value: encoding,
                                onChange: (e) => changeEncoding(e.target.value),
                            },
                                ENCODINGS.map(o => HFS.h('option', { key: o.value, value: o.value, title: o.hint }, o.label))
                            ),
                            HFS.h('button', {
                                key: 'save', type: 'button',
                                title: dirty ? 'Save (Ctrl+S)' : 'No changes to save',
                                className: 'dv-btn-save' + (dirty ? '' : ' dv-btn-save-idle'),
                                onClick: save,
                                disabled: !dirty,
                            }, 'Save'),
                        ]),
                    ]),
                    searchBar,
                    HFS.h('div', {
                        key: 'editor',
                        ref: scrollRef,
                        className: 'dv-editor-scroll' + (wrapMode === 'off' ? ' no-wrap' : '')
                    }, [
                        HFS.h(Editor, {
                            key: 'ce',
                            value, onValueChange: change, highlight: theme,
                            padding: 16, tabSize: 4, insertSpaces: true,
                            textareaClassName: 'dv-editor-textarea',
                            preClassName: 'dv-editor-pre',
                            style: {
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                                fontSize: fontSize + 'px',
                                lineHeight: 1.55,
                                minHeight: '100%',
                                boxSizing: 'border-box',
                                background: 'var(--bg)',
                                color: 'var(--text)',
                                width: wrapMode === 'off' ? 'max-content' : '100%',
                                minWidth: '100%',
                                overflow: wrapMode === 'off' ? 'visible' : 'hidden',
                            },
                            onKeyDown,
                        })
                    ]),
                    CACHE_ENABLED && historyOpen && HFS.h(HistoryDialog, {
                        key: 'history-dialog',
                        uri, encoding,
                        onClose: () => setHistoryOpen(false),
                        onRestore: (content) => {
                            change(content);
                            setHlInput(content);
                            setDirty(true);
                            resetHistoryBaseline(content);
                        },
                    }),
                    unsavedPrompt && HFS.h(UnsavedChangesDialog, {
                        key: 'unsaved',
                        onSave: handlePromptSave,
                        onDiscard: handlePromptDiscard,
                        onCancel: handlePromptCancel,
                    }),
                ].filter(Boolean));
            }
        };

        dialog = HFS.dialogLib.newDialog(dialogDescriptor);
        setTimeout(setupFullscreenDialog, 100);
        setTimeout(setupFullscreenDialog, 300);
    }

    // ============================================================
    // 右鍵菜單：對「所有 Doc-viewer 支持的格式」顯示 Edit
    // 包括 html / htm / xhtml（即使它們默認不在 editableExts 中）
    // ============================================================
    HFS.onEvent('fileMenu', ({ entry: ent }) => {
        const showCreateFile = ent.isFolder && ent.uri === location.pathname && HFS.state.props.can_upload;
        if (ent.isFolder && !showCreateFile) return;
        if (!HFS.state.props.can_upload) return;

        if (!ent.isFolder && Number(ent.s) > limit) {
            const name = ent.n || ent.name || '';
            // 用「完整支持列表」判斷是否顯示「文件太大」提示
            if (isSupportedDocName(name)) {
                return {
                    label: 'Edit (too large)', icon: 'edit',
                    onClick() { alert('File too large to edit (' + formatBytes(ent.s) + '). Limit: ' + (limit / 1024 / 1024) + ' MB.'); },
                };
            }
            return;
        }

        if (showCreateFile) {
            let dialog;
            return {
                label: 'Create file',
                icon: 'file',
                onClick() {
                    dialog = HFS.dialogLib.newDialog({
                        title: 'Create file',
                        Content() {
                            const [f, sf] = r.useState('');
                            return HFS.h(r.Fragment, null,
                                HFS.h('form', {
                                    onSubmit: (e) => { e.preventDefault(); createFile(ent.uri, f, dialog); },
                                    style: { marginTop: 10 }
                                },
                                    HFS.h('label', { style: { marginBottom: 10, display: 'block' } }, 'Enter file name'),
                                    HFS.h('input', { name: 'input', onChange(e) { sf(e.target.value); } })
                                ),
                                HFS.h('div', { style: { marginTop: 10, display: 'flex', justifyContent: 'flex-end' } },
                                    HFS.h('button', { onClick: () => createFile(ent.uri, f, dialog) }, 'Create')
                                )
                            );
                        }
                    });
                }
            };
        }

        // 用「完整支持列表」判斷是否顯示 Edit（含 html/htm/xhtml）
        if (!isSupportedDocName(ent.n || ent.name || '')) return;

        return {
            label: 'Edit',
            icon: 'edit',
            onClick() { openEditorDialog(ent); }
        };
    });

    async function createFile(path, filename, d) {
        if (!filename) return;
        if (path === '/') path = '';
        const uri = `${path}/${filename}`;
        const s = await HFS.apiCall('get_file_list', { uri: path });
        if (s.list.find(f => !f.isFolder && f.n === filename)) {
            return HFS.dialogLib.newDialog({
                title: 'Conflict',
                Content: () => HFS.h('div', null, 'File already exists, choose a different name')
            });
        }
        return fetch(uri, { method: 'PUT', body: '' }).then(d.close).then(HFS.reloadList);
    }

    function setupFullscreenDialog() {
        const backdrops = document.querySelectorAll('.dialog-backdrop');
        if (backdrops.length === 0) return null;
        const backdrop = backdrops[backdrops.length - 1];
        if (backdrop.dataset.dvFullscreen === '1') return backdrop;
        backdrop.dataset.dvFullscreen = '1';
        backdrop.classList.add('dv-dialog-fullscreen');

        const stopClick = (e) => {
            if (e.target === backdrop) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }
        };
        backdrop.addEventListener('click', stopClick, true);
        backdrop.addEventListener('mousedown', stopClick, true);
        backdrop.addEventListener('touchstart', stopClick, true);

        const closer = backdrop.querySelector('.dialog-closer');
        if (closer) {
            const onCloser = (e) => {
                if (typeof window.__dvTryClose === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    window.__dvTryClose();
                }
            };
            closer.addEventListener('click', onCloser, true);
            backdrop.dataset.dvCloserPatched = '1';
        }

        const onEsc = (e) => {
            if (e.key !== 'Escape') return;
            if (typeof window.__dvTryClose !== 'function') return;
            const active = document.activeElement;
            if (active && active.closest && active.closest('.dv-unsaved-dialog')) return;
            if (active && active.classList && active.classList.contains('dv-search-input')) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            window.__dvTryClose();
        };
        document.addEventListener('keydown', onEsc, true);
        backdrop.__dvEscHandler = onEsc;

        return backdrop;
    }

    IconHijack._openDialog = openEditorDialog;
    IconHijack.start();
    HFS.onEvent('afterList', () => {
        setTimeout(() => IconHijack.hijackAllIcons(), 50);
        setTimeout(() => IconHijack.hijackAllIcons(), 300);
        setTimeout(() => IconHijack.hijackAllIcons(), 800);
    });

    HFS.onEvent('configChanged', (newCfg) => {
        if (!newCfg) return;
        if ('autoBackup' in newCfg) {
            const newCacheEnabled = newCfg.autoBackup !== false;
            if (newCacheEnabled !== CACHE_ENABLED) {
                if (confirm('Cache master switch changed. Reload page to apply?')) {
                    location.reload();
                }
                return;
            }
        }
        if ('editableExts' in newCfg) {
            const oldExts = EDITABLE_EXTS.join(',');
            const newExts = parseEditableExts(newCfg.editableExts).join(',');
            if (oldExts !== newExts) {
                if (confirm('Editable extension list changed. Reload page to apply?')) {
                    location.reload();
                }
            }
        }
    });

    window.DocViewer = {
        version: '8.6.0',
        config: cfg,
        cacheEnabled: CACHE_ENABLED,
        editableExts: EDITABLE_EXTS,
        supportedExts: ALL_SUPPORTED_EXTS,
        openEditorDialog,
        IconHijack,
    };
    console.log('[doc-viewer] loaded, version 8.6.0, cacheEnabled:', CACHE_ENABLED,
        'supported:', ALL_SUPPORTED_EXTS.length,
        'iconHijack:', EDITABLE_EXTS.length);
}