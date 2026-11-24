import { describe, expect, it } from "vitest";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { WRAP_UP } from "../src/receptionist/scripts.js";
import type { Actor } from "../src/core/types.js";

/**
 * Live Intake, over and over. The point of this file is the *corpus*: the
 * ways real callers actually say things, run through the real session at
 * every point in a call. Its first run found that most natural custody,
 * police, court and crisis phrasings never escalated at all — "My husband
 * is in jail right now", "the police are at my door", "I took a bunch of
 * pills" — and that "No." counted as consent to recording. Each of those is
 * pinned here so it can't quietly come back.
 */
const actor: Actor = { id: "r1", role: "receptionist" };
// A Wednesday, so weekday phrases resolve deterministically.
const NOW = new Date(2026, 10, 25, 10, 0, 0);

function makeSession() {
  const auditLog = new AuditLog();
  return new ReceptionistChatSession({
    matterId: "m1",
    module: criminalLawModule,
    router: new Router(new AccessControl(auditLog), auditLog),
    actor,
    now: () => NOW,
  });
}

/** Cooperative answers that take a call to each point, by how many turns in. */
const COOPERATIVE = [
  "I'm a new client.",
  "Yes, that's fine.",
  "Taylor Brooks.",
  "No, I'm not in custody.",
  "In about three weeks.",
  "No, there's no protective order.",
  "Shoplifting, I think.",
];
const POSITIONS: Record<string, number> = {
  opening: 0,
  "at the consent question": 1,
  "at the conflict question": 2,
  "at the custody question": 3,
  "at the court-date question": 4,
  "at the protective-order question": 5,
  "at the charge question": 6,
};

const EMERGENCIES: Record<string, { trigger: string; lines: string[] }> = {
  custody: {
    trigger: "in_custody",
    lines: [
      "my son got arrested last night and he's still in jail",
      "My husband is in jail right now",
      "IM IN JAIL",
      "im in custody",
      "i'm locked up",
      "I got arrested and I'm at the county jail",
      "they're holding me at the police station",
      "I was booked into county last night",
      "I'm calling from jail",
      "this is a collect call from the county detention center",
      "he's been detained by ICE",
      "my brother is being held at the precinct",
      "im in custdy",
      "they took him to jail",
      "my daughter was arrested this morning",
      "he's not out of jail yet",
      "I need to post bail for my son",
      // Second round: slang, regional, texting shorthand, Spanish.
      "hes in jail rn",
      "the cops picked him up an hour ago",
      "he got nicked last night and he's in the cells",
      "my husband was remanded in custody",
      "hes locked up at county",
      "he's at county",
      "they hauled him in",
      "my brother is behind bars",
      "ICE took my husband",
      "immigration detained my wife",
      "my wife got taken in by the police",
      "he got cuffed and taken in",
      "i got arrested an hour ago and they won't let me leave",
      "mi esposo está en la cárcel",
      "mi hijo está detenido",
      "my son está en la cárcel",
      "lo arrestaron anoche",
    ],
  },
  police: {
    trigger: "imminent_police_questioning",
    lines: [
      "the cops want to talk to me tomorrow",
      "a detective left me a card and wants me to come in",
      "the police are at my door right now",
      "police are outside my house",
      "officers want to interview me this afternoon",
      "a detective called and wants a statement from me",
      "the police want to question me",
      "5-0 is at my door",
      "the police wanna talk to me",
      "theres cops at my door rn",
      "FBI agents came to my house and want to talk to me",
      "I've been asked to attend a voluntary interview at the police station",
      "la policía está en mi casa",
    ],
  },
  court: {
    trigger: "court_appearance_imminent",
    lines: [
      "I have court tomorrow morning",
      "my hearing is tomorrow",
      "my arraignment is in 2 hours",
      "court is today at 1pm",
      "my trial starts tomorrow",
      "I have to be in front of the judge tomorrow",
      "my hearing is in two hours",
      "my court date is Friday",
      "sentencing is tonight",
      "court 2moro",
      "court tmrw",
      "my court date is 2day",
      "court is in 1hr",
      "I gotta be in court in the morning",
      "I'm due in court on Thursday",
      "my case is called tomorrow",
      "I've got a court date day after tomorrow",
      "I'm due at the magistrates' court tomorrow",
      "tengo corte mañana",
    ],
  },
  "protective order": {
    trigger: "active_protective_order",
    lines: [
      "my ex says I violated the restraining order and the police came",
      "he violated the protective order",
      "there's a no-contact order and she says I broke it",
      "the police came because of the restraining order",
      "I just got served with a protective order",
      "she took out a TRO on me",
      "there's an RO against me and he says I broke it",
      "he got a PFA against me",
      "I was served with a DVRO",
      "an order of protection was issued against me yesterday",
      "she has a no contact order and I texted her",
    ],
  },
  crisis: {
    trigger: "crisis_risk",
    lines: [
      "i want to kill myself",
      "I don't see the point in living anymore",
      "i'm going to end it all",
      "he has a gun and he's outside",
      "my boyfriend is hitting me right now",
      "I'm not safe",
      "she's threatening to kill me",
      "I took a bunch of pills",
      "I'm in danger",
      "i wanna kms",
      "kms",
      "i want to unalive myself",
      "i'm thinking about ending my life",
      "my husband just hit me",
      "my ex is outside with a gun",
      "me quiero morir",
    ],
  },
};

