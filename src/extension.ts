import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('extension.openInExplorer', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("アクティブなエディタが見つかりません。");
            return;
        }
        
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection).trim();
        if (!selectedText) {
            vscode.window.showErrorMessage("有効なファイルパスを選択してください。");
            return;
        }

        // OSごとのパス形式のバリデーション
        if (process.platform === 'win32') {
            // Windowsの共有フォルダ（UNCパス）のみ判定
            const uncPathRegex = /^\\\\[^\\]+\\[^\\]+/;
            if (!uncPathRegex.test(selectedText)) {
                vscode.window.showErrorMessage("選択されたテキストは有効なWindowsの共有フォルダのパスではありません。");
                return;
            }
        } else if (process.platform === 'darwin') {
            if (!selectedText.startsWith('/')) {
                vscode.window.showErrorMessage("選択されたテキストは有効なmacOSの絶対パスではありません。");
                return;
            }
        }

        if (!fs.existsSync(selectedText)) {
            vscode.window.showErrorMessage("指定されたパスは存在しません。");
            return;
        }
        
        const stats = fs.statSync(selectedText);
        let command: string = "";

        if (process.platform === 'win32') {
            if (stats.isFile()) {
                // ファイルの場合はエクスプローラー上でファイルを選択状態にする
                command = `explorer.exe /select,"${selectedText}"`;
            } else if (stats.isDirectory()) {
                command = `explorer.exe "${selectedText}"`;
            }
        } else if (process.platform === 'darwin') {
            if (stats.isFile()) {
                command = `open -R "${selectedText}"`;
            } else if (stats.isDirectory()) {
                command = `open "${selectedText}"`;
            }
        }

        child_process.exec(command, (err, stdout, stderr) => {
            if (err) {
                console.log(err);
                vscode.window.showErrorMessage("エクスプローラーを開く際にエラーが発生しました: " + (err.message || ""));
            }
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
