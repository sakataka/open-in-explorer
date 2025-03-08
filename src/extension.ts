import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { normalize } from 'path';
import { access, constants } from 'fs/promises';

const execPromise = promisify(exec);

/**
 * 拡張機能の設定をロードする型定義
 */
interface ExtensionConfig {
    // カスタムファイルエクスプローラー（OS別）
    customExplorerWindows: string;
    customExplorerMacOS: string;
    customExplorerLinux: string;
    // テキストファイル判定のバイト数
    textFileScanBytes: number;
    // 大きなファイルの定義（バイト）
    largeFileSizeLimit: number;
    // 大きなファイルを開く前に確認する
    confirmLargeFileOpen: boolean;
    // 相対パスを許可する
    allowRelativePaths: boolean;
}

/**
 * 拡張機能の設定を読み込みます。
 * @returns 現在の拡張機能設定
 */
function loadConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('openInExplorer');
    return {
        customExplorerWindows: config.get<string>('customExplorerWindows', ''),
        customExplorerMacOS: config.get<string>('customExplorerMacOS', ''),
        customExplorerLinux: config.get<string>('customExplorerLinux', ''),
        textFileScanBytes: config.get<number>('textFileScanBytes', 512),
        largeFileSizeLimit: config.get<number>('largeFileSizeLimit', 5 * 1024 * 1024), // 5MB
        confirmLargeFileOpen: config.get<boolean>('confirmLargeFileOpen', true),
        allowRelativePaths: config.get<boolean>('allowRelativePaths', false)
    };
}

/**
 * シェルコマンドを非同期で実行し、stdoutおよびstderrの内容をログに出力します。
 * コマンドインジェクション対策も含まれています。
 * 
 * @param command 実行するコマンド文字列。
 * @returns 実行結果のPromise。
 */
