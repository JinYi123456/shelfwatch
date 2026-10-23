#!/usr/bin/env node
// Cursor hook: enforces two non-negotiables from the brief — English-only
// product files, and no credentials anywhere near a commit. Advisory by design:
// it reports, it never rewrites, and it must never crash the agent.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const PRODUCT_DIRS = ['src', 'public', 'data', 'examples', 'usql'];
const PRODUCT_FILES = ['README.md', 'metadata.json', 'package.json'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cursor', 'shelfwatch-prep', 'logs']);

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxai-[A-Za-z0-9]{20,}\b/g,
  /\bnvapi-[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{12,}['"]/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]{24,}=*/g
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function targetsFrom(input) {
  const out = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const k of ['file_path', 'filePath', 'path', 'target_file', 'targetFile']) {
      if (typeof v[k] === 'string') out.add(v[k]);
    }
    if (Array.isArray(v.files)) v.files.forEach((f) => f && typeof f.path === 'string' && out.add(f.path));
    Object.values(v).forEach((x) => { if (x && typeof x === 'object') walk(x); });
  };
  walk(input);
  return [...out];
}

function isProduct(rel) {
  const p = rel.split(path.sep).join('/');
  if (p.endsWith('.md') && p !== 'README.md') return false;
  if (/\.(data\.json|jsonl|csv)$/i.test(p)) return false;
  return PRODUCT_FILES.includes(p) || PRODUCT_DIRS.some((d) => p === d || p.startsWith(d + '/'));
}

function listProductFiles() {
  const files = [];
  const seen = new Set();
  const queue = ['.'];
  while (queue.length) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = path.join(dir, e.name).replace(/^\.[\\/]/, '');
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) queue.push(rel);
        continue;
      }
      if (isProduct(rel)) files.push(rel);
    }
  }
  for (const f of PRODUCT_FILES) if (!seen.has(f) && fs.existsSync(f)) files.push(f);
  return files;
}

function scan(rel) {
  const findings = [];
  let text;
  try {
    const st = fs.statSync(rel);
    if (st.size > 900_000) return findings;
    text = fs.readFileSync(rel, 'utf8');
  } catch {
    return findings;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const nonAscii = line.match(/[^\x09\x0A\x0D\x20-\x7E]/g);
    if (nonAscii) {
      const uniq = [...new Set(nonAscii)].slice(0, 8).join(' ');
      findings.push(`${rel}:${i + 1} non-English characters: ${uniq}`);
    }
    for (const re of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) findings.push(`${rel}:${i + 1} possible credential — ${line.trim().slice(0, 60)}`);
    }
  });
  return findings;
}

function emit(payload) {
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch {
    /* nothing can be done from a hook */
  }
}

function main() {
  const raw = readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    return emit({});
  }
  const event = input.hook_event_name || input.hookEventName || '';
  const command = typeof input.command === 'string' ? input.command : '';

  if (/git (commit|push)/.test(command)) {
    const findings = listProductFiles().flatMap(scan).slice(0, 12);
    if (findings.length) {
      return emit({
        user_message: 'Shelfwatch guard: this commit is blocked pending review.',
        agent_message: `Fix these before committing:\n${findings.map((f) => '- ' + f).join('\n')}`
      });
    }
    return emit({});
  }

  if (event === 'postToolUse' || event === 'PostToolUse') {
    const files = targetsFrom(input).filter((f) => f && isProduct(f.replace(/^\.[\\/]/, '')));
    const findings = files.flatMap((f) => scan(f)).slice(0, 12);
    if (findings.length) {
      return emit({
        additional_context: `Shelfwatch guard flagged the files you just wrote. The brief requires English-only product files and no credentials in tracked source. Resolve or explain:\n${findings.map((f) => '- ' + f).join('\n')}`
      });
    }
  }
  emit({});
}

try {
  main();
} catch {
  emit({});
}
