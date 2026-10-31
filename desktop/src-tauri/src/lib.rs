//! Обёртка Offerly для Windows (5.2): окно с живым адресом offerly-c8b.pages.dev, значок в трее,
//! нативные уведомления и автообновление по latest.json последнего релиза GitHub.
//!
//! Крестик окна прячет приложение в трей (напоминания продолжают приходить), выход — из меню значка.
//! Обновления проверяются через 20 секунд после запуска и дальше раз в 6 часов; найденное обновление не
//! ставится само — приходит уведомление, а в меню трея появляется пункт «Установить обновление N».
//! Страница в окне видит `window.__TAURI__` (withGlobalTauri) и показывает напоминание дня нативным
//! уведомлением через plugin:notification — см. src/desktop.ts в веб-клиенте.

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Как часто проверять обновления, пока приложение запущено.
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Пауза перед первой проверкой — чтобы окно успело открыться.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);

const MENU_OPEN: &str = "open";
const MENU_CHECK: &str = "check";
const MENU_INSTALL: &str = "install";
const MENU_QUIT: &str = "quit";

/// Найденное, но ещё не установленное обновление и пункт меню, который его ставит.
struct Pending {
    update: Mutex<Option<Update>>,
    install_item: MenuItem<Wry>,
}

pub fn run() {
    tauri::Builder::default()
        // Второй запуск не открывает второе окно, а показывает уже запущенное.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FIRST_CHECK_AFTER).await;
                loop {
                    check_updates(&handle, false).await;
                    tokio::time::sleep(UPDATE_EVERY).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик прячет окно в трей; выход — из меню значка.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Offerly не запустился");
}

/// Показать главное окно (из трея, после второго запуска, по пункту меню).
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Открыть Offerly", true, None::<&str>)?;
    let check = MenuItem::with_id(app, MENU_CHECK, "Проверить обновления", true, None::<&str>)?;
    let install = MenuItem::with_id(app, MENU_INSTALL, "Обновлений нет", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Выход", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &check, &install, &separator, &quit])?;
    app.manage(Pending { update: Mutex::new(None), install_item: install.clone() });

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("иконка приложения задана в tauri.conf.json");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Offerly")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_CHECK => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move { check_updates(&h, true).await });
            }
            MENU_INSTALL => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move { install_pending(&h).await });
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Нативное уведомление Windows от самого приложения (обновления); напоминания дня шлёт страница через plugin:notification.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("уведомление не показано: {e}");
    }
}

/// Проверка latest.json. manual — по пункту меню: тогда сообщаем и об отсутствии обновлений, и об ошибке.
async fn check_updates(app: &AppHandle, manual: bool) {
    let current = app.package_info().version.to_string();
    let result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let pending = app.state::<Pending>();
            let _ = pending.install_item.set_text(format!("Установить обновление {version}"));
            let _ = pending.install_item.set_enabled(true);
            *pending.update.lock().expect("pending update") = Some(update);
            notify(
                app,
                &format!("Offerly {version}"),
                "Доступно обновление. Установить — в меню значка Offerly в трее, приложение перезапустится.",
            );
        }
        Ok(None) => {
            if manual {
                notify(app, "Offerly", &format!("Обновлений нет — у вас последняя версия {current}."));
            }
        }
        Err(e) => {
            log::warn!("проверка обновлений: {e}");
            if manual {
                notify(app, "Offerly", &format!("Проверить обновления не удалось: {e}"));
            }
        }
    }
}

/// Скачивает и запускает установщик найденного обновления; на Windows установщик сам закрывает приложение.
async fn install_pending(app: &AppHandle) {
    let update = app.state::<Pending>().update.lock().expect("pending update").clone();
    let Some(update) = update else { return };
    notify(app, &format!("Offerly {}", update.version), "Обновление скачивается, приложение перезапустится само.");
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => app.restart(),
        Err(e) => notify(app, "Offerly", &format!("Обновление не установилось: {e}")),
    }
}
