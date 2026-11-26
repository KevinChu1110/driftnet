use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 8787;

struct SidecarState(Mutex<Option<CommandChild>>);

fn server_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn wait_for_server(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..60 {
        if TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Minimal local HTTP POST to /api/ingest for "Save link from clipboard" without extra crates.
fn ingest_local_url(port: u16, url: &str) {
    let body = serde_json::json!({ "url": url, "platform": "desktop", "chat": "clipboard" }).to_string();
    let req = format!(
        "POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.write_all(req.as_bytes());
        let mut buf = [0u8; 256];
        let _ = stream.read(&mut buf);
    }
}

fn spawn_sidecar(app: &AppHandle, port: u16) {
    let public_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("resources").join("public"));

    let mut cmd = match app.shell().sidecar("driftnet-server") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[driftnet-desktop] failed to locate sidecar: {e}");
            return;
        }
    };
    cmd = cmd
        .args(["start"])
        .env("DRIFTNET_OPEN", "0")
        .env("PORT", port.to_string());
    if let Some(dir) = public_dir {
        if dir.exists() {
            cmd = cmd.env("DRIFTNET_PUBLIC_DIR", dir.to_string_lossy().to_string());
        }
    }

    match cmd.spawn() {
        Ok((_rx, child)) => {
            if let Ok(mut slot) = app.state::<SidecarState>().0.lock() {
                *slot = Some(child);
            }
            let handle = app.clone();
            std::thread::spawn(move || {
                if wait_for_server(port) {
                    let _ = handle.opener().open_url(server_url(port), None::<&str>);
                }
            });
        }
        Err(e) => eprintln!("[driftnet-desktop] failed to start sidecar: {e}"),
    }
}

fn stop_sidecar(app: &AppHandle) {
    if let Ok(mut slot) = app.state::<SidecarState>().0.lock() {
        if let Some(child) = slot.take() {
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_item = MenuItem::with_id(app, "open", "Open driftnet", true, None::<&str>)?;
            let clip_item = MenuItem::with_id(
                app,
                "save_clipboard",
                "Save link from clipboard",
                true,
                None::<&str>,
            )?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit driftnet", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&open_item, &clip_item, &sep, &autostart_item, &quit_item],
            )?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("driftnet")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = app.opener().open_url(server_url(port), None::<&str>);
                    }
                    "save_clipboard" => {
                        if let Ok(text) = app.clipboard().read_text() {
                            if let Some(link) = text
                                .split_whitespace()
                                .find(|w| w.starts_with("http://") || w.starts_with("https://"))
                                .map(|s| s.to_string())
                            {
                                std::thread::spawn(move || ingest_local_url(port, &link));
                            }
                        }
                    }
                    "autostart" => {
                        let mgr = app.autolaunch();
                        if mgr.is_enabled().unwrap_or(false) {
                            let _ = mgr.disable();
                        } else {
                            let _ = mgr.enable();
                        }
                    }
                    "quit" => {
                        stop_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            spawn_sidecar(app.handle(), port);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building driftnet desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sidecar(app);
            }
        });
}
