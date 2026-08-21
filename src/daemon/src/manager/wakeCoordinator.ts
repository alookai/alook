import type { HostCommand } from "@alook/shared";

type WakeCommand = Extract<HostCommand, { type: "agent:wake" }>;

export type WakeCoordinationResult =
  | { state: "accepted" }
  | { state: "suppressed"; coveredSeq: number };

interface ScopeState {
  desiredSeq: number;
  admittedSeq: number;
  modelSeenSeq: number;
  command: WakeCommand | null;
}

interface AdmissionCoverage {
  previousSeq: number;
  admittedSeq: number;
}

interface ActiveAdmission {
  launchId: string;
  coverage: Map<string, AdmissionCoverage>;
  acknowledged: boolean;
  whileActive: boolean;
}

interface AgentState {
  active: boolean;
  admitting: boolean;
  activeAdmission: ActiveAdmission | null;
  failedAdmissionLaunchId: string | null;
  coalescedReplacement: WakeCommand | null;
  retryAfterFailure: WakeCommand | null;
  observationGeneration: number;
  scopes: Map<string, ScopeState>;
  dispatch: ((command: WakeCommand) => void | Promise<void>) | null;
}

/**
 * One outstanding unread-notification admission per agent. Channels carry
 * desired and model-seen watermarks; they never become independent steer
 * lanes.
 */
export class WakeCoordinator {
  private readonly agents = new Map<string, AgentState>();

  async run(
    command: WakeCommand,
    dispatch: (command: WakeCommand) => void | Promise<void>,
    onDesiredAdvance?: (command: WakeCommand) => void,
  ): Promise<WakeCoordinationResult> {
    const state = this.agent(command.agentId);
    const channel = command.unreadNotice.channel;
    const seq = command.unreadNotice.latestSeq;
    const scope = state.scopes.get(channel);
    const coveredSeq = Math.max(scope?.modelSeenSeq ?? 0, scope?.admittedSeq ?? 0);
    if (seq <= coveredSeq) {
      this.rememberReplacement(state, command);
      return { state: "suppressed", coveredSeq };
    }

    const desiredAdvanced = !scope || seq > scope.desiredSeq;
    if (!scope || seq >= scope.desiredSeq) {
      state.scopes.set(channel, {
        desiredSeq: Math.max(scope?.desiredSeq ?? 0, seq),
        admittedSeq: scope?.admittedSeq ?? 0,
        modelSeenSeq: scope?.modelSeenSeq ?? 0,
        command,
      });
    }
    if (desiredAdvanced) onDesiredAdvance?.(command);
    state.dispatch = dispatch;

    // One unread notification may be outstanding at a time. An active runtime
    // still needs the first higher watermark delivered into its current
    // logical session; later watermarks coalesce behind that admission until
    // the resulting inbox pull proves what the model actually saw.
    if (state.admitting || state.activeAdmission) {
      this.rememberReplacement(state, command);
      return { state: "suppressed", coveredSeq: seq };
    }

    await this.admit(command.agentId, command);
    return { state: "accepted" };
  }

  modelSeenGeneration(agentId: string): number {
    return this.agent(agentId).observationGeneration;
  }

  recordModelSeen(
    agentId: string,
    messages: ReadonlyArray<{ channel: string; seq: string }>,
    generation: number,
  ): boolean {
    const state = this.agent(agentId);
    if (generation !== state.observationGeneration) return false;
    for (const message of messages) {
      const seq = Number(message.seq.startsWith("#") ? message.seq.slice(1) : message.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) continue;
      const scope = state.scopes.get(message.channel);
      if (scope) {
        scope.modelSeenSeq = Math.max(scope.modelSeenSeq, seq);
      } else {
        // Pull may beat a delayed/replayed WS frame. Preserve that observation
        // even when no wake for the scope has reached ingress yet.
        state.scopes.set(message.channel, {
          desiredSeq: 0,
          admittedSeq: 0,
          modelSeenSeq: seq,
          command: null,
        });
      }
    }
    if (this.finishObservedAdmission(state)) {
      void this.reconcile(agentId, state).catch(() => {});
    }
    return true;
  }

  /** Runtime activity is the admission lifecycle, not command dispatch time. */
  recordAgentActivity(agentId: string, activity: string): void {
    const state = this.agent(agentId);
    if (activity === "starting" || activity === "running") {
      state.active = true;
      void this.reconcile(agentId, state).catch(() => {});
      return;
    }
    if (activity !== "idle") return;
    state.active = false;
    state.activeAdmission = null;
    const next = this.nextPending(state);
    if (next && state.dispatch) void this.admit(agentId, next);
  }

  recordDeliveryAck(agentId: string, launchId: string, status: "ok" | "error"): void {
    const state = this.agents.get(agentId);
    const admission = state?.activeAdmission;
    if (!state || !admission || admission.launchId !== launchId) return;
    if (status === "ok") {
      admission.acknowledged = true;
      if (this.finishObservedAdmission(state)) {
        void this.reconcile(agentId, state).catch(() => {});
      }
      return;
    }
    // A failed delivery never occupies admission coverage. Desired watermarks
    // remain, so a later transport retry or idle reconciliation can re-arm.
    for (const [channel, coverage] of admission.coverage) {
      const scope = state.scopes.get(channel);
      if (scope?.admittedSeq === coverage.admittedSeq) {
        scope.admittedSeq = coverage.previousSeq;
      }
    }
    state.active = admission.whileActive && state.active;
    state.failedAdmissionLaunchId = launchId;
    state.retryAfterFailure = state.coalescedReplacement;
    state.coalescedReplacement = null;
    state.activeAdmission = null;
    if (!state.admitting && state.retryAfterFailure) {
      void this.retryFailedAdmission(agentId, state).catch(() => {});
    }
  }

