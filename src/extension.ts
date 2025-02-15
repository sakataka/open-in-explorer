import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// 共通のコマンド実行関数
function executeCommand(command: string): void {
    childProcess.exec(command, (err, stdout, stderr) => {
        if (err) {
            console.error(err);
        }
        if (stderr) {
            console.error("stderr:", stderr);
        }
    });
}

// ファイルがテキストかどうかを簡易判定する関数
async function isTextFile(filePath: string): Promise<boolean> {
    try {
        const fileHandle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(512);
        const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0);
        await fileHandle.close();
        // nullバイトが含まれていればバイナリとみなす
        return !buffer.slice(0, bytesRead).includes(0);
    } catch (error) {
        console.error("isTextFile error:", error);
        return false;
    }
}

// プラットフォームハンドラのインターフェース
interface PlatformHandler {
    validatePath(selectedText: string): string | null; // エラー文または null
    openPath(selectedText: string, isFile: boolean): void;
}

// Windows用ハンドラ
class WindowsHandler implements PlatformHandler {
    private readonly UNC_PATH_REGEX = /^\\\\[^\s\\]+\\[^\s\\]+/;

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
        executeCommand(command);
    }
}

// macOS用ハンドラ
class MacOSHandler implements PlatformHandler {
    validatePath(selectedText: string): string | null {
        if (!selectedText.startsWith('/') || selectedText.includes('..')) {
            return "選択されたテキストは有効なmacOSの絶対パスではありません。";
        }
        return null;
    }

    openPath(selectedText: string, isFile: boolean): void {
        const command = isFile ? `open -R "${selectedText}"` : `open "${selectedText}"`;
        executeCommand(command);
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
    TEXT_FILE_OPEN_ERROR: "テキストファイルを開く際にエラーが発生しました：",
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

        // fs.stat により存在確認と情報取得
        let stats;
        try {
            stats = await fs.stat(selectedText);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                vscode.window.showErrorMessage(ERROR_MESSAGES.PATH_NOT_EXISTS);
            } else {
                vscode.window.showErrorMessage(`ファイル/フォルダの確認中にエラーが発生しました: ${error.message || ""}`);
            }
            return;
        }

        const isFile = stats.isFile();

        // ファイルの場合の処理
        if (isFile) {
            // 拡張子がなければ、OSのエクスプローラ/Finderで開く（フォルダ扱い）
            if (path.extname(selectedText) === "") {
                platformHandler.openPath(selectedText, isFile);
                return;
            }

            // 拡張子がある場合、テキストファイルならVSCodeで開く
            try {
                const textFile = await isTextFile(selectedText);
                if (textFile) {
                    const uri = vscode.Uri.file(selectedText);
                    try {
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Active });
                        return;
                    } catch (error: any) {
                        vscode.window.showErrorMessage(ERROR_MESSAGES.TEXT_FILE_OPEN_ERROR + (error.message || ""));
                        return;
                    }
                }
            } catch (error) {
                console.error("テキストファイル判定エラー:", error);
            }
        }

        // フォルダの場合、またはテキストファイルでない場合はOSのエクスプローラ/Finderで開く
        platformHandler.openPath(selectedText, isFile);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() { }
