import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { normalize } from 'path';
import { access, constants } from 'fs/promises';

const execPromise = promisify(exec);

/**
 * 国際化対応のためのメッセージ
 */
interface LocalizedMessage {
    ja: string;   // 日本語メッセージ
    en: string;   // 英語メッセージ
}

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
    // 言語設定（デフォルトは日本語）
    language: string;
    // シンボリックリンクの追跡
    followSymlinks: boolean;
}

/**
 * 多言語対応エラーメッセージ
 */
const MESSAGES = {
    NO_ACTIVE_EDITOR: {
        ja: 'アクティブなエディタが見つかりません。',
        en: 'No active editor found.'
    },
    NO_VALID_PATH: {
        ja: '有効なファイルパスを選択してください。',
        en: 'Please select a valid file path.'
    },
    PATH_NOT_EXISTS: {
        ja: '指定されたパスは存在しません。',
        en: 'The specified path does not exist.'
    },
    TEXT_FILE_OPEN_ERROR: {
        ja: 'テキストファイルを開く際にエラーが発生しました：',
        en: 'Error occurred while opening text file:'
    },
    UNSUPPORTED_PLATFORM: {
        ja: 'サポートされていないプラットフォームです：',
        en: 'Unsupported platform:'
    },
    LARGE_FILE_WARNING: {
        ja: 'このファイルは大きいサイズです。VS Code内で開くと処理が遅くなる可能性があります。',
        en: 'This is a large file. Opening it within VS Code may slow down processing.'
    },
    SYMLINK_DETECTED: {
        ja: 'シンボリックリンクが検出されました。',
        en: 'Symbolic link detected.'
    },
    FOLLOW_SYMLINK_PROMPT: {
        ja: 'シンボリックリンクの参照先に移動しますか？',
        en: 'Do you want to follow this symbolic link to its target?'
    },
    COMMAND_INJECTION_RISK: {
        ja: 'コマンドに危険な文字が含まれています。',
        en: 'Command contains potentially dangerous characters.'
    },
    CUSTOM_EXPLORER_INVALID: {
        ja: 'カスタムエクスプローラーコマンドに無効な文字が含まれています。',
        en: 'Custom explorer command contains invalid characters.'
    },
    SETTINGS_UPDATED: {
        ja: 'open-in-explorer拡張機能の設定が更新されました。',
        en: 'open-in-explorer extension settings have been updated.'
    },
    README_NOT_FOUND: {
        ja: 'README.mdファイルが見つかりません。',
        en: 'README.md file not found.'
    },
    README_OPEN_ERROR: {
        ja: 'READMEを開けませんでした',
        en: 'Could not open README'
    },
    WINDOWS_PATH_INVALID: {
        ja: '選択されたテキストは有効なWindowsのパス形式ではありません。パスは絶対パス（C:\\folder\\file.txt または \\\\server\\share）である必要があります。',
        en: 'The selected text is not a valid Windows path format. Path must be an absolute path (C:\\folder\\file.txt or \\\\server\\share).'
    },
    MACOS_PATH_INVALID: {
        ja: '選択されたテキストは有効なmacOSのパス形式ではありません。パスは絶対パス（/path/to/file）である必要があります。',
        en: 'The selected text is not a valid macOS path format. Path must be an absolute path (/path/to/file).'
    },
    LINUX_PATH_INVALID: {
        ja: '選択されたテキストは有効なLinuxのパス形式ではありません。パスは絶対パス（/path/to/file）である必要があります。',
        en: 'The selected text is not a valid Linux path format. Path must be an absolute path (/path/to/file).'
    },
    FILE_STAT_ERROR: {
        ja: 'ファイル/フォルダの確認中にエラーが発生しました: ',
        en: 'Error occurred while checking file/folder: '
    },
    OPEN_IN_VSCODE: {
        ja: '通常通り開く',
        en: 'Open normally'
    },
    OPEN_IN_EXPLORER: {
        ja: 'エクスプローラーで開く',
        en: 'Open in explorer'
    },
    CANCEL: {
        ja: 'キャンセル',
        en: 'Cancel'
    },
    FOLLOW: {
        ja: '参照先に移動',
        en: 'Follow link'
    },
    STAY: {
        ja: 'リンク自体を開く',
        en: 'Open the link itself'
    }
};

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
        allowRelativePaths: config.get<boolean>('allowRelativePaths', false),
        language: config.get<string>('language', 'ja'),
        followSymlinks: config.get<boolean>('followSymlinks', true)
    };
}