async function executeCommand(command: string): Promise<{success: boolean, output?: string, error?: string}> {
    try {
        // コマンドインジェクション対策
        if (/[;&|><$`\\]/.test(command)) {
            return {
                success: false,
                error: 'コマンドに危険な文字が含まれています。'
            };
        }
        
        const { stdout, stderr } = await execPromise(command);
        
        if (stdout) {
            console.log('コマンド出力:', stdout);
        }
        
        if (stderr) {
            console.error('コマンドエラー出力:', stderr);
            return {
                success: true,
                output: stdout,
                error: stderr
            };
        }
        
        return {
            success: true,
            output: stdout
        };
    } catch (error: any) {
        console.error('コマンド実行エラー:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 指定されたファイルがテキストファイルかどうかを null バイトの有無で判定します。
 * 
 * @param filePath ファイルのパス。
 * @param bytesToRead 判定に使用するバイト数（デフォルト: 512）。
 * @returns テキストファイルなら true、そうでなければ false を返す Promise。
 */
async function isTextFile(filePath: string, bytesToRead: number = 512): Promise<boolean> {
    try {
        const fileHandle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
        await fileHandle.close();
        
        // null バイトが見つかった場合はバイナリファイルと見なす
        const hasNullByte = buffer.slice(0, bytesRead).includes(0);
        
        // コントロール文字の割合が多すぎる場合もバイナリとみなす
        const controlChars = buffer.slice(0, bytesRead).filter(b => (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127);
        const controlCharRatio = controlChars.length / bytesRead;
        
        // 30%以上がコントロール文字ならバイナリとみなす
        return !hasNullByte && controlCharRatio < 0.3;
    } catch (error) {
        console.error('テキストファイル判定エラー:', error);
        return false;
    }
}

/**
 * ファイルの存在を確認します。
 * 
 * @param filePath ファイルのパス。
 * @returns ファイルが存在する場合はtrue、そうでなければfalseを返すPromise。
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * パスをサニタイズします。
 * 
 * @param inputPath 入力パス。
 * @returns サニタイズされたパス。
 */
function sanitizePath(inputPath: string): string {
    // トリミングして余分な空白を削除
    let sanitized = inputPath.trim();
    
    // 引用符を削除
    sanitized = sanitized.replace(/["']/g, '');
    
    // 正規化（../などの解決）
    sanitized = normalize(sanitized);
    
    return sanitized;
}

/**
 * プラットフォーム固有のパス処理を行うためのインターフェース。
 */
interface PlatformHandler {
    /**
     * パス文字列の検証を行います。
     * @param selectedText パスを表すテキスト。
     * @param allowRelative 相対パスを許可するかどうか。
     * @returns 有効な場合は null、無効な場合はエラーメッセージを返します。
     */
    validatePath(selectedText: string, allowRelative: boolean): string | null;
    
    /**
     * パス文字列を正規化します。
     * @param selectedText パスを表すテキスト。
     * @returns 正規化されたパス。
     */
    normalizePath(selectedText: string): string;
    
    /**
     * 指定されたパスを適切なOSコマンドを使用して開きます。
     * @param selectedText 開くパス。
     * @param isFile パスがファイルであるかどうかの真偽値。
     * @param customExplorer カスタムエクスプローラーコマンド（設定されている場合）。
     */
    openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void>;
}

/**
 * Windows用のパス検証およびオープン処理ハンドラ。
 */
class WindowsHandler implements PlatformHandler {
    // UNCパス（\\server\share）
    private readonly UNC_PATH_REGEX = /^\\\\[^\s\\]+\\[^\s\\]+/;
    // ローカルドライブパス（C:\path\to\file）
    private readonly LOCAL_DRIVE_REGEX = /^[a-zA-Z]:\\[^<>:"|?*]+$/;

    validatePath(selectedText: string, allowRelative: boolean): string | null {
        // ローカルドライブパス検証
        if (this.LOCAL_DRIVE_REGEX.test(selectedText)) {
            return null;
        }
        
        // UNCパス検証
        if (this.UNC_PATH_REGEX.test(selectedText)) {
            return null;
        }
        
        // 相対パスの検証（許可されている場合）
        if (allowRelative && !selectedText.includes('..')) {
            return null;
        }
        
        return '選択されたテキストは有効なWindowsのパス形式ではありません。' +
               'パスは絶対パス（C:\\folder\\file.txt または \\\\server\\share）である必要があります。';
    }
    
    normalizePath(selectedText: string): string {
        // Windowsパスの正規化
        return path.normalize(selectedText).replace(/\//g, '\\');
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        let command: string;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            command = isFile
                ? `${customExplorer} /select,"${selectedText}"`
                : `${customExplorer} "${selectedText}"`;
        } else {
            // デフォルトのエクスプローラーを使用
            command = isFile
                ? `explorer.exe /select,"${selectedText}"`
                : `explorer.exe "${selectedText}"`;
        }
        
        const result = await executeCommand(command);
        if (!result.success) {
            vscode.window.showErrorMessage(`パスを開く際にエラーが発生しました: ${result.error}`);
        }
    }
}

/**
 * macOS用のパス検証およびオープン処理ハンドラ。
 */
class MacOSHandler implements PlatformHandler {
    // 絶対パス（/path/to/file）
    private readonly ABSOLUTE_PATH_REGEX = /^\/.+/;
    
    validatePath(selectedText: string, allowRelative: boolean): string | null {
        // 絶対パス検証
        if (this.ABSOLUTE_PATH_REGEX.test(selectedText) && !selectedText.includes('..')) {
            return null;
        }
        
        // 相対パスの検証（許可されている場合）
        if (allowRelative && !selectedText.includes('..')) {
            return null;
        }
        
        return '選択されたテキストは有効なmacOSのパス形式ではありません。' +
               'パスは絶対パス（/path/to/file）である必要があります。';
    }
    
    normalizePath(selectedText: string): string {
        // macOSパスの正規化
        return path.normalize(selectedText);
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        let command: string;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            command = `${customExplorer} "${selectedText}"`;
        } else {
            // デフォルトのFinderを使用
            command = isFile ? `open -R "${selectedText}"` : `open "${selectedText}"`;
        }
        
        const result = await executeCommand(command);
        if (!result.success) {
            vscode.window.showErrorMessage(`パスを開く際にエラーが発生しました: ${result.error}`);
        }
    }
}

/**
 * Linux用のパス検証およびオープン処理ハンドラ。
 */
class LinuxHandler implements PlatformHandler {
    // 絶対パス（/path/to/file）
    private readonly ABSOLUTE_PATH_REGEX = /^\/.+/;
    
    validatePath(selectedText: string, allowRelative: boolean): string | null {
        // 絶対パス検証
        if (this.ABSOLUTE_PATH_REGEX.test(selectedText) && !selectedText.includes('..')) {
            return null;
        }
        
        // 相対パスの検証（許可されている場合）
        if (allowRelative && !selectedText.includes('..')) {
            return null;
        }
        
        return '選択されたテキストは有効なLinuxのパス形式ではありません。' +
               'パスは絶対パス（/path/to/file）である必要があります。';
    }
    
    normalizePath(selectedText: string): string {
        // Linuxパスの正規化
        return path.normalize(selectedText);
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        let command: string;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            command = `${customExplorer} "${selectedText}"`;
        } else {
            // デフォルトではxdg-openを使用
            // 多くのLinuxディストリビューションでは、ファイルマネージャーで選択状態で開くコマンドが異なるため
            // 親ディレクトリを開いて選択状態にする代わりに、ディレクトリを直接開く
            command = `xdg-open "${isFile ? path.dirname(selectedText) : selectedText}"`;
        }
        
        const result = await executeCommand(command);
        if (!result.success) {
            vscode.window.showErrorMessage(`パスを開く際にエラーが発生しました: ${result.error}`);
        }
    }
}

const PLATFORM_HANDLERS: { [key: string]: PlatformHandler } = {
    win32: new WindowsHandler(),
    darwin: new MacOSHandler(),
    linux: new LinuxHandler()
};

const ERROR_MESSAGES = {
    NO_ACTIVE_EDITOR: 'アクティブなエディタが見つかりません。',
    NO_VALID_PATH: '有効なファイルパスを選択してください。',
    PATH_NOT_EXISTS: '指定されたパスは存在しません。',
    TEXT_FILE_OPEN_ERROR: 'テキストファイルを開く際にエラーが発生しました：',
    UNSUPPORTED_PLATFORM: 'サポートされていないプラットフォームです：',
    LARGE_FILE_WARNING: 'このファイルは大きいサイズです。VS Code内で開くと処理が遅くなる可能性があります。'
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
 * @param config 拡張機能の設定。
 */
async function processPath(
    selectedText: string, 
    platformHandler: PlatformHandler, 
    config: ExtensionConfig
): Promise<void> {
    // パスの正規化
    const normalizedPath = platformHandler.normalizePath(selectedText);
    
    let stats;
    try {
        stats = await fs.stat(normalizedPath);
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
        // ファイルサイズチェック
        const fileSize = stats.size;
        const isLargeFile = fileSize > config.largeFileSizeLimit;
        
        // 拡張子がない場合はフォルダとして扱う
        if (path.extname(normalizedPath) === '') {
            await platformHandler.openPath(
                normalizedPath, 
                isFile, 
                getPlatformSpecificExplorer(process.platform, config)
            );
            return;
        }

        // テキストファイルかどうかを確認
        try {
            const textFile = await isTextFile(normalizedPath, config.textFileScanBytes);
            
            if (textFile) {
                // 大きなファイルの場合は確認ダイアログを表示
                if (isLargeFile && config.confirmLargeFileOpen) {
                    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
                    const result = await vscode.window.showWarningMessage(
                        `${ERROR_MESSAGES.LARGE_FILE_WARNING} (${fileSizeMB} MB)`,
                        '通常通り開く',
                        'エクスプローラーで開く',
                        'キャンセル'
                    );
                    
                    if (result === 'エクスプローラーで開く') {
                        await platformHandler.openPath(
                            normalizedPath, 
                            isFile, 
                            getPlatformSpecificExplorer(process.platform, config)
                        );
                        return;
                    } else if (result !== '通常通り開く') {
                        return; // キャンセル
                    }
                }
                
                // VS Code内でテキストファイルを開く
                const uri = vscode.Uri.file(normalizedPath);
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
    await platformHandler.openPath(
        normalizedPath, 
        isFile, 
        getPlatformSpecificExplorer(process.platform, config)
    );
}

/**
 * プラットフォームに応じたカスタムエクスプローラーコマンドを取得します。
 * @param platform 現在のプラットフォーム。
 * @param config 拡張機能の設定。
 * @returns カスタムエクスプローラーコマンド。
 */
function getPlatformSpecificExplorer(platform: string, config: ExtensionConfig): string {
    switch (platform) {
        case 'win32':
            return config.customExplorerWindows;
        case 'darwin':
            return config.customExplorerMacOS;
        case 'linux':
            return config.customExplorerLinux;
        default:
            return '';
    }
}

/**
 * 拡張機能の設定変更を監視して適用するためのイベントハンドラを登録します。
 * @param context VSCodeによって提供される拡張機能のコンテキスト。
 */
function registerConfigurationWatcher(context: vscode.ExtensionContext): void {
    const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('openInExplorer')) {
            // 設定が変更されたことをユーザーに通知
            vscode.window.showInformationMessage('open-in-explorer拡張機能の設定が更新されました。');
        }
    });
    
    context.subscriptions.push(configWatcher);
}

/**
 * 拡張機能がアクティベートされた際に呼ばれるメソッドです。
 * システムのエクスプローラーでファイルまたはフォルダを開くコマンドを登録します。
 * @param context VSCodeによって提供される拡張機能のコンテキスト。
 */
export async function activate(context: vscode.ExtensionContext) {
    // 拡張機能の設定変更を監視
    registerConfigurationWatcher(context);
    
    let disposable = vscode.commands.registerCommand('extension.openInExplorer', async () => {
        // 設定を読み込む
        const config = loadConfig();
        
        // 1. アクティブエディタを取得
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            handleError(ERROR_MESSAGES.NO_ACTIVE_EDITOR);
            return;
        }

        // 2. 選択されたテキストを取得し、検証する
        const selection = editor.selection;
        const rawSelectedText = editor.document.getText(selection).trim();
        if (!rawSelectedText) {
            handleError(ERROR_MESSAGES.NO_VALID_PATH);
            return;
        }
        
        // パスをサニタイズ
        const selectedText = sanitizePath(rawSelectedText);

        // 3. 適切なプラットフォームハンドラを選択
        const platformHandler = PLATFORM_HANDLERS[process.platform];
        if (!platformHandler) {
            handleError(`${ERROR_MESSAGES.UNSUPPORTED_PLATFORM}${process.platform}`);
            return;
        }

        // 4. パスの検証を実施
        const validationError = platformHandler.validatePath(selectedText, config.allowRelativePaths);
        if (validationError) {
            handleError(validationError);
            return;
        }

        // 5. パスの存在確認・ファイル種別の判定・オープン処理
        await processPath(selectedText, platformHandler, config);
    });

    context.subscriptions.push(disposable);
    
    // README表示コマンドの登録
    const showReadmeCommand = vscode.commands.registerCommand('extension.showOpenInExplorerReadme', async () => {
        try {
            const readmePath = path.join(context.extensionPath, 'README.md');
            
            // READMEファイルの存在確認
            const exists = await fileExists(readmePath);
            if (!exists) {
                vscode.window.showInformationMessage('README.mdファイルが見つかりません。');
                return;
            }
            
            const readmeUri = vscode.Uri.file(readmePath);
            const doc = await vscode.workspace.openTextDocument(readmeUri);
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            handleError('READMEを開けませんでした', err);
        }
    });
    
    context.subscriptions.push(showReadmeCommand);
}

/**
 * 拡張機能が非アクティブ化される際に呼ばれるメソッドです。
 */
export function deactivate() { }