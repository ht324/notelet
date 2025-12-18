import { createPopper } from '@popperjs/core';
import { SessionStore } from './session-store.js';
import { ThemeController } from './theme.js';
import { HistoryModal } from './history-modal.js';
import { EditorManager } from './editor-manager.js';
import { MAX_SESSIONS } from './constants.js';

const $ = (id) => document.getElementById(id);

const toast = $('toast');
const modalOverlay = $('modal-overlay');
const modalMessage = $('modal-message');
const modalOk = $('modal-ok');
const modalCancel = $('modal-cancel');

const showToast = (msg) => {
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
        toast.style.display = 'none';
    }, 4000);
};

const askConfirm = (message) => new Promise((resolve) => {
    modalMessage.textContent = message;
    modalOverlay.style.display = 'flex';
    const cleanup = () => {
        modalOverlay.style.display = 'none';
        modalOk.onclick = null;
        modalCancel.onclick = null;
    };
    modalOk.onclick = () => {
        cleanup();
        resolve(true);
    };
    modalCancel.onclick = () => {
        cleanup();
        resolve(false);
    };
});

const sessionStore = new SessionStore();
const historyButton = $('open-history');
const historyModal = new HistoryModal({
    overlay: $('history-overlay'),
    listEl: $('history-list'),
    closeBtn: $('history-close'),
    historyCountLabel: $('history-count'),
    historyTitleCount: $('history-title-count'),
    askConfirm
});

const themeController = new ThemeController({
    themeToggle: $('theme-toggle'),
    tabThemeToggle: $('tab-theme-toggle')
});

const editorManager = new EditorManager({
    container: $('editors'),
    tabs: $('tabs'),
    tabList: $('tab-list'),
    statusText: $('status-text'),
    modeSelect: $('mode-select'),
    formatPrettyBtn: $('format-pretty'),
    formatCompactBtn: $('format-compact'),
    wrapToggle: $('wrap-toggle'),
    selectionMenu: $('selection-menu'),
    addTabButton: $('add-editor-tab'),
    addSplitButton: $('add-editor-split'),
    showToast,
    askConfirm,
    sessionStore,
    setHistoryCount: (count) => {
        historyModal.setCount(count);
        setHistoryTooltip(count);
    },
    themeController
});

const setHistoryTooltip = (count = 0) => {
    const text = `歷史紀錄 (${count}/${MAX_SESSIONS})`;
    if (historyButton) {
        historyButton.dataset.tooltip = text;
        historyButton.setAttribute('aria-label', text);
    }
};
setHistoryTooltip(0);

themeController.setEditorsGetter(() => editorManager.getEditors());
themeController.apply(themeController.preference, { skipPersist: true });
themeController.bindToggleButtons();
editorManager.handleSelectionMenuBinding();
editorManager.addEditorPane();
editorManager.updateHistoryCount();

const handleLoadLatest = async () => {
    const sessions = await sessionStore.list();
    if (!sessions.length) return;
    const latest = sessions[0];
    const hasContent = editorManager.hasAnyContent();
    if (hasContent) {
        window.open(`./?load=${encodeURIComponent(latest.id)}`, '_blank');
    } else {
        editorManager.applySnapshot(latest, true);
        editorManager.setPageId(latest.id);
    }
};

const handleOpenHistory = async () => {
    const sessions = await sessionStore.list();
    await historyModal.show({
        sessions,
        activeSessionId: editorManager.getPageId(),
        onSelect: (session) => {
            if (editorManager.hasAnyContent()) {
                window.open(`./?load=${encodeURIComponent(session.id)}`, '_blank');
            } else {
                editorManager.applySnapshot(session, true);
                editorManager.setPageId(session.id);
            }
            historyModal.hide();
        },
        onDelete: async (session) => {
            await sessionStore.delete(session.id);
            await editorManager.updateHistoryCount();
            handleOpenHistory();
        }
    });
};

const setupStatusTooltips = () => {
    const buttons = Array.from(document.querySelectorAll('.status-tool-btn[data-tooltip]'));
    if (!buttons.length) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'status-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');

    const content = document.createElement('div');
    content.className = 'tooltip-content';
    tooltip.appendChild(content);

    const arrow = document.createElement('div');
    arrow.className = 'tooltip-arrow';
    arrow.setAttribute('data-popper-arrow', '');
    tooltip.appendChild(arrow);

    document.body.appendChild(tooltip);

    let instance = null;
    let hideTimer = null;
    let activeTarget = null;
    const suppressedUntil = new WeakMap();

    const show = (target) => {
        clearTimeout(hideTimer);
        const until = suppressedUntil.get(target);
        if (until && until > Date.now()) return;
        const label = target.dataset.tooltip || target.getAttribute('aria-label') || '';
        if (!label) return;
        activeTarget = target;
        content.textContent = label;
        tooltip.setAttribute('data-show', '');
        tooltip.setAttribute('aria-hidden', 'false');
        instance?.destroy();
        instance = createPopper(target, tooltip, {
            placement: 'top',
            modifiers: [
                { name: 'offset', options: { offset: [0, 4] } },
                { name: 'preventOverflow', options: { padding: 8 } }
            ]
        });
    };

    const hide = () => {
        hideTimer = setTimeout(() => {
            hideImmediate();
        }, 60);
    };

    const hideImmediate = (target = null) => {
        if (target && activeTarget !== target) return;
        clearTimeout(hideTimer);
        tooltip.removeAttribute('data-show');
        tooltip.setAttribute('aria-hidden', 'true');
        activeTarget = null;
        if (instance) {
            instance.destroy();
            instance = null;
        }
    };

    const refreshIfActive = (target) => {
        if (activeTarget !== target) return;
        if (!tooltip.hasAttribute('data-show')) return;
        const label = target.dataset.tooltip || target.getAttribute('aria-label') || '';
        if (!label) return;
        content.textContent = label;
        instance?.update?.();
    };

    document.addEventListener('notelet:tooltip-hide', (e) => {
        const target = e?.detail?.target ?? null;
        hideImmediate(target);
    });

    document.addEventListener('notelet:tooltip-suppress', (e) => {
        const target = e?.detail?.target ?? null;
        const ms = Number(e?.detail?.ms ?? 0);
        if (!target || !(target instanceof Element) || !Number.isFinite(ms) || ms <= 0) return;
        suppressedUntil.set(target, Date.now() + ms);
    });

    buttons.forEach((btn) => {
        btn.addEventListener('mouseenter', () => show(btn));
        btn.addEventListener('focus', () => show(btn));
        btn.addEventListener('mouseleave', hide);
        btn.addEventListener('blur', hide);
        btn.addEventListener('click', () => refreshIfActive(btn));
    });
};

