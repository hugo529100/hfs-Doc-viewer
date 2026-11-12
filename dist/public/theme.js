'use strict';
(function () {
    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const MAX_HL_CHARS = 200000;   // 单次高亮最大字符数（超出走纯转义）
    const MAX_COLOR_CHARS = 400000;

    const C = {
        variable: '#9cdcfe', attr: '#9cdcfe',
        function: '#dcdcaa',
        keyword: '#569cd6', tag: '#569cd6',
        type: '#c586c0',
        string: '#ce9178', number: '#b5cea8', selector: '#d7ba7d',
        comment: '#6a9955', booleanTrue: '#6a9955',
        booleanFalse: '#f44747',
        operator: '#d4d4d4', punctuation: '#d4d4d4',
    };

    function span(color, text) {
        return '<span style="color:' + color + '">' + text + '</span>';
    }

    // ============================================================
    // 颜色字面量：实体预保护 + 单次 replace
    // ============================================================
    const COLOR_RE_SRC =
        '(?<!&)#[0-9a-fA-F]{3,8}\\b' +
        '|\\brgba?\\(\\s*\\d[^)]*\\)' +
        '|\\bhsla?\\(\\s*\\d[^)]*\\)' +
        '|\\btransparent\\b' +
        '|\\bcurrentColor\\b' +
        '|\\bvar\\(\\s*--[\\w-]+\\s*(?:,[^)]*)?\\)';
    const COLOR_RE = new RegExp(COLOR_RE_SRC, 'g');

    const ENTITY_RE = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

    // 实体 -> 哨兵（\u0001E<idx>\u0001），确保 #39 不被当成颜色
    function protectEntities(html) {
        const store = [];
        const out = html.replace(ENTITY_RE, (m) => {
            const key = '\u0001E' + store.length + '\u0001';
            store.push(m);
            return key;
        });
        return { out, store };
    }
    function restoreEntities(str, store) {
        if (store.length === 0) return str;
        return str.replace(/\u0001E(\d+)\u0001/g, (m, i) => store[+i]);
    }

    function wrapColorsInHtml(html) {
        if (!html) return html;
        if (html.length > MAX_COLOR_CHARS) return html;
        if (html.indexOf('#') < 0 && html.indexOf('rgb') < 0 &&
            html.indexOf('hsl') < 0 && html.indexOf('var(') < 0 &&
            html.indexOf('transparent') < 0 && html.indexOf('currentColor') < 0) {
            return html;
        }
        const { out, store } = protectEntities(html);
        // 只处理文本节点：把标签整段原样跳过
        const result = out.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, text) => {
            if (tag) return tag;
            return text.replace(COLOR_RE, (tok) => {
                const safe = tok.replace(/"/g, '&quot;');
                if (/^var\(/i.test(tok)) {
                    return '<span class="dv-css-var" style="color:' + safe + '">' + tok + '</span>';
                }
                if (/^transparent$/i.test(tok) || /^currentColor$/i.test(tok)) {
                    return '<span class="dv-color-token dv-color-keyword" data-kw="' + tok + '" style="--dv-color:transparent">' + tok + '</span>';
                }
                return '<span class="dv-color-token" style="--dv-color:' + safe + '">' + tok + '</span>';
            });
        });
        return restoreEntities(result, store);
    }

    // ============================================================
    // 通用：单遍 alternation 高亮器工厂
    // 规则数组：[{ re, rep }]，按顺序用一个大 regex 匹配，回调返回对应 HTML
    // ============================================================
    function buildHighlight(code, rules, fallbackEscape) {
        if (code.length > MAX_HL_CHARS) {
            return wrapColorsInHtml(escapeHtml(code));
        }
        const src = code; // 已在调用前 escape？
        // 这里要求传入的是「原文」，内部先 escape，再按 escaped 文本用规则匹配
        // 但规则里含 &quot; 等实体，需对 escaped 文本操作
        const esc = escapeHtml(code);
        // 合并正则：每条规则一个命名组
        const parts = [];
        const map = [];
        for (let i = 0; i < rules.length; i++) {
            parts.push('(' + rules[i].re.source + ')');
            map.push(rules[i].rep);
        }
        if (parts.length === 0) return wrapColorsInHtml(esc);
        const merged = new RegExp(parts.join('|'), 'gm');
        const out = esc.replace(merged, function () {
            for (let i = 0; i < map.length; i++) {
                // 找到第一个命中的组
                if (arguments[i + 1] !== undefined) {
                    const matched = arguments[0];
                    // 规则回调：fn(matched, group) => html
                    return map[i](matched);
                }
            }
            return arguments[0];
        });
        return wrapColorsInHtml(out);
    }

    // ============================================================
    // 各语言高亮器（规则顺序 = 优先级）
    // ============================================================
    function highlightPlain(code) {
        if (code.length > 400000) return wrapColorsInHtml(escapeHtml(code));
        const parts = [];
        const fence = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
        let last = 0, m;
        while ((m = fence.exec(code))) {
            if (m.index > last) parts.push({ type: 'text', text: code.slice(last, m.index) });
            parts.push({ type: 'fence', lang: (m[1] || '').toLowerCase(), text: m[2] });
            last = m.index + m[0].length;
        }
        if (last < code.length) parts.push({ type: 'text', text: code.slice(last) });

        return parts.map(p => {
            if (p.type === 'fence') {
                const fn = THEMES.get(p.lang) || highlightPlain;
                return '<span class="dv-fence-body">' + fn(p.text) + '</span>';
            }
            return wrapColorsInHtml(escapeHtml(p.text));
        }).join('');
    }

    function highlightJavaScript(code) {
        const rules = [
            { re: /`(?:\\.|[^`\\])*`/, rep: m => span(C.string, m) },
            { re: /(^|[^\w$)\]}\s])\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/, rep: m => m.replace(/(^[^\w$)\]}\s]?)/, '$1') },
            { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, rep: m => span(C.comment, m) },
            { re: /&quot;(?:\\.|[^&\\])*?&quot;|&#39;(?:\\.|[^&\\])*?&#39;/, rep: m => span(C.string, m) },
            { re: /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, rep: m => span(C.number, m) },
            { re: /\b(?:function|const|let|var|if|else|for|while|do|return|class|new|this|typeof|instanceof|in|of|async|await|try|catch|finally|throw|switch|case|break|continue|default|export|import|from|as|extends|super|static|get|set|delete|void|yield|with|debugger|null|undefined)\b/, rep: m => span(C.keyword, m) },
            { re: /\btrue\b/, rep: m => span(C.booleanTrue, m) },
            { re: /\bfalse\b/, rep: m => span(C.booleanFalse, m) },
            { re: /\b(?:String|Number|Boolean|Array|Object|Function|Promise|Map|Set|WeakMap|WeakSet|Symbol|BigInt|Date|RegExp|Error|JSON|Math|Reflect|Proxy)\b/, rep: m => span(C.type, m) },
            { re: /\b([a-zA-Z_$][\w$]*)(?=\s*\()/, rep: m => span(C.function, m) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightJson(code) {
        const rules = [
            { re: /&quot;(?:\\.|[^&\\])*?&quot;(\s*:)/, rep: m => m.replace(/^(&quot;[\s\S]*?&quot;)(\s*:)$/, (_, k, c) => span(C.variable, k) + c) },
            { re: /&quot;(?:\\.|[^&\\])*?&quot;/, rep: m => span(C.string, m) },
            { re: /\bnull\b/, rep: m => span(C.keyword, m) },
            { re: /\btrue\b/, rep: m => span(C.booleanTrue, m) },
            { re: /\bfalse\b/, rep: m => span(C.booleanFalse, m) },
            { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, rep: m => span(C.number, m) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightCss(code) {
        const rules = [
            { re: /\/\*[\s\S]*?\*\//, rep: m => span(C.comment, m) },
            { re: /([^{}]+)\{/, rep: m => m.replace(/([^{}]+)(\{)/, (_, sel, br) => span(C.selector, sel) + br) },
            { re: /([a-zA-Z-]+)(\s*:)(?!:)/, rep: m => m.replace(/([a-zA-Z-]+)(\s*:)/, (_, p, c) => span(C.variable, p) + c) },
            { re: /#[0-9a-fA-F]{3,8}|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg)?\b/, rep: m => span(C.number, m) },
            { re: /&quot;[^&]*?&quot;|&#39;[^&]*?&#39;/, rep: m => span(C.string, m) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightYaml(code) {
        const rules = [
            { re: /(^|[ \t])#(?=[ \t]|$)[^\n]*/m, rep: m => m.replace(/^([ \t])(#.*)$/, (_, sp, c) => sp + span(C.comment, c)) },
            { re: /^(---|\.\.\.)[ \t]*$/m, rep: m => span(C.punctuation, m) },
            { re: /(:\s*)([|>][-+]?)(?=\s*(?:#.*)?$)/m, rep: m => m.replace(/(:\s*)([|>][-+]?)/, (_, c, mk) => c + span(C.keyword, mk)) },
            { re: /^(\s*)(-)(\s)/m, rep: m => m.replace(/^(\s*)(-)(\s)/, (_, i, d, s) => i + span(C.keyword, d) + s) },
            { re: /^(\s*)(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)(\s*:)/m, rep: m => m.replace(/^(\s*)(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)(\s*:)/, (_, i, k, c) => i + span(C.variable, k) + span(C.punctuation, c)) },
            { re: /^(\s*)([^\s#\-][^:\n]*?)(\s*:)(?=\s|$)/m, rep: m => m.replace(/^(\s*)([^\s#\-][^:\n]*?)(\s*:)/, (_, i, k, c) => i + span(C.variable, k) + span(C.punctuation, c)) },
            { re: /(^|[ \t])([&*][\w-]+)/, rep: m => m.replace(/^(.*?)(&[&*][\w-]+|\*[&*][\w-]+)$/, (_, p, n) => p + span(C.type, n)) },
            { re: /(^|[ \t])(!![\w:/-]+)/, rep: m => m.replace(/^(.*?)(!![\w:/-]+)$/, (_, p, t) => p + span(C.tag, t)) },
            { re: /&#39;(?:[^&\n]|&amp;)*?&#39;/, rep: m => span(C.string, m) },
            { re: /&quot;(?:\\.|[^&\\])*?&quot;/, rep: m => span(C.string, m) },
            { re: /\b(?:true|yes|on|True|Yes|On)\b/, rep: m => span(C.booleanTrue, m) },
            { re: /\b(?:false|no|off|False|No|Off)\b/, rep: m => span(C.booleanFalse, m) },
            { re: /\b(?:null|~|Null|NULL)\b/, rep: m => span(C.keyword, m) },
            { re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/, rep: m => span(C.number, m) },
            { re: /(^|[ \t:,\[])(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/, rep: m => m.replace(/^(.*?)(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)$/, (_, p, n) => p + span(C.number, n)) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightPython(code) {
        const rules = [
            { re: /#[^\n]*/, rep: m => span(C.comment, m) },
            { re: /&quot;&quot;&quot;[\s\S]*?&quot;&quot;&quot;|&#39;&#39;&#39;[\s\S]*?&#39;&#39;&#39;|&quot;(?:\\.|[^&\\])*&quot;|&#39;(?:\\.|[^&\\])*&#39;/, rep: m => span(C.string, m) },
            { re: /\bNone\b/, rep: m => span(C.keyword, m) },
            { re: /\bTrue\b/, rep: m => span(C.booleanTrue, m) },
            { re: /\bFalse\b/, rep: m => span(C.booleanFalse, m) },
            { re: /\b(?:def|class|if|elif|else|for|while|return|yield|import|from|as|try|except|finally|with|pass|raise|global|nonlocal|lambda|and|or|not|in|is|async|await|assert|del|break|continue)\b/, rep: m => span(C.keyword, m) },
            { re: /\b\d+(?:\.\d+)?\b/, rep: m => span(C.number, m) },
            { re: /\b([a-zA-Z_]\w*)(?=\s*\()/, rep: m => span(C.function, m) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightMarkdown(code) {
        const rules = [
            { re: /^(#{1,6})\s+(.*)$/m, rep: m => m.replace(/^(#{1,6})\s+(.*)$/, (_, h, t) => span(C.keyword, h) + ' ' + '<span style="color:' + C.type + ';font-weight:bold">' + t + '</span>') },
            { re: /^(\s*)([*+-])(\s+)/m, rep: m => m.replace(/^(\s*)([*+-])(\s+)/, (_, i, b, s) => i + span(C.keyword, b) + s) },
            { re: /\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/, rep: m => '<span style="font-weight:bold;font-style:italic;color:' + C.function + '">' + m + '</span>' },
            { re: /\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/, rep: m => '<span style="font-weight:bold;color:' + C.function + '">' + m + '</span>' },
            { re: /(^|[^*\s])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=[^*\s]|$)/m, rep: m => m.replace(/^([^*\s]?)\*(.*?)\*$/, (_, p, t) => p + '<span style="font-style:italic;color:' + C.string + '">*' + t + '*</span>') },
            { re: /`([^`]+)`/, rep: m => '<span style="background:var(--ghost-contrast);color:' + C.string + ';padding:0 2px">' + m + '</span>' },
            { re: /\[([^\]]+)\]\(([^)]+)\)/, rep: m => span(C.type, m) },
            { re: /^>\s+(.*)$/m, rep: m => span(C.comment, m) },
        ];
        return buildHighlight(code, rules);
    }

    function highlightXml(code) {
        const rules = [
            { re: /&lt;!--[\s\S]*?--&gt;/, rep: m => span(C.comment, m) },
            { re: /(&lt;\/?)([a-zA-Z][\w-]*)([^&]*?)(\/?&gt;)/, rep: m => m.replace(/(&lt;\/?)([a-zA-Z][\w-]*)([^&]*?)(\/?&gt;)/, (_, open, tag, attrs, close) => {
                let out = span(C.punctuation, open) + span(C.tag, tag);
                out += attrs.replace(/([\w-]+)(\s*=\s*)(&quot;(?:\\.|[^&\\])*?&quot;|&#39;(?:\\.|[^&\\])*?&#39;)/, (_, n, eq, v) => span(C.attr, n) + span(C.punctuation, eq) + span(C.string, v));
                return out + span(C.punctuation, close);
            }) },
        ];
        return buildHighlight(code, rules);
    }

    function sniffHighlighter(code, ext) {
        const forced = THEMES.get(ext);
        if (forced && forced !== highlightPlain) return forced;
        const sample = String(code || '').slice(0, 4000);
        if (!sample) return highlightPlain;

        if (/^\s*(?:<\?xml|<!DOCTYPE|<html|<svg)/im.test(sample)) return highlightXml;
        if (/^\s*[\[{][\s\S]*[\]}]\s*$/m.test(sample) && /"\s*:\s*[\[{"\d]/.test(sample)) return highlightJson;
        if (/(?:^|\n)\s*(?:function|const|let|var|class|import|export|async|await)\b/.test(sample)) return highlightJavaScript;
        if (/(?:^|\n)\s*[\w$.]+\s*=\s*[\w$.]+\s*\(/.test(sample) && /[;]\s*$/m.test(sample)) return highlightJavaScript;
        if (/(?:^|\n)\s*(?:def |class \w+\(|import \w+|from \w+ import)/.test(sample)) return highlightPython;
        if (/(?:^|\n)\s*(?:\.[\w-]+|#[\w-]+|@media|@import|@keyframes|[a-z][\w-]*)[^{}\n]*\{[^{}]*[a-z-]+\s*:\s*[^;{}]+;?[^{}]*\}/i.test(sample)
            && !/(?:^|\n)\s*function\b/.test(sample)) return highlightCss;
        if (/(?:^|\n)\s*#{1,6}\s+\S/.test(sample) || /(?:^|\n)\s*[-*+]\s+\S/.test(sample)) return highlightMarkdown;

        return highlightPlain;
    }

    const THEMES = new Map();
    function register(exts, fn) { exts.forEach(ext => THEMES.set(ext.toLowerCase(), fn)); }

    register(['txt', 'log', 'nfo', 'readme', 'rtf'], highlightPlain);
    register(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'], highlightJavaScript);
    register(['json'], highlightJson);
    register(['yaml', 'yml'], highlightYaml);
    register(['css', 'scss', 'sass', 'less'], highlightCss);
    register(['py'], highlightPython);
    register(['md', 'markdown'], highlightMarkdown);
    register(['html', 'htm', 'xhtml', 'xml', 'svg'], highlightXml);

    window.DocViewerThemes = {
        get(ext) { return THEMES.get(String(ext).toLowerCase()) || highlightPlain; },
        sniff(code, ext) { return sniffHighlighter(code, ext); },
        register, escapeHtml, THEMES,
        wrapColorsInHtml,
        COLOR_RE_SRC,
        MAX_HL_CHARS,
    };
})();