/**
 * 設定された言語に基づいてメッセージを取得します。
 * @param message 多言語対応メッセージオブジェクト
 * @param language 使用する言語
 * @returns 選択された言語のメッセージ
 */
function getLocalizedMessage(message: LocalizedMessage, language: string): string {
    return language === 'en' ? message.en : message.ja;
}

/**
 * コマンドをセキュアに実行するための引数エスケープ関数
 * @param arg エスケープする引数
 * @returns エスケープされた引数
 */
function escapeShellArg(arg: string): string {
    // Windows: ダブルクォートでエスケープ
    if (process.platform === 'win32') {
        // Windowsはダブルクォートをエスケープするためにもうひとつのダブルクォートを追加
        return `"${arg.replace(/"/g, '""')}"`;
    }
    
    // Unix/Linux/macOS: シングルクォートでエスケープ
    // シングルクォートはシングルクォートを閉じて、バックスラッシュでエスケープしてから再度開く
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * カスタムエクスプローラーコマンドを検証します
 * @param command 検証するコマンド
 * @returns 有効な場合はtrue、そうでなければfalse
 */
function validateCustomExplorer(command: string): boolean {
    // 明らかに危険なパターンをチェック
    const dangerousPatterns = [
        /[;&|><$`\\]/,         // シェル特殊文字
        /(curl|wget|nc|ncat)/i,  // ネットワークツール
        /(bash|sh|cmd|powershell)/i,  // シェル実行
        /(rm|rmdir|del|format)/i,  // 削除コマンド
    ];
    
    return !dangerousPatterns.some(pattern => pattern.test(command));
}

/**
 * シェルコマンドを非同期で実行し、stdoutおよびstderrの内容をログに出力します。
 * 強化されたコマンドインジェクション対策を含みます。
 * 
 * @param commandBase 実行するコマンドのベース部分
 * @param args コマンド引数の配列
 * @returns 実行結果のPromise
 */
async function executeCommand(
    commandBase: string, 
    args: string[]
): Promise<{success: boolean, output?: string, error?: string}> {
    try {
        // カスタムコマンドの検証
        if (commandBase !== 'explorer.exe' && 
            commandBase !== 'open' && 
            commandBase !== 'xdg-open' && 
            !validateCustomExplorer(commandBase)) {
            return {
                success: false,
                error: getLocalizedMessage(MESSAGES.CUSTOM_EXPLORER_INVALID, loadConfig().language)
            };
        }
        
        // 引数をエスケープ
        const escapedArgs = args.map(arg => escapeShellArg(arg));
        
        // コマンドを構築
        const command = `${commandBase} ${escapedArgs.join(' ')}`;
        
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
 * ファイルのMIMEタイプを判定します
 * @param filePath ファイルパス
 * @returns MIMEタイプ文字列
 */
async function determineMimeType(filePath: string): Promise<string> {
    try {
        const fileExtension = path.extname(filePath).toLowerCase();
        
        // 一般的なテキストファイル拡張子
        const textExtensions = [
            '.txt', '.md', '.json', '.js', '.ts', '.html', '.css', '.xml',
            '.csv', '.yml', '.yaml', '.ini', '.conf', '.cfg', '.log',
            '.c', '.cpp', '.h', '.hpp', '.java', '.py', '.rb', '.php',
            '.sh', '.bash', '.ps1', '.bat', '.cmd', '.sql', '.diff'
        ];
        
        if (textExtensions.includes(fileExtension)) {
            return 'text/plain';
        }
        
        // バイナリと判断される一般的な拡張子
        const binaryExtensions = [
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.zip', '.rar', '.tar', '.gz', '.7z', '.exe', '.dll', '.so',
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp',
            '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
            '.db', '.sqlite', '.mdb'
        ];
        
        if (binaryExtensions.includes(fileExtension)) {
            return 'application/octet-stream';
        }
        
        // 拡張子で判断できない場合は内容を確認
        return await isTextFile(filePath) ? 'text/plain' : 'application/octet-stream';
    } catch (error) {
        console.error('MIMEタイプ判定エラー:', error);
        return 'application/octet-stream'; // エラー時はバイナリと仮定
    }
}

/**
 * 指定されたファイルがテキストファイルかどうかを判定します。
 * 改良版のロジックを使用します。
 * 
 * @param filePath ファイルのパス。
 * @param bytesToRead 判定に使用するバイト数（デフォルト: 4096）。
 * @returns テキストファイルなら true、そうでなければ false を返す Promise。
 */
async function isTextFile(filePath: string, bytesToRead: number = 4096): Promise<boolean> {
    try {
        const config = loadConfig();
        bytesToRead = config.textFileScanBytes || bytesToRead;
        
        const fileHandle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
        await fileHandle.close();
        
        // UTF-8/16/32 BOMチェック
        if (bytesRead >= 2) {
            // UTF-8 BOM: EF BB BF
            if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
                return true;
            }
            
            // UTF-16 BE BOM: FE FF
            if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
                return true;
            }
            
            // UTF-16 LE BOM: FF FE
            if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
                // UTF-32 LE BOMと区別
                if (buffer[2] !== 0x00 || buffer[3] !== 0x00) {
                    return true;
                }
            }
            
            // UTF-32 BE BOM: 00 00 FE FF
            if (buffer[0] === 0x00 && buffer[1] === 0x00 && 
                buffer[2] === 0xFE && buffer[3] === 0xFF) {
                return true;
            }
        }
        
        // null バイトが見つかった場合はバイナリファイルと見なす
        const hasNullByte = buffer.slice(0, bytesRead).includes(0);
        
        if (hasNullByte) {
            return false;
        }
        
        // コントロール文字の分析
        const controlChars = buffer.slice(0, bytesRead).filter(b => {
            // タブ(9)、LF(10)、CR(13)は許可
            return (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127;
        });
        
        const controlCharRatio = controlChars.length / bytesRead;
        
        // 20%以上がコントロール文字ならバイナリとみなす
        if (controlCharRatio > 0.2) {
            return false;
        }
        
        // ASCII範囲外の文字の分析（UTF-8の可能性）
        const nonAsciiChars = buffer.slice(0, bytesRead).filter(b => b > 127);
        const nonAsciiRatio = nonAsciiChars.length / bytesRead;
        
        // 非ASCIIが90%以上ならバイナリの可能性が高い
        if (nonAsciiRatio > 0.9) {
            return false;
        }
        
        // 上記の条件を通過したらテキストファイルと判断
        return true;
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
    validatePath(selectedText: string, allowRelative: boolean): LocalizedMessage | null;
    
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

    validatePath(selectedText: string, allowRelative: boolean): LocalizedMessage | null {
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
        
        return MESSAGES.WINDOWS_PATH_INVALID;
    }
    
    normalizePath(selectedText: string): string {
        // Windowsパスの正規化
        return path.normalize(selectedText).replace(/\//g, '\\');
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        const config = loadConfig();
        const language = config.language;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            if (isFile) {
                await executeCommand(customExplorer, ['/select,', selectedText]);
            } else {
                await executeCommand(customExplorer, [selectedText]);
            }
        } else {
            // デフォルトのエクスプローラーを使用
            if (isFile) {
                await executeCommand('explorer.exe', ['/select,', selectedText]);
            } else {
                await executeCommand('explorer.exe', [selectedText]);
            }
        }
    }
}

/**
 * macOS用のパス検証およびオープン処理ハンドラ。
 */
class MacOSHandler implements PlatformHandler {
    // 絶対パス（/path/to/file）
    private readonly ABSOLUTE_PATH_REGEX = /^\/.+/;
    
    validatePath(selectedText: string, allowRelative: boolean): LocalizedMessage | null {
        // 絶対パス検証
        if (this.ABSOLUTE_PATH_REGEX.test(selectedText) && !selectedText.includes('..')) {
            return null;
        }
        
        // 相対パスの検証（許可されている場合）
        if (allowRelative && !selectedText.includes('..')) {
            return null;
        }
        
        return MESSAGES.MACOS_PATH_INVALID;
    }
    
    normalizePath(selectedText: string): string {
        // macOSパスの正規化
        return path.normalize(selectedText);
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        const config = loadConfig();
        const language = config.language;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            await executeCommand(customExplorer, [selectedText]);
        } else {
            // デフォルトのFinderを使用
            if (isFile) {
                await executeCommand('open', ['-R', selectedText]);
            } else {
                await executeCommand('open', [selectedText]);
            }
        }
    }
}

/**
 * Linux用のパス検証およびオープン処理ハンドラ。
 */
class LinuxHandler implements PlatformHandler {
    // 絶対パス（/path/to/file）
    private readonly ABSOLUTE_PATH_REGEX = /^\/.+/;
    
    validatePath(selectedText: string, allowRelative: boolean): LocalizedMessage | null {
        // 絶対パス検証
        if (this.ABSOLUTE_PATH_REGEX.test(selectedText) && !selectedText.includes('..')) {
            return null;
        }
        
        // 相対パスの検証（許可されている場合）
        if (allowRelative && !selectedText.includes('..')) {
            return null;
        }
        
        return MESSAGES.LINUX_PATH_INVALID;
    }
    
    normalizePath(selectedText: string): string {
        // Linuxパスの正規化
        return path.normalize(selectedText);
    }

    async openPath(selectedText: string, isFile: boolean, customExplorer?: string): Promise<void> {
        const config = loadConfig();
        const language = config.language;
        
        if (customExplorer && customExplorer.trim() !== '') {
            // カスタムエクスプローラーコマンドを使用
            await executeCommand(customExplorer, [selectedText]);
        } else {
            // デフォルトではxdg-openを使用
            if (isFile) {
                await executeCommand('xdg-open', [path.dirname(selectedText)]);
            } else {
                await executeCommand('xdg-open', [selectedText]);
            }
        }
    }
}

const PLATFORM_HANDLERS: { [key: string]: PlatformHandler } = {
    win32: new WindowsHandler(),
    darwin: new MacOSHandler(),
    linux: new LinuxHandler()
};

/**
 * エラー処理の共通関数です。エラーメッセージのログ出力とユーザーへの通知を行います。
 * @param message ユーザーに表示するエラーメッセージ。
 * @param error エラーオブジェクト（任意）。
 */
function handleError(message: LocalizedMessage | string, error?: any): void {
    const config = loadConfig();
    const language = config.language;
    
    let localizedMessage: string;
    if (typeof message === 'string') {
        localizedMessage = message;
    } else {
        localizedMessage = getLocalizedMessage(message, language);
    }
    
    if (error) {
        console.error(localizedMessage, error);
        vscode.window.showErrorMessage(`${localizedMessage} ${error.message || ''}`);
    } else {
        console.error(localizedMessage);
        vscode.window.showErrorMessage(localizedMessage);
    }
}

/**
 * シンボリックリンクの処理を行います。
 * @param filePath シンボリックリンクのパス
 * @param config 拡張機能の設定
 * @returns 処理すべきパス（リンク先またはリンク自体）
 */
async function handleSymlink(filePath: string, config: ExtensionConfig): Promise<string> {
    try {
        const language = config.language;
        const stats = await fs.lstat(filePath);
        
        if (stats.isSymbolicLink()) {
            // シンボリックリンクが検出された場合、ユーザーに確認
            const message = getLocalizedMessage(MESSAGES.SYMLINK_DETECTED, language);
            const prompt = getLocalizedMessage(MESSAGES.FOLLOW_SYMLINK_PROMPT, language);
            const followOption = getLocalizedMessage(MESSAGES.FOLLOW, language);
            const stayOption = getLocalizedMessage(MESSAGES.STAY, language);
            
            // 自動追跡の設定がある場合は確認せずに追跡
            if (config.followSymlinks) {
                return await fs.readlink(filePath);
            }
            
            const result = await vscode.window.showInformationMessage(
                `${message} ${prompt}`,
                followOption,
                stayOption
            );
            
            if (result === followOption) {
                // リンク先を取得
                return await fs.readlink(filePath);
            }
        }
        
        // シンボリックリンクでない、またはユーザーが「リンク自体を開く」を選択した場合
        return filePath;
    } catch (error) {
        console.error('シンボリックリンク処理エラー:', error);
        return filePath; // エラー時は元のパスを返す
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
    const language = config.language;
    
    // パスの正規化
    let normalizedPath = platformHandler.normalizePath(selectedText);
    
    // シンボリックリンクの処理
    normalizedPath = await handleSymlink(normalizedPath, config);
    
    let stats;
    try {
        stats = await fs.stat(normalizedPath);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            handleError(MESSAGES.PATH_NOT_EXISTS);
        } else {
            handleError(
                `${getLocalizedMessage(MESSAGES.FILE_STAT_ERROR, language)}${error.message || ''}`, 
                error
            );
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

        // MIMEタイプの判定
        const mimeType = await determineMimeType(normalizedPath);
        const isTextMime = mimeType.startsWith('text/');
        
        if (isTextMime) {
            // 大きなファイルの場合は確認ダイアログを表示
            if (isLargeFile && config.confirmLargeFileOpen) {
                const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
                const warningMessage = getLocalizedMessage(MESSAGES.LARGE_FILE_WARNING, language);
                const openNormalOption = getLocalizedMessage(MESSAGES.OPEN_IN_VSCODE, language);
                const openExplorerOption = getLocalizedMessage(MESSAGES.OPEN_IN_EXPLORER, language);
                const cancelOption = getLocalizedMessage(MESSAGES.CANCEL, language);
                
                const result = await vscode.window.showWarningMessage(
                    `${warningMessage} (${fileSizeMB} MB)`,
                    openNormalOption,
                    openExplorerOption,
                    cancelOption
                );
                
                if (result === openExplorerOption) {
                    await platformHandler.openPath(
                        normalizedPath, 
                        isFile, 
                        getPlatformSpecificExplorer(process.platform, config)
                    );
                    return;
                } else if (result !== openNormalOption) {
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
                handleError(MESSAGES.TEXT_FILE_OPEN_ERROR, error);
                return;
            }
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
            const config = loadConfig();
            const language = config.language;
            
            // 設定が変更されたことをユーザーに通知
            vscode.window.showInformationMessage(
                getLocalizedMessage(MESSAGES.SETTINGS_UPDATED, language)
            );
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
        const language = config.language;
        
        // 1. アクティブエディタを取得
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            handleError(MESSAGES.NO_ACTIVE_EDITOR);
            return;
        }

        // 2. 選択されたテキストを取得し、検証する
        const selection = editor.selection;
        const rawSelectedText = editor.document.getText(selection).trim();
        if (!rawSelectedText) {
            handleError(MESSAGES.NO_VALID_PATH);
            return;
        }
        
        // パスをサニタイズ
        const selectedText = sanitizePath(rawSelectedText);

        // 3. 適切なプラットフォームハンドラを選択
        const platformHandler = PLATFORM_HANDLERS[process.platform];
        if (!platformHandler) {
            handleError(`${getLocalizedMessage(MESSAGES.UNSUPPORTED_PLATFORM, language)}${process.platform}`);
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
    const showReadmeCommand = vscode.commands.registerCommand('extension.showPathOpenerReadme', async () => {
        try {
            const config = loadConfig();
            const language = config.language;
            const readmePath = path.join(context.extensionPath, 'README.md');
            
            // READMEファイルの存在確認
            const exists = await fileExists(readmePath);
            if (!exists) {
                vscode.window.showInformationMessage(
                    getLocalizedMessage(MESSAGES.README_NOT_FOUND, language)
                );
                return;
            }
            
            const readmeUri = vscode.Uri.file(readmePath);
            const doc = await vscode.workspace.openTextDocument(readmeUri);
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            handleError(MESSAGES.README_OPEN_ERROR, err);
        }
    });
    
    context.subscriptions.push(showReadmeCommand);
}

/**
 * 拡張機能が非アクティブ化される際に呼ばれるメソッドです。
 */
export function deactivate() { }