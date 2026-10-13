// Test-call scripts: "A:" agent / "C:" customer lines, planted fake PII marked
// [[KIND:text]]. Shared by the unit tests (scripted word timings) and the audio
// generator / eval scripts (real TTS audio through the real vendors).
//
// Markup
//   # meta: agent=<name>; caller=<name>   names the rules get as extra terms
//   # strict                              nothing outside a planted value may be bleeped
//   A: >>-1500 text                        crosstalk: this line starts 1500 ms before the previous line ends
//   # repeat 12 … # end                    the lines between are repeated 12 times; inside them
//                                          {first|second|third} picks one option per repeat (seeded, so the
//                                          same file always expands the same way and repeats differ)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Planted = { kind: string; text: string; line: number; from: number; to: number };   // token range within the line
export type CallScript = {
  name: string;
  agent: string;
  caller: string;
  strict: boolean;
  lines: { speaker: "agent" | "customer"; text: string; tokens: string[]; overlap_ms: number }[];
  planted: Planted[];
};

// Kinds a model is needed for (no rule can know "Springfield" is a city).
export const MODEL_ONLY = new Set(["HEALTH", "MEDICATION", "BENEFICIARY", "CITY"]);

/** Deterministic PRNG (mulberry32) so a repeat block always expands the same way. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Expand `# repeat N … # end` blocks and their {a|b|c} alternations. */
export function expandRepeats(name: string, src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const m = /^#\s*repeat\s+(\d+)\s*$/.exec(lines[k].trim());
    if (!m) { out.push(lines[k]); continue; }
    const body: string[] = [];
    let j = k + 1;
    for (; j < lines.length && !/^#\s*end\s*$/.test(lines[j].trim()); j++) body.push(lines[j]);
    if (j >= lines.length) throw new Error(`${name}: # repeat at line ${k + 1} has no # end`);
    const rand = rng(seedOf(`${name}:${k}`));
    for (let r = 0; r < Number(m[1]); r++) {
      for (const b of body) out.push(b.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts: string) => {
        const o = opts.split("|");
        return o[Math.floor(rand() * o.length)];
      }));
    }
    k = j;
  }
  return out.join("\n");
}

export function parseScript(name: string, src: string): CallScript {
  const meta = /#\s*meta:\s*agent=([^;]+);\s*caller=(.+)/.exec(src);
  const strict = /^#\s*strict\s*$/m.test(src);
  const lines: CallScript["lines"] = [];
  const planted: Planted[] = [];
  for (const raw of expandRepeats(name, src).split("\n")) {
    const m = /^([AC]):\s*(?:>>-(\d+)\s+)?(.*)$/.exec(raw.trim());
    if (!m) continue;
    const tokens: string[] = [];
    const re = /\[\[([A-Z_]+):([^\]]+)\]\]|(\S+)/g;
    let x: RegExpExecArray | null;
    while ((x = re.exec(m[3]))) {
      if (x[1]) {
        const toks = x[2].split(/\s+/).filter(Boolean);
        // a trailing punctuation mark right after ]] belongs to the last planted token
        planted.push({ kind: x[1], text: x[2], line: lines.length, from: tokens.length, to: tokens.length + toks.length - 1 });
        tokens.push(...toks);
      } else if (/^[.,?!]+$/.test(x[3]) && tokens.length) {
        tokens[tokens.length - 1] += x[3];
      } else {
        tokens.push(x[3]);
      }
    }
    lines.push({ speaker: m[1] === "A" ? "agent" : "customer", text: tokens.join(" "), tokens, overlap_ms: m[2] ? Number(m[2]) : 0 });
  }
  return { name, agent: meta?.[1].trim() ?? "", caller: meta?.[2].trim() ?? "", strict, lines, planted };
}

export function loadScripts(dir = path.join(__dirname, "calls")): CallScript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => parseScript(f.replace(/\.txt$/, ""), readFileSync(path.join(dir, f), "utf8")));
}
