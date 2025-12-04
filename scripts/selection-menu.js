export class SelectionMenuController {
    constructor({ menuEl, showToast, getActiveEditor }) {
        this.menuEl = menuEl;
        this.showToast = showToast;
        this.getActiveEditor = getActiveEditor;
        this.hoverTimer = null;
        this.touchTimer = null;
        this.hideTimer = null;
        this.lastPointer = { x: 0, y: 0 };
        this.lastSelectionCheck = 0;
        this.CHECK_INTERVAL = 80;
        this.bindMenu();
    }

    getPrimarySelection(ed = this.getActiveEditor()) {
        if (!ed?.listSelections) return null;
        const selections = ed.listSelections();
        if (!selections || !selections.length) return null;
        const sel = selections[0];
        const anchor = sel.anchor || { line: 0, ch: 0 };
        const head = sel.head || { line: 0, ch: 0 };
        const cmp = (a, b) => (a.line === b.line ? a.ch - b.ch : a.line - b.line);
        const isForward = cmp(anchor, head) <= 0;
        const from = isForward ? anchor : head;
        const to = isForward ? head : anchor;
        const isEmpty = from.line === to.line && from.ch === to.ch;
        return { from, to, isEmpty, editor: ed };
    }

    bindMenu() {
        if (!this.menuEl) return;
        this.menuEl.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            this.handleAction(action);
        });
        this.menuEl.addEventListener('mouseenter', () => {
            if (this.hideTimer) {
                clearTimeout(this.hideTimer);
                this.hideTimer = null;
            }
        });
        this.menuEl.addEventListener('mouseleave', () => {
            this.hideTimer = setTimeout(() => this.hide(), 200);
        });
    }

    attachToEditor(editorInstance) {
        const containerEl = editorInstance?.getWrapperElement?.();
        if (!containerEl) return;
        containerEl.addEventListener('mousemove', (e) => {
            if (this.getActiveEditor() !== editorInstance) return;
            const pageX = e.pageX ?? (e.clientX + window.scrollX);
            const pageY = e.pageY ?? (e.clientY + window.scrollY);
            this.schedule(pageX, pageY, 1000);
        });
        containerEl.addEventListener('mouseleave', (e) => {
            if (this.menuEl && this.menuEl.contains(e.relatedTarget)) return;
            this.hideTimer = setTimeout(() => this.hide(), 200);
        });
        containerEl.addEventListener('touchstart', (e) => {
            if (this.getActiveEditor() !== editorInstance) return;
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            const selection = this.getPrimarySelection(editorInstance);
            if (!selection || selection.isEmpty) return;
            if (!this.updateMenuActions()) return;
            this.clearTouchTimer();
            const pageX = touch.clientX + window.scrollX;
            const pageY = touch.clientY + window.scrollY;
            this.touchTimer = setTimeout(() => {
                this.position(pageX, pageY);
            }, 600);
        }, { passive: true });
        containerEl.addEventListener('touchend', () => this.clearTouchTimer());
        containerEl.addEventListener('touchcancel', () => this.clearTouchTimer());
    }

    handleAction(action) {
        const activeEditor = this.getActiveEditor();
        if (!activeEditor) return;
        const selection = this.getPrimarySelection(activeEditor);
        if (!selection || selection.isEmpty) return;
        const text = activeEditor.getRange(selection.from, selection.to);
        if (!text) return;
        let next = text;
        if (action === 'toggle-case') {
            next = text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
        } else if (action === 'decode-uri') {
            try {
                next = decodeURIComponent(text);
            } catch (e) {
                this.showToast('Decode URI 失敗');
                return;
            }
        } else {
            return;
        }
        const start = selection.from;
        activeEditor.replaceRange(next, selection.from, selection.to);
        const lines = next.split('\n');
        const endLine = start.line + lines.length - 1;
        const endCh = lines.length === 1 ? start.ch + lines[0].length : lines[lines.length - 1].length;
        activeEditor.setSelection(start, { line: endLine, ch: endCh });
        this.hide();
    }

    getSelectionBounds(ed) {
        if (!ed) return null;
        const selection = this.getPrimarySelection(ed);
        if (!selection || selection.isEmpty) return null;
        const startCoords = ed.cursorCoords(selection.from, 'page');
        const endCoords = ed.cursorCoords(selection.to, 'page');
        if (!startCoords || !endCoords) return null;
        const top = Math.min(startCoords.top, endCoords.top);
        const bottom = Math.max(startCoords.bottom, endCoords.bottom);
        const left = Math.min(startCoords.left, endCoords.left);
        const right = Math.max(startCoords.right, endCoords.right);
        return { left, right, top, bottom };
    }

    isPointerInSelection(pageX, pageY) {
        const bounds = this.getSelectionBounds(this.getActiveEditor());
        if (!bounds) return false;
        return pageX >= bounds.left && pageX <= bounds.right && pageY >= bounds.top && pageY <= bounds.bottom;
    }

    isPointerOnMenu(pageX, pageY) {
        if (!this.menuEl || this.menuEl.style.display === 'none') return false;
        const rect = this.menuEl.getBoundingClientRect();
        const x = pageX - window.scrollX;
        const y = pageY - window.scrollY;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    schedule(pageX, pageY, delay = 1000) {
        if (!this.menuEl || !this.getActiveEditor()) return;
        const now = Date.now();
        if (now - this.lastSelectionCheck < this.CHECK_INTERVAL) return;
        this.lastSelectionCheck = now;
        const selection = this.getPrimarySelection(this.getActiveEditor());
        if (!selection || selection.isEmpty) return;
        if (!this.isPointerInSelection(pageX, pageY) && !this.isPointerOnMenu(pageX, pageY)) {
            if (this.hideTimer) clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(() => this.hide(), 200);
            return;
        }
        if (!this.updateMenuActions()) {
            this.hide();
            return;
        }
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        this.lastPointer = { x: pageX, y: pageY };
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
            this.position(this.lastPointer.x, this.lastPointer.y);
        }, delay);
    }

    position(pageX, pageY) {
        if (!this.menuEl) return;
        this.menuEl.style.display = 'block';
        this.menuEl.style.left = `${pageX}px`;
        this.menuEl.style.top = `${pageY}px`;
        const rect = this.menuEl.getBoundingClientRect();
        const clientX = pageX - window.scrollX;
        const clientY = pageY - window.scrollY;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - rect.width - 8, clientX + 8));
        const clampedTop = Math.max(8, Math.min(window.innerHeight - rect.height - 8, clientY + 8));
        this.menuEl.style.left = `${clampedLeft}px`;
        this.menuEl.style.top = `${clampedTop}px`;
    }

    updateMenuActions() {
        const activeEditor = this.getActiveEditor();
        if (!this.menuEl || !activeEditor) return false;
        const selection = this.getPrimarySelection(activeEditor);
        if (!selection || selection.isEmpty) return false;
        const text = activeEditor.getRange(selection.from, selection.to) || '';
        const hasLatin = /[A-Za-z]/.test(text);
        const toggleBtn = this.menuEl.querySelector('[data-action="toggle-case"]');
        if (toggleBtn) {
            toggleBtn.style.display = hasLatin ? 'block' : 'none';
        }
        const buttons = Array.from(this.menuEl.querySelectorAll('button'));
        const hasVisible = buttons.some(btn => btn.style.display !== 'none');
        if (!hasVisible) this.hide();
        return hasVisible;
    }

    hide() {
        if (this.menuEl) this.menuEl.style.display = 'none';
        if (this.hoverTimer) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
        }
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    clearTouchTimer() {
        if (this.touchTimer) {
            clearTimeout(this.touchTimer);
            this.touchTimer = null;
        }
    }
}