  invalidate(agentId: string, clearModelSeen: boolean): void {
    const state = this.agent(agentId);
    state.observationGeneration += 1;
    state.active = false;
    state.admitting = false;
    state.activeAdmission = null;
    state.failedAdmissionLaunchId = null;
    state.coalescedReplacement = null;
    state.retryAfterFailure = null;
    if (clearModelSeen) {
      state.scopes.clear();
      return;
    }
    // Stop/model switch preserve messages actually shown to the model, while
    // dropping any pre-stop admission/desired coverage.
    for (const scope of state.scopes.values()) {
      scope.desiredSeq = scope.modelSeenSeq;
      scope.admittedSeq = scope.modelSeenSeq;
    }
  }

  private agent(agentId: string): AgentState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = {
        active: false,
        admitting: false,
        activeAdmission: null,
        failedAdmissionLaunchId: null,
        coalescedReplacement: null,
        retryAfterFailure: null,
        observationGeneration: 0,
        scopes: new Map(),
        dispatch: null,
      };
      this.agents.set(agentId, state);
    }
    return state;
  }

  private nextPending(state: AgentState): WakeCommand | null {
    let next: ScopeState | null = null;
    for (const scope of state.scopes.values()) {
      if (scope.desiredSeq <= Math.max(scope.modelSeenSeq, scope.admittedSeq)) continue;
      if (!scope.command) continue;
      if (scope.command.launchId === state.failedAdmissionLaunchId) continue;
      if (!next || scope.desiredSeq > next.desiredSeq) next = scope;
    }
    return next?.command ?? null;
  }

  private async admit(agentId: string, preferred?: WakeCommand): Promise<void> {
    const state = this.agent(agentId);
    if (state.admitting || state.activeAdmission || !state.dispatch) return;
    const admissionGeneration = state.observationGeneration;
    const wasActive = state.active;
    const command = preferred ?? this.nextPending(state);
    if (!command) return;
    const commandScope = state.scopes.get(command.unreadNotice.channel);
    if (commandScope && command.unreadNotice.latestSeq >= commandScope.desiredSeq) {
      commandScope.command = command;
    }
    const coverage = new Map<string, AdmissionCoverage>();
    for (const [channel, scope] of state.scopes) {
      if (scope.desiredSeq <= Math.max(scope.modelSeenSeq, scope.admittedSeq)) continue;
      coverage.set(channel, {
        previousSeq: scope.admittedSeq,
        admittedSeq: scope.desiredSeq,
      });
      scope.admittedSeq = scope.desiredSeq;
      scope.command = command;
    }
    if (coverage.size === 0) return;
    state.admitting = true;
    state.active = true;
    state.failedAdmissionLaunchId = null;
    state.coalescedReplacement = null;
    state.activeAdmission = {
      launchId: command.launchId,
      coverage,
      acknowledged: false,
      whileActive: wasActive,
    };
    let dispatchError: unknown;
    try {
      await state.dispatch(command);
    } catch (error) {
      if (state.observationGeneration === admissionGeneration) {
        for (const [channel, admitted] of coverage) {
          const scope = state.scopes.get(channel);
          if (scope?.admittedSeq === admitted.admittedSeq) {
            scope.admittedSeq = admitted.previousSeq;
          }
        }
        state.active = wasActive && state.active;
        state.failedAdmissionLaunchId = command.launchId;
        state.retryAfterFailure = state.coalescedReplacement;
        state.coalescedReplacement = null;
        state.activeAdmission = null;
      }
      dispatchError = error;
    } finally {
      if (state.observationGeneration === admissionGeneration) {
        state.admitting = false;
      }
    }
    if (state.observationGeneration === admissionGeneration) {
      await this.retryFailedAdmission(agentId, state);
      await this.reconcile(agentId, state);
    }
    if (dispatchError) throw dispatchError;
  }

  private rememberReplacement(state: AgentState, command: WakeCommand): void {
    const failedOrActiveLaunchId = state.activeAdmission?.launchId ?? state.failedAdmissionLaunchId;
    if (!failedOrActiveLaunchId || command.launchId === failedOrActiveLaunchId) return;
    const scope = state.scopes.get(command.unreadNotice.channel);
    // Only a command at the scope's current desired watermark may replace a
    // provisional admission. A delayed lower-seq frame must not displace a
    // valid same-watermark retry candidate that arrived before it.
    if (!scope || command.unreadNotice.latestSeq < scope.desiredSeq) return;
    state.coalescedReplacement = command;
    if (state.failedAdmissionLaunchId) state.retryAfterFailure = command;
  }

  private async retryFailedAdmission(agentId: string, state: AgentState): Promise<void> {
    if (state.admitting || state.activeAdmission) return;
    const replacement = state.retryAfterFailure;
    state.retryAfterFailure = null;
    if (!replacement) return;
    state.failedAdmissionLaunchId = null;
    await this.admit(agentId, replacement);
  }

  private finishObservedAdmission(state: AgentState): boolean {
    const admission = state.activeAdmission;
    if (!admission?.acknowledged) return false;
    for (const [channel, coverage] of admission.coverage) {
      const scope = state.scopes.get(channel);
      if (!scope || scope.modelSeenSeq < coverage.admittedSeq) return false;
    }
    state.activeAdmission = null;
    return true;
  }

  private async reconcile(agentId: string, state: AgentState): Promise<void> {
    if (state.admitting || state.activeAdmission || !state.dispatch) return;
    const next = this.nextPending(state);
    if (next) await this.admit(agentId, next);
  }
}
