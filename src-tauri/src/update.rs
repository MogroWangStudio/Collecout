//! 应用内更新：下载安装包、双下载源测速、退出后替换自身并重启。
//!
//! 前端只负责版本比较与界面状态，真正的网络与文件操作用系统原生方式完成：
//! WebView 里 fetch 发行包会被 CORS 拦下（GitHub 资产不返回 CORS 头），
//! 所以下载与测速都走 reqwest；替换自身则必须交给独立进程，否则无法覆盖运行中的 exe。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 下载进度事件（与前端 listen 的事件名一致）
const PROGRESS_EVENT: &str = "update:progress";

/// 用户点了「取消下载」：下载循环每收一块检查一次，置位后立即中断并清掉半截文件
static CANCELED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
pub struct Speed {
    bytes: u64,
    millis: u64,
    bps: f64,
}

/// Windows 侧替换自身用的批处理。内容保持纯 ASCII（中文路径全部走环境变量），
/// 避免代码页问题把路径写坏。
const WINDOWS_HELPER: &str = r#"@echo off
setlocal
:wait
ping -n 2 127.0.0.1 >nul
del /f /q "%COLLECOUT_CUR_EXE%" >nul 2>&1
if exist "%COLLECOUT_CUR_EXE%" goto wait
copy /y "%COLLECOUT_NEW_EXE%" "%COLLECOUT_CUR_EXE%" >nul
cd /d "%COLLECOUT_APP_DIR%"
start "" "%COLLECOUT_CUR_EXE%"
rd /s /q "%COLLECOUT_TMP_DIR%" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#;

/// macOS 侧替换自身用的 shell 脚本：等进程退出 → 解包 → 覆盖 .app → 重新打开。
/// 覆盖失败（例如 /Applications 无写权限）时直接打开解出来的新副本，不至于什么都没发生。
const MAC_HELPER: &str = r#"#!/bin/sh
APP="$1"
ARCHIVE="$2"
sleep 1
while pgrep -x Collecout >/dev/null 2>&1; do sleep 0.5; done
TMP=$(mktemp -d /tmp/collecout-update.XXXXXX)
if ! ditto -x -k "$ARCHIVE" "$TMP" >/dev/null 2>&1; then
  rm -rf "$TMP"
  exit 0
fi
NEW=$(find "$TMP" -maxdepth 1 -name '*.app' -print -quit)
if [ -z "$NEW" ]; then
  rm -rf "$TMP"
  exit 0
fi
if rm -rf "$APP" 2>/dev/null && ditto "$NEW" "$APP" 2>/dev/null; then
  open "$APP"
else
  open "$NEW"
fi
rm -f "$0"
"#;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Collecout-Updater")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// 只保留文件名，挡掉前端传来的任何路径成分
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    if cleaned.is_empty() {
        "Collecout-update.zip".into()
    } else {
        cleaned
    }
}

fn find_by_name(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_by_name(&path, name) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(name))
        {
            return Some(path);
        }
    }
    None
}

/// 下载更新包到系统临时目录，边下边发 `update:progress`（received / total 字节）。
/// 返回落盘后的绝对路径，交给 `install_update` 使用。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    CANCELED.store(false, Ordering::SeqCst);

    let client = client()?;
    let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);

    let dir = std::env::temp_dir().join("collecout-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(safe_file_name(&file_name));
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;

    let mut received: u64 = 0;
    loop {
        if CANCELED.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&dest);
            return Err("已取消下载".into());
        }
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&dest);
                return Err(e.to_string());
            }
        };
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress {
                received,
                total,
            },
        );
    }
    file.flush().map_err(|e| e.to_string())?;

    // 传了 total 但字节数对不上，说明连接被中断，不能拿半截包去安装
    if total > 0 && received != total {
        let _ = std::fs::remove_file(&dest);
        return Err("下载不完整，请重试".into());
    }

    Ok(dest.to_string_lossy().into_owned())
}

/// 中断正在进行的下载
#[tauri::command]
pub fn cancel_download() {
    CANCELED.store(true, Ordering::SeqCst);
}

/// 测速：下载最多 1.2 MB 或 5 秒，返回实际字节数与耗时，前端换算成 MB/s。
/// 超时或中途断流时，只要已经收到过数据就按已收部分计算，避免整次测速作废。
#[tauri::command]
pub async fn probe_speed(url: String) -> Result<Speed, String> {
    const LIMIT: u64 = 1_200_000;

    let client = client()?;
    let start = std::time::Instant::now();
    let mut resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let mut bytes: u64 = 0;
    loop {
        if bytes >= LIMIT {
            break;
        }
        match resp.chunk().await {
            Ok(Some(chunk)) => bytes += chunk.len() as u64,
            Ok(None) => break,
            Err(e) => {
                if bytes == 0 {
                    return Err(e.to_string());
                }
                break;
            }
        }
    }

    let millis = start.elapsed().as_millis().max(1) as u64;
    let bps = bytes as f64 / (millis as f64 / 1000.0);
    Ok(Speed {
        bytes,
        millis,
        bps,
    })
}

/// 安装已下载的更新包：解包 → 起一个等待进程退出后替换自身的助手 → 前端随后退出应用。
#[tauri::command]
pub fn install_update(archive: String) -> Result<(), String> {
    let archive = PathBuf::from(archive);
    if !archive.is_file() {
        return Err("更新包已不存在，请重新下载".into());
    }

    #[cfg(target_os = "windows")]
    {
        install_windows(&archive)
    }
    #[cfg(target_os = "macos")]
    {
        install_macos(&archive)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = archive;
        Err("当前平台暂不支持自动安装，请手动解压替换".into())
    }
}

#[cfg(target_os = "windows")]
fn install_windows(archive: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_dir = exe
        .parent()
        .ok_or("无法定位程序所在目录")?
        .to_path_buf();
    let extract_dir = std::env::temp_dir().join("collecout-update-extract");
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    // Windows 10 1803+ 自带 tar（bsdtar），直接解 zip，省一个 zip 依赖
    let output = std::process::Command::new("tar")
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(&extract_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("解压失败：{e}"))?;
    if !output.status.success() {
        return Err("解压更新包失败".into());
    }

    let new_exe = find_by_name(&extract_dir, "Collecout.exe").ok_or("更新包里没有 Collecout.exe")?;
    let script = std::env::temp_dir().join("collecout-update.bat");
    std::fs::write(&script, WINDOWS_HELPER).map_err(|e| e.to_string())?;

    std::process::Command::new("cmd")
        .arg("/C")
        .arg(&script)
        .env("COLLECOUT_NEW_EXE", &new_exe)
        .env("COLLECOUT_CUR_EXE", &exe)
        .env("COLLECOUT_APP_DIR", &app_dir)
        .env("COLLECOUT_TMP_DIR", &extract_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos(archive: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // .../Collecout.app/Contents/MacOS/Collecout → .../Collecout.app
    let app = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or("无法定位应用包")?
        .to_path_buf();

    let script = std::env::temp_dir().join("collecout-update.sh");
    std::fs::write(&script, MAC_HELPER).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    std::process::Command::new("/bin/sh")
        .arg(&script)
        .arg(&app)
        .arg(archive)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 退出应用（更新安装流程的最后一步：助手进程正等着本进程退出）
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
