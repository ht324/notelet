import { SessionStore } from './session-store.js';
import { ThemeController } from './theme.js';
import { HistoryModal } from './history-modal.js';
import { EditorManager } from './editor-manager.js';

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
    addButton: $('add-editor'),
    showToast,
    askConfirm,
    sessionStore,
    setHistoryCount: (count) => historyModal.setCount(count),
    themeController
});

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
$('tab-add')?.addEventListener('click', (e) => {
    e.stopPropagation();
    editorManager.addEditorPane();
});

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
