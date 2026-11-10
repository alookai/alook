use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        net::UnixListener as NativeListener,
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Resource, RunEvent, Runtime};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    time::{sleep, timeout, timeout_at, Instant},
};

const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(1);
const RETRY_INTERVAL: Duration = Duration::from_millis(20);
const MAX_MESSAGE_BYTES: usize = 262_144;
const ACKNOWLEDGMENT: &[u8] = b"ALOOK-SI-1";

type Callback<R> = dyn FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync;

struct Ownership {
    file: File,
    acquired: bool,
}

impl Ownership {
    fn new(file: File) -> Self {
        Self {
            file,
            acquired: false,
        }
    }

    fn try_acquire(&mut self) -> io::Result<bool> {
        match self.file.try_lock() {
            Ok(()) => {
                self.acquired = true;
                Ok(true)
            }
            Err(TryLockError::WouldBlock) => Ok(false),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

impl Drop for Ownership {
    fn drop(&mut self) {
        if self.acquired {
            let _ = self.file.unlock();
        }
    }
}

struct Owner {
    _lock: Ownership,
    socket: PathBuf,
    endpoint: (u64, u64),
}

impl Drop for Owner {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.socket).is_ok_and(|metadata| {
            metadata.file_type().is_socket() && (metadata.dev(), metadata.ino()) == self.endpoint
        }) {
            let _ = fs::remove_file(&self.socket);
        }
    }
}

struct Primary {
    owner: Arc<Owner>,
    listener: UnixListener,
}

enum Admission {
    Primary(Primary),
    Secondary,
}

struct Instance {
    owner: Arc<Owner>,
    listener: Mutex<Option<UnixListener>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Resource for Instance {}

impl Drop for Instance {
    fn drop(&mut self) {
        if let Ok(task) = self.task.get_mut() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
        if let Ok(listener) = self.listener.get_mut() {
            listener.take();
        }
    }
}

struct InstanceResource(u32);

pub(crate) fn init<R, F>(callback: F) -> TauriPlugin<R>
where
    R: Runtime,
    F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static,
{
    let callback: Arc<Mutex<Box<Callback<R>>>> = Arc::new(Mutex::new(Box::new(callback)));
    tauri::plugin::Builder::new("single-instance")
        .setup(|app, _| {
            let directory = app.path().app_local_data_dir()?;
            fs::create_dir_all(&directory)?;
            let identifier = app.config().identifier.replace(['.', '-'].as_ref(), "_");
            let socket = PathBuf::from(format!("/tmp/{identifier}_si.sock"));
            let message = current_message()?;
            match tauri::async_runtime::block_on(admit(
                &directory.join("single-instance.lock"),
                &socket,
                &message,
                DELIVERY_TIMEOUT,
            ))? {
                Admission::Primary(primary) => {
                    let id = app.resources_table().add(Instance {
                        owner: primary.owner,
                        listener: Mutex::new(Some(primary.listener)),
                        task: Mutex::new(None),
                    });
                    if !app.manage(InstanceResource(id)) {
                        app.resources_table().close(id)?;
                        return Err(io::Error::other("single-instance already initialized").into());
                    }
                }
                Admission::Secondary => std::process::exit(0),
            }
            Ok(())
        })
        .on_event(move |app, event| {
            if !matches!(event, RunEvent::Ready) {
                return;
            }
            let id = app.state::<InstanceResource>().0;
            let instance = app.resources_table().get::<Instance>(id);
            let result = instance
                .map_err(|_| io::Error::other("single-instance resource unavailable"))
                .and_then(|instance| start_receiver(&instance, app.clone(), callback.clone()));
            if result.is_err() {
                eprintln!("native single-instance receiver unavailable");
                app.exit(1);
            }
        })
        .build()
}

fn start_receiver<R: Runtime>(
    instance: &Instance,
    app: AppHandle<R>,
    callback: Arc<Mutex<Box<Callback<R>>>>,
) -> io::Result<()> {
    let listener = instance
        .listener
        .lock()
        .map_err(|_| io::Error::other("single-instance listener unavailable"))?
        .take();
    let Some(listener) = listener else {
        return Ok(());
    };
    let owner = instance.owner.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _owner = owner;
        loop {
            let mut stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    eprintln!("native single-instance listener failed");
                    app.exit(1);
                    return;
                }
            };
            let Ok(Ok((args, cwd))) = timeout(CONNECTION_TIMEOUT, read_message(&mut stream)).await
            else {
                continue;
            };
            let delivered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut callback = callback
                    .lock()
                    .map_err(|_| io::Error::other("single-instance callback unavailable"))?;
                if let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<R>>() {
                    deep_link.handle_cli_arguments(args.iter());
                }
                callback(&app, args, cwd);
                Ok::<_, io::Error>(())
            }));
            if !matches!(delivered, Ok(Ok(()))) {
                eprintln!("native single-instance activation failed");
                app.exit(1);
                return;
            }
            let _ = timeout(CONNECTION_TIMEOUT, stream.write_all(ACKNOWLEDGMENT)).await;
        }
    });
    *instance
        .task
        .lock()
        .map_err(|_| io::Error::other("single-instance task unavailable"))? = Some(task);
    Ok(())
}

