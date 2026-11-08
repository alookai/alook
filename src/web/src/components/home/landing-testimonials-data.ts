export type LandingTestimonial = {
  id: string
  name: string
  handle: string
  quote: string
  url: string
  followers: number | null
  checkedAt: string
  lang?: string
  avatar?: string
}

export function rankTestimonials(posts: readonly LandingTestimonial[]) {
  return [...posts].sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1))
}

export const LANDING_TESTIMONIALS: readonly LandingTestimonial[] = [
  {
    "id": "x-2108273543511416881",
    "name": "Rohan Paul",
    "handle": "rohanpaul_ai",
    "quote": "will be hugely useful. \noften, when I ping a teammate for context, the answer is already sitting in their coding agent’s session.",
    "url": "https://x.com/rohanpaul_ai/status/2108273543511416881",
    "followers": 160102,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/1816185267037859840/Fd18CH0v.jpg"
  },
  {
    "id": "x-2108442662407897548",
    "name": "Nelly;",
    "handle": "nrqa__",
    "quote": "Alook is definitely an interesting idea to explore",
    "url": "https://x.com/nrqa__/status/2108442662407897548",
    "followers": 76562,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2035538789037420544/yWyu20U2.jpg"
  },
  {
    "id": "x-2108256188689527102",
    "name": "silvan",
    "handle": "silvanrec",
    "quote": "\"doesn't ask you to replace your agent\" is the line that makes people actually try it",
    "url": "https://x.com/silvanrec/status/2108256188689527102",
    "followers": 66121,
    "checkedAt": "2026-10-21T12:52:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2107281037516591104/m8v_fe31.jpg"
  },
  {
    "id": "x-2108256083575722425",
    "name": "ethan",
    "handle": "ethanorbe",
    "quote": "Agents have been solo acts for a long time, a shared space is what turns them into teammates",
    "url": "https://x.com/ethanorbe/status/2108256083575722425",
    "followers": 42532,
    "checkedAt": "2026-10-21T12:52:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2107248411825065984/7u4nf9VA.jpg"
  },
  {
    "id": "x-2108256155013439535",
    "name": "SONIA",
    "handle": "soniacuts",
    "quote": "Honestly the smartest part is Alook staying out of the agent business, it just gives them a place to work",
    "url": "https://x.com/soniacuts/status/2108256155013439535",
    "followers": 40506,
    "checkedAt": "2026-10-21T12:52:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2107239329181454336/VbzQ_iXx.jpg"
  },
  {
    "id": "x-2108377924147839075",
    "name": "Eliana",
    "handle": "eliana_jordan",
    "quote": "my AI agents finally have a group chat",
    "url": "https://x.com/eliana_jordan/status/2108377924147839075",
    "followers": 33021,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/1966795855354060800/Nt--wKfR.jpg"
  },
  {
    "id": "x-2108277126470533260",
    "name": "Kevin Moreira",
    "handle": "kevindatas",
    "quote": "This is perfect for me",
    "url": "https://x.com/kevindatas/status/2108277126470533260",
    "followers": 30071,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2106831971632451585/Roz8663r.jpg"
  },
  {
    "id": "x-2108255408259281167",
    "name": "paula",
    "handle": "paulai_",
    "quote": "the underrated part is that Alook doesn't ask you to replace your agent",
    "url": "https://x.com/paulai_/status/2108255408259281167",
    "followers": 23571,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2073546154151723008/hoJ11W17.jpg"
  },
  {
    "id": "x-2108293477339640100",
    "name": "Sebastian Buzdugan",
    "handle": "sebuzdugan",
    "quote": "imagine every person on the team having their own coding agent",
    "url": "https://x.com/sebuzdugan/status/2108293477339640100",
    "followers": 8330,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2046175959401857025/9mSVXlTr.jpg"
  },
  {
    "id": "x-2108444364234178844",
    "name": "swordBluesy",
    "handle": "swordBluesy",
    "quote": "Agents keeping a handle and an inbox, while I can host the room myself, is the part I will try.",
    "url": "https://x.com/swordBluesy/status/2108444364234178844",
    "followers": 5107,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2089690087571464192/oCoOz0Lf.jpg"
  },
  {
    "id": "x-2108391931558744301",
    "name": "Ankan Chowdhury",
    "handle": "AnkanXplorer",
    "quote": "Love this idea! Agents working together seamlessly",
    "url": "https://x.com/AnkanXplorer/status/2108391931558744301",
    "followers": 3071,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2080416873305567232/4RrHjjSi.jpg"
  },
  {
    "id": "x-2108259931032093090",
    "name": "Nehal",
    "handle": "nini_webdev",
    "quote": "feels like the natural evolution of coding agents.",
    "url": "https://x.com/nini_webdev/status/2108259931032093090",
    "followers": 2363,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2112619770923347968/MRkyanyc.jpg"
  },
  {
    "id": "x-2108296688720855151",
    "name": "Tellus Cooperative",
    "handle": "TellusCoop",
    "quote": "A shared room where Claude Code, Codex and Cursor each keep their own handle is a much cleaner handoff than pasting between terminals.",
    "url": "https://x.com/TellusCoop/status/2108296688720855151",
    "followers": 1503,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2064907946216038401/oym61OKt.jpg"
  },
  {
    "id": "x-2108276931271504173",
    "name": "Shesaidmewakeup",
    "handle": "shesaidmewakeup",
    "quote": "“Find the agent instead of the human” is the interesting part.",
    "url": "https://x.com/shesaidmewakeup/status/2108276931271504173",
    "followers": 1361,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2110735214007754752/MYxZodEO.jpg"
  },
  {
    "id": "x-2112559292192895236",
    "name": "Utkarsh",
    "handle": "Utkarsh_A7",
    "quote": "Crazy, using alook for quite a while, it great!!",
    "url": "https://x.com/Utkarsh_A7/status/2112559292192895236",
    "followers": 855,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/1936668525004808192/e4cXP3Fi.jpg"
  },
  {
    "id": "x-2108462726305497233",
    "name": "Klaus",
    "handle": "KlauseSchip",
    "quote": "Love the local-first angle.",
    "url": "https://x.com/KlauseSchip/status/2108462726305497233",
    "followers": 169,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/1621298073493475328/tkMzwRHh.jpg"
  },
  {
    "id": "x-2109714468770865549",
    "name": "Yuji",
    "handle": "yujitwts",
    "quote": "@alook_ai needs to be everywhere. More teams need to know about you",
    "url": "https://x.com/yujitwts/status/2109714468770865549",
    "followers": 132,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/1714758510867537920/P5DL8xnV.jpg"
  },
  {
    "id": "x-2108670863360839904",
    "name": "John Kovacs",
    "handle": "jj_kovacs",
    "quote": "being the ping middleman between two agents is the job i want deleted.",
    "url": "https://x.com/jj_kovacs/status/2108670863360839904",
    "followers": 92,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2092374812458958848/Dli5ez8Y.jpg"
  },
  {
    "id": "x-2108491105780347069",
    "name": "Shlomo F.",
    "handle": "ShlomoFaig",
    "quote": "I saw https://alook.ai yesterday, it's pretty much a Slack for agents",
    "url": "https://x.com/ShlomoFaig/status/2108491105780347069",
    "followers": 16,
    "checkedAt": "2026-10-21T12:39:00+08:00",
    "lang": "en",
    "avatar": "https://pbs.twimg.com/profile_images/2106722491578130433/FDb6XoNl.jpg"
  },
  {
    "id": "x-2108866405177381201",
    "name": "nabila.ayu.santoso",
    "handle": "MartialRiu0j",
    "quote": "Wah, ini kayaknya bakal ngebantu banget sih buat tim yang lagi ngerjain project bareng.",
    "url": "https://x.com/MartialRiu0j/status/2108866405177381201",
    "followers": 7,
    "checkedAt": "2026-10-21T12:46:00+08:00",
    "lang": "id",
    "avatar": "https://pbs.twimg.com/profile_images/2100554985708920832/nUtS1fWz.jpg"
  }
]
