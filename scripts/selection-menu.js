const Range = ace.require('ace/range').Range;

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
        const containerEl = editorInstance?.renderer?.container;
        if (!containerEl) return;
        containerEl.addEventListener('mousemove', (e) => {
            if (this.getActiveEditor() !== editorInstance) return;
            const pageX = e.clientX + window.scrollX;
            const pageY = e.clientY + window.scrollY;
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
            const range = editorInstance.getSelectionRange();
            if (range.isEmpty()) return;
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

    handleSelectionChange() {
        this.hide();
    }

    handleAction(action) {
        const activeEditor = this.getActiveEditor();
        if (!activeEditor) return;
        const sel = activeEditor.getSelectionRange();
        if (sel.isEmpty()) return;
        const text = activeEditor.session.getTextRange(sel);
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
        const start = sel.start;
        activeEditor.session.replace(sel, next);
        const lines = next.split('\n');
        const endRow = start.row + lines.length - 1;
        const endCol = lines.length === 1 ? start.column + lines[0].length : lines[lines.length - 1].length;
        activeEditor.selection.setSelectionRange(new Range(start.row, start.column, endRow, endCol));
        this.hide();
    }

    getSelectionBounds(ed) {
        if (!ed) return null;
        const range = ed.getSelectionRange();
        if (range.isEmpty()) return null;
        const renderer = ed.renderer;
        const start = renderer.textToScreenCoordinates(range.start.row, range.start.column);
        const end = renderer.textToScreenCoordinates(range.end.row, range.end.column);
        const lineHeight = renderer.lineHeight || 16;
        const top = Math.min(start.pageY, end.pageY);
        const bottom = Math.max(start.pageY, end.pageY) + lineHeight;
        const rect = renderer.container.getBoundingClientRect();
        const left = rect.left + window.scrollX;
        const right = rect.right + window.scrollX;
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
        const range = this.getActiveEditor().getSelectionRange();
        if (range.isEmpty()) return;
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
        const range = activeEditor.getSelectionRange();
        if (range.isEmpty()) return false;
        const text = activeEditor.session.getTextRange(range) || '';
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
