pub(crate) struct CurrentListener<T> {
    next_id: u64,
    current: Option<(u64, T)>,
}

impl<T> Default for CurrentListener<T> {
    fn default() -> Self {
        Self { next_id: 0, current: None }
    }
}

impl<T> CurrentListener<T> {
    pub(crate) fn install(&mut self, channel: T) -> u64 {
        self.next_id += 1;
        self.current = Some((self.next_id, channel));
        self.next_id
    }

    pub(crate) fn remove(&mut self, id: u64) {
        if self.current.as_ref().is_some_and(|(current, _)| *current == id) {
            self.retire();
        }
    }

    pub(crate) fn notify(&mut self, send: impl FnOnce(&T) -> bool) {
        if self.current.as_ref().is_some_and(|(_, channel)| !send(channel)) {
            self.retire();
        }
    }

    pub(crate) fn retire(&mut self) {
        self.current = None;
    }
}

#[cfg(test)]
mod tests {
    use super::CurrentListener;

    struct Payload(u8);

    #[test]
    fn only_the_current_listener_receives_and_old_ids_cannot_remove_replacements() {
        let mut slots = CurrentListener::<Payload>::default();
        slots.notify(|_| panic!("no listener"));
        let old = slots.install(Payload(1));
        let current = slots.install(Payload(2));
        slots.remove(old);
        slots.notify(|value| { assert_eq!(value.0, 2); true });
        slots.notify(|_| false);
        slots.notify(|_| panic!("failed listener must retire"));
        let next = slots.install(Payload(3));
        assert!(next > current);
        slots.remove(current);
        slots.notify(|value| { assert_eq!(value.0, 3); true });
        slots.retire();
        slots.notify(|_| panic!("retired listener"));
        let latest = slots.install(Payload(4));
        assert!(latest > next);
        slots.remove(next);
        slots.notify(|value| { assert_eq!(value.0, 4); true });
        slots.remove(latest);
        slots.notify(|_| panic!("removed listener"));
    }
}
