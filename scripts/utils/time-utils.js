const getLocaleDayPeriod = (date) => {
    try {
        const locale = navigator.language || 'en';
        const formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true });
        const parts = formatter.formatToParts(date || new Date());
        const day = parts.find(p => p.type === 'dayPeriod');
        if (day && day.value) return day.value;
    } catch (_) {}
    return date && date.getHours() < 12 ? 'AM' : 'PM';
};

const getLocalePatterns = () => {
    const locale = (navigator.language || 'en').toLowerCase();
    if (locale.startsWith('zh') || locale.startsWith('ja')) {
        return {
            full: 'yyyy年MM月dd日 ahh:mm',
            dateZh: 'yyyy年MM月dd日',
            dateSlash: 'yyyy/MM/dd',
            time: 'ahh:mm'
        };
    }
    return {
        full: 'yyyy/MM/dd hh:mm a',
        dateZh: 'yyyy/MM/dd',
        dateSlash: 'yyyy/MM/dd',
        time: 'hh:mm a'
    };
};

export const localePatterns = getLocalePatterns();

export const formatTimestamp = (pattern) => {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const hours24 = now.getHours();
    const ampm = getLocaleDayPeriod(now);
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    const parts = {
        yyyy: now.getFullYear(),
        MM: pad2(now.getMonth() + 1),
        dd: pad2(now.getDate()),
        hh: pad2(hours12),
        HH: pad2(hours24),
        mm: pad2(now.getMinutes()),
        a: ampm
    };
    return pattern.replace(/ahh|yyyy|MM|dd|hh|HH|mm|a/g, (token) => {
        if (token === 'ahh') return `${parts.a}${parts.hh}`;
        return parts[token] ?? token;
    });
};

export const generateUuid = () => {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const rand = () => (crypto && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint8Array(1))[0] % 16
        : Math.floor(Math.random() * 16);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = rand();
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};
