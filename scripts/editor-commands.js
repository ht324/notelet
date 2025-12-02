import { downloadMetaFromMode, hashString } from './utils/editor-utils.js';
import { formatTimestamp, generateUuid, localePatterns } from './utils/time-utils.js';

export const registerSaveCommand = (editorInstance) => {
    editorInstance.commands.addCommand({
        name: 'saveToFile',
        bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
        exec: (ed) => {
            const content = ed.getValue();
            const { ext, mime } = downloadMetaFromMode(ed.session.$modeId);
            const downloadName = `${hashString(content)}.${ext}`;
            const url = window.URL.createObjectURL(new Blob([ed.getValue()], { type: `${mime}; charset=UTF-8` }));
            let a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            a.click();
            window.URL.revokeObjectURL(url);
        },
        readOnly: true
    });
};

export const registerTimeCommands = (editorInstance) => {
    const commands = [
        { name: 'insertUuid', bindKey: { win: 'Ctrl-Shift-6', mac: 'Command-Shift-6' }, exec: () => generateUuid() },
        { name: 'insertDateTimeZh', bindKey: { win: 'Ctrl-Shift-7', mac: 'Command-Shift-7' }, pattern: localePatterns.full },
        { name: 'insertDateZh', bindKey: { win: 'Ctrl-Shift-8', mac: 'Command-Shift-8' }, pattern: localePatterns.dateZh },
        { name: 'insertDateSlash', bindKey: { win: 'Ctrl-Shift-9', mac: 'Command-Shift-9' }, pattern: localePatterns.dateSlash },
        { name: 'insertTimeZh', bindKey: { win: 'Ctrl-Shift-0', mac: 'Command-Shift-0' }, pattern: localePatterns.time }
    ];
    commands.forEach((cmd) => {
        editorInstance.commands.addCommand({
            name: cmd.name,
            bindKey: cmd.bindKey,
            exec: (ed) => {
                if (cmd.exec) {
                    ed.insert(cmd.exec());
                    return;
                }
                ed.insert(formatTimestamp(cmd.pattern));
            }
        });
    });
};
