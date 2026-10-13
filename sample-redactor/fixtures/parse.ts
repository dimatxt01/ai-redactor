// Test-call scripts: "A:" agent / "C:" customer lines, planted fake PII marked
// [[KIND:text]]. Shared by the unit tests (scripted word timings) and the audio
// generator / eval scripts (real TTS audio through the real vendors).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Planted = { kind: string; text: string; line: number; from: number; to: number };   // token range within the line
export type CallScript = {
  name: string;
  agent: string;
  caller: string;
  lines: { speaker: "agent" | "customer"; text: string; tokens: string[] }[];
  planted: Planted[];
};

// Kinds a model is needed for (no rule can know "Springfield" is a city).
export const MODEL_ONLY = new Set(["HEALTH", "MEDICATION", "BENEFICIARY", "CITY"]);

export function parseScript(name: string, src: string): CallScript {
  const meta = /#\s*meta:\s*agent=([^;]+);\s*caller=(.+)/.exec(src);
  const lines: CallScript["lines"] = [];
  const planted: Planted[] = [];
  for (const raw of src.split("\n")) {
    const m = /^([AC]):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const tokens: string[] = [];
    const re = /\[\[([A-Z_]+):([^\]]+)\]\]|(\S+)/g;
    let x: RegExpExecArray | null;
    while ((x = re.exec(m[2]))) {
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
    lines.push({ speaker: m[1] === "A" ? "agent" : "customer", text: tokens.join(" "), tokens });
  }
  return { name, agent: meta?.[1].trim() ?? "", caller: meta?.[2].trim() ?? "", lines, planted };
}

export function loadScripts(dir = path.join(__dirname, "calls")): CallScript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => parseScript(f.replace(/\.txt$/, ""), readFileSync(path.join(dir, f), "utf8")));
}
