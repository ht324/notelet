import { THEME_STORAGE_KEY } from './constants.js';

const resolveTheme = (pref, isSystemDark) => {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return isSystemDark ? 'dark' : 'light';
};

const getStoredThemePref = () => {
    try {
        return localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
    } catch (_) {
        return 'auto';
    }
};

export class ThemeController {
    constructor({ themeToggle, tabThemeToggle, editorsGetter = () => [] } = {}) {
        this.themeToggle = themeToggle;
        this.tabThemeToggle = tabThemeToggle;
        this.editorsGetter = editorsGetter;
        this.systemDarkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        this.preference = getStoredThemePref();
        this.resolved = resolveTheme(this.preference, this.systemDarkQuery ? this.systemDarkQuery.matches : false);
        this.iconLabelMap = { auto: '自動', dark: '暗', light: '亮' };
        this.attachSystemListener();
    }

    attachSystemListener() {
        if (!this.systemDarkQuery) return;
        const onChange = () => {
            if (this.preference === 'auto') {
                this.apply('auto', { skipPersist: true });
            }
        };
        if (typeof this.systemDarkQuery.addEventListener === 'function') {
            this.systemDarkQuery.addEventListener('change', onChange);
        } else if (typeof this.systemDarkQuery.addListener === 'function') {
            this.systemDarkQuery.addListener(onChange);
        }
    }

    setEditorsGetter(fn) {
        this.editorsGetter = fn;
    }

    nextTheme(pref = this.preference) {
        const isSystemDark = this.systemDarkQuery ? this.systemDarkQuery.matches : false;
        if (pref === 'auto') return isSystemDark ? 'light' : 'dark';
        return 'auto';
    }

    apply(pref = this.preference, { skipPersist = false } = {}) {
        this.preference = pref || 'auto';
        this.resolved = resolveTheme(this.preference, this.systemDarkQuery ? this.systemDarkQuery.matches : false);
        document.documentElement.setAttribute('data-theme', this.resolved);
        if (!skipPersist) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, this.preference);
            } catch (_) {}
        }
        this.editorsGetter().forEach(ed => ed.setTheme?.(this.resolved));
        this.updateToggleUI();
    }

    updateToggleUI() {
        const iconClass = {
            auto: this.resolved === 'light' ? 'icon-theme-light' : 'icon-theme-dark',
            dark: 'icon-theme-dark',
            light: 'icon-theme-light'
        }[this.preference] || 'icon-theme-dark';
        const updateBtn = (btn) => {
            if (!btn) return;
            const icon = btn.querySelector('.icon');
            if (icon) icon.className = `icon ${iconClass}`;
            btn.setAttribute('title', `切換主題（目前：${this.iconLabelMap[this.preference] || '自動'}）`);
        };
        updateBtn(this.themeToggle);
        updateBtn(this.tabThemeToggle);
    }

    bindToggleButtons() {
        const handler = () => this.apply(this.nextTheme(this.preference));
        if (this.themeToggle) this.themeToggle.addEventListener('click', handler);
        if (this.tabThemeToggle) {
            this.tabThemeToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                handler();
            });
        }
    }
}
