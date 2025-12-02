import { simplifyMode, isFormatSupported } from './utils/editor-utils.js';

const parseJsonSafe = (val) => {
    if (window.jsonlint && typeof jsonlint.parse === 'function') {
        return jsonlint.parse(val);
    }
    return JSON.parse(val);
};

const formatters = {
    json: {
        pretty: (val) => JSON.stringify(parseJsonSafe(val), null, 2),
        compact: (val) => JSON.stringify(parseJsonSafe(val))
    },
    xml: {
        pretty: (val) => {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(val, 'application/xml');
            const err = xmlDoc.querySelector('parsererror');
            if (err) throw new Error('Invalid XML');
            const serializer = new XMLSerializer();
            const raw = serializer.serializeToString(xmlDoc).replace(/>\s*</g, '><');
            const lines = raw.replace(/></g, '>\n<').split('\n');
            let depth = 0;
            const formatted = lines.map(line => {
                const trimmed = line.trim();
                const isClosing = /^<\//.test(trimmed);
                const isSelf = /<[^>]+\/>$/.test(trimmed);
                const isOpening = /^<[^!?][^>]*[^\/]?>$/.test(trimmed) && !isSelf && !/^<.*><\/.*>$/.test(trimmed);
                if (isClosing) depth = Math.max(depth - 1, 0);
                const pad = '  '.repeat(depth);
                if (isOpening) depth += 1;
                return pad + trimmed;
            }).join('\n');
            return formatted;
        },
        compact: (val) => {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(val, 'application/xml');
            const err = xmlDoc.querySelector('parsererror');
            if (err) throw new Error('Invalid XML');
            const serializer = new XMLSerializer();
            return serializer.serializeToString(xmlDoc).replace(/>\s+</g, '><');
        }
    },
    javascript: {
        pretty: (val) => {
            if (window.js_beautify) return js_beautify(val, { indent_size: 2 });
            return val;
        },
        compact: (val) => {
            if (window.js_beautify) return js_beautify(val, { indent_size: 0, preserve_newlines: false });
            return val.replace(/\s+/g, ' ').trim();
        }
    },
    css: {
        pretty: (val) => {
            if (window.css_beautify) return css_beautify(val, { indent_size: 2 });
            return val;
        },
        compact: (val) => {
            if (window.css_beautify) return css_beautify(val, { indent_size: 0, preserve_newlines: false });
            return val.replace(/\s+/g, ' ').trim();
        }
    },
    markdown: {
        pretty: (val) => val,
        compact: (val) => val.replace(/\s+/g, ' ').trim()
    },
    text: {
        pretty: (val) => {
            if (!val) return val;
            const betweenCjkAndAscii = (str) => {
                return str
                    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
                    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
            };
            return betweenCjkAndAscii(val);
        }
    }
};

export const formatContent = (kind, value, modeId) => {
    const key = simplifyMode(modeId);
    if (!isFormatSupported(key)) return value;
    if (kind === 'compact' && key !== 'json') return value;
    const fmt = formatters[key] || formatters.json;
    if (!fmt[kind]) return value;
    return fmt[kind](value);
};

export { simplifyMode, isFormatSupported };
