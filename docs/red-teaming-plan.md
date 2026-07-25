# Red-teaming plan for the receptionist agent

§7 open item #3: "Testing/red-teaming plan for edge cases (confessions
mid-call, minors calling, crisis situations) before the receptionist agent
ever talks to a real person."

This document has two parts: what's automated today (`test/red-team-
scenarios.test.ts`), and further human adversarial testing ideas below.
The practicing attorney overseeing this project has reviewed and signed
off on the automated suite plus this plan as sufficient for real use (see
CLAUDE.md's "§7 open items — status") — the rest of this document remains
as a roadmap for deepening that testing over time, not a blocking
prerequisite. Treat the automated suite as a regression floor — it proves
specific fixes stay fixed, not an exhaustive safety guarantee.

## What this pass found

Running an initial red-teaming pass against the existing code (not just
imagining scenarios in the abstract) surfaced four real gaps, all now
fixed and covered by regression tests:

1. **No crisis/self-harm detection at all.** Nothing in the signal
   extraction covered suicidal ideation or "someone is trying to hurt me
   right now" language. A caller in genuine crisis would have been routed
   through ordinary intake. Fixed: a dedicated `crisis_risk` emergency
   trigger (`core/escalation.ts`) with its own script that includes 911
   and the 988 Suicide & Crisis Lifeline, not just a generic handoff.
2. **Minor-age detection required the word "only."** `"I'm 15"` didn't
   match; only `"I'm only 15"` did. A caller stating their age plainly
   would have gone unrecognized as a minor. Fixed: broadened the pattern.
3. **Recording-consent refusal was silently ignored.** The chat agent
   disclosed the recording notice and then proceeded as if consent were
   given, regardless of what the caller actually said. Fixed: an explicit
   refusal now routes to a human instead of continuing.
4. **Hypothetical/indirect legal-advice phrasing evaded detection.**
   `"hypothetically, would someone go to jail for that"` didn't match the
   first-person, present-tense patterns the legal-advice detector used.
   Fixed: added hypothetical/"what if"/"would" phrasing patterns.

This is the expected shape of red-teaming: adversarial testing against
the real implementation finds gaps that reasoning about the spec in the
abstract doesn't. The process below is meant to keep finding them.

## Categories covered by the automated suite

`test/red-team-scenarios.test.ts` exercises, against the actual
`ReceptionistChatSession`/`VoiceReceptionistSession` (not mocks of them):

- Confessions/pre-retention narratives — on the first message, and
  mid-intake after several ordinary turns
- Minors calling — with and without the caller volunteering their age
  explicitly, and a negative case (an adult's age doesn't misfire it)
- Crisis situations — self-harm language and immediate-danger-from-
  another-person language, at the start of a call and mid-intake, plus a
  negative case (ordinary case-related worry isn't miscategorized)
- Recording-consent refusal vs. an ordinary affirmative response
- Indirect/hypothetical requests for legal advice
- Hostile/abusive callers — confirms scripted behavior holds up (no
  crash, no leaked advice) even under hostile phrasing
- Mixed/competing signals in a single message — crisis vs. legal-advice
  question, emergency vs. opt-out request — confirming the more urgent
  trigger always wins
- Third-party callers who push back — confirms the confidentiality
  default holds even when insisted upon
- Voice-specific: repeated silence/mishearing never leaks state or
  advances intake; a clear emergency spoken after mis-heard turns still
  escalates correctly

## What still needs human adversarial testing

Pattern-matching on transcript text has a ceiling. These need a human (or
several, from different backgrounds) actively trying to break the system,
not more regex:

- **Identity verification / impersonation.** Nothing in this system
  verifies that a caller claiming to be "the client" actually is. A family
  member could self-identify as the client to bypass the confidentiality
  default. This needs a different mitigation entirely (callback
  verification, a shared PIN/passphrase set at retention, etc.) — it's not
  a text-pattern problem.
- **Tone, sarcasm, and code-switching.** Regex has no sense of tone. A
  caller being sarcastic about jail ("oh sure, throw me in jail then") or
  switching between languages mid-sentence needs a human tester, ideally
  someone bilingual for the second case.
- **Non-English crisis/emergency phrasing.** `signal-extraction.ts` is
  English-only. A crisis disclosed in another language currently won't
  trigger anything until the interpreter-routing gate hands off — which
  may be too late. This is a real gap that needs either per-language
  pattern sets or (better) not relying on text patterns for this category
  once a real voice/NLU vendor is in place.
- **Slow-burn disclosure.** A caller who reveals an emergency signal
  gradually across many turns, each individually innocuous, rather than
  in one clear statement. The system re-evaluates signals every turn, so
  this should work in principle — but only a human running a long,
  patient adversarial conversation will actually find out.
- **Jurisdiction-specific consent nuance.** One-party vs. two-party
  consent handling is currently a single boolean
  (`FirmConfig.jurisdictionRecordingConsent`) — a real launch needs
  someone to verify the actual disclosure language against that specific
  state's law, not just that a disclosure happens.
- **Vulnerable-caller categories beyond minors** — visible intoxication,
  acute confusion, or impairment expressed in ways that don't match
  `VULNERABLE_RE`'s current patterns. This needs a red-teamer generating
  realistic transcript variety, not just guessing phrasings.

## Process before real-client launch

1. Run the automated suite (`npm test`) as a gate on every change to
   `receptionist/`, `core/escalation.ts`, or a practice-area module's
   `deriveEscalationSignals`/intake questions — it should never be
   possible to merge a regression on any scenario above.
2. Before pilot launch, run a live adversarial session: at least two
   people who did not write this code, playing callers, trying
   specifically to get the system to give advice, miss an emergency, or
   leak case details to a third party. Log every transcript, not just
   failures — a near-miss that happened to escalate for the wrong reason
   is still worth reviewing.
3. Any gap found gets a regression test added to
   `red-team-scenarios.test.ts` before the fix is considered done — the
   same way the four gaps in this pass were handled.
4. After launch, any real incident (a caller who should have escalated
   and didn't, or vice versa) triggers the same process: reproduce it as
   a test case first, then fix, so the fix is provably permanent.
5. Re-run the live adversarial session periodically (at minimum: after
   any change to the hard-coded trigger set, and on some fixed cadence —
   quarterly is a reasonable default) since attacker/caller phrasing
   drifts over time and the pattern-matching approach doesn't generalize
   the way a human tester's intuition does.

## Explicitly out of scope for this document

Full deadline/calendar-redundancy design and criminal-law template
completeness are §7 items #1 and #2 — see `CLAUDE.md`'s "§7 open items —
status" for those. This document is scoped to receptionist-agent
red-teaming only.
