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
  'ょ',
  // Dakuten
  'が',
  'ぎ',
  'ぐ',
  'げ',
  'ご',
  'ざ',
  'じ',
  'ず',
  'ぜ',
  'ぞ',
  'だ',
  'ぢ',
  'づ',
  'で',
  'ど',
  'ば',
  'び',
  'ぶ',
  'べ',
  'ぼ',
  // Handakuten
  'ぱ',
  'ぴ',
  'ぷ',
  'ぺ',
  'ぽ',
];

/** When true (default), don't overwrite existing JSON files (preserves manual fixes). */
const SKIP_EXISTING = !process.argv.includes('--force');

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
  // animCJK medians are polylines using M / L (implicit after M) / H / V.
  // Tokenize letters and numbers separately so we can honor each command.
  const tokens = d.match(/[a-zA-Z]|-?\d+(?:\.\d+)?/g) ?? [];
  const points = [];
  let cmd = null;
  let cx = 0;
  let cy = 0;
  let i = 0;

  const readNum = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      i++;
      continue;
    }
    switch (cmd) {
      case 'M':
      case 'L': {
        cx = readNum();
        cy = readNum();
        points.push([cx, cy]);
        // After an explicit M, subsequent implicit pairs are treated as L.
        if (cmd === 'M') cmd = 'L';
        break;
      }
      case 'm':
      case 'l': {
        cx += readNum();
        cy += readNum();
        points.push([cx, cy]);
        if (cmd === 'm') cmd = 'l';
        break;
      }
      case 'H': {
        cx = readNum();
        points.push([cx, cy]);
        break;
      }
      case 'h': {
        cx += readNum();
        points.push([cx, cy]);
        break;
      }
      case 'V': {
        cy = readNum();
        points.push([cx, cy]);
        break;
      }
      case 'v': {
        cy += readNum();
        points.push([cx, cy]);
        break;
      }
      default: {
        // Unknown / unsupported command — skip the orphan number.
        i++;
        break;
      }
    }
  }

  return points.map(([x, y]) => [x, Y_FLIP_ANCHOR - y]);
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

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const outDir = path.resolve(process.cwd(), 'example/assets/kana');
  await fs.mkdir(outDir, { recursive: true });

  const failures = [];
  for (const char of KANA) {
    const codepoint = char.codePointAt(0);
    // Use ASCII-only filenames to avoid Metro resolution issues on some setups.
    const outPath = path.join(outDir, `hiragana-${codepoint}.json`);

    if (SKIP_EXISTING && (await fileExists(outPath))) {
      // eslint-disable-next-line no-console
      console.log(`skip (exists) ${outPath}`);
      continue;
    }

    const url = charToAnimCjkKanaSvgUrl(char);
    const res = await fetch(url);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`skip (HTTP ${res.status}) ${char} (${url})`);
      failures.push({ char, codepoint, status: res.status });
      continue;
    }
    const svgText = await res.text();
    const json = parseAnimCjkKanaSvg(svgText);
    await fs.writeFile(outPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${outPath}`);
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\nMissing in animCJK: ${failures
        .map((f) => `${f.char}(${f.codepoint})`)
        .join(', ')}`
    );
  }
}

await main();

