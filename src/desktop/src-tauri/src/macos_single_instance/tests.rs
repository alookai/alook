use super::*;
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

const CHILD_MODE: &str = "ALOOK_INSTANCE_TEST_CHILD";
const CHILD_TEST: &str = "macos_single_instance::tests::cross_process_ownership_and_crash_recovery";
static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let path = PathBuf::from(format!(
            "/tmp/alook-instance-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn signal(&self, name: &str) {
        fs::write(self.path(name), []).unwrap();
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "retained native instance test evidence: {}",
                self.0.display()
            );
        } else {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

struct Process(Child);

impl Process {
    fn spawn(directory: &Directory, id: &str, mode: &str) -> Self {
        let output = File::create(directory.path(&format!("{id}.stdout"))).unwrap();
        Self(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", CHILD_TEST, "--nocapture"])
                .env(CHILD_MODE, mode)
                .env("ALOOK_INSTANCE_TEST_ROOT", &directory.0)
                .env("ALOOK_INSTANCE_TEST_ID", id)
                .stdout(Stdio::from(output.try_clone().unwrap()))
                .stderr(Stdio::from(output))
                .spawn()
                .unwrap(),
        )
    }

    fn completed(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success(), "child {} exited {status}", self.0.id());
                return;
            }
            assert!(std::time::Instant::now() < deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn wait_for(path: &Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "missing {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn message(id: &str) -> Vec<u8> {
    format!("/fixture/{id}\0\0alook\0--open\0{id}").into_bytes()
}

fn child(mode: &str) {
    let directory = PathBuf::from(std::env::var_os("ALOOK_INSTANCE_TEST_ROOT").unwrap());
    let id = std::env::var("ALOOK_INSTANCE_TEST_ID").unwrap();
    wait_for(&directory.join("start"));
    let primary = tauri::async_runtime::block_on(async {
        let lock_path = directory.join("owner.lock");
        let socket = directory.join("ipc.sock");
        if mode == "before-bind" {
            let mut lock = Ownership::new(open_lock(&lock_path).unwrap());
            assert!(lock.try_acquire().unwrap());
            fs::write(directory.join("ownership-held"), []).unwrap();
            wait_for(&directory.join("bind"));
            return bind_primary(lock, &socket).unwrap();
        }
        fs::write(directory.join(format!("{id}.attempting")), []).unwrap();
        match admit(&lock_path, &socket, &message(&id), Duration::from_secs(3))
            .await
            .unwrap()
        {
            Admission::Secondary => {
                fs::write(directory.join(format!("{id}.status")), "secondary").unwrap();
                std::process::exit(0);
            }
            Admission::Primary(primary) => primary,
        }
    });
    fs::write(directory.join(format!("{id}.status")), "primary").unwrap();
    if mode != "never-ready" {
        wait_for(&directory.join("ready"));
        tauri::async_runtime::block_on(async {
            let (mut stream, _) = primary.listener.accept().await.unwrap();
            let value = read_message(&mut stream).await.unwrap();
            fs::write(
                directory.join("received.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            stream.write_all(ACKNOWLEDGMENT).await.unwrap();
        });
    }
    wait_for(&directory.join("stop"));
    drop(primary);
}

#[test]
fn cross_process_ownership_and_crash_recovery() {
    if let Ok(mode) = std::env::var(CHILD_MODE) {
        child(&mode);
        return;
    }
    let race = Directory::new();
    let mut first = Process::spawn(&race, "a", "elect");
    let mut second = Process::spawn(&race, "b", "elect");
    race.signal("ready");
    race.signal("start");
    wait_for(&race.path("a.status"));
    wait_for(&race.path("b.status"));
    let a = fs::read_to_string(race.path("a.status")).unwrap();
    let b = fs::read_to_string(race.path("b.status")).unwrap();
    assert_eq!(
        [a.as_str(), b.as_str()]
            .iter()
            .filter(|v| **v == "primary")
            .count(),
        1
    );
    assert_eq!(
        [a.as_str(), b.as_str()]
            .iter()
            .filter(|v| **v == "secondary")
            .count(),
        1
    );
    let secondary = if a == "secondary" { "a" } else { "b" };
    let received: (Vec<String>, String) =
        serde_json::from_slice(&fs::read(race.path("received.json")).unwrap()).unwrap();
    assert_eq!(received.0, ["alook", "--open", secondary]);
    assert_eq!(received.1, format!("/fixture/{secondary}"));
    race.signal("stop");
    first.completed();
    second.completed();
    assert!(!race.path("ipc.sock").exists());
    assert!(race.path("owner.lock").is_file());

    let recovery = Directory::new();
    recovery.signal("start");
    let mut previous = Process::spawn(&recovery, "old", "never-ready");
    wait_for(&recovery.path("old.status"));
    let original_inode = fs::metadata(recovery.path("owner.lock")).unwrap().ino();
    let observer = open_lock(&recovery.path("owner.lock")).unwrap();
    assert!(matches!(observer.try_lock(), Err(TryLockError::WouldBlock)));
    previous.0.kill().unwrap();
    previous.0.wait().unwrap();
    assert!(fs::symlink_metadata(recovery.path("ipc.sock"))
        .unwrap()
        .file_type()
        .is_socket());
    let mut replacement = Process::spawn(&recovery, "new", "elect");
    wait_for(&recovery.path("new.status"));
    assert_eq!(
        fs::read_to_string(recovery.path("new.status")).unwrap(),
        "primary"
    );
    assert_eq!(
        fs::metadata(recovery.path("owner.lock")).unwrap().ino(),
        original_inode
    );
    recovery.signal("ready");
    tauri::async_runtime::block_on(async {
        timeout(
            Duration::from_secs(2),
            notify(&recovery.path("ipc.sock"), &message("recovery")),
        )
        .await
        .unwrap()
        .unwrap();
    });
    recovery.signal("stop");
    replacement.completed();
    assert!(!recovery.path("ipc.sock").exists());
    assert_eq!(
        fs::metadata(recovery.path("owner.lock")).unwrap().ino(),
        original_inode
    );
    observer.try_lock().unwrap();
}

#[test]
fn secondary_survives_the_owner_before_bind_and_ready() {
    let directory = Directory::new();
    directory.signal("start");
    let mut owner = Process::spawn(&directory, "owner", "before-bind");
    wait_for(&directory.path("ownership-held"));
    let observer = open_lock(&directory.path("owner.lock")).unwrap();
    assert!(matches!(observer.try_lock(), Err(TryLockError::WouldBlock)));
    let mut secondary = Process::spawn(&directory, "secondary", "elect");
    wait_for(&directory.path("secondary.attempting"));
    assert!(!directory.path("ipc.sock").exists());
    assert!(secondary.0.try_wait().unwrap().is_none());
    directory.signal("bind");
    wait_for(&directory.path("owner.status"));
    assert!(!directory.path("secondary.status").exists());
    directory.signal("ready");
    secondary.completed();
    assert_eq!(
        fs::read_to_string(directory.path("secondary.status")).unwrap(),
        "secondary"
    );
    let received: (Vec<String>, String) =
        serde_json::from_slice(&fs::read(directory.path("received.json")).unwrap()).unwrap();
    assert_eq!(received.0, ["alook", "--open", "secondary"]);
    directory.signal("stop");
    owner.completed();
}

#[test]
fn a_live_owner_without_ipc_times_out_without_another_primary() {
    let directory = Directory::new();
    let owner = open_lock(&directory.path("owner.lock")).unwrap();
    owner.try_lock().unwrap();
    tauri::async_runtime::block_on(async {
        let result = admit(
            &directory.path("owner.lock"),
            &directory.path("ipc.sock"),
            &message("timeout"),
            Duration::from_millis(120),
        )
        .await;
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::TimedOut));
    });
    assert!(!directory.path("ipc.sock").exists());
    assert!(matches!(
        open_lock(&directory.path("owner.lock")).unwrap().try_lock(),
        Err(TryLockError::WouldBlock)
    ));
}

#[test]
fn ownership_and_endpoint_errors_preserve_existing_objects() {
    let directory = Directory::new();
    let lock = directory.path("owner.lock");
    let socket = directory.path("ipc.sock");
    fs::create_dir(&lock).unwrap();
    assert!(open_lock(&lock).is_err());
    fs::remove_dir(&lock).unwrap();
    let target = directory.path("target");
    fs::write(&target, "preserve").unwrap();
    std::os::unix::fs::symlink(&target, &lock).unwrap();
    assert!(open_lock(&lock).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "preserve");
    fs::remove_file(&lock).unwrap();
    fs::write(&socket, "preserve").unwrap();
    tauri::async_runtime::block_on(async {
        assert!(
            admit(&lock, &socket, &message("invalid"), Duration::from_secs(1))
                .await
                .is_err()
        );
    });
    assert_eq!(fs::read_to_string(&socket).unwrap(), "preserve");
    assert!(open_lock(&lock).unwrap().try_lock().is_ok());
    fs::remove_file(&socket).unwrap();
    std::os::unix::fs::symlink(&target, &socket).unwrap();
    tauri::async_runtime::block_on(async {
        assert!(
            admit(&lock, &socket, &message("invalid"), Duration::from_secs(1))
                .await
                .is_err()
        );
    });
    assert!(fs::symlink_metadata(&socket)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "preserve");
}

#[test]
fn cleanup_keeps_a_replaced_endpoint_and_the_lock_inode() {
    let directory = Directory::new();
    tauri::async_runtime::block_on(async {
        let lock = directory.path("owner.lock");
        let socket = directory.path("ipc.sock");
        let Admission::Primary(primary) =
            admit(&lock, &socket, &message("owner"), Duration::from_secs(1))
                .await
                .unwrap()
        else {
            panic!("primary missing")
        };
        let inode = fs::metadata(&lock).unwrap().ino();
        fs::rename(&socket, directory.path("old.sock")).unwrap();
        fs::write(&socket, "replacement").unwrap();
        drop(primary);
        assert_eq!(fs::read_to_string(&socket).unwrap(), "replacement");
        assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
        open_lock(&lock).unwrap().try_lock().unwrap();
    });
}

#[test]
fn normal_release_unlocks_even_with_a_surviving_duplicate_descriptor() {
    let directory = Directory::new();
    let path = directory.path("owner.lock");
    let mut ownership = Ownership::new(open_lock(&path).unwrap());
    assert!(ownership.try_acquire().unwrap());
    let duplicate = ownership.file.try_clone().unwrap();
    assert!(matches!(
        open_lock(&path).unwrap().try_lock(),
        Err(TryLockError::WouldBlock)
    ));
    drop(ownership);
    let next = open_lock(&path).unwrap();
    next.try_lock().unwrap();
    drop(duplicate);
    assert!(matches!(
        open_lock(&path).unwrap().try_lock(),
        Err(TryLockError::WouldBlock)
    ));
    next.unlock().unwrap();
}

#[test]
fn nul_arguments_require_an_acknowledged_delivery() {
    let directory = Directory::new();
    tauri::async_runtime::block_on(async {
        let socket = directory.path("unconfirmed.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let unconfirmed_receiver = tauri::async_runtime::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_message(&mut stream).await.unwrap()
        });
        assert!(matches!(
            admit(
                &directory.path("owner.lock"),
                &socket,
                &message("wire"),
                Duration::from_secs(1)
            )
            .await,
            Err(error) if error.kind() == io::ErrorKind::InvalidData
        ));
        let value = unconfirmed_receiver.await.unwrap();
        assert_eq!(value.0, ["alook", "--open", "wire"]);
        assert!(socket.exists());
        open_lock(&directory.path("owner.lock"))
            .unwrap()
            .try_lock()
            .unwrap();

        let socket = directory.path("modern.sock");
        let Admission::Primary(primary) = admit(
            &directory.path("other.lock"),
            &socket,
            &message("modern"),
            Duration::from_secs(1),
        )
        .await
        .unwrap() else {
            panic!("primary missing")
        };
        let mut sender = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        sender.write_all(&message("wire-client")).unwrap();
        drop(sender);
        let (mut stream, _) = primary.listener.accept().await.unwrap();
        let value = read_message(&mut stream).await.unwrap();
        assert_eq!(value.0, ["alook", "--open", "wire-client"]);
    });
}

#[test]
fn malformed_oversized_and_stalled_messages_do_not_become_activations() {
    tauri::async_runtime::block_on(async {
        for bytes in [
            b"missing separator".to_vec(),
            b"/cwd\0\0\xff".to_vec(),
            vec![b'x'; MAX_MESSAGE_BYTES + 1],
        ] {
            let (mut sender, mut receiver) = UnixStream::pair().unwrap();
            let writer = tauri::async_runtime::spawn(async move {
                sender.write_all(&bytes).await.unwrap();
                sender.shutdown().await.unwrap();
            });
            assert!(read_message(&mut receiver).await.is_err());
            writer.await.unwrap();
        }
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        sender.write_all(b"/unfinished").await.unwrap();
        assert!(timeout(CONNECTION_TIMEOUT, read_message(&mut receiver))
            .await
            .is_err());
        drop(sender);
        drop(receiver);
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        sender.write_all(&message("after-stall")).await.unwrap();
        sender.shutdown().await.unwrap();
        assert_eq!(
            read_message(&mut receiver).await.unwrap().0,
            ["alook", "--open", "after-stall"]
        );
    });
}

#[test]
fn an_owned_receiver_must_acknowledge_delivery() {
    let directory = Directory::new();
    tauri::async_runtime::block_on(async {
        let lock = open_lock(&directory.path("owner.lock")).unwrap();
        lock.try_lock().unwrap();
        let listener = UnixListener::bind(directory.path("ipc.sock")).unwrap();
        let peer = tauri::async_runtime::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_message(&mut stream).await.unwrap();
        });
        assert!(
            matches!(admit(&directory.path("owner.lock"), &directory.path("ipc.sock"), &message("no-ack"), Duration::from_secs(1)).await, Err(error) if error.kind() == io::ErrorKind::InvalidData)
        );
        peer.await.unwrap();
    });
}
