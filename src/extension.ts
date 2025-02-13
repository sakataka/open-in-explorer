import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// プラットフォームハンドラのインターフェース
interface PlatformHandler {
    validatePath(selectedText: string): string | null; // Validation error message or null if valid
    openPath(selectedText: string, isFile: boolean): void;
}

// Windows用ハンドラ
class WindowsHandler implements PlatformHandler {
    private readonly UNC_PATH_REGEX = /^\\\\[^\s\\]+\\[^\s\\]+/; // Improved UNC path regex

    validatePath(selectedText: string): string | null {
        if (!this.UNC_PATH_REGEX.test(selectedText)) {
            return "選択されたテキストは有効なWindowsの共有フォルダのパスではありません。";
        }
        return null;
    }

    openPath(selectedText: string, isFile: boolean): void {
        const command = isFile
            ? `explorer.exe /select,"${selectedText}"`
            : `explorer.exe "${selectedText}"`;
        this.executeCommand(command);
    }

    private executeCommand(command: string): void {
        child_process.exec(command, (err, stdout, stderr) => {
            if (err) {
                console.error(err);
                vscode.window.showErrorMessage(`エクスプローラーを開く際にエラーが発生しました: ${err.message || ""}`);
            }
        });
    }
}

// macOS用ハンドラ
class MacOSHandler implements PlatformHandler {
    validatePath(selectedText: string): string | null {
        // More robust validation (example, you might need a more complex regex or a different approach)
        if (!selectedText.startsWith('/') || selectedText.includes('..')) { // Prevent ".." for security
            return "選択されたテキストは有効なmacOSの絶対パスではありません。";
        }

        return null;
    }

    openPath(selectedText: string, isFile: boolean): void {
        const command = isFile ? `open -R "${selectedText}"` : `open "${selectedText}"`;
        this.executeCommand(command);
    }

    private executeCommand(command: string): void {
        child_process.exec(command, (err) => {
            if (err) {
                console.error(err);
                vscode.window.showErrorMessage(`Finderを開く際にエラーが発生しました: ${err.message || ""}`);
            }
        });
    }
}

const PLATFORM_HANDLERS: { [key: string]: PlatformHandler } = {
    win32: new WindowsHandler(),
    darwin: new MacOSHandler(),
};

const ERROR_MESSAGES = {
    NO_ACTIVE_EDITOR: "アクティブなエディタが見つかりません。",
    NO_VALID_PATH: "有効なファイルパスを選択してください。",
    PATH_NOT_EXISTS: "指定されたパスは存在しません。",
    TXT_FILE_OPEN_ERROR: "txtファイルを開く際にエラーが発生しました。"
};


export async function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('extension.openInExplorer', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage(ERROR_MESSAGES.NO_ACTIVE_EDITOR);
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection).trim();
        if (!selectedText) {
            vscode.window.showErrorMessage(ERROR_MESSAGES.NO_VALID_PATH);
            return;
        }

        const platformHandler = PLATFORM_HANDLERS[process.platform];
        if (!platformHandler) {
            vscode.window.showErrorMessage(`サポートされていないプラットフォームです: ${process.platform}`);
            return;
        }

        const validationError = platformHandler.validatePath(selectedText);
        if (validationError) {
            vscode.window.showErrorMessage(validationError);
            return;
        }

        try {
            await fs.access(selectedText);
            const stats = await fs.stat(selectedText);
            const isFile = stats.isFile();

            // 拡張子が .txt かどうかをチェック
            if (isFile && path.extname(selectedText).toLowerCase() === '.txt') {
                // VS Code で新規ファイルとして開く
                const uri = vscode.Uri.file(selectedText);
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside); // 新しいタブで開く
                }
                catch(error: any){
                     vscode.window.showErrorMessage(ERROR_MESSAGES.TXT_FILE_OPEN_ERROR + error.message);
                }

            } else {
                // .txtでなければ、OSの既定のプログラムで開く。
                platformHandler.openPath(selectedText, isFile);
            }

        } catch (error: any) {
            if (error.code === 'ENOENT') {
                vscode.window.showErrorMessage(ERROR_MESSAGES.PATH_NOT_EXISTS);
            } else {
                vscode.window.showErrorMessage(`ファイル/フォルダの確認中にエラーが発生しました: ${error.message || ""}`);
            }
            return;
        }

    });

    context.subscriptions.push(disposable);
}

export function deactivate() { }