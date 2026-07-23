import type { CallerType } from "./types.js";

/**
 * §2: "Family members calling for updates are not the client. Default: 'I
 * can't share case details, but I can pass along a message' — even to a
 * spouse or parent." Only the client themself (or an attorney) may receive
 * case details through the receptionist channel; there is no per-caller
 * override of this default.
 */
export interface ThirdPartyDisclosurePolicy {
  mayShareCaseDetails: boolean;
  mayTakeMessage: boolean;
  scriptedResponse: string | undefined;
}

export function disclosurePolicyFor(callerType: CallerType): ThirdPartyDisclosurePolicy {
  if (callerType === "existing_client" || callerType === "new_client") {
    return { mayShareCaseDetails: true, mayTakeMessage: true, scriptedResponse: undefined };
  }

  return {
    mayShareCaseDetails: false,
    mayTakeMessage: true,
    scriptedResponse: "I can't share case details, but I can pass along a message.",
  };
}