$('load-latest')?.addEventListener('click', handleLoadLatest);
$('open-history')?.addEventListener('click', handleOpenHistory);
$('tab-load')?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleLoadLatest();
});
$('tab-history')?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleOpenHistory();
});

setupStatusTooltips();

const setupModeDropdown = () => {
    const select = $('mode-select');
    const button = $('mode-select-btn');
    if (!select || !button) return;

    const iconEl = button.querySelector('.mode-select-icon');
    const labelEl = button.querySelector('.mode-select-label');

    const iconByValue = {
        'text/plain': 'txt',
        'application/json': '{ }',
        javascript: 'JS',
        css: 'CSS',
        xml: '</>',
        markdown: 'Md'
    };

    const menu = document.createElement('div');
    menu.className = 'mode-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    document.body.appendChild(menu);

    let popperInstance = null;

    const getSelectedOption = () => Array.from(select.options).find(o => o.value === select.value) || select.options[0] || null;

    const syncButton = () => {
        const opt = getSelectedOption();
        const text = opt ? (opt.textContent || opt.value) : 'Mode';
        const iconText = opt ? (iconByValue[opt.value] || (text || '')) : '';
        if (labelEl) labelEl.textContent = text;
        if (iconEl) iconEl.textContent = iconText;
    };

    const rebuildMenu = () => {
        menu.textContent = '';
        Array.from(select.options).forEach((opt) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mode-menu-item';
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;
            item.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');

            const check = document.createElement('span');
            check.className = 'mode-menu-check';
            check.setAttribute('aria-hidden', 'true');

            const icon = document.createElement('span');
            icon.className = 'mode-select-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconByValue[opt.value] || '';

            const name = document.createElement('span');
            name.className = 'mode-menu-name';
            name.textContent = opt.textContent || opt.value;

            item.appendChild(check);
            item.appendChild(icon);
            item.appendChild(name);

            item.addEventListener('click', () => {
                if (select.value !== opt.value) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                document.dispatchEvent(new CustomEvent('notelet:tooltip-hide', { detail: { target: button } }));
                document.dispatchEvent(new CustomEvent('notelet:tooltip-suppress', { detail: { target: button, ms: 500 } }));
                closeMenu();
                button.focus();
            });

            menu.appendChild(item);
        });
    };

    const openMenu = () => {
        rebuildMenu();
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        popperInstance?.destroy();
        popperInstance = createPopper(button, menu, {
            placement: 'bottom-start',
            modifiers: [
                { name: 'offset', options: { offset: [0, 6] } },
                { name: 'preventOverflow', options: { padding: 8 } }
            ]
        });
        popperInstance.update();
        const selected = menu.querySelector('[aria-selected="true"]');
        if (selected instanceof HTMLElement) selected.focus({ preventScroll: true });
    };

    const closeMenu = () => {
        if (menu.hidden) return;
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        popperInstance?.destroy();
        popperInstance = null;
    };

    const toggleMenu = () => {
        if (menu.hidden) openMenu();
        else closeMenu();
    };

    button.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMenu();
    });

    button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu();
        }
    });

    document.addEventListener('mousedown', (e) => {
        if (menu.hidden) return;
        const target = e.target;
        if (!(target instanceof Node)) return;
        if (menu.contains(target) || button.contains(target)) return;
        closeMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (menu.hidden) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMenu();
            button.focus();
        }
    });

    select.addEventListener('change', () => {
        syncButton();
        if (!menu.hidden) rebuildMenu();
    });
    select.addEventListener('notelet:mode-sync', () => {
        syncButton();
        if (!menu.hidden) rebuildMenu();
    });

    syncButton();
};

setupModeDropdown();

window._notelet = editorManager.buildPublicApi();

const params = new URLSearchParams(window.location.search);
const loadId = params.get('load');
if (loadId) {
    sessionStore.list().then(sessions => {
        const found = sessions.find(s => s.id === loadId);
        if (found) {
            editorManager.applySnapshot(found, true);
            editorManager.setPageId(found.id);
            history.replaceState({}, document.title, './');
        }
    });
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}

const hasAnyContent = () => editorManager.hasAnyContent();
window.onbeforeunload = () => {
    if (!hasAnyContent()) return undefined;
    return '您有尚未保存的內容，確定要離開嗎？';
};
