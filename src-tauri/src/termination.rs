//! Keep Cocoa's Dock/system quit route on the same unsaved-work guard as Cmd-Q.
//! Tao's applicationWillTerminate notification is too late to cancel termination.

use std::{
    ffi::{c_char, c_void},
    sync::OnceLock,
};
use tauri::{Emitter, Manager};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
    fn object_getClass(object: *mut c_void) -> *mut c_void;
    fn class_addMethod(
        class: *mut c_void,
        selector: *mut c_void,
        implementation: *const c_void,
        types: *const c_char,
    ) -> bool;
}

extern "C" fn should_terminate(_: *mut c_void, _: *mut c_void, _: *mut c_void) -> usize {
    if let Some(app) = APP.get() {
        if app.get_webview_window("main").is_some() {
            let _ = app.emit("easyreaktoro:request-exit", ());
            return 0; // NSTerminateCancel; the window is destroyed only after the guard.
        }
    }
    1 // NSTerminateNow when no editable window remains.
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    // Called from Tauri setup on the macOS main thread. These two selectors
    // have no arguments beyond receiver/selector and return Objective-C objects.
    unsafe {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let application = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let delegate = send(application, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() {
            return Err("无法安装 macOS 未保存更改保护：应用委托尚未就绪".into());
        }
        // NSUInteger applicationShouldTerminate:(NSApplication *): Q@:@ on arm64.
        if !class_addMethod(
            object_getClass(delegate),
            sel_registerName(c"applicationShouldTerminate:".as_ptr()),
            should_terminate as *const () as *const c_void,
            c"Q@:@".as_ptr(),
        ) {
            return Err("无法安装 macOS 未保存更改保护：运行时已有不同的退出处理器".into());
        }
    }
    Ok(())
}
