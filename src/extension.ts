import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execPromise = promisify(exec);

/**
 * シェルコマンドを非同期で実行し、stdoutおよびstderrの内容をログに出力します。
 * @param command 実行するコマンド文字列。
 */
async function executeCommand(command: string): Promise<void> {
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stdout) {
            console.log(stdout);
        }
        if (stderr) {
            console.error('stderr:', stderr);
        }
    } catch (error) {
        console.error('コマンド実行エラー:', error);
    }
}

/**
 * 指定されたファイルがテキストファイルかどうかを null バイトの有無で判定します。
 * @param filePath ファイルのパス。
 * @returns テキストファイルなら true、そうでなければ false を返す Promise。
 */
async function isTextFile(filePath: string): Promise<boolean> {
    const READ_BYTES = 512;
    try {
        const fileHandle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(READ_BYTES);
        const { bytesRead } = await fileHandle.read(buffer, 0, READ_BYTES, 0);
        await fileHandle.close();
        // null バイトが見つかった場合はバイナリファイルと見なす
        return !buffer.slice(0, bytesRead).includes(0);
    } catch (error) {
        console.error('isTextFile エラー:', error);
        return false;
    }
}

/**
 * プラットフォーム固有のパス処理を行うためのインターフェース。
 */
interface PlatformHandler {
    /**
     * パス文字列の検証を行います。
     * @param selectedText パスを表すテキスト。
     * @returns 有効な場合は null、無効な場合はエラーメッセージを返します。
     */
    validatePath(selectedText: string): string | null;
    /**
     * 指定されたパスを適切なOSコマンドを使用して開きます。
     * @param selectedText 開くパス。
     * @param isFile パスがファイルであるかどうかの真偽値。
     */
    openPath(selectedText: string, isFile: boolean): void;
}

/**
 * Windows用のパス検証およびオープン処理ハンドラ。
 */
class WindowsHandler implements PlatformHandler {
    private readonly UNC_PATH_REGEX = /^\\\\[^\s\\]+\\[^\s\\]+/;

    validatePath(selectedText: string): string | null {
        if (!this.UNC_PATH_REGEX.test(selectedText)) {
            return '選択されたテキストは有効なWindowsの共有フォルダのパスではありません。';
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

/**
 * macOS用のパス検証およびオープン処理ハンドラ。
 */
class MacOSHandler implements PlatformHandler {
    validatePath(selectedText: string): string | null {
        if (!selectedText.startsWith('/') || selectedText.includes('..')) {
            return '選択されたテキストは有効なmacOSの絶対パスではありません。';
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
    NO_ACTIVE_EDITOR: 'アクティブなエディタが見つかりません。',
    NO_VALID_PATH: '有効なファイルパスを選択してください。',
    PATH_NOT_EXISTS: '指定されたパスは存在しません。',
    TEXT_FILE_OPEN_ERROR: 'テキストファイルを開く際にエラーが発生しました：',
};

/**
 * エラー処理の共通関数です。エラーメッセージのログ出力とユーザーへの通知を行います。
 * @param message ユーザーに表示するエラーメッセージ。
 * @param error エラーオブジェクト（任意）。
 */
function handleError(message: string, error?: any): void {
    if (error) {
        console.error(message, error);
        vscode.window.showErrorMessage(`${message} ${error.message || ''}`);
    } else {
        console.error(message);
        vscode.window.showErrorMessage(message);
    }
}

/**
 * 指定されたパスを処理し、ファイルの場合はテキストファイルかどうかの判定を行い、
 * 適切な方法（VSCode内でのオープンまたはOSのエクスプローラー/ファインダーでのオープン）で開きます。
 * @param selectedText 対象のパス文字列。
 * @param platformHandler 使用するプラットフォームハンドラ。
 */
async function processPath(selectedText: string, platformHandler: PlatformHandler): Promise<void> {
    let stats;
    try {
        stats = await fs.stat(selectedText);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            handleError(ERROR_MESSAGES.PATH_NOT_EXISTS);
        } else {
            handleError(`ファイル/フォルダの確認中にエラーが発生しました: ${error.message || ''}`, error);
        }
        return;
    }

    const isFile = stats.isFile();

    if (isFile) {
        // 拡張子がない場合はフォルダとして扱う
        if (path.extname(selectedText) === '') {
            platformHandler.openPath(selectedText, isFile);
            return;
        }

        // テキストファイルかどうかを確認
        try {
            const textFile = await isTextFile(selectedText);
            if (textFile) {
                const uri = vscode.Uri.file(selectedText);
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Active });
                    return;
                } catch (error: any) {
                    handleError(ERROR_MESSAGES.TEXT_FILE_OPEN_ERROR, error);
                    return;
                }
            }
        } catch (error) {
            console.error('テキストファイル判定エラー:', error);
        }
    }
    // ファイルでない場合、またはテキストファイルでなかった場合は、OSのエクスプローラー/ファインダーで開く
    platformHandler.openPath(selectedText, isFile);
}

/**
 * 拡張機能がアクティベートされた際に呼ばれるメソッドです。
 * システムのエクスプローラーでファイルまたはフォルダを開くコマンドを登録します。
 * @param context VSCodeによって提供される拡張機能のコンテキスト。
 */
export async function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('extension.openInExplorer', async () => {
        // 1. アクティブエディタを取得
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            handleError(ERROR_MESSAGES.NO_ACTIVE_EDITOR);
            return;
        }

        // 2. 選択されたテキストを取得し、検証する
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection).trim();
        if (!selectedText) {
            handleError(ERROR_MESSAGES.NO_VALID_PATH);
            return;
        }

        // 3. 適切なプラットフォームハンドラを選択
        const platformHandler = PLATFORM_HANDLERS[process.platform];
        if (!platformHandler) {
            handleError(`サポートされていないプラットフォームです: ${process.platform}`);
            return;
        }

        // 4. パスの検証を実施
        const validationError = platformHandler.validatePath(selectedText);
        if (validationError) {
            handleError(validationError);
            return;
        }

        // 5. パスの存在確認・ファイル種別の判定・オープン処理
        await processPath(selectedText, platformHandler);
    });

    context.subscriptions.push(disposable);
}

/**
 * 拡張機能が非アクティブ化される際に呼ばれるメソッドです。
 */
export function deactivate() { }