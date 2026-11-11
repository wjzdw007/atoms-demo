/**
 * The agent characters. These are original drawings made for this demo, in the friendly, rounded
 * spirit of the Atoms team; they are not copies of the official artwork.
 */
export const TEAM = [
  { name: "Mike", role: "团队负责人", colors: ["#ffd3a6", "#ff9a4d"], acc: "star" },
  { name: "Iris", role: "深度研究员", colors: ["#e6ccff", "#b07cf5"], acc: "cap" },
  { name: "Emma", role: "产品经理", colors: ["#ffd0e0", "#ff86b3"], acc: "bow" },
  { name: "Bob", role: "架构师 / 评审", colors: ["#ffffff", "#dfe2ee"], acc: "scarf" },
  { name: "Alex", role: "工程师", colors: ["#c4d6ff", "#6b95ff"], acc: "glasses" },
  { name: "David", role: "数据分析师", colors: ["#c5f5cf", "#5fd47c"], acc: "phones" },
  { name: "Sarah", role: "SEO 专家", colors: ["#fff0b8", "#f8c94a"], acc: "lens" },
  { name: "Adrian", role: "广告专家", colors: ["#ffc9bf", "#ff7a6b"], acc: "horn" },
] as const;

export type TeamName = (typeof TEAM)[number]["name"];

function Accessory({ kind }: { kind: string }) {
  const dark = "#2b2b3a";
  switch (kind) {
    case "star":
      return <polygon points="100,138 106,152 121,153 109,162 113,177 100,169 87,177 91,162 79,153 94,152" fill="#fff" opacity=".95" />;
    case "cap":
      return (
        <>
          <polygon points="100,0 168,24 100,48 32,24" fill={dark} />
          <rect x="72" y="30" width="56" height="18" rx="6" fill={dark} />
          <path d="M160 26v30" stroke="#ffd66b" strokeWidth="5" strokeLinecap="round" />
          <circle cx="160" cy="60" r="7" fill="#ffd66b" />
        </>
      );
    case "bow":
      return (
        <>
          <path d="M138 34l34-16v36z" fill="#ff5c93" />
          <path d="M138 34l-30-16v36z" fill="#ff5c93" />
          <circle cx="138" cy="34" r="9" fill="#ff86b3" />
        </>
      );
    case "scarf":
      return (
        <>
          <rect x="42" y="140" width="116" height="20" rx="10" fill={dark} />
          <rect x="116" y="150" width="20" height="40" rx="8" fill={dark} />
        </>
      );
    case "glasses":
      return (
        <>
          <circle cx="78" cy="108" r="20" fill="rgba(255,255,255,.35)" stroke={dark} strokeWidth="5" />
          <circle cx="122" cy="108" r="20" fill="rgba(255,255,255,.35)" stroke={dark} strokeWidth="5" />
          <path d="M98 108h4" stroke={dark} strokeWidth="5" />
        </>
      );
    case "phones":
      return (
        <>
          <path d="M36 100Q100 -6 164 100" fill="none" stroke={dark} strokeWidth="9" strokeLinecap="round" />
          <rect x="20" y="90" width="26" height="44" rx="12" fill={dark} />
          <rect x="154" y="90" width="26" height="44" rx="12" fill={dark} />
        </>
      );
    case "lens":
      return (
        <>
          <circle cx="158" cy="146" r="17" fill="rgba(255,255,255,.6)" stroke={dark} strokeWidth="6" />
          <path d="M170 160l16 18" stroke={dark} strokeWidth="8" strokeLinecap="round" />
        </>
      );
    case "horn":
      return (
        <>
          <polygon points="150,150 190,126 190,178" fill={dark} />
          <rect x="138" y="143" width="16" height="16" rx="4" fill={dark} />
        </>
      );
    default:
      return null;
  }
}

export function Mascot({ name, size = 40, className = "" }: { name: TeamName; size?: number; className?: string }) {
  const m = TEAM.find((t) => t.name === name)!;
  const id = `mascot-${name}`;
  return (
    <svg width={size} height={size} viewBox="0 -6 200 206" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={m.colors[0]} />
          <stop offset="1" stopColor={m.colors[1]} />
        </linearGradient>
      </defs>
      <path d="M100 22C150 22 172 70 172 118C172 160 142 180 100 180C58 180 28 160 28 118C28 70 50 22 100 22Z" fill={`url(#${id})`} />
      <ellipse cx="72" cy="62" rx="22" ry="12" fill="#fff" opacity=".5" transform="rotate(-28 72 62)" />
      <ellipse cx="78" cy="108" rx="9" ry="12" fill="#1b1b1f" />
      <ellipse cx="122" cy="108" rx="9" ry="12" fill="#1b1b1f" />
      <circle cx="81" cy="103" r="3.2" fill="#fff" />
      <circle cx="125" cy="103" r="3.2" fill="#fff" />
      <ellipse cx="60" cy="130" rx="10" ry="6" fill="#ff8fa3" opacity=".55" />
      <ellipse cx="140" cy="130" rx="10" ry="6" fill="#ff8fa3" opacity=".55" />
      <path d="M91 128Q100 138 109 128" fill="none" stroke="#1b1b1f" strokeWidth="3.6" strokeLinecap="round" />
      <Accessory kind={m.acc} />
    </svg>
  );
}

/** The overlapping row of characters above the hero headline. */
export function MascotRow() {
  return (
    <div className="mb-5 flex justify-center" aria-hidden>
      {TEAM.map((m, i) => (
        <span
          key={m.name}
          className="mascot-bob -ml-2 flex h-11 w-11 items-center justify-center rounded-full border-2 border-bg first:ml-0"
          style={{ background: m.colors[0], animationDelay: `${i * 0.18}s` }}
        >
          <Mascot name={m.name} size={36} />
        </span>
      ))}
    </div>
  );
}
