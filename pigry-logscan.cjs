// Scans the windows job log for the signature upload step and its result.
const fs = require('fs');
var s = fs.readFileSync('win-log.txt', 'utf8');
s = s.replace(/^\uFEFF/, '');
var lines = s.split(/\r?\n/);
var idx = -1;
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('Upload updater signatures') !== -1) { idx = i; break; }
}
console.log('step found:', idx);
if (idx !== -1) {
  for (var j = idx; j < idx + 16 && j < lines.length; j++) console.log(lines[j].slice(28));
}
// also scan for any .sig upload/failure lines across the whole log
console.log('--- sig mentions ---');
for (var k = 0; k < lines.length; k++) {
  if (lines[k].indexOf('.sig') !== -1 || lines[k].toLowerCase().indexOf('signature') !== -1) {
    console.log(lines[k].slice(28));
  }
}
