// Shows what happened right after the gh release upload command.
const fs = require('fs');
var s = fs.readFileSync('win-log.txt', 'utf8').replace(/^\uFEFF/, '');
var lines = s.split(/\r?\n/);
var up = -1;
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('gh release upload "v0.3.0" --clobber') !== -1 && lines[i].indexOf('sig_files') !== -1) {
    // find the last occurrence (the actual step, not the echoed group)
    up = i;
  }
}
if (up === -1) { console.log('upload line not found'); process.exit(1); }
for (var j = up; j < up + 10 && j < lines.length; j++) console.log(lines[j].slice(28));
