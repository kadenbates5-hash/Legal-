import type { EscalationSignals } from "../core/escalation.js";

/**
 * Rule-based extraction of escalation-relevant signals from a caller's free
 * text. Deliberately conservative pattern matching, not an LLM judgment
 * call — false positives (over-escalating) are the safe failure mode here,
 * false negatives are not. Practice-area modules can layer their own
 * extraction on top via deriveEscalationSignals; this only covers the core,
 * practice-area-agnostic patterns from §2.
 */
/*
 * Custody. A family member calling about someone else is the most common
 * custody call, so none of these require "I"; and people describe it a
 * dozen ways ("he's still in jail", "calling from the county detention
 * center", "they took him in", "my daughter was arrested this morning").
 * Each pattern is checked with `matchesUnnegated`, so "I'm not in jail" or
 * "I've never been arrested" doesn't count — but a nearby "no" alone
 * doesn't cancel a match, because "No, my husband is in jail" is exactly
 * the call this exists for.
 */
const CUSTODY_PLACE = String.raw`(?:jail|prison|lockup|lock-up|detention(?: center| facility)?|juvie|juvenile hall|holding(?: cell)?|precinct|police station|the cells|slammer|clink)`;
const CUSTODY_RES: RegExp[] = [
  /\bin (?:\w+ )?cust[oa]?dy\b/i, // "in custody", "in police custody", "in custdy"
  new RegExp(String.raw`(?<!released )\b(?:in|at|inside|from)\s+(?:the\s+|a\s+)?(?:\w+\s+)?${CUSTODY_PLACE}\b`, "i"),
  new RegExp(String.raw`\b(?:took|taken|hauled|carted|brought|sent)\s+(?:\w+\s+){0,2}(?:to|into)\s+(?:the\s+)?(?:\w+\s+)?(?:${CUSTODY_PLACE}|custody|the station)\b`, "i"),
  // The optional word between the verb and the participle is never a
  // negation, so "he's not locked up" is a denial rather than a match.
  /(?:\b(?:was|were|got|gotten|been|is|are|am|im|being|just|still)|'s|'re|'m)\s+(?:(?!not\b|never\b)\w+\s+)?(?:arrested|detained|booked\s+in(?:to)?|picked up|taken into custody|taken in|hauled in|brought in|locked up|handcuffed|cuffed|in handcuffs|nicked|remanded|busted|incarcerated|jailed|imprisoned)\b/i,
  /\b(?:they|police|cops|officers?|deput(?:y|ies)|ice|immigration|border patrol|feds|agents|marshals|troopers?|sheriffs?)\s+(?:just\s+)?(?:arrested|detained|picked up|took|locked up|booked|hauled|cuffed)\s+(?:him|her|them|me|my|our|us)\b/i,
  /\b(?:under arrest|collect call|being held|been held|behind bars|(?:holding|detaining|keeping) (?:me|him|her|them|my \w+)(?! back))\b/i,
  /\b(?:post|posting|make|making|pay|paying)\s+(?:his |her |their |my )?(?:bail|bond)\b|\bbail(?:ing)?\s+(?:him|her|them|me|us|my \w+|\w+)\s+out\b/i,
  // "not out of jail yet" means still in it — the one place a negation adds custody rather than removing it.
  /\b(?:not|n't|never)\s+(?:\w+\s+)?(?:out of|released from|let out of|bailed out)\b/i,
  // "the cops picked him up", "they hauled her in", "took my son away".
  /\b(?:they|police|cops|officers?|deput(?:y|ies)|ice|immigration|feds|agents)\s+(?:just\s+)?(?:picked|hauled|took|dragged|carted|brought|locked)\s+(?:him|her|them|me|my \w+)\s+(?:up|in|away|downtown)\b/i,
  // "He's at county" — the county jail — but not county court, the clerk, or a county line.
  /\b(?:at|from) (?:the )?county\b(?! (?:court|clerk|office|hospital|line|fair|records?|building))/i,
  // Being kept there right now, whatever the caller said happened first.
  /\b(?:won't|will not|aren't|are not|not) (?:let(?:ting)?|allow(?:ing)?) (?:me|him|her|them|us) (?:leave|go)\b/i,
  // Spanish, from code-switching callers: "mi esposo está en la cárcel", "lo arrestaron anoche".
  // A Spanish "no" directly before the verb is a denial: "no está detenido".
  /(?:(?<!\bno )\ben la c[aá]rcel|\ben (?:la )?prisi[oó]n|(?<!\bno )\best[aá]n? (?:pres[oa]s?|detenid[oa]s?|arrestad[oa]s?)|\b(?:lo|la|los|las|me|nos) (?:arrestaron|detuvieron|agarraron|llevaron preso)|\bfue (?:arrestad|detenid)[oa]|\bbajo custodia|\bla migra)/i,
];
const CUSTODY_NEGATABLE = new Set([0, 1, 3, 5, 8, 9]);
/** Index of the "was/got/been arrested" pattern, which also skips a caller's own *past* arrest — see below. */
const ARREST_EVENT_INDEX = 3;
/**
 * "I was arrested" / "I got picked up" from the caller themselves: they're
 * on the phone, so almost always released, and this is the opening of a
 * narrative (redirected as one) rather than a custody emergency. Someone
 * else's arrest ("my son was arrested") and the caller's *present* state
 * ("I'm being held", "I'm calling from jail") still count.
 */
const OWN_PAST_ARREST_RE = /\b(?:i|i've|ive|i have|i had)\s+(?:just\s+|already\s+|recently\s+)?$/i;

/* Imminent police contact: someone from law enforcement *and* a sign they want to talk now or soon. */
const LAW_ENFORCEMENT_RE = /\b(?:police|cops?|detectives?|officers?|investigators?|agents?|fbi|dea|atf|sheriff'?s?|deput(?:y|ies)|troopers?|feds|law enforcement)\b/i;
const POLICE_CONTACT_RE = /\b(?:(?:attend|come in for|go (?:in )?for|do) (?:a |an |the )?(?:voluntary |police )?interview|want(?:s|ed)? to (?:talk|speak|question|interview|meet|see|ask)(?: (?:to|with))? (?:me|him|her|them|us|my \w+)|want(?:s|ed)? (?:me|him|her|them|us|my \w+) to (?:come|talk|meet|answer|go)|(?:at|outside|on) (?:my|the|our) (?:door|house|home|porch|work|job|apartment|place)|outside|knocking|asking (?:me )?questions|question(?:ing)? me|interview me|(?:give|make|take|get|want|wants|need|needs) (?:a |my )?statement|come (?:in|down) (?:to the (?:station|precinct)|for (?:questioning|an interview))|left (?:me )?a (?:card|message|voicemail|note)|called me|showed up|came (?:to|by)|(?:is|are) here|on (?:their|the|his|her) way|coming (?:by|over|here|round|back|to (?:my|the|our) (?:house|home|door|work|place)))\b/i;
const IMMINENT_POLICE_RE = /\b(police (?:want|are going|is going) to (?:question|interview|talk to) me|(?:talking|about to talk) to (?:the )?police (?:now|tonight|today)|detective(?:s)? (?:want|need) to (?:speak|talk) (?:with|to) me)\b/i;
/* Spanish: "la policía está en mi casa", "la policía quiere hablar conmigo". */
const SPANISH_POLICE_RE = /\b(?:polic[ií]as?|detectives?|agentes?)\b.{0,30}(?:est[aá]n? (?:aqu[ií]|afuera|en (?:mi|la) (?:casa|puerta))|vin(?:o|ieron)|viene|quieren? (?:hablar|interrogar)|toc(?:a|an|ando))/i;

/* A court appearance is named many ways; the timing is parsed separately (parseHoursUntil). */
const COURT_MENTION_RE = /\b(?:courts?|hearing|arraignment|arraigned|trial|judge|sentencing|docket|magistrates?|appearance|appear|(?:case|matter) is (?:called|heard|up|on|set|scheduled|listed)|corte|audiencia|juicio|juez|tribunal)\b/i;

const PROTECTIVE_ORDER_RE = /\b(?:(?:protective|restraining|no[- ]contact|stay[- ]away|protection) order|order of protection|pfa|tro|dvro|epo|ppo|cpo|an? ro (?:against|on))\b/i;
// What makes an order an *issue* rather than background: a breach, the
// police, being served, or one newly taken out against the caller — and
// any contact with the protected person, which is how a breach is usually
// described ("she has a no contact order and I texted her").
const PROTECTIVE_ORDER_ISSUE_RE = /\b(?:violat|broke|break|arrest|warrant|police|cops|served|showed up|came (?:to|by|over)|they said i|says? i|took out|filed|issued|against me|on me|texted|called|messaged|contacted|went (?:to|near|by|over)|go (?:to|near)|saw (?:her|him|them)|ran into)/i;

const LEGAL_ADVICE_RE = /\b(am i going to (?:jail|prison)|do i have a case|should i (?:talk|speak) to (?:the )?police|what should i (?:do|say)|is (?:this|that) legal|can they (?:do that|arrest me)|will i (?:go to jail|get convicted))\b/i;
// The questions callers actually ask, beyond the first-person patterns above.
const LEGAL_QUESTION_RE = /\b(?:should i (?:plead|take (?:the|a) (?:deal|plea)|fight|accept|sign|say|tell|answer|turn myself in|run|leave)|plead (?:guilty|not guilty|no contest)|what are (?:my|the) (?:chances|odds|options)|(?:can|could) (?:i|you|they) (?:get|have) (?:my |the |these |this |it )?(?:charges?|case|ticket|dui|record|it)\s+(?:dropped|reduced|dismissed|expunged|sealed|thrown out)|how much (?:time|jail time|prison time|of a sentence)|what(?:'s| is) the (?:penalty|sentence|punishment|maximum|max)|is it worth (?:fighting|it|going to trial)|will i (?:lose|go to (?:jail|prison)|get (?:time|probation|jail|prison|convicted|deported)|have a record|be (?:deported|charged|convicted))|will (?:this|it) (?:go on|show up on|stay on) my record|(?:do|would) i need a lawyer|can i (?:beat|fight|win) (?:this|it|my case)|how long (?:will|would|could) i (?:get|be|go|serve)|what (?:will|would|could) happen (?:to me|if)|am i in trouble|(?:will|could|would) i be deported|is (?:this|that|it) (?:a felony|a misdemeanor|illegal|a crime))\b/i;
// Catches indirect/hypothetical phrasing that evades LEGAL_ADVICE_RE's
// first-person present-tense patterns — "hypothetically, would they go to
// jail for X" is still a request for legal advice, just phrased around it.
const HYPOTHETICAL_ADVICE_RE = /\b(hypothetically|what if (?:i|someone|they|my \w+))\b.{0,60}\b(jail|prison|legal|arrest(?:ed)?|convicted|guilty|charged)\b/i;
const WOULD_ADVICE_RE = /\bwould (?:i|they|someone|he|she) (?:go to jail|get convicted|be (?:guilty|charged)|be arrested)\b/i;
const NARRATIVE_RE = /\b(what happened was|so i was|then (?:he|she|they) |i (?:was|got) (?:arrested|pulled over|stopped) and)\b/i;
const MINOR_RE = /\bi(?:'m| am) (?:a minor|underage)\b/i;
const MINOR_AGE_RE = /\bi(?:'m| am) (?:only )?(?:[5-9]|1[0-7])\b/i;
const VULNERABLE_RE = /\b(i(?:'ve| have) been drinking|i(?:'m| am) (?:scared|terrified|panicking)|i can(?:'t|not) breathe)\b/i;
// §7 red-teaming: self-harm/suicide risk and immediate physical danger from
// another person right now. Treated as its own emergency-tier trigger (see
// escalation.ts's crisis_risk), not folded into the generic "vulnerable
// caller" gentler-handoff path — a crisis needs resource information (988),
// not just a faster human handoff. Never negation-guarded: "I'm not
// suicidal" reaching a human costs nothing.
const CRISIS_SELF_HARM_RE = /\b(kill(?:ing)? myself|want (?:it|this|everything) (?:all )?to (?:stop|end)|want (?:it|this|everything) to be over|end(?:ing)? my life|ending it all|want to die|don'?t want to (?:live|be here anymore)|hurt myself|suicidal|suicide|self[- ]harm|end it all|end things|want to end it|(?:no|don'?t see (?:the|any)|there'?s no) (?:point|reason) (?:in |to |of )?(?:living|going on|life|being alive)|better off dead|wish i (?:was|were) dead|take my (?:own )?life|not worth living|can'?t go on|cut(?:ting)? myself|overdos(?:e|ed|ing)|(?:took|swallowed|taking|take) (?:a (?:whole )?bunch of|too many|all (?:my|the|of my)|a lot of|a handful of|a (?:whole )?bottle of|the whole bottle of) (?:pills|meds|medication|tablets|sleeping pills|painkillers))\b/i;
const CRISIS_DANGER_RE = /\b(he'?s going to (?:kill|hurt) me|she'?s going to (?:kill|hurt) me|(?:someone|he|she|they) (?:is|are) (?:trying to (?:kill|hurt|attack) me|attacking me)|i(?:'m| am|m)? not safe|i need help right now|(?:he|she|they) (?:has|have|got|pulled|is pointing|are pointing) a (?:gun|knife|weapon)|(?:is|are|keeps?|he'?s|she'?s|they'?re|been) (?:hitting|beating|choking|strangling|hurting|attacking|punching|kicking) me|threaten(?:ing|ed|s)? to (?:kill|hurt|shoot|stab) (?:me|us|my)|i(?:'m| am|m)? in danger|(?:just|has|have|he|she|they|husband|wife|boyfriend|girlfriend|partner|ex|dad|mom|father|mother)\s+(?:just\s+)?(?:hit|punched|kicked|choked|strangled|beat|attacked|stabbed|shot|slapped|shoved|pushed) me|beat me up)\b/i;
// A weapon *here, now* — outside, at the door, in the house, on the way. Not
// "charged with a gun", which is an ordinary call to a criminal practice.
const CRISIS_WEAPON_NEARBY_RE = /\b(?:outside|here|at (?:my|the) (?:door|house|window)|in (?:my|the) (?:house|home|yard)|on (?:his|her|their) way|coming (?:over|here))\b.{0,30}\b(?:gun|knife|weapon|firearm)\b|\b(?:gun|knife|weapon|firearm)\b.{0,30}\b(?:outside|at (?:my|the) (?:door|house|window)|in (?:my|the) (?:house|home|yard)|coming (?:over|here)|(?:he|she|they)(?:'s|'re| is| are) (?:here|inside|in the house))\b/i;
// Spanish: "me quiero morir", "me está pegando", "me quiere matar".
const SPANISH_CRISIS_RE = /(?:\bme quiero (?:morir|matar)|\bquiero morir|\bno quiero vivir|\bme voy a matar|\bme (?:est[aá]n? )?(?:pegando|golpeando)|\bme (?:quiere|quieren|va a|van a) matar|\bsuicid)/i;
const OPT_OUT_RE = /\b(don'?t want (?:an? )?ai|no ai|human only|talk to a human please|opt out of ai)\b/i;
const INTERPRETER_RE = /\b(i (?:don'?t|do not) speak english well|necesito un int[eé]rprete|interpreter|translator)\b/i;
// §7 red-teaming: explicit refusal of recording consent, distinct from
// silence/non-response — must route to a human rather than proceed as if
// consent were given (see chat-agent.ts's disclose_recording_consent gate).
export const RECORDING_CONSENT_REFUSAL_RE = /\b(no,? (?:i (?:don'?t|do not)|don'?t) (?:want|consent)|(?:don'?t|do not) record me|not okay with (?:that|being recorded)|i refuse|no recording)\b/i;

/**
 * What every matcher here sees: runs of whitespace collapsed to one space
 * (so "in  custody" matches "in custody") and curly quotes made straight —
 * phones type "I’m in jail" with a curly apostrophe, which every pattern
 * written with a straight one would otherwise miss.
 */
export function normalizeCallerText(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

/**
 * Texting shorthand, expanded before the escalation patterns run — so
 * "court 2moro", "hes in jail rn", "the police wanna talk to me", "kms"
 * and "5-0 is at my door" read as what they say. Only the escalation
 * matchers see this: party names for conflicts screening are taken from
 * the caller's own words, where turning "R" into "are" would mangle them.
 */
/**
 * What speech-to-text produces, cleaned up the same way and for the same
 * reason as texting shorthand below — a voice caller's words arrive as a
 * transcript, and a transcript isn't what anyone wrote. Applied first, so
 * spelled-out letters are rejoined before "r" can become "are".
 *
 * - Vocal fillers ("um", "uh") and stutters ("i i", "my my husband")
 *   sit in the middle of phrases and broke nearly every multi-word
 *   pattern: "i want to uh die" read as nothing at all.
 * - Abbreviations said letter by letter: "a t r o", "p f a", "f b i".
 * - The slips transcription engines reliably make on exactly the words
 *   that matter here: "arraignment" heard as "arrangement", "court" as
 *   "cord", "bail" as "bale", "arrested" as "a rested". Each is only
 *   rewritten where the context makes the legal word likely — and
 *   "court" is deliberately never recovered from "caught", because "I got
 *   caught…" is how half of all calls to a criminal practice begin.
 */
const VOICE_FIXES: Array<[RegExp, string]> = [
  [/\b(?:u+m+|u+h+m*|e+r+m+|h+m+|m{2,}|a+h+)\b[,.]?\s*/gi, ""],
  [/\b(\w+(?:'\w+)?)(?:\s+\1\b)+/gi, "$1"],
  [/\bt\.?\s*r\.?\s*o\b\.?/gi, "tro"],
  [/\bp\.?\s*f\.?\s*a\b\.?/gi, "pfa"],
  [/\bd\.?\s*v\.?\s*r\.?\s*o\b\.?/gi, "dvro"],
  [/\bf\.?\s+b\.?\s+i\b\.?/gi, "fbi"],
  [/\ba\s+(?=r\s+o\s+(?:against|on)\b)/gi, "an "],
  [/\br\s+o(?=\s+(?:against|on)\b)/gi, "ro"],
  [/\ba rested\b/gi, "arrested"],
  [/\bbale\b/gi, "bail"],
  [/\b(my|his|her|their|the)\s+arrangement\b(?!s)/gi, "$1 arraignment"],
  [/\b(have|had|got|to|in|at|my|his|her|their|for)\s+cord\b/gi, "$1 court"],
  [/\bcord(?=\s+(?:date|hearing|house|room|tomorrow|today|tonight|this|next)\b)/gi, "court"],
];

const SHORTHAND: Array<[RegExp, string]> = [
  [/\b(?:2mor+ow|2moro|2mrw|tmrw|tmw|tomoz|tomor+ow|tom+or+ow)\b/gi, "tomorrow"],
  [/\b2day\b/gi, "today"],
  [/\b(?:2nite|2night|tonite)\b/gi, "tonight"],
  [/\bnite\b/gi, "night"],
  [/\brn\b/gi, "right now"],
  [/\bwanna\b/gi, "want to"],
  [/\bgonna\b/gi, "going to"],
  [/\bgotta\b/gi, "got to"],
  [/\btryna\b/gi, "trying to"],
  [/\bu\b/gi, "you"],
  [/\br\b/gi, "are"],
  [/\bur\b/gi, "your"],
  [/\bb4\b/gi, "before"],
  [/\byr\b/gi, "year"],
  [/\b(hes|shes|theyre|im|ive|dont|cant|wont|isnt|arent|wasnt|werent|didnt|doesnt|hasnt|havent|wouldnt|couldnt|shouldnt|aint)\b/gi, "\u0000$1"],
  [/\bkms\b/gi, "kill myself"],
  [/\bunalive (?:my ?self)\b/gi, "kill myself"],
  [/\b(?:5-?0|five-?o|po-?po)\b/gi, "police"],
];
const CONTRACTIONS: Record<string, string> = {
  hes: "he's", shes: "she's", theyre: "they're", im: "i'm", ive: "i've", dont: "don't", cant: "can't", wont: "won't",
  isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", didnt: "didn't", doesnt: "doesn't", hasnt: "hasn't",
  havent: "haven't", wouldnt: "wouldn't", couldnt: "couldn't", shouldnt: "shouldn't", aint: "ain't",
};
export function expandShorthand(text: string): string {
  let out = text;
  for (const [re, replacement] of VOICE_FIXES) out = out.replace(re, replacement);
  for (const [re, replacement] of SHORTHAND) out = out.replace(re, replacement);
  return out.replace(/\u0000(\w+)/g, (_, word: string) => CONTRACTIONS[word.toLowerCase()] ?? word);
}

const NEGATION_WORD_RE = /^(?:not|never|\w+n't|\w+n’t|cannot)$/i;

/**
 * True if `re` matches somewhere in `text` that isn't directly negated —
 * "not", "never" or an "-n't" word among the three words just before the
 * match. A bare "no" earlier in the sentence doesn't count, so "No, he's in
 * jail" still matches while "I'm not in jail" doesn't.
 */
function matchesUnnegated(re: RegExp, text: string, skip?: (before: string, match: string) => boolean): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const match of text.matchAll(global)) {
    const preceding = text.slice(0, match.index);
    const before = preceding.split(/[^\w'’]+/).filter(Boolean).slice(-3);
    if (before.some((word) => NEGATION_WORD_RE.test(word))) continue;
    if (skip?.(preceding, match[0])) continue;
    return true;
  }
  return false;
}

/** The arrest-event pattern, minus the caller's own past arrest: a past-tense auxiliary with "I" as its subject. */
function isOwnPastArrest(preceding: string, match: string): boolean {
  const aux = match.trim().split(/\s+/)[0]!.toLowerCase();
  // Being booked means processed into a jail, a far stronger custody sign
  // than "arrested", so the caller's own booking still counts.
  if (/\bbooked\b/i.test(match)) return false;
  return ["was", "got", "gotten", "been", "just"].includes(aux) && OWN_PAST_ARREST_RE.test(preceding);
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  "a few": 3, "a couple": 2, "a couple of": 2, couple: 2, few: 3,
};
/**
 * Spoken numbers, as a transcript writes them: "forty eight", "twenty-four".
 * Longest alternatives first, so "forty eight" isn't read as "forty".
 */
const NUMBER_WORD = String.raw`(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|ten|eleven|twelve|one|two|three|four|five|six|seven|eight|nine|an?|a few|a couple(?: of)?)`;
function numberFromWords(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const key = raw.toLowerCase().replace(/ of$/, "");
  if (NUMBER_WORDS[key] !== undefined) return NUMBER_WORDS[key]!;
  return key.split(/[\s-]+/).reduce((sum, word) => sum + (NUMBER_WORDS[word] ?? 0), 0) || 1;
}
const RELATIVE_QUALIFIER = String.raw`(?:about\s+|around\s+|like\s+|roughly\s+|maybe\s+|approximately\s+|just\s+|another\s+)?`;
const RELATIVE_RE = new RegExp(
  String.raw`\bin\s+${RELATIVE_QUALIFIER}(\d{1,3}(?=\s*(?:hours?|hrs?|days?|weeks?)\b)|${NUMBER_WORD})\s*(hours?|hrs?|days?|weeks?)\b`,
  "gi",
);
/** "in forty five minutes", "in 30 mins", "in half an hour" — whatever the count, it's within the hour or so. */
const MINUTES_RE = new RegExp(
  String.raw`\bin\s+${RELATIVE_QUALIFIER}(?:\d{1,4}\s*|${NUMBER_WORD}\s+)(?:minutes?|mins?)\b|\bin\s+${RELATIVE_QUALIFIER}half an? (?:hour|hr)\b`,
  "i",
);
/**
 * Dates said as ordinals — "the twenty sixth", "november twenty-sixth",
 * "the fifth of december" — rewritten as "26th" so the date patterns
 * below read them. Only after "the" or a month name, so "my second
 * arrest" stays a count rather than becoming a date.
 */
const ORDINAL_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};
const ORDINAL_TEENS: Record<string, number> = {
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const MONTH_WORD = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const ORDINAL_WORD_RE = new RegExp(
  String.raw`\b(the|${MONTH_WORD})\s+(?:(twenty|thirty)[\s-](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|(${Object.keys(ORDINAL_UNITS).join("|")}|${Object.keys(ORDINAL_TEENS).join("|")}))\b`,
  "gi",
);
function ordinalsToDigits(text: string): string {
  return text.replace(ORDINAL_WORD_RE, (_, lead: string, tens?: string, unit?: string, single?: string) => {
    const day = tens ? NUMBER_WORDS[tens.toLowerCase()]! + ORDINAL_UNITS[unit!.toLowerCase()]! : (ORDINAL_UNITS[single!.toLowerCase()] ?? ORDINAL_TEENS[single!.toLowerCase()]!);
    return `${lead} ${day}th`;
  });
}
const SAME_DAY_RE = /\b(?:today|tonight|this (?:morning|afternoon|evening)|right now|in an hour|hoy|esta (?:noche|tarde))\b/i;
const TOMORROW_RE = /(?:\b(?:tomorrow|tmrw|tmr|in the morning|first thing)\b|\bma[nñ]ana)/i;
const THIS_WEEK_RE = /\b(?:this week|in a day or two|in the next (?:day|two days|couple (?:of )?days)|day after tomorrow|pasado ma[nñ]ana)\b/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
/** "the 26th of november". */
const DAY_OF_MONTH_RE = /\b(\d{1,2})(?:st|nd|rd|th)\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
/** "the 26th", no month: this month's if it's still to come, otherwise next month's. */
const BARE_DAY_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/;

function hoursUntilDate(month: number, day: number, now: Date): number | undefined {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month, day);
  if (target.getMonth() !== month) return undefined; // e.g. Feb 31
  // A date more than a month in the past is next year's; a recent past date is just in the past.
  if (target.getTime() < today.getTime() - 31 * 86_400_000) target = new Date(now.getFullYear() + 1, month, day);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  return days < 0 ? undefined : Math.max(days * 24, 12);
}

/**
 * Parses when something happens ("today", "in 6 hours", "in two days",
 * "Monday", "11/24") into hours-from-now, returning the soonest if several
 * are mentioned. Shared by the free-text extractor below (which requires a
 * court word nearby) and by the receptionist chat agent's intake answer
 * handling (where the question already establishes the topic). Weekdays
 * and dates need `now`; without it only relative phrases are understood.
 * Errs early: a weekday is read as its *next* occurrence, never the one
 * after, and anything today counts as 24 hours or less. Returns undefined
 * if no recognizable timing phrase is present.
 */
export function parseHoursUntil(rawText: string, now?: Date): number | undefined {
  const text = ordinalsToDigits(expandShorthand(normalizeCallerText(rawText)));
  const found: number[] = [];
  for (const match of text.matchAll(RELATIVE_RE)) {
    const count = numberFromWords(match[1]!);
    const unit = match[2]!.toLowerCase();
    found.push(unit.startsWith("h") ? count : unit.startsWith("d") ? count * 24 : count * 168);
  }
  if (MINUTES_RE.test(text)) found.push(1);
  if (SAME_DAY_RE.test(text)) found.push(12);
  if (TOMORROW_RE.test(text)) found.push(24);
  if (THIS_WEEK_RE.test(text)) found.push(48);
  if (now) {
    const weekday = text.match(WEEKDAY_RE);
    if (weekday) {
      const days = (WEEKDAYS.indexOf(weekday[1]!.toLowerCase()) - now.getDay() + 7) % 7;
      found.push(days === 0 ? 12 : days * 24);
    }
    const monthDay = text.match(MONTH_DAY_RE);
    if (monthDay) {
      const hours = hoursUntilDate(MONTHS.indexOf(monthDay[1]!.toLowerCase().slice(0, 3)), Number(monthDay[2]), now);
      if (hours !== undefined) found.push(hours);
    }
    const numeric = text.match(NUMERIC_DATE_RE);
    if (numeric) {
      const hours = hoursUntilDate(Number(numeric[1]) - 1, Number(numeric[2]), now);
      if (hours !== undefined) found.push(hours);
    }
    const dayOfMonth = text.match(DAY_OF_MONTH_RE);
    if (dayOfMonth) {
      const hours = hoursUntilDate(MONTHS.indexOf(dayOfMonth[2]!.toLowerCase().slice(0, 3)), Number(dayOfMonth[1]), now);
      if (hours !== undefined) found.push(hours);
    }
    const bareDay = text.match(BARE_DAY_RE);
    if (bareDay) {
      const day = Number(bareDay[1]);
      // Still to come this month, or else next month's — December's
      // "the 5th" being January's, which hoursUntilDate rolls into next year.
      const month = day >= now.getDate() ? now.getMonth() : (now.getMonth() + 1) % 12;
      const hours = hoursUntilDate(month, day, now);
      if (hours !== undefined) found.push(hours);
    }
  }
  return found.length ? Math.min(...found) : undefined;
}

export function extractSignalsFromText(rawText: string, now?: Date): Partial<EscalationSignals> {
  const text = expandShorthand(normalizeCallerText(rawText));
  const signals: Partial<EscalationSignals> = {};

  if (
    CUSTODY_RES.some((re, i) =>
      i === ARREST_EVENT_INDEX ? matchesUnnegated(re, text, isOwnPastArrest) : CUSTODY_NEGATABLE.has(i) ? matchesUnnegated(re, text) : re.test(text),
    )
  ) {
    signals.inCustody = true;
  }
  if (IMMINENT_POLICE_RE.test(text) || SPANISH_POLICE_RE.test(text) || (LAW_ENFORCEMENT_RE.test(text) && POLICE_CONTACT_RE.test(text))) {
    signals.imminentPoliceQuestioning = true;
  }

  if (COURT_MENTION_RE.test(text)) {
    const hours = parseHoursUntil(text, now);
    if (hours !== undefined) signals.courtAppearanceWithinHours = hours;
  }

  // "There's no protective order against me" denies the order itself, so
  // the order mention has to survive negation — including a bare "no"
  // right before it, which elsewhere doesn't count ("No, he violated the
  // order" is still a violation).
  if (matchesUnnegated(PROTECTIVE_ORDER_RE, text, (before) => /\b(?:no|without|any)\s+(?:active\s+|current\s+|kind of\s+)?$/i.test(before)) && PROTECTIVE_ORDER_ISSUE_RE.test(text)) {
    signals.activeProtectiveOrderIssue = true;
  }

  if (LEGAL_ADVICE_RE.test(text) || LEGAL_QUESTION_RE.test(text) || HYPOTHETICAL_ADVICE_RE.test(text) || WOULD_ADVICE_RE.test(text)) {
    signals.callerAskedForLegalAdvice = true;
  }
  if (NARRATIVE_RE.test(text)) signals.callerNarratingFacts = true;
  if (MINOR_RE.test(text) || MINOR_AGE_RE.test(text) || VULNERABLE_RE.test(text)) signals.vulnerableCaller = true;
  if (CRISIS_SELF_HARM_RE.test(text) || CRISIS_DANGER_RE.test(text) || CRISIS_WEAPON_NEARBY_RE.test(text) || SPANISH_CRISIS_RE.test(text)) {
    signals.crisisRisk = true;
  }
  if (OPT_OUT_RE.test(text)) signals.clientRequestedOptOut = true;
  if (INTERPRETER_RE.test(text)) signals.interpreterNeeded = true;

  return signals;
}

/**
 * Pulls candidate party names out of a caller's free-text answer, for
 * firm-wide conflicts screening (see `core/conflicts.ts`).
 *
 * Capitalized runs are the signal: "I'm being sued by Acme Corp" yields
 * "Acme Corp". Over-extraction is harmless here and under-extraction is
 * not — a spurious candidate simply matches nothing in the firm's
 * records, whereas a missed one is a conflict that slipped through. That
 * asymmetry is the same reason the escalation extractors above prefer to
 * over-trigger.
 *
 * Falls back to the whole answer when nothing is capitalized, so a caller
 * who types entirely in lower case is still screened rather than silently
 * skipped.
 */
const NAME_STOPWORDS = new Set([
  "i", "i'm", "im", "my", "me", "we", "he", "she", "they", "the", "a", "an", "and", "or", "but",
  "is", "was", "are", "were", "am", "be", "been", "it", "this", "that", "there", "here",
  "yes", "no", "ok", "okay", "hi", "hello", "please", "thanks", "thank",
  "mr", "mrs", "ms", "miss", "dr",
]);

export function extractCandidatePartyNames(text: string): string[] {
  const candidates = new Set<string>();
  // Runs of 1-4 capitalized words, e.g. "John Q Smith", "Acme Corp".
  const runs = text.match(/\b[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3}\b/g) ?? [];
  for (const run of runs) {
    const trimmed = run.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/);
    // A lone capitalized word is usually just a sentence opener; keep it
    // only when it isn't an obvious stopword and is long enough to be a
    // real name rather than an initial.
    if (words.length === 1) {
      const lone = words[0]!.toLowerCase().replace(/[^a-z']/g, "");
      if (lone.length < 3 || NAME_STOPWORDS.has(lone)) continue;
    }
    candidates.add(trimmed);
  }
  if (candidates.size === 0) {
    const fallback = text.trim();
    if (fallback) candidates.add(fallback);
  }
  return [...candidates];
}
