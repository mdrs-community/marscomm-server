/* serverStats.js — analyze a MarsComm db.json file and print message statistics.
   Usage: node serverStats.js [dbfile] [firstSol] [lastSol]
   All arguments are optional.  firstSol/lastSol default to covering all Sols.
   If dbfile is omitted, db.json is used.  Sol range args must be integers.
*/

const fs = require('fs');

//--------------------------------------------------------------------------------------------------
// Arg parsing

let dbFile   = 'db.json';
let firstSol = null;
let lastSol  = null;

const args = process.argv.slice(2);
let ai = 0;
if (args[ai] !== undefined && !/^\d+$/.test(args[ai])) dbFile   = args[ai++];
if (args[ai] !== undefined &&  /^\d+$/.test(args[ai])) firstSol = parseInt(args[ai++]);
if (args[ai] !== undefined &&  /^\d+$/.test(args[ai])) lastSol  = parseInt(args[ai++]);

//--------------------------------------------------------------------------------------------------
// Text utilities

function stripHtml(str)
{
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi,  ' ')
    .replace(/&amp;/gi,   '&')
    .replace(/&lt;/gi,    '<')
    .replace(/&gt;/gi,    '>')
    .replace(/&quot;/gi,  '"')
    .replace(/&#\d+;/g,   ' ')
    .replace(/\s+/g,      ' ')
    .trim();
}

function wordCount(str)
{
  const clean = stripHtml(str);
  if (!clean) return 0;
  return clean.split(/\s+/).filter(w => w.length > 0).length;
}

function countQuestions(str)
{
  // each run of consecutive '?' counts as one question
  const matches = stripHtml(str).match(/\?+/g);
  return matches ? matches.length : 0;
}

function countSentences(str)
{
  // rough sentence count via terminal punctuation runs
  const matches = stripHtml(str).match(/[.!?]+/g);
  return matches ? matches.length : 0;
}

function avgWordLength(str)
{
  const clean = stripHtml(str);
  const words = clean.split(/\s+/).filter(w => w.length > 0);
  if (!words.length) return 0;
  return words.reduce((a, w) => a + w.length, 0) / words.length;
}

function truncate(str, len) { return str.length > len ? str.slice(0, len) + '…' : str; }

//--------------------------------------------------------------------------------------------------
// Math utilities

function sum(arr)    { return arr.length ? arr.reduce((a, b) => a + b, 0) : 0; }
function mean(arr)   { return arr.length ? sum(arr) / arr.length : 0; }