const VARIANTS: Record<string, (s: string) => string> = {
  "as written": (s) => s,
  "ALL CAPS": (s) => s.toUpperCase(),
  "all lower case": (s) => s.toLowerCase(),
  "with a filler": (s) => `um ok so ${s}`,
  "with a plea": (s) => `${s}, please help!!`,
  "with extra spaces": (s) => `  ${s.replace(/ /g, "  ")}  `,
  "with a phone's curly apostrophe": (s) => s.replace(/'/g, "\u2019"),
};

function at(position: number) {
  const session = makeSession();
  for (const line of COOPERATIVE.slice(0, position)) {
    const r = session.handleMessage(line);
    if (r.done) throw new Error(`setup ended early at "${line}": ${r.trace.label}`);
  }
  return session;
}

describe("every emergency, every phrasing, every point in the call", () => {
  for (const [group, { trigger, lines }] of Object.entries(EMERGENCIES)) {
    describe(group, () => {
      for (const line of lines) {
        it(`escalates "${line}" in every variant and position`, () => {
          for (const [variantName, variant] of Object.entries(VARIANTS)) {
            for (const [positionName, position] of Object.entries(POSITIONS)) {
              const result = at(position).handleMessage(variant(line));
              const where = `${variantName}, ${positionName}`;
              expect(result.done, where).toBe(true);
              expect(result.trace.triggers, where).toContain(trigger);
            }
          }
        });
      }
    });
  }
});

describe("an emergency buried at the end of a long, rambling opener still escalates", () => {
  const ramble = (end: string) =>
    "Hi so this is kind of a long story, my cousin recommended you guys and I've been meaning to call for a while because things have been crazy with work and the kids and the house and honestly everything, and I wasn't sure who to call or whether this was even the right kind of firm, anyway the reason I'm calling is " +
    end;
  const cases: Array<[string, string]> = [
    ["in_custody", "my husband got arrested last night and he is still in jail"],
    ["court_appearance_imminent", "I have to be in court tomorrow morning and I have no idea what to do"],
    ["crisis_risk", "I honestly don't want to live anymore"],
    ["imminent_police_questioning", "a detective wants me to come in and talk tomorrow"],
  ];
  for (const [trigger, end] of cases) {
    it(`escalates a ramble ending "${end}"`, () => {
      const result = makeSession().handleMessage(ramble(end));
      expect(result.done).toBe(true);
      expect(result.trace.triggers).toContain(trigger);
    });
  }
});

describe("legal questions are redirected to a person, never answered or skipped", () => {
  const questions = [
    "should I plead guilty?",
    "what are my chances",
    "can I get my charges dropped",
    "how much time am I looking at",
    "is it worth fighting this",
    "will I lose my license",
    "Am I going to jail?",
    "do I need a lawyer for this?",
    "will this go on my record",
  ];
  for (const line of questions) {
    it(`redirects "${line}"`, () => {
      for (const [positionName, position] of Object.entries(POSITIONS)) {
        const result = at(position).handleMessage(line);
        expect(result.done, positionName).toBe(true);
        expect(result.trace.triggers, positionName).toContain("legal_advice_requested");
      }
    });
  }
});

describe("ordinary answers don't end the call", () => {
  // Answered at the court-date question, where "no"/"yes" can't be read as custody.
  const benign = [
    "No, I'm not in jail.",
    "I've never been arrested.",
    "In about three weeks.",
    "Not yet, they said they'd mail it",
    "I booked a consultation online last week",
    "The police report has my name spelled wrong",
    "he got out of jail last month",
    "I was arrested last year and want to get it expunged",
    "next month sometime",
    "Will I need to come in to the office?",
    "the officer gave me a ticket and I want to come in to your office",
    "🙏",
    // Second round: denials and ordinary answers in the new styles.
    "lol no he's not locked up",
    "no court date yet",
    "court isnt till next yr",
    "idk when court is, they didnt say",
    "mi esposo no está detenido",
    "I got caught with a gun in my car last month",
    "I'm charged with carrying a knife",
    "the hearing is at the county courthouse next month",
    "No, there's no protective order against me.",
    "nah there isnt any restraining order on me",
  ];
  for (const line of benign) {
    it(`continues after "${line}"`, () => {
      const result = at(POSITIONS["at the court-date question"]!).handleMessage(line);
      expect(result.done).toBe(false);
      expect(result.trace.triggers).toEqual([]);
    });
  }
});

/** Deterministic PRNG so a failure is reproducible from its seed. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = [
  "",
  "   ",
  "asdfghjkl",
  "???",
  "...",
  "😂😂😂",
  "ok",
  "k",
  "yes",
  "no",
  "maybe",
  "idk",
  "what?",
  "um what?",
  "are you a robot?",
  "how much do you charge?",
  "who is this?",
  "where are you located?",
  "can you repeat that?",
  "hola, no hablo bien inglés",
  "Je ne comprends pas",
  "lol sure whatever",
  "THIS IS RIDICULOUS",
  "I already told you that",
  "my cat is named Biscuit",
  "Taylor Brooks",
  "I'm a new client",
  "it's about my son",
  "x".repeat(3000),
  "First line\nsecond line\nthird line",
  "<script>alert(1)</script>",
  "null",
  "undefined",
  "0",
  "-1",
  "I need an interpreter",
];

describe("fuzzed conversations never crash, never stall, and stay ended", () => {
  // Every turn either advances, or is a bounded re-ask (one caller-type,
  // one consent, one interpreter) or one of at most two side questions in a
  // row — so a call must finish within this many turns, whatever is said.
  const steps = criminalLawModule.intakeQuestions.length + 3 /* gates */ + 1 /* interpreter */ + 3 /* re-asks */;
  const bound = steps * 3 + 1;

  it(`ends every conversation within ${bound} turns, with a real reply every turn (1500 seeded runs)`, () => {
    for (let seed = 1; seed <= 1500; seed += 1) {
      const random = mulberry32(seed);
      const session = makeSession();
      let ended = false;
      for (let turn = 1; turn <= bound + 5; turn += 1) {
        const text = NOISE[Math.floor(random() * NOISE.length)]!;
        const result = session.handleMessage(text);
        expect(typeof result.reply, `seed ${seed} turn ${turn}`).toBe("string");
        expect(result.reply.trim().length, `seed ${seed} turn ${turn}`).toBeGreaterThan(0);
        expect(result.reply.length, `seed ${seed} turn ${turn}`).toBeLessThan(600);
        if (ended) {
          expect(result.done, `seed ${seed}: a finished call stays finished`).toBe(true);
          expect(result.reply).toBe(WRAP_UP);
        }
        if (result.done && !ended) {
          ended = true;
          expect(turn, `seed ${seed} ended on turn ${turn}`).toBeLessThanOrEqual(bound);
        }
      }
      expect(ended, `seed ${seed} never ended`).toBe(true);
    }
  });

  it("never echoes the caller's own text back as the reply", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = mulberry32(seed);
      const session = makeSession();
      for (let turn = 0; turn < 12; turn += 1) {
        const text = NOISE[Math.floor(random() * NOISE.length)]!;
        const result = session.handleMessage(text);
        if (text.trim().length > 3) expect(result.reply).not.toContain(text.trim());
        if (result.done) break;
      }
    }
  });
});

