// Shows the full signature-upload step output (command → result).
const fs = require('fs');
var s = fs.readFileSync('win-log.txt', 'utf8').replace(/^\uFEFF/, '');
var lines = s.split(/\r?\n/);
var start = -1;
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('Run sig_files=') !== -1) { start = i; break; }
}
if (start === -1) { console.log('upload start not found'); process.exit(1); }
for (var j = start - 1; j < start + 12 && j < lines.length; j++) console.log(lines[j].slice(28));