function median(arr)
{
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function fmt(n, dec)
{
  if (typeof n !== 'number') return String(n);
  const d = dec !== undefined ? dec : 1;
  return Number.isInteger(n) ? n.toString() : n.toFixed(d);
}

function pct(n, total) { return total ? ((n / total) * 100).toFixed(1) + '%' : '—'; }

//--------------------------------------------------------------------------------------------------
// IM statistics accumulator

function newIMAccum()
{
  return {
    count:         0,
    lengths:       [],   // stripped char lengths
    words:         [],   // word counts
    questions:     [],   // question count per message
    sentences:     [],   // sentence count per message
    avgWordLens:   [],   // avg word length per message
    messagesWithQ: 0,    // messages containing at least one question
    singleWord:    0,    // messages that are a single word
    withLinks:     0,    // messages containing http(s) URLs
    withFormatting:0,    // messages using **bold** or __italic__
    withCode:      0,    // messages using `code`
    withEmoji:     0,    // messages containing emoji characters
    senders:       {},   // { username: count }
    longestMsg:    '',
    longestLen:    0,
  };
}

function accumIM(acc, im)
{
  const raw  = im.content || '';
  const text = stripHtml(raw);
  const len  = text.length;
  if (len === 0) return;

  const wc  = wordCount(raw);
  const qs  = countQuestions(raw);
  const sc  = countSentences(raw);
  const awl = avgWordLength(raw);

  acc.count++;
  acc.lengths.push(len);
  acc.words.push(wc);
  acc.questions.push(qs);
  acc.sentences.push(sc);
  acc.avgWordLens.push(awl);

  if (qs > 0)                                    acc.messagesWithQ++;
  if (wc <= 1)                                   acc.singleWord++;
  if (/https?:\/\//i.test(text))                 acc.withLinks++;
  if (/\*\*[^*]+\*\*|__[^_]+__/.test(raw))       acc.withFormatting++;
  if (/`[^`]+`/.test(raw))                       acc.withCode++;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(text))       acc.withEmoji++;

  acc.senders[im.user] = (acc.senders[im.user] || 0) + 1;
  if (len > acc.longestLen) { acc.longestLen = len; acc.longestMsg = text; }
}

function mergeIMAccum(dst, src)
{
  dst.count         += src.count;
  dst.lengths        = dst.lengths.concat(src.lengths);
  dst.words          = dst.words.concat(src.words);
  dst.questions      = dst.questions.concat(src.questions);
  dst.sentences      = dst.sentences.concat(src.sentences);
  dst.avgWordLens    = dst.avgWordLens.concat(src.avgWordLens);
  dst.messagesWithQ += src.messagesWithQ;
  dst.singleWord    += src.singleWord;
  dst.withLinks     += src.withLinks;
  dst.withFormatting+= src.withFormatting;
  dst.withCode      += src.withCode;
  dst.withEmoji     += src.withEmoji;
  for (const [u, n] of Object.entries(src.senders))
    dst.senders[u] = (dst.senders[u] || 0) + n;
  if (src.longestLen > dst.longestLen) { dst.longestLen = src.longestLen; dst.longestMsg = src.longestMsg; }
}

//--------------------------------------------------------------------------------------------------
// Report statistics accumulator

function newRepAccum()
{
  return {
    total:          0,
    filled:         0,
    transmitted:    0,
    approved:       0,
    attachmentCount:0,
    contentLengths: [],
    wordCounts:     [],
    unfilled:       [],
  };
}

function accumReport(acc, report)
{
  acc.total++;
  const text = stripHtml(report.content || '');
  if (text.length > 0)
  {
    acc.filled++;
    acc.contentLengths.push(text.length);
    acc.wordCounts.push(wordCount(report.content));
  }
  else acc.unfilled.push(report.name);

  if (report.transmitted) acc.transmitted++;
  if (report.approved)    acc.approved++;
  acc.attachmentCount += (report.attachments || []).length;
}

function mergeRepAccum(dst, src)
{
  dst.total          += src.total;
  dst.filled         += src.filled;
  dst.transmitted    += src.transmitted;
  dst.approved       += src.approved;
  dst.attachmentCount+= src.attachmentCount;
  dst.contentLengths  = dst.contentLengths.concat(src.contentLengths);
  dst.wordCounts      = dst.wordCounts.concat(src.wordCounts);
}

//--------------------------------------------------------------------------------------------------
// Printing

const COL = 18;
function row(label, value) { console.log('    ' + (label + ':').padEnd(COL) + value); }

function printIMStats(label, acc)
{
  console.log('  ' + label + ':');
  if (acc.count === 0) { console.log('    (no messages)'); return; }

  row('Messages',     acc.count);
  row('Senders',      Object.entries(acc.senders).sort((a,b)=>b[1]-a[1]).map(([u,n])=>u+'('+n+')').join(', '));
  row('Char length',  'mean=' + fmt(mean(acc.lengths)) + '  median=' + fmt(median(acc.lengths)) +
                      '  min=' + Math.min(...acc.lengths) + '  max=' + Math.max(...acc.lengths));
  row('Word count',   'mean=' + fmt(mean(acc.words)) + '  median=' + fmt(median(acc.words)) +
                      '  min=' + Math.min(...acc.words) + '  max=' + Math.max(...acc.words));
  row('Avg word len', fmt(mean(acc.avgWordLens)) + ' chars/word');
  row('Sentences',    'mean=' + fmt(mean(acc.sentences)) + '  total=' + sum(acc.sentences));
  row('Questions',    sum(acc.questions) + ' total  ' +
                      acc.messagesWithQ + ' msgs with ?s (' + pct(acc.messagesWithQ, acc.count) + ')  ' +
                      fmt(mean(acc.questions)) + ' avg/msg');
  if (acc.singleWord)     row('Single-word',  acc.singleWord + ' (' + pct(acc.singleWord, acc.count) + ')');
  if (acc.withLinks)      row('With URLs',    acc.withLinks + ' (' + pct(acc.withLinks, acc.count) + ')');
  if (acc.withFormatting) row('Formatted',    acc.withFormatting + ' (' + pct(acc.withFormatting, acc.count) + ')');
  if (acc.withCode)       row('With code',    acc.withCode + ' (' + pct(acc.withCode, acc.count) + ')');
  if (acc.withEmoji)      row('With emoji',   acc.withEmoji + ' (' + pct(acc.withEmoji, acc.count) + ')');
  if (acc.longestMsg)     row('Longest msg',  '"' + truncate(acc.longestMsg, 72) + '"');
}

function printRepStats(label, acc)
{
  console.log('  ' + label + ':');
  row('Reports',     acc.total + ' total  filled=' + acc.filled + ' (' + pct(acc.filled, acc.total) + ')' +
                     '  transmitted=' + acc.transmitted + '  approved=' + acc.approved +
                     '  attachments=' + acc.attachmentCount);
  if (acc.filled > 0)
  {
    row('Content len',  'mean=' + fmt(mean(acc.contentLengths)) + '  median=' + fmt(median(acc.contentLengths)) + ' chars');
    row('Word count',   'mean=' + fmt(mean(acc.wordCounts))     + '  median=' + fmt(median(acc.wordCounts)));
  }
  if (acc.unfilled.length > 0 && acc.unfilled.length <= 6)
    row('Unfilled',   acc.unfilled.join(', '));
}

//--------------------------------------------------------------------------------------------------
// Main

if (!fs.existsSync(dbFile)) { console.error('File not found: ' + dbFile); process.exit(1); }

const db   = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const sols = db.sols;

if (!sols || !sols.length) { console.error('No sols found in ' + dbFile); process.exit(1); }

if (firstSol === null) firstSol = 0;
if (lastSol  === null) lastSol  = sols.length - 1;
firstSol = Math.max(0, Math.min(firstSol, sols.length - 1));
lastSol  = Math.max(firstSol, Math.min(lastSol, sols.length - 1));

const HR = '='.repeat(64);
const hr = '-'.repeat(64);

console.log('');
console.log(HR);
console.log('MarsComm Statistics  —  ' + dbFile);
console.log('Sols ' + firstSol + ' through ' + lastSol + '  (' + (lastSol - firstSol + 1) + ' sol' + (lastSol - firstSol ? 's' : '') + ')');
console.log(HR);

const totEarth  = newIMAccum();
const totMars   = newIMAccum();
const totRepE   = newRepAccum();
const totRepM   = newRepAccum();
let   solsWithIMs = 0;

for (let s = firstSol; s <= lastSol; s++)
{
  const sol = sols[s];
  if (!sol) { console.log('\nSol ' + s + ': (data missing)'); continue; }

  const eAcc = newIMAccum();
  const mAcc = newIMAccum();
  const rE   = newRepAccum();
  const rM   = newRepAccum();

  for (const im of (sol.ims || []))
  {
    if (im.planet === 'Earth') accumIM(eAcc, im);
    else                       accumIM(mAcc, im);
  }
  for (const r of (sol.reportsEarth || [])) accumReport(rE, r);
  for (const r of (sol.reportsMars  || [])) accumReport(rM, r);

  const imTotal = eAcc.count + mAcc.count;
  if (imTotal > 0) solsWithIMs++;
  mergeIMAccum(totEarth, eAcc);
  mergeIMAccum(totMars,  mAcc);
  mergeRepAccum(totRepE, rE);
  mergeRepAccum(totRepM, rM);

  console.log('\n' + hr);
  console.log('Sol ' + s + '  |  ' + imTotal + ' IMs  |  ' +
              rE.filled + '/' + rE.total + ' Earth reports filled  |  ' +
              rM.filled + '/' + rM.total + ' Mars reports filled');
  console.log(hr);
  printIMStats('IMs  Earth \u2192 Mars',  eAcc);
  printIMStats('IMs  Mars  \u2192 Earth', mAcc);
  printRepStats('Reports (Earth)', rE);
  printRepStats('Reports (Mars)',  rM);
}

// Cumulative totals
const totalIMs = totEarth.count + totMars.count;
console.log('\n' + HR);
console.log('CUMULATIVE TOTALS  (Sols ' + firstSol + '\u2013' + lastSol + ')');
console.log(HR);

row('Total IMs',      totalIMs + '  (Earth\u2192Mars: ' + totEarth.count + ',  Mars\u2192Earth: ' + totMars.count + ')');
row('Sols with IMs',  solsWithIMs + ' of ' + (lastSol - firstSol + 1));
if (solsWithIMs > 0)
  row('Avg IMs/sol',  fmt(totalIMs / solsWithIMs) + ' (over active sols)');

console.log('');
printIMStats('IMs  Earth \u2192 Mars',  totEarth);
console.log('');
printIMStats('IMs  Mars  \u2192 Earth', totMars);
console.log('');
printRepStats('Reports (Earth)', totRepE);
console.log('');
printRepStats('Reports (Mars)',  totRepM);

// Sender leaderboard across all IMs
const allSenders = {};
for (const [u, n] of Object.entries(totEarth.senders)) allSenders[u] = (allSenders[u] || 0) + n;
for (const [u, n] of Object.entries(totMars.senders))  allSenders[u] = (allSenders[u] || 0) + n;

if (Object.keys(allSenders).length > 1)
{
  const ranked = Object.entries(allSenders).sort((a, b) => b[1] - a[1]);
  console.log('');
  row('Sender ranking', ranked.map(([u, n]) => u + '(' + n + ',  ' + pct(n, totalIMs) + ')').join('   '));
}

// Combined IM stats
if (totalIMs > 0)
{
  const allLengths = totEarth.lengths.concat(totMars.lengths);
  const allWords   = totEarth.words.concat(totMars.words);
  const allQs      = totEarth.questions.concat(totMars.questions);
  console.log('');
  row('All IMs combined', '');
  row('  Char length',    'mean=' + fmt(mean(allLengths)) + '  median=' + fmt(median(allLengths)) +
                          '  min=' + Math.min(...allLengths) + '  max=' + Math.max(...allLengths));
  row('  Word count',     'mean=' + fmt(mean(allWords)) + '  median=' + fmt(median(allWords)));
  row('  Questions',      sum(allQs) + ' total  ' + fmt(mean(allQs)) + ' avg/msg');
}

console.log('');
console.log(HR);
console.log('');
