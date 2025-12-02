export const hashString = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export const generateSessionId = () => `page-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;

export const detectModeFromText = (text) => {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
        try {
            JSON.parse(trimmed);
            return 'ace/mode/json';
        } catch (_) {}
    }

    if (/(function\s+\w+)|(=>)|(^|\n)\s*(const|let|var)\s+\w+/.test(trimmed)) return 'ace/mode/javascript';
    if (/^<[^>]+>/.test(trimmed)) return 'ace/mode/xml';
    if (/^[^{]+\{[^}]*:[^}]*\}/m.test(trimmed)) return 'ace/mode/css';
    if (/^\s{0,3}#\s+.+/m.test(trimmed) || /^[-*]_\s*[-*]_\s*[-*]_/.test(trimmed) || /^>\s+.+/m.test(trimmed)) return 'ace/mode/markdown';
    return null;
};

export const simplifyMode = (mode) => {
    if (!mode) return 'text';
    const parts = mode.split('/');
    return parts[parts.length - 1];
};

export const isFormatSupported = (modeId) => {
    const m = simplifyMode(modeId);
    return ['json', 'xml', 'javascript', 'css', 'markdown', 'text'].includes(m);
};

export const downloadMetaFromMode = (modeId) => {
    const key = (modeId || '').split('/').pop() || 'txt';
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
