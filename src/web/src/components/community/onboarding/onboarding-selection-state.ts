export type OnboardingSelectionState = {
  value: string
  customValue: string
}

export function selectOnboardingOption(
  state: OnboardingSelectionState,
  value: string,
  customOptionValue?: string,
): OnboardingSelectionState {
  return {
    value,
    customValue: value === customOptionValue ? state.customValue : "",
  }
}

export function changeOnboardingCustomValue(
  customValue: string,
  customOptionValue: string,
): OnboardingSelectionState {
  return {
    value: customOptionValue,
    customValue,
  }
}
