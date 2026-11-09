// Append-only activity log, one JSON object per line. Each node keeps its own;
// the cluster page merges the recent entries every node reports in its heartbeat.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.dataDir, 'audit.jsonl');
const KEEP = 200;
let recentEntries = [];
let total = 0;

try {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  total = lines.length;
  recentEntries = lines.slice(-KEEP).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { /* first start */ }

export function append({ who, via, msg }) {
  const entry = { id: crypto.randomUUID(), t: Date.now(), node: config.nodeId, who: who || 'system', via: via || config.nodeId, msg };
  recentEntries.push(entry);
  if (recentEntries.length > KEEP) recentEntries.shift();
  total++;
  fs.appendFile(file, JSON.stringify(entry) + '\n', err => { if (err) console.error('[audit]', err.message); });
  return entry;
}
export const recent = (n = 30) => recentEntries.slice(-n).reverse();
export const count = () => total;