/*
 * Round three: what a speech-to-text engine actually hands over. A voice
 * call reaches the receptionist as a transcript — lower case, no
 * punctuation, fillers and stutters left in, numbers spelled out, and the
 * same handful of words misheard every time. Its first run found that a
 * filler in the middle of a phrase ("i want to uh die") defeated almost
 * every pattern, that minutes ("court in thirty minutes") and spoken
 * dates ("the twenty sixth") weren't understood at all, and that
 * "arraignment" transcribed as "arrangement" went straight past.
 */
const plain = (s: string) => s.toLowerCase().replace(/[.,!?;:"]/g, "").replace(/\s+/g, " ").trim();
const VOICE: Record<string, (s: string) => string> = {
  "as transcribed": plain,
  "without apostrophes": (s) => plain(s).replace(/['’]/g, ""),
  "with fillers mid-phrase": (s) => {
    const words = plain(s).split(" ");
    words.splice(Math.min(3, words.length), 0, "uh");
    return `um ${words.join(" ")}`;
  },
  "with a false start": (s) => {
    const words = plain(s).split(" ");
    return [...words.slice(0, 2), ...words].join(" ");
  },
};

const VOICE_EMERGENCIES: Record<string, { trigger: string; lines: string[] }> = {
  custody: {
    trigger: "in_custody",
    lines: [
      "my son he got arrested and he's still in jail",
      "hi yeah so my brother got locked up last night",
      "they're holding my daughter at the at the police station",
      "my boyfriend's in jail and his bail is like five thousand",
      "i need to bail my son out",
      "i need to post bale for my son",
      "he got a rested last night",
      "my son is incarcerated",
      "my nephew got arrested and they won't let him go",
    ],
  },
  police: {
    trigger: "imminent_police_questioning",
    lines: [
      "the police are like at my door right now",
      "the cops called and they want me to come down to the station tomorrow",
      "an officer is coming by to talk to me in an hour",
      "there's a cop knocking on my door",
    ],
  },
  court: {
    trigger: "court_appearance_imminent",
    lines: [
      "i have court tomorrow at nine thirty",
      "court is in like an hour and a half",
      "my court date is in forty five minutes",
      "i have court in thirty minutes",
      "court is in half an hour",
      "my arrangement is tomorrow morning",
      "i have cord tomorrow",
      "my court date is the twenty sixth",
      "court is on november twenty sixth",
      "my hearing is on the twenty sixth of november",
      "i have a court date on the twenty seventh",
      "court is on the 26th",
      "court's at eight am tomorrow",
      "my hearing is in twenty four hours",
    ],
  },
  "protective order": {
    trigger: "active_protective_order",
    lines: ["she got a t r o on me", "he got a p f a against me", "there's a no contact order and i texted her"],
  },
  crisis: {
    trigger: "crisis_risk",
    lines: [
      "i want to die",
      "he's got a knife and he's here",
      "i took a whole bottle of pills",
      "i'm thinking about killing myself",
      "i just want it all to stop",
      "i'm scared he's gonna kill me",
    ],
  },
};

describe("round three: voice transcripts, every emergency, every point in the call", () => {
  // Every phrasing from all three rounds, as a transcript would carry it.
  const all: Array<[string, string, string]> = [];
  for (const source of [EMERGENCIES, VOICE_EMERGENCIES]) {
    for (const [group, { trigger, lines }] of Object.entries(source)) {
      for (const line of lines) all.push([group, trigger, line]);
    }
  }
  for (const [group, trigger, line] of all) {
    it(`${group}: escalates "${line}" as a transcript`, () => {
      for (const [variantName, variant] of Object.entries(VOICE)) {
        for (const [positionName, position] of Object.entries(POSITIONS)) {
          const result = at(position).handleMessage(variant(line));
          const where = `${variantName}, ${positionName}`;
          expect(result.done, where).toBe(true);
          expect(result.trace.triggers, where).toContain(trigger);
        }
      }
    });
  }
});

describe("round three: ordinary transcribed answers don't end the call", () => {
  // At the court-date question, so none of these may carry a time within
  // two days — there, any "today" or "tomorrow" is read as the court date.
  const benign = [
    "no no i'm not in jail",
    "uh no court date yet",
    "um i think court is like next month",
    "court is on the fifth of december",
    "court is on the fifth",
    "my lawyer said court is the twenty eighth",
    "the first hearing was in october",
    "my second hearing is in march",
    "i was arrested like last year",
    "no there's no restraining order",
    "court is in like forty five days",
    "i need to bail out of this contract",
    "he he used to hit me years ago but not anymore",
    "i think i was charged with a d u i",
  ];
  for (const line of benign) {
    it(`continues after "${line}"`, () => {
      for (const [variantName, variant] of Object.entries(VOICE)) {
        const result = at(POSITIONS["at the court-date question"]!).handleMessage(variant(line));
        expect(result.done, variantName).toBe(false);
        expect(result.trace.triggers, variantName).toEqual([]);
      }
    });
  }
});
