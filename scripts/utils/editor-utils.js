export const hashString = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export const generateSessionId = () => `page-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

const normalizeModeId = (modeId = '') => {
    if (typeof modeId !== 'string') return 'text/plain';
    const lower = modeId.toLowerCase();
    if (lower.includes('json')) return 'application/json';
    if (lower.includes('javascript') || lower.includes('js')) return 'javascript';
    if (lower.includes('xml') || lower.includes('html')) return 'xml';
    if (lower.includes('css')) return 'css';
    if (lower.includes('markdown') || lower.includes('md')) return 'markdown';
    return 'text/plain';
};

export const detectModeFromText = (text) => {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
        try {
            JSON.parse(trimmed);
            return 'application/json';
        } catch (_) {}
    }

    if (/(function\s+\w+)|(=>)|(^|\n)\s*(const|let|var)\s+\w+/.test(trimmed)) return 'javascript';
    if (/^<[^>]+>/.test(trimmed)) return 'xml';
    if (/^[^{]+\{[^}]*:[^}]*\}/m.test(trimmed)) return 'css';
    if (/^\s{0,3}#\s+.+/m.test(trimmed) || /^[-*]_\s*[-*]_\s*[-*]_/.test(trimmed) || /^>\s+.+/m.test(trimmed)) return 'markdown';
    return null;
};

export const simplifyMode = (mode) => {
    const normalized = normalizeModeId(mode);
    switch (normalized) {
        case 'application/json':
            return 'json';
        case 'javascript':
            return 'javascript';
        case 'xml':
            return 'xml';
        case 'css':
            return 'css';
        case 'markdown':
            return 'markdown';
        default:
            return 'text';
    }
};

export const isFormatSupported = (modeId) => {
    const m = simplifyMode(modeId);
    return ['json', 'xml', 'javascript', 'css', 'markdown', 'text'].includes(m);
};

export const downloadMetaFromMode = (modeId) => {
    const key = simplifyMode(modeId);
    switch (key) {
        case 'json':
            return { ext: 'json', mime: 'application/json' };
        case 'xml':
            return { ext: 'xml', mime: 'application/xml' };
        case 'javascript':
            return { ext: 'js', mime: 'application/javascript' };
        case 'css':
            return { ext: 'css', mime: 'text/css' };
        case 'markdown':
            return { ext: 'md', mime: 'text/markdown' };
        default:
            return { ext: 'txt', mime: 'text/plain' };
    }
};

export const toCodeMirrorMode = (modeId) => {
    const key = simplifyMode(modeId);
    if (key === 'json') return { name: 'javascript', json: true };
    if (key === 'javascript') return { name: 'javascript' };
    if (key === 'xml') return 'xml';
    if (key === 'css') return 'css';
    if (key === 'markdown') return 'markdown';
    return 'text/plain';
};

export const normalizeModeIdForStore = (modeId) => normalizeModeId(modeId);
