#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnvironmentChoice {
    Prebuilt,
    Default,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Waiting,
    Building,
    Ready,
    Cancelled,
}

pub(crate) struct CreationGate {
    enabled: bool,
    setup_ready: bool,
    environment: Option<EnvironmentChoice>,
    phase: Phase,
    placeholder: bool,
    placeholder_issued: bool,
    default_retry: bool,
}

impl CreationGate {
    pub(crate) const fn new(enabled: bool) -> Self {
        Self {
            enabled,
            setup_ready: false,
            environment: None,
            phase: Phase::Waiting,
            placeholder: false,
            placeholder_issued: false,
            default_retry: false,
        }
    }

    pub(crate) fn accepts_environment(&self) -> bool {
        self.enabled && self.phase == Phase::Waiting && self.environment.is_none()
    }

    pub(crate) fn environment_ready(
        &mut self,
        choice: EnvironmentChoice,
    ) -> Option<EnvironmentChoice> {
        if !self.accepts_environment() {
            return None;
        }
        self.environment = Some(choice);
        self.claim()
    }

    pub(crate) fn setup_ready(&mut self) -> Option<EnvironmentChoice> {
        self.setup_ready = true;
        self.claim()
    }

    fn claim(&mut self) -> Option<EnvironmentChoice> {
        if !self.enabled || !self.setup_ready || self.phase != Phase::Waiting {
            return None;
        }
        let choice = self.environment?;
        self.phase = Phase::Building;
        Some(choice)
    }

    pub(crate) fn building(&self) -> bool {
        self.phase == Phase::Building
    }

    pub(crate) fn permit_placeholder(&mut self) {
        if self.building() && !self.placeholder_issued {
            self.placeholder_issued = true;
            self.placeholder = true;
        }
    }

    pub(crate) fn consume_placeholder(&mut self) -> bool {
        if !self.building() || !self.placeholder {
            return false;
        }
        self.placeholder = false;
        true
    }

    pub(crate) fn default_retry(&mut self) -> bool {
        if !self.building()
            || self.environment != Some(EnvironmentChoice::Prebuilt)
            || self.default_retry
        {
            return false;
        }
        self.default_retry = true;
        self.placeholder = false;
        true
    }

    pub(crate) fn created(&mut self) -> bool {
        if !self.building() {
            return false;
        }
        self.phase = Phase::Ready;
        self.placeholder = false;
        true
    }

    pub(crate) fn cancel(&mut self) {
        self.phase = Phase::Cancelled;
        self.placeholder = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_completion_waits_for_independent_setup() {
        let mut gate = CreationGate::new(true);
        assert_eq!(gate.environment_ready(EnvironmentChoice::Prebuilt), None);
        assert!(!gate.building());
        assert_eq!(gate.setup_ready(), Some(EnvironmentChoice::Prebuilt));
        assert_eq!(gate.setup_ready(), None);
        assert!(gate.created());
        assert!(!gate.created());
    }

    #[test]
    fn setup_waits_for_the_same_environment_completion() {
        let mut gate = CreationGate::new(true);
        assert_eq!(gate.setup_ready(), None);
        assert_eq!(
            gate.environment_ready(EnvironmentChoice::Prebuilt),
            Some(EnvironmentChoice::Prebuilt)
        );
        assert_eq!(gate.environment_ready(EnvironmentChoice::Default), None);
    }

    #[test]
    fn synchronous_failure_cannot_be_replaced_by_a_late_success() {
        let mut gate = CreationGate::new(true);
        assert_eq!(gate.environment_ready(EnvironmentChoice::Default), None);
        assert!(!gate.accepts_environment());
        assert_eq!(gate.environment_ready(EnvironmentChoice::Prebuilt), None);
        assert_eq!(gate.setup_ready(), Some(EnvironmentChoice::Default));
        assert!(!gate.default_retry());
    }

    #[test]
    fn a_failed_prebuilt_creation_has_only_one_default_retry() {
        let mut gate = CreationGate::new(true);
        gate.setup_ready();
        gate.environment_ready(EnvironmentChoice::Prebuilt);
        assert!(gate.default_retry());
        assert!(!gate.default_retry());
    }

    #[test]
    fn cancellation_retires_pending_and_already_scheduled_creations() {
        for setup_first in [false, true] {
            let mut gate = CreationGate::new(true);
            if setup_first {
                gate.setup_ready();
                gate.environment_ready(EnvironmentChoice::Prebuilt);
                gate.permit_placeholder();
            }
            gate.cancel();
            assert!(!gate.accepts_environment());
            assert_eq!(gate.environment_ready(EnvironmentChoice::Prebuilt), None);
            assert_eq!(gate.setup_ready(), None);
            assert!(!gate.created());
            assert!(!gate.consume_placeholder());
            assert!(!gate.default_retry());
        }
    }

    #[test]
    fn placeholder_is_single_use_and_expires_when_main_is_created() {
        let mut gate = CreationGate::new(true);
        assert!(!gate.consume_placeholder());
        gate.setup_ready();
        gate.environment_ready(EnvironmentChoice::Prebuilt);
        gate.permit_placeholder();
        assert!(gate.consume_placeholder());
        assert!(!gate.consume_placeholder());
        gate.permit_placeholder();
        assert!(!gate.consume_placeholder());
        assert!(gate.created());
        assert!(!gate.consume_placeholder());
    }

    #[test]
    fn an_explicit_nonautomatic_window_is_not_created_by_the_factory() {
        let mut gate = CreationGate::new(false);
        assert_eq!(gate.setup_ready(), None);
        assert_eq!(gate.environment_ready(EnvironmentChoice::Prebuilt), None);
        assert!(!gate.building());
    }
}
