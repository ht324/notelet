import { MAX_SESSIONS } from './constants.js';

export class HistoryModal {
    constructor({ overlay, listEl, closeBtn, historyCountLabel, historyTitleCount, askConfirm }) {
        this.overlay = overlay;
        this.listEl = listEl;
        this.closeBtn = closeBtn;
        this.historyCountLabel = historyCountLabel;
        this.historyTitleCount = historyTitleCount;
        this.askConfirm = askConfirm;
        this.closeBtn?.addEventListener('click', () => this.hide());
    }

    setCount(count) {
        const text = `(${count}/${MAX_SESSIONS})`;
        if (this.historyCountLabel) this.historyCountLabel.textContent = text;
        if (this.historyTitleCount) this.historyTitleCount.textContent = ` ${text}`;
    }

    renderEmpty() {
        this.listEl.innerHTML = '<div style="color:#ccc;">目前沒有歷史紀錄</div>';
    }

    buildCard(session, onSelect, onDelete) {
        const card = document.createElement('div');
        card.className = 'history-card';

        const delBtn = document.createElement('button');
        delBtn.className = 'history-delete';
        delBtn.textContent = '×';
        card.appendChild(delBtn);

        const time = document.createElement('div');
        time.className = 'history-time';
        time.textContent = new Date(session.updatedAt).toLocaleString();
        const preview = document.createElement('div');
        preview.className = 'history-preview';
        const first = (session.editors && session.editors[0]?.content) || '';
        const snippet = first.split('\n').slice(0, 7).join('\n');
        preview.textContent = snippet;
        const mode = document.createElement('div');
        mode.className = 'history-mode';
        const firstMode = (session.editors && session.editors[0]?.mode) || session.mode;
        mode.textContent = this.simplifyMode(firstMode);
        preview.appendChild(mode);
        card.appendChild(time);
        card.appendChild(preview);

        card.addEventListener('click', () => onSelect(session));
        delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const ok = await this.askConfirm('要刪除這筆歷史紀錄嗎？');
            if (!ok) return;
            onDelete(session);
        });

        return card;
    }

    simplifyMode(mode) {
        if (!mode) return 'text';
        const parts = mode.split('/');
        return parts[parts.length - 1];
    }

    async show({ sessions, activeSessionId, onSelect, onDelete }) {
        if (!this.overlay || !this.listEl) return;
        const available = sessions || [];
        this.listEl.innerHTML = '';
        this.setCount((sessions || []).length);
        if (!available.length) {
            this.renderEmpty();
        } else {
            available.forEach((s) => {
                const card = this.buildCard(s, onSelect, onDelete);
                this.listEl.appendChild(card);
            });
        }
        this.overlay.style.display = 'flex';
    }

    hide() {
        if (this.overlay) this.overlay.style.display = 'none';
    }
}