fn current_message() -> io::Result<Vec<u8>> {
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let args = std::env::args_os()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let message = format!("{cwd}\0\0{}", args.join("\0")).into_bytes();
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "activation too large",
        ));
    }
    Ok(message)
}

fn open_lock(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    let named = fs::symlink_metadata(path)?;
    let opened = file.metadata()?;
    if !named.file_type().is_file()
        || named.len() != 0
        || (named.dev(), named.ino()) != (opened.dev(), opened.ino())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid ownership file",
        ));
    }
    Ok(file)
}

async fn admit(
    lock_path: &Path,
    socket: &Path,
    message: &[u8],
    budget: Duration,
) -> io::Result<Admission> {
    let mut lock = Ownership::new(open_lock(lock_path)?);
    let deadline = Instant::now() + budget;
    loop {
        let owns = lock.try_acquire()?;
        match timeout_at(deadline, notify(socket, message)).await {
            Ok(Ok(())) => return Ok(Admission::Secondary),
            Ok(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "activation timed out",
                ))
            }
        }
        if owns {
            return bind_primary(lock, socket).map(Admission::Primary);
        }
        timeout_at(deadline, sleep(RETRY_INTERVAL))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "receiver not ready"))?;
    }
}

fn bind_primary(lock: Ownership, socket: &Path) -> io::Result<Primary> {
    match fs::symlink_metadata(socket) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(socket)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "invalid activation endpoint",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = NativeListener::bind(socket)?;
    let metadata = fs::symlink_metadata(socket)?;
    let owner = Arc::new(Owner {
        _lock: lock,
        socket: socket.to_owned(),
        endpoint: (metadata.dev(), metadata.ino()),
    });
    listener.set_nonblocking(true)?;
    let listener = UnixListener::from_std(listener)?;
    Ok(Primary { owner, listener })
}

async fn notify(socket: &Path, message: &[u8]) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket).await?;
    stream.write_all(message).await?;
    stream.shutdown().await?;
    let mut reply = Vec::new();
    (&mut stream)
        .take((ACKNOWLEDGMENT.len() + 1) as u64)
        .read_to_end(&mut reply)
        .await?;
    if reply == ACKNOWLEDGMENT {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation not acknowledged",
        ))
    }
}

async fn read_message(stream: &mut UnixStream) -> io::Result<(Vec<String>, String)> {
    let mut bytes = Vec::new();
    stream
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "activation too large",
        ));
    }
    let value = String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid activation encoding"))?;
    let (cwd, args) = value
        .split_once("\0\0")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "incomplete activation"))?;
    Ok((
        args.split('\0').map(str::to_owned).collect(),
        cwd.to_owned(),
    ))
}

#[cfg(test)]
mod tests;
