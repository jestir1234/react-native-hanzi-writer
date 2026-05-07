import fs from 'node:fs/promises';
import path from 'node:path';

const Y_FLIP_ANCHOR = 900;
const X_MIN = 0;
const X_MAX = 1024;

const KANA = [
  'あ',
  'お',
  'な',
  'の',
  'ぬ',
  'ね',
  'す',
  'ま',
  'む',
  'み',
  'め',
  'ほ',
  'は',
  'る',
  'よ',
];

function charToAnimCjkKanaSvgUrl(char) {
  const codepoint = char.codePointAt(0);
  return `https://raw.githubusercontent.com/parsimonhi/animCJK/master/svgsJaKana/${codepoint}.svg`;
}

function pickMedianVariant(variants) {
  // Prefer variant whose points are inside the viewbox (filters mirrored negatives).
  const inBox = variants.find((v) => v.minX >= X_MIN && v.maxX <= X_MAX);
  return inBox ?? variants[0] ?? null;
}

function parseMedianPathD(d) {
  // Example: "M 174,258 251,308 440,306 697,241"
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    points.push([x, Y_FLIP_ANCHOR - y]);
  }
  return points;
}

function formatStrokePathD(d) {
  // Transform y coordinates: y' = 900 - y.
  // animCJK kana paths appear to be made of commands with coordinate pairs; handle H/V specially.
  let curCmd = null;
  let numBuf = '';
  let expecting = 'x'; // for pairwise commands

  const out = [];
  const flushNumber = () => {
    if (numBuf === '') return;
    const raw = Number(numBuf);
    if (Number.isNaN(raw)) {
      out.push(numBuf);
      numBuf = '';
      return;
    }

    if (curCmd === 'V') {
      out.push(String(Y_FLIP_ANCHOR - raw));
    } else if (curCmd === 'H') {
      out.push(String(raw));
    } else {
      if (expecting === 'x') {
        out.push(String(raw));
        expecting = 'y';
      } else {
        out.push(String(Y_FLIP_ANCHOR - raw));
        expecting = 'x';
      }
    }
    numBuf = '';
  };

  for (let i = 0; i < d.length; i++) {
    const ch = d[i];
    const isNumChar = /[0-9.\-]/.test(ch);
    const isCmdChar = /[a-zA-Z]/.test(ch);

    if (isCmdChar) {
      flushNumber();
      curCmd = ch.toUpperCase();
      // After a command, reset pair expectation for pairwise commands
      if (curCmd !== 'H' && curCmd !== 'V') {
        expecting = 'x';
      }
      out.push(ch);
      continue;
    }

    if (isNumChar) {
      numBuf += ch;
      continue;
    }

    // delimiter
    flushNumber();
    if (ch === ',') {
      out.push(',');
    } else {
      out.push(ch);
    }
  }
  flushNumber();

  // Normalize whitespace a bit
  return out
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAnimCjkKanaSvg(svgText) {
  // Stroke shapes: <path id="z12354d1" d="..."/>
  const strokeByNum = new Map(); // num -> [dStrings]
  const strokeRe = /<path\s+id="z\d+d(\d+)([a-z])?"\s+d="([^"]+)"/g;
  for (const match of svgText.matchAll(strokeRe)) {
    const num = Number(match[1]);
    const d = match[3];
    const arr = strokeByNum.get(num) ?? [];
    arr.push(d);
    strokeByNum.set(num, arr);
  }

  // Medians: <path ... clip-path="url(#z12354c1)" d="M ..."/>
  const mediansByNum = new Map(); // num -> variants
  const medianRe =
    /<path[^>]*clip-path="url\(#z\d+c(\d+)([a-z])?\)"[^>]*\sd="([^"]+)"/g;
  for (const match of svgText.matchAll(medianRe)) {
    const num = Number(match[1]);
    const d = match[3];
    const pts = parseMedianPathD(d);
    if (pts.length < 2) continue;
    const xs = pts.map((p) => p[0]);
    const variant = {
      points: pts,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
    };
    const arr = mediansByNum.get(num) ?? [];
    arr.push(variant);
    mediansByNum.set(num, arr);
  }

  const maxStrokeNum = Math.max(...strokeByNum.keys());
  const strokes = [];
  const medians = [];

  for (let n = 1; n <= maxStrokeNum; n++) {
    const dParts = strokeByNum.get(n);
    if (!dParts?.length) continue;
    const mergedD = dParts.map(formatStrokePathD).join(' ');
    strokes.push(mergedD);

    const medianVariants = mediansByNum.get(n) ?? [];
    const picked = pickMedianVariant(medianVariants);
    if (!picked) {
      throw new Error(`No median path found for stroke ${n}`);
    }
    medians.push(picked.points);
  }

  return { strokes, medians };
}

async function main() {
  const outDir = path.resolve(process.cwd(), 'example/assets/kana');
  await fs.mkdir(outDir, { recursive: true });

  for (const char of KANA) {
    const codepoint = char.codePointAt(0);
    const url = charToAnimCjkKanaSvgUrl(char);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed fetching ${char} (${url}): ${res.status}`);
    }
    const svgText = await res.text();
    const json = parseAnimCjkKanaSvg(svgText);
    // Use ASCII-only filenames to avoid Metro resolution issues on some setups.
    const outPath = path.join(outDir, `hiragana-${codepoint}.json`);
    await fs.writeFile(outPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${outPath}`);
  }
}

await main();

