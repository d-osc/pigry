const fs = require('fs');
let s = fs.readFileSync('src-tauri/src/git_state/tests.rs', 'utf8');
const before = (s.match(/file_hunks\(&dir, "code\.txt"\)/g) || []).length;
s = s.split('file_hunks(&dir, "code.txt")').join('file_hunks(&dir, "code.txt", false)');
s = s.split('file_hunks(&dir, "brand-new.ts")').join('file_hunks(&dir, "brand-new.ts", false)');
fs.writeFileSync('src-tauri/src/git_state/tests.rs', s);
console.log('call sites fixed:', before);
