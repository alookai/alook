use crate::current_listener::CurrentListener;
use serde::Serialize;

#[cfg(mobile)]
use crate::native_command_guard::guard;
#[cfg(mobile)]
use std::sync::Mutex;
#[cfg(mobile)]
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowLifecycleEvent {
    Suspended,
    Resumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLifecycleListenResult {
    pub registration_id: u64,
    pub suspended: bool,
}

struct WindowLifecycleCore<T> {
    suspended: bool,
    listeners: CurrentListener<T>,
}

impl<T> Default for WindowLifecycleCore<T> {
    fn default() -> Self {
        Self {
            suspended: false,
            listeners: CurrentListener::default(),
        }
    }
}

impl<T> WindowLifecycleCore<T> {
    fn listen(&mut self, channel: T) -> WindowLifecycleListenResult {
        let registration_id = self.listeners.install(channel);
        WindowLifecycleListenResult {
            registration_id,
            suspended: self.suspended,
        }
    }

    fn unlisten(&mut self, registration_id: u64) {
        self.listeners.remove(registration_id);
    }

    fn retire(&mut self) {
        self.listeners.retire();
    }

    fn record(&mut self, suspended: bool, send: impl FnOnce(&T, WindowLifecycleEvent) -> bool) {
        self.suspended = suspended;
        let event = if suspended {
            WindowLifecycleEvent::Suspended
        } else {
            WindowLifecycleEvent::Resumed
        };
        self.listeners.notify(|channel| send(channel, event));
    }
}

#[cfg(mobile)]
#[derive(Default)]
pub struct WindowLifecycleState {
    core: Mutex<WindowLifecycleCore<Channel<WindowLifecycleEvent>>>,
}

#[cfg(mobile)]
pub fn retire_listener(app: &AppHandle) {
    if let Some(state) = app.try_state::<WindowLifecycleState>() {
        if let Ok(mut core) = state.core.lock() {
            core.retire();
        }
    }
}

#[cfg(mobile)]
pub fn record_lifecycle(app: &AppHandle, suspended: bool) {
    if let Some(state) = app.try_state::<WindowLifecycleState>() {
        if let Ok(mut core) = state.core.lock() {
            core.record(suspended, |channel, event| channel.send(event).is_ok());
        }
    }
}

#[cfg(mobile)]
#[tauri::command]
pub fn window_lifecycle_listen(
    window: WebviewWindow,
    channel: Channel<WindowLifecycleEvent>,
) -> Result<WindowLifecycleListenResult, &'static str> {
    guard(&window)?;
    let state = window
        .app_handle()
        .try_state::<WindowLifecycleState>()
        .ok_or("lifecycle_unavailable")?;
    let mut core = state.core.lock().map_err(|_| "lifecycle_unavailable")?;
    Ok(core.listen(channel))
}

#[cfg(mobile)]
#[tauri::command]
pub fn window_lifecycle_unlisten(
    window: WebviewWindow,
    registration_id: u64,
) -> Result<(), &'static str> {
    guard(&window)?;
    let state = window
        .app_handle()
        .try_state::<WindowLifecycleState>()
        .ok_or("lifecycle_unavailable")?;
    let mut core = state.core.lock().map_err(|_| "lifecycle_unavailable")?;
    core.unlisten(registration_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{WindowLifecycleCore, WindowLifecycleEvent};
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn listen_returns_current_suspended_snapshot_and_retire_preserves_os_state() {
        let mut core = WindowLifecycleCore::<Rc<RefCell<Vec<WindowLifecycleEvent>>>>::default();
        let first_events = Rc::new(RefCell::new(Vec::new()));
        let first = core.listen(first_events.clone());
        assert!(!first.suspended);

        core.record(true, |sink, event| {
            sink.borrow_mut().push(event);
            true
        });
        assert_eq!(
            *first_events.borrow(),
            vec![WindowLifecycleEvent::Suspended]
        );

        // Navigation retires the channel without forgetting that the OS window is suspended.
        core.retire();
        let second_events = Rc::new(RefCell::new(Vec::new()));
        let second = core.listen(second_events.clone());
        assert!(second.suspended);
        assert!(second.registration_id > first.registration_id);

        // Stale unlisten from the previous document cannot remove the active channel.
        core.unlisten(first.registration_id);
        core.record(false, |sink, event| {
            sink.borrow_mut().push(event);
            true
        });
        assert_eq!(*second_events.borrow(), vec![WindowLifecycleEvent::Resumed]);

        // Active unlisten stops further delivery while still tracking OS state.
        core.unlisten(second.registration_id);
        core.record(true, |sink, event| {
            sink.borrow_mut().push(event);
            true
        });
        assert_eq!(*second_events.borrow(), vec![WindowLifecycleEvent::Resumed]);

        let third = core.listen(Rc::new(RefCell::new(Vec::new())));
        assert!(third.suspended);
    }

    #[test]
    fn failed_channel_send_retires_listener_cleanly() {
        let mut core = WindowLifecycleCore::<u8>::default();
        let first = core.listen(1);
        assert_eq!(first.registration_id, 1);
        core.record(true, |_, _| false);
        core.record(false, |_, _| panic!("retired channel must not be called"));
    }
}
