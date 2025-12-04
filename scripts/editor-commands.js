import { downloadMetaFromMode, hashString } from './utils/editor-utils.js';
import { formatTimestamp, generateUuid, localePatterns } from './utils/time-utils.js';

export const registerSaveCommand = (editorInstance) => {
    const handler = () => {
        const content = editorInstance.getValue();
        const modeId = editorInstance.getMode();
        const { ext, mime } = downloadMetaFromMode(modeId);
        const downloadName = `${hashString(content)}.${ext}`;
        const url = window.URL.createObjectURL(new Blob([content], { type: `${mime}; charset=UTF-8` }));
        let a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        a.click();
        window.URL.revokeObjectURL(url);
    };
    editorInstance.addKeymap([
        { key: 'Mod-s', preventDefault: true, run: () => { handler(); return true; } }
    ]);
};

export const registerTimeCommands = (editorInstance) => {
    const commands = [
        { name: 'insertUuid', bindKey: { win: 'Ctrl-Shift-6', mac: 'Command-Shift-6' }, exec: () => generateUuid() },
        { name: 'insertDateTimeZh', bindKey: { win: 'Ctrl-Shift-7', mac: 'Command-Shift-7' }, pattern: localePatterns.full },
        { name: 'insertDateZh', bindKey: { win: 'Ctrl-Shift-8', mac: 'Command-Shift-8' }, pattern: localePatterns.dateZh },
        { name: 'insertDateSlash', bindKey: { win: 'Ctrl-Shift-9', mac: 'Command-Shift-9' }, pattern: localePatterns.dateSlash },
        { name: 'insertTimeZh', bindKey: { win: 'Ctrl-Shift-0', mac: 'Command-Shift-0' }, pattern: localePatterns.time }
    ];
    const bindings = commands.flatMap((cmd) => {
        const handler = () => {
            const text = cmd.exec ? cmd.exec() : formatTimestamp(cmd.pattern);
            editorInstance.replaceSelection(text);
            return true;
        };
        return [
            { key: cmd.bindKey.win.replace('Ctrl', 'Mod'), run: handler },
            { key: cmd.bindKey.mac.replace('Command', 'Mod'), run: handler }
        ];
    });
    editorInstance.addKeymap(bindings);
};
