export type EmailBodyState = { content: string; isHtml: boolean } | null;

type EmailListItem = {
  id: string;
};

export function beginEmailFolderSwitch() {
  return {
    body: null,
    composing: false,
    emails: [],
    loading: true,
    selectedId: null,
  };
}

export function nextEmailLoadRequestId(currentRequestId: number): number {
  return currentRequestId + 1;
}

export function shouldApplyEmailLoadResult(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

export function applyDiscardSuccessState<TEmail extends EmailListItem>(
  state: {
    body: EmailBodyState;
    emails: TEmail[];
    selectedId: string | null;
  },
  discardedEmailId: string
) {
  return {
    body: state.selectedId === discardedEmailId ? null : state.body,
    emails: state.emails.filter((email) => email.id !== discardedEmailId),
    selectedId: state.selectedId === discardedEmailId ? null : state.selectedId,
  };
}

export function getDiscardSuccessToastMessage(): string {
  return "Moved to Untrust";
}

export function shouldShowHydrationShell({
  mounted,
  agentLoading,
}: {
  mounted: boolean;
  agentLoading: boolean;
}): boolean {
  return !mounted || agentLoading;
}